import { afterEach, describe, expect, it, vi } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Divergence rebuilds (tui.scrollbackRebuild) erase native scrollback with
// ED3 and replay the whole frame. Windows Terminal's ED3 unconditionally
// moves the host viewport to the top of the buffer and a scrolled reader's
// viewport position is host state no escape sequence can reset (issues
// #1635/#1746), so on ConPTY hosts the rebuild is deferred to an input
// checkpoint (`rebuildScrollbackIfDirty`) where the viewport is provably at
// the bottom. POSIX hosts keep the eager erase-and-replay behavior.

const PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, "platform");

class MutableLinesComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
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

describe("scrollback divergence rebuild defers on ConPTY hosts", () => {
	afterEach(() => {
		if (PLATFORM_DESCRIPTOR) Object.defineProperty(process, "platform", PLATFORM_DESCRIPTOR);
		delete process.env.WSL_DISTRO_NAME;
		vi.restoreAllMocks();
	});

	it("does not erase scrollback on a divergence under ConPTY (win32)", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const term = new VirtualTerminal(80, 5);
		const writes = capture(term);
		const tui = new TUI(term);
		tui.setScrollbackRebuild(true);
		const component = new MutableLinesComponent(rows("tail", 200));
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);
			expect(term.isNativeViewportAtBottom()).toBe(true);

			// Reader scrolls up into history (as during a streaming answer).
			term.scrollLines(-3);
			expect(term.isNativeViewportAtBottom()).toBe(false);

			// Answer finalizes: the frame shrinks below the committed row count.
			// On ConPTY this must NOT erase scrollback — the host viewport would
			// strand at the buffer top (issue #1635/#1746).
			writes.length = 0;
			component.setLines(rows("tail", 160));
			tui.requestRender();
			await settle(term);

			const output = writes.join("");
			expect(output).not.toContain("\x1b[3J");
			// The scrolled reader keeps their position: no destructive replay
			// moved the host viewport. (The visible rows are the reader's
			// scroll position plus the repaired-below tail — expected mix.)
			expect(term.isNativeViewportAtBottom()).toBe(false);
		} finally {
			tui.stop();
		}
	});

	it("flushes the deferred rebuild at the input checkpoint", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const term = new VirtualTerminal(80, 5);
		const writes = capture(term);
		const tui = new TUI(term);
		tui.setScrollbackRebuild(true);
		const component = new MutableLinesComponent(rows("tail", 200));
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);

			// Divergence fires while the reader is scrolled up: deferred.
			term.scrollLines(-3);
			component.setLines(rows("tail", 160));
			tui.requestRender();
			await settle(term);
			expect(writes.join("")).not.toContain("\x1b[3J");

			// User presses Enter: the viewport is provably at the bottom now.
			// The checkpoint rebuild erases and replays exactly once.
			writes.length = 0;
			tui.rebuildScrollbackIfDirty();
			await settle(term);
			await settle(term);

			const output = writes.join("");
			expect(output).toContain("\x1b[H\x1b[3J");
			expect(term.isNativeViewportAtBottom()).toBe(true);
			expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual(rows("tail", 160));

			// A second flush is a no-op: nothing pending.
			writes.length = 0;
			tui.rebuildScrollbackIfDirty();
			await settle(term);
			expect(writes.join("")).not.toContain("\x1b[3J");
		} finally {
			tui.stop();
		}
	});

	it("flushes a deferred non-destructive refresh at the input checkpoint", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const term = new VirtualTerminal(80, 5);
		const writes = capture(term);
		const tui = new TUI(term);
		const component = new MutableLinesComponent(rows("tail", 200));
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);

			// A completed-run toggle during a later stream uses refreshDisplay so it
			// does not erase a reader's current Windows viewport. The refresh still
			// needs a destructive replay once the next prompt puts the viewport at
			// the bottom.
			term.scrollLines(-3);
			component.setLines(rows("tail", 160));
			writes.length = 0;
			tui.refreshDisplay("completed-run-toggle-during-stream");
			await settle(term);
			expect(writes.join("")).not.toContain("\x1b[3J");

			writes.length = 0;
			expect(tui.rebuildScrollbackIfDirty({ includePendingDestructiveReplay: true })).toBe(true);
			await settle(term);
			await settle(term);

			expect(writes.join("")).toContain("\x1b[H\x1b[3J");
			expect(term.isNativeViewportAtBottom()).toBe(true);
			expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual(rows("tail", 160));
		} finally {
			tui.stop();
		}
	});

	it("keeps the eager erase-and-replay on POSIX hosts", async () => {
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		const term = new VirtualTerminal(80, 5);
		const writes = capture(term);
		const tui = new TUI(term);
		tui.setScrollbackRebuild(true);
		const component = new MutableLinesComponent(rows("tail", 200));
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);

			writes.length = 0;
			component.setLines(rows("tail", 160));
			tui.requestRender();
			await settle(term);

			const output = writes.join("");
			expect(output).toContain("\x1b[H\x1b[3J");
			expect(term.getViewport().map(line => line.trimEnd())).toEqual([
				"tail-155",
				"tail-156",
				"tail-157",
				"tail-158",
				"tail-159",
			]);
		} finally {
			tui.stop();
		}
	});

	it("a destructive replay consumes the deferred rebuild flag", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const term = new VirtualTerminal(80, 5);
		const writes = capture(term);
		const tui = new TUI(term);
		tui.setScrollbackRebuild(true);
		const component = new MutableLinesComponent(rows("tail", 200));
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);

			// Deferred divergence, then a user-driven resetDisplay consumes it.
			term.scrollLines(-3);
			component.setLines(rows("tail", 160));
			tui.requestRender();
			await settle(term);
			expect(writes.join("")).not.toContain("\x1b[3J");

			writes.length = 0;
			tui.resetDisplay();
			await settle(term);
			await settle(term);
			expect(writes.join("")).toContain("\x1b[H\x1b[3J");

			// Flag consumed: the checkpoint flush is now a no-op.
			writes.length = 0;
			tui.rebuildScrollbackIfDirty();
			await settle(term);
			expect(writes.join("")).not.toContain("\x1b[3J");
		} finally {
			tui.stop();
		}
	});
});
