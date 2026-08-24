import { afterEach, describe, expect, it, vi } from "bun:test";
import { type TerminalFramePlan, type TerminalFrameProvider, TUI, type ViewportSize } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// A refresh may recompute the mutable viewport while a Windows reader is
// scrolled into native history, but it must leave that history untouched.
// Callers can explicitly replay the provider's current HistoryBatch at a safe
// checkpoint, or reset immediately when the user requested a destructive
// redraw.

const PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, "platform");

class MutableFrameProvider implements TerminalFrameProvider {
	#lines: string[];
	#nextHistoryId = 1;
	#historyPending = true;

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		const historyLength = Math.max(0, this.#lines.length - viewport.rows);
		return {
			history:
				this.#historyPending && historyLength > 0
					? { id: this.#nextHistoryId, rows: this.#lines.slice(0, historyLength) }
					: undefined,
			viewport: this.#lines.slice(historyLength),
		};
	}

	acknowledgeHistory(id: number): void {
		if (!this.#historyPending || id !== this.#nextHistoryId) return;
		this.#historyPending = false;
		this.#nextHistoryId++;
	}

	resetHistory(): void {
		this.#historyPending = true;
	}
}

function rows(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_v, i) => `${prefix}-${i}`);
}

async function settle(term: VirtualTerminal): Promise<void> {
	// The render scheduler defers its immediate hop with setImmediate (so queued
	// stdin such as Esc is read before an ordinary render). Drain that hop, then
	// wait past the throttled frame so the divergent frame actually lands.
	const immediate = Promise.withResolvers<void>();
	setImmediate(immediate.resolve);
	await immediate.promise;
	await Bun.sleep(60);
	await term.flush();
}

function capture(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	vi.spyOn(term, "write").mockImplementation((data: string) => {
		writes.push(data);
		realWrite(data);
	});
	return writes;
}

function plainBuffer(term: VirtualTerminal): string[] {
	return term.getScrollBuffer().map(line => Bun.stripANSI(line).trimEnd());
}

describe("explicit scrollback replay checkpoints", () => {
	afterEach(() => {
		if (PLATFORM_DESCRIPTOR) Object.defineProperty(process, "platform", PLATFORM_DESCRIPTOR);
		delete process.env.WSL_DISTRO_NAME;
		vi.restoreAllMocks();
	});

	it("keeps refreshDisplay non-destructive for a scrolled Windows reader", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const term = new VirtualTerminal(80, 5);
		const writes = capture(term);
		const tui = new TUI(term);
		const provider = new MutableFrameProvider(rows("tail", 200));
		tui.setFrameProvider(provider);

		try {
			tui.start();
			await settle(term);
			expect(term.isNativeViewportAtBottom()).toBe(true);

			term.scrollLines(-3);
			expect(term.isNativeViewportAtBottom()).toBe(false);

			// Recompute the current frame without issuing ED3, which would strand
			// the native Windows viewport at the top of its buffer.
			writes.length = 0;
			provider.setLines(rows("tail", 160));
			tui.refreshDisplay();
			await settle(term);

			expect(writes.join("")).not.toContain("\x1b[3J");
			expect(term.isNativeViewportAtBottom()).toBe(false);
		} finally {
			tui.stop();
		}
	});

	it("leaves a pending refresh marker untouched at the default checkpoint", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const term = new VirtualTerminal(80, 5);
		const tui = new TUI(term);
		const provider = new MutableFrameProvider(rows("tail", 200));
		tui.setFrameProvider(provider);

		try {
			tui.start();
			await settle(term);

			provider.setLines(rows("tail", 160));
			tui.refreshDisplay();
			await settle(term);

			expect(tui.rebuildScrollbackIfDirty()).toBe(false);
			expect(tui.rebuildScrollbackIfDirty({ includePendingDestructiveReplay: true })).toBe(true);
		} finally {
			tui.stop();
		}
	});

	it("replays refreshed history exactly once at an opted-in checkpoint", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const term = new VirtualTerminal(80, 5);
		const writes = capture(term);
		const tui = new TUI(term);
		const provider = new MutableFrameProvider(rows("tail", 200));
		tui.setFrameProvider(provider);

		try {
			tui.start();
			await settle(term);

			provider.setLines(rows("tail", 160));
			tui.refreshDisplay();
			await settle(term);

			writes.length = 0;
			expect(tui.rebuildScrollbackIfDirty({ includePendingDestructiveReplay: true })).toBe(true);
			const output = writes.join("");
			expect(output.match(/\x1b\[3J/g) ?? []).toHaveLength(1);
			expect(plainBuffer(term)).toEqual(rows("tail", 160));

			writes.length = 0;
			expect(tui.rebuildScrollbackIfDirty({ includePendingDestructiveReplay: true })).toBe(false);
			expect(writes.join("")).not.toContain("\x1b[3J");
		} finally {
			tui.stop();
		}
	});

	it("resets and replays history synchronously on POSIX", async () => {
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		const term = new VirtualTerminal(80, 5);
		const writes = capture(term);
		const tui = new TUI(term);
		const provider = new MutableFrameProvider(rows("tail", 200));
		tui.setFrameProvider(provider);

		try {
			tui.start();
			await settle(term);

			writes.length = 0;
			provider.setLines(rows("tail", 160));
			tui.resetDisplay();

			const output = writes.join("");
			expect(output).toContain("\x1b[H\x1b[3J");
			expect(plainBuffer(term)).toEqual(rows("tail", 160));
		} finally {
			tui.stop();
		}
	});

	it("makes an opted-in checkpoint a no-op after an explicit reset", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const term = new VirtualTerminal(80, 5);
		const writes = capture(term);
		const tui = new TUI(term);
		const provider = new MutableFrameProvider(rows("tail", 200));
		tui.setFrameProvider(provider);

		try {
			tui.start();
			await settle(term);

			provider.setLines(rows("tail", 160));
			tui.refreshDisplay();
			await settle(term);

			writes.length = 0;
			tui.resetDisplay();
			expect(writes.join("")).toContain("\x1b[H\x1b[3J");
			expect(plainBuffer(term)).toEqual(rows("tail", 160));

			writes.length = 0;
			expect(tui.rebuildScrollbackIfDirty({ includePendingDestructiveReplay: true })).toBe(false);
			expect(writes.join("")).not.toContain("\x1b[3J");
		} finally {
			tui.stop();
		}
	});
});
