import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type TerminalFramePlan, type TerminalFrameProvider, TUI, type ViewportSize } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

const ENV_KEYS = [
	"TMUX",
	"STY",
	"ZELLIJ",
	"CMUX_WORKSPACE_ID",
	"CMUX_SURFACE_ID",
	"CMUX_REMOTE_TRANSPORT",
	"TERM_PROGRAM",
	"PI_TUI_RESIZE_IN_PLACE",
] as const;

class Provider implements TerminalFrameProvider {
	renderFrames = 0;
	resizeFrames = 0;

	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		this.renderFrames++;
		return { viewport: [`frame@${viewport.columns}x${viewport.rows}`] };
	}

	renderResizeFrame(viewport: ViewportSize): readonly string[] {
		this.resizeFrames++;
		return [`resize@${viewport.columns}x${viewport.rows}`];
	}

	acknowledgeHistory(): void {}
}

class Scheduler {
	#timers = new Set<() => void>();

	now(): number {
		return 0;
	}

	scheduleImmediate(callback: () => void): void {
		callback();
	}

	scheduleRender(callback: () => void) {
		this.#timers.add(callback);
		return { cancel: () => this.#timers.delete(callback) };
	}

	settle(): void {
		const timers = [...this.#timers];
		this.#timers.clear();
		for (const timer of timers) timer();
	}
}

describe("in-place resize hosts", () => {
	let saved: Partial<Record<(typeof ENV_KEYS)[number] | "HERDR_ENV" | "TERM", string | undefined>>;

	beforeEach(() => {
		saved = {};
		for (const key of ENV_KEYS) {
			saved[key] = Bun.env[key];
			delete Bun.env[key];
		}
		saved.HERDR_ENV = Bun.env.HERDR_ENV;
		saved.TERM = Bun.env.TERM;
		Bun.env.HERDR_ENV = "1";
		Bun.env.TERM = "dumb";
	});

	afterEach(() => {
		for (const key of [...ENV_KEYS, "HERDR_ENV", "TERM"] as const) {
			const value = saved[key];
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	});

	it("coalesces a Herdr resize burst without feeding back through the alternate screen", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const writes: string[] = [];
		const write = terminal.write.bind(terminal);
		terminal.write = data => {
			writes.push(data);
			write(data);
		};
		const scheduler = new Scheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const provider = new Provider();
		tui.setFrameProvider(provider);
		tui.start();
		const framesBeforeResize = provider.renderFrames;
		writes.length = 0;

		for (let index = 0; index < 24; index++) {
			terminal.resize(41 + index, 8 + (index % 4));
		}
		terminal.resize(64, 12);

		const resizeOutput = writes.join("");
		expect(resizeOutput).not.toContain("\x1b[?1049h");
		expect(resizeOutput).not.toContain("\x1b[?1049l");
		expect(resizeOutput).not.toContain("\x1b[6n");
		expect(provider.renderFrames).toBe(framesBeforeResize);
		expect(provider.resizeFrames).toBe(0);
		scheduler.settle();
		expect(writes.join("")).toContain("\x1b[6n");
		await terminal.flush();
		expect(provider.renderFrames).toBe(framesBeforeResize + 1);
		expect(terminal.getViewport().some(row => row.includes("frame@64x12"))).toBe(true);
		tui.stop();
	});

	it("honors the explicit alternate-screen override inside Herdr", () => {
		Bun.env.PI_TUI_RESIZE_IN_PLACE = "0";
		const terminal = new VirtualTerminal(40, 8);
		const writes: string[] = [];
		const write = terminal.write.bind(terminal);
		terminal.write = data => {
			writes.push(data);
			write(data);
		};
		const tui = new TUI(terminal, undefined, { renderScheduler: new Scheduler() });
		tui.setFrameProvider(new Provider());
		tui.start();
		writes.length = 0;

		terminal.resize(52, 10);

		expect(writes.join("")).toContain("\x1b[?1049h");
		tui.stop();
	});
});
