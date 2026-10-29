import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type Component, Container, Text } from "@oh-my-pi/pi-tui";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

const COLUMNS = 120;
const REPLY_LINES = 150;

/** Turn chrome (status, loader, HUD) that outlives the turn, taller than the idle chrome at startup. */
class TurnChrome implements Component {
	rows = 0;
	render(): readonly string[] {
		return Array.from({ length: this.rows }, (_, i) => `Turn chrome row ${i}`);
	}
}

class RunGate extends Container {
	#finalized = false;

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	allowsTranscriptSuccessorRetirement(): boolean {
		return true;
	}

	finalize(): void {
		this.#finalized = true;
	}
}

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	};
}

beforeAll(async () => {
	await initTheme();
});

describe("transcript rows under chrome that outlives the turn", () => {
	it("does not duplicate animated tool previews in native history before settlement", async () => {
		const terminal = new VirtualTerminal(COLUMNS, 24);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		const title = "Animated tool preview";
		const code = Array.from({ length: 40 }, (_, i) => `value_${i} = ${i}`).join("\n");
		const tool = new ToolExecutionComponent("eval", { language: "py", code, title }, {}, undefined, composer.ui);
		transcript.addChild(tool);
		const chrome = new TurnChrome();
		chrome.rows = 20;
		const editor = new Text("EDITOR", 0, 0);
		composer.setRuntimeChildren([transcript, chrome, editor]);
		composer.start({ playWelcomeIntro: false });
		const titleRows = (): string[] => terminal.getScrollBuffer().filter(row => row.includes(title));
		try {
			for (let tick = 0; tick < 8; tick++) {
				tool.tickSpinner(tick);
				composer.ui.requestRender();
				await scheduler.settle(terminal);
			}
			chrome.rows = 0;
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			expect(titleRows()).toHaveLength(1);

			// A live result may replace the entire code preview, not just its spinner.
			chrome.rows = 20;
			tool.updateResult(
				{
					content: [{ type: "text", text: "LIVE_OUTPUT" }],
					details: {
						cells: [{ index: 0, title, code, language: "python", output: "LIVE_OUTPUT", status: "running" }],
					},
				},
				true,
			);
			for (let tick = 0; tick < 8; tick++) {
				tool.tickSpinner(tick);
				composer.ui.requestRender();
				await scheduler.settle(terminal);
			}
			chrome.rows = 0;
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			expect(titleRows()).toHaveLength(1);

			tool.setExpanded(true);
			const result = {
				content: [{ type: "text", text: "FINAL_OUTPUT" }],
				details: {
					cells: [{ index: 0, title, code, language: "python", output: "FINAL_OUTPUT", status: "complete" }],
				},
			};
			tool.updateResult(result, false);
			chrome.rows = 20;
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			expect(titleRows()).toHaveLength(1);
			expect(terminal.getScrollBuffer().filter(row => row.includes("FINAL_OUTPUT"))).toHaveLength(1);
			expect(terminal.getScrollBuffer().some(row => row.includes("LIVE_OUTPUT"))).toBe(false);
			expect(terminal.getScrollBuffer().flatMap(row => row.match(/value_\d+ = \d+/g) ?? [])).toEqual(
				code.split("\n"),
			);

			composer.ui.resetDisplay();
			await scheduler.settle(terminal);
			expect(titleRows()).toHaveLength(1);
			expect(terminal.getScrollBuffer().filter(row => row.includes("FINAL_OUTPUT"))).toHaveLength(1);
			expect(terminal.getScrollBuffer().flatMap(row => row.match(/value_\d+ = \d+/g) ?? [])).toEqual(
				code.split("\n"),
			);
		} finally {
			tool.stopAnimation();
			composer.stop();
		}
	});

	for (const gated of [false, true]) {
		it(`keeps a large stable code block reachable during streaming${gated ? " behind an open run gate" : ""}`, async () => {
			const terminal = new VirtualTerminal(COLUMNS, 24);
			const scheduler = new VirtualRenderScheduler();
			const composer = new Composer({
				terminal,
				tuiOptions: { renderScheduler: scheduler },
				preferences: { ...COMPOSER_DEFAULTS, quiet: true },
			});
			const transcript = new TranscriptContainer();
			const gate = new RunGate();
			if (gated) transcript.addChild(gate);
			transcript.setToolRowsFolded(gated);
			const completedTool = { joinsFoldedToolRows: true as const, render: () => ["Tool completed"] };
			transcript.addChild(completedTool);
			const message = new AssistantMessageComponent();
			transcript.addChild(message);
			const editor = new Container();
			editor.addChild(new Text("EDITOR", 0, 0));
			composer.setRuntimeChildren([transcript, editor]);
			composer.start({ playWelcomeIntro: false });
			const markers = Array.from({ length: 40 }, (_, i) => `QZP${String(i).padStart(3, "0")}`);
			let text = `## Answer\n\n\`\`\`text\n${markers.join("\n")}\n\`\`\`\n\nStill streaming`;
			const visibleMarkers = (): string[] =>
				terminal.getScrollBuffer().flatMap(row => Bun.stripANSI(row).match(/QZP\d{3}/g) ?? []);
			try {
				for (const suffix of ["", " the next paragraph", "\n\nMore output"]) {
					text += suffix;
					message.updateContent(reply(text), { transient: true });
					composer.ui.requestRender();
					await scheduler.settle(terminal);
					expect(visibleMarkers()).toEqual(markers);
				}

				// A replay during the live turn must retain the already-emitted code.
				composer.ui.resetDisplay();
				await scheduler.settle(terminal);
				expect(visibleMarkers()).toEqual(markers);

				message.updateContent(reply(text));
				message.markTranscriptBlockFinalized();
				gate.finalize();
				composer.ui.requestRender();
				await scheduler.settle(terminal);
				expect(visibleMarkers()).toEqual(markers);
			} finally {
				composer.stop();
			}
		});
	}

	it("keeps tool rows contiguous across native history while turn chrome grows", async () => {
		const terminal = new VirtualTerminal(COLUMNS, 30);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		const settled = Array.from({ length: 35 }, (_, i) => `Settled tool row ${i}`);
		const pending = Array.from({ length: 12 }, (_, i) => `Pending tool row ${i}`);
		const settledBlock = { render: () => settled, isTranscriptBlockFinalized: () => true };
		const pendingBlock = { render: () => pending, isTranscriptBlockFinalized: () => false };
		transcript.addChild(settledBlock);
		const chrome = new TurnChrome();
		const editor = new Container();
		editor.addChild(new Text("EDITOR", 0, 0));
		composer.setRuntimeChildren([transcript, chrome, editor]);
		composer.start({ playWelcomeIntro: false });
		try {
			await scheduler.settle(terminal);
			chrome.rows = 8;
			transcript.addChild(pendingBlock);
			for (const chromeRows of [8, 0]) {
				chrome.rows = chromeRows;
				composer.ui.requestRender();
				await scheduler.settle(terminal);
				const toolRows = terminal
					.getScrollBuffer()
					.map(row => Bun.stripANSI(row).trim())
					.filter(row => /^(Settled|Pending) tool row \d+$/.test(row));
				expect(toolRows).toEqual([...settled, ...pending]);
			}
		} finally {
			composer.stop();
		}
	});

	for (const rows of [24, 45]) {
		it(`keeps every line of a long streamed answer at ${rows} rows`, async () => {
			const terminal = new VirtualTerminal(COLUMNS, rows);
			const scheduler = new VirtualRenderScheduler();
			const composer = new Composer({
				terminal,
				tuiOptions: { renderScheduler: scheduler },
				preferences: { ...COMPOSER_DEFAULTS, quiet: true },
			});
			const transcript = new TranscriptContainer();
			const chrome = new TurnChrome();
			const editor = new Container();
			editor.addChild(new Text("EDITOR", 0, 0));
			composer.setRuntimeChildren([transcript, chrome, editor]);
			composer.start({ playWelcomeIntro: false });
			await scheduler.settle(terminal);

			const message = new AssistantMessageComponent();
			transcript.addChild(message);
			chrome.rows = 7;
			const lines = Array.from(
				{ length: REPLY_LINES },
				(_, i) => `QZC${String(i + 1).padStart(3, "0")} alpha bravo`,
			);
			for (let n = 1; n <= lines.length; n++) {
				message.updateContent(reply(lines.slice(0, n).join("\n\n")), { transient: true });
				composer.ui.requestRender();
				await scheduler.settle(terminal);
			}
			message.updateContent(reply(lines.join("\n\n")));
			message.markTranscriptBlockFinalized();
			composer.ui.requestRender();
			// Past the idle-chrome settle window, the chrome that outlived the turn is permanent.
			await scheduler.advance(terminal, 300);

			const counts = new Map<number, number>();
			for (const row of terminal.getScrollBuffer()) {
				const token = /QZC(\d{3})/.exec(Bun.stripANSI(row))?.[1];
				if (token !== undefined) counts.set(Number(token), (counts.get(Number(token)) ?? 0) + 1);
			}
			const missing = Array.from({ length: REPLY_LINES }, (_, i) => i + 1).filter(n => !counts.has(n));
			const duplicated = [...counts].filter(([, count]) => count > 1).map(([n]) => n);
			expect({ missing, duplicated }).toEqual({ missing: [], duplicated: [] });
			composer.stop();
		});
	}

	for (const mounting of ["initial mount", "runtime remount"] as const) {
		it(`keeps restored transcript and shell history reachable when idle chrome grows after ${mounting} without a new run`, async () => {
			const rows = 30;
			const shell = Array.from({ length: 12 }, (_, i) => `shell${i}`);
			const terminal = new VirtualTerminal(COLUMNS, rows);
			terminal.write(`${shell.join("\r\n")}${"\r\n".repeat(rows + 1)}`);
			const scheduler = new VirtualRenderScheduler();
			const composer = new Composer({
				terminal,
				tuiOptions: { renderScheduler: scheduler },
				preferences: { ...COMPOSER_DEFAULTS, quiet: true },
			});
			const transcript = new TranscriptContainer();
			const lines = Array.from(
				{ length: REPLY_LINES },
				(_, i) => `QZI${String(i + 1).padStart(3, "0")} alpha bravo`,
			);
			const message = new AssistantMessageComponent();
			message.updateContent(reply(lines.join("\n\n")));
			message.markTranscriptBlockFinalized();
			transcript.addChild(message);
			const chrome = new TurnChrome();
			const editor = new Container();
			editor.addChild(new Text("EDITOR", 0, 0));
			composer.setRuntimeChildren([transcript, chrome, editor]);
			composer.start({ playWelcomeIntro: false });
			try {
				await scheduler.advance(terminal, 300);
				if (mounting === "runtime remount") {
					// Replacing session-aware roots resets floor bookkeeping, but
					// does not imply another agent run or erase existing history.
					composer.setRuntimeChildren([transcript, chrome, editor]);
					await scheduler.advance(terminal, 300);
				}
				const history = (): string[] =>
					terminal
						.getScrollBuffer()
						.map(row => Bun.stripANSI(row).trim())
						.filter(row => /^(shell\d+|QZI\d{3} alpha bravo)$/.test(row));
				expect(history()).toEqual([...shell, ...lines]);
				chrome.rows = 7;
				composer.ui.requestRender();
				await scheduler.advance(terminal, 300);
				expect(history()).toEqual([...shell, ...lines]);
				expect(
					terminal
						.getViewport()
						.map(row => Bun.stripANSI(row).trim())
						.filter(row => row.startsWith("Turn chrome row ")),
				).toEqual(Array.from({ length: 7 }, (_, i) => `Turn chrome row ${i}`));

				chrome.rows = 0;
				composer.ui.requestRender();
				await scheduler.advance(terminal, 300);
				const editorRow = terminal.getViewport().findIndex(row => row.includes("EDITOR"));
				expect(editorRow).toBeGreaterThanOrEqual(0);
				expect(editorRow).toBeLessThan(rows - 1);
				expect(history()).toEqual([...shell, ...lines]);
			} finally {
				composer.stop();
			}
		});
	}

	/** Stream {@link REPLY_LINES} lines under 7 rows of persistent chrome, then let the idle chrome settle. */
	async function streamUnderChrome(composer: Composer, scheduler: VirtualRenderScheduler, terminal: VirtualTerminal) {
		const transcript = new TranscriptContainer();
		const chrome = new TurnChrome();
		const editorRoot = new Container();
		editorRoot.addChild(composer.editor);
		composer.setRuntimeChildren([transcript, chrome, editorRoot]);
		await scheduler.settle(terminal);
		return async (beforeStream?: () => Promise<void>): Promise<string[]> => {
			await beforeStream?.();
			const message = new AssistantMessageComponent();
			transcript.addChild(message);
			chrome.rows = 7;
			const lines = Array.from({ length: REPLY_LINES }, (_, i) => `QZS${String(i + 1).padStart(3, "0")}`);
			for (let n = 1; n <= lines.length; n++) {
				message.updateContent(reply(lines.slice(0, n).join("\n\n")), { transient: true });
				composer.ui.requestRender();
				await scheduler.settle(terminal);
			}
			message.updateContent(reply(lines.join("\n\n")));
			message.markTranscriptBlockFinalized();
			composer.ui.requestRender();
			await scheduler.advance(terminal, 300);
			const seen = new Set<string>();
			for (const row of terminal.getScrollBuffer()) {
				const token = /QZS\d{3}/.exec(Bun.stripANSI(row))?.[0];
				if (token !== undefined) seen.add(token);
			}
			return lines.filter(line => !seen.has(line));
		};
	}

	it("keeps every line when the runtime composer shape is taller than the prepaint shape", async () => {
		const terminal = new VirtualTerminal(COLUMNS, 24);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true, composerShape: "band" },
		});
		composer.start({ playWelcomeIntro: false });
		try {
			// The bootstrap frame paints the cached 2-row band; settings then resolve to the 3-row pi shape.
			await scheduler.settle(terminal);
			composer.editor.setBorderStyle("pi");
			const run = await streamUnderChrome(composer, scheduler, terminal);
			expect(await run()).toEqual([]);
		} finally {
			composer.stop();
		}
	});

	it("keeps every line after the composer shape grows mid-session", async () => {
		const terminal = new VirtualTerminal(COLUMNS, 24);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true, composerShape: "band" },
		});
		composer.start({ playWelcomeIntro: false });
		try {
			await scheduler.settle(terminal);
			const run = await streamUnderChrome(composer, scheduler, terminal);
			const missing = await run(async () => {
				composer.setPreferences({ composerShape: "pi" });
				composer.ui.requestRender();
				await scheduler.settle(terminal);
			});
			expect(missing).toEqual([]);
		} finally {
			composer.stop();
		}
	});
});
