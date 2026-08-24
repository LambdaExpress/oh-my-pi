import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { BashExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/bash-execution";
import { Composer } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { Component } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { setLocale } from "../src/i18n";

function plainRows(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

function dump(label: string, rows: readonly string[]): void {
	console.log(`==== ${label} ====`);
	for (const [i, row] of rows.entries()) console.log(String(i).padStart(3), JSON.stringify(row));
}

describe("libkitty end-to-end", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		setLocale("en");
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-libkitty-e2e-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		term = new VirtualTerminal(120, 32);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
		setLocale(null);
	});

	it("paints the submitted user message before any model reply", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const pending = mode.getUserInput();
		await term.waitForRender();

		term.sendInput("hi there omp");
		await term.waitForRender();
		term.sendInput("\r");
		const input = await pending;
		expect(input.text).toBe("hi there omp");

		// The optimistic user-message block must be on the physical screen now,
		// before any assistant output exists.
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("hi there omp")));
		const viewport = plainRows(term.getViewport());
		const hits = viewport.filter(row => row.includes("hi there omp"));
		if (hits.length !== 1) dump("viewport after submit", viewport);
		expect(hits.length).toBe(1);
	});

	it("keeps the whole buffer clean across non-overflowing width resizes", async () => {
		term.resize(140, 40);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();
		term.sendInput("MARKER_DRAFT");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("MARKER_DRAFT")));

		term.resize(120, 40);
		await Bun.sleep(300);
		await term.waitForRender();
		term.resize(110, 40);
		await Bun.sleep(300);
		await term.waitForRender();

		// Content always fit the screen, so the terminal never pushed live rows
		// into scrollback: the entire buffer must hold exactly one copy.
		const buffer = plainRows(term.getScrollBuffer());
		const drafts = buffer.filter(row => row.includes("MARKER_DRAFT"));
		if (drafts.length !== 1) dump("scroll buffer after resizes", buffer);
		expect(drafts.length).toBe(1);
		const welcomes = buffer.filter(row => row.includes("Welcome back!"));
		expect(welcomes.length).toBe(1);
	});

	it("keeps the screen exact through an overflowing shrink", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();
		term.sendInput("MARKER_DRAFT");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("MARKER_DRAFT")));

		// Width+height shrink: the live viewport rewraps taller than the new
		// screen, so the terminal itself pushes stale top rows into scrollback.
		// Those pushed rows are unreachable to an inline app; the contract is an
		// exact screen and no duplicate of the bottom-anchored rows anywhere.
		term.resize(88, 26);
		await Bun.sleep(300);
		await term.waitForRender();

		const viewport = plainRows(term.getViewport());
		const editors = viewport.filter(row => row.includes("MARKER_DRAFT"));
		if (editors.length !== 1) dump("viewport after overflowing shrink", viewport);
		expect(editors.length).toBe(1);
		expect(viewport.filter(row => row.includes("Welcome back!")).length).toBeLessThanOrEqual(1);
		const buffer = plainRows(term.getScrollBuffer());
		expect(buffer.filter(row => row.includes("MARKER_DRAFT")).length).toBe(1);
	});

	it("keeps one editor through a drag storm, shrink, and grow", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();
		term.sendInput("MARKER_DRAFT");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("MARKER_DRAFT")));

		// Drag storm: several unsettled steps inside one settle window.
		term.resize(112, 30);
		await Bun.sleep(30);
		term.resize(104, 28);
		await Bun.sleep(30);
		term.resize(96, 24);
		await Bun.sleep(300);
		await term.waitForRender();
		// Height-only shrink, then a combined grow back out.
		term.resize(96, 18);
		await Bun.sleep(300);
		await term.waitForRender();
		term.resize(120, 32);
		await Bun.sleep(300);
		await term.waitForRender();

		const buffer = plainRows(term.getScrollBuffer());
		const drafts = buffer.filter(row => row.includes("MARKER_DRAFT"));
		if (drafts.length !== 1) dump("scroll buffer after drag storm", buffer);
		expect(drafts.length).toBe(1);
		const viewport = plainRows(term.getViewport());
		expect(viewport.filter(row => row.includes("Welcome back!")).length).toBeLessThanOrEqual(1);

		// The editor is still live: typing paints into the one surviving editor.
		term.sendInput("X");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("MARKER_DRAFTX")));
		expect(plainRows(term.getViewport()).filter(row => row.includes("MARKER_DRAFTX")).length).toBe(1);
	});

	it("keeps an active block's provider-settled prefix exact across native history", async () => {
		const width = 120;
		term = new VirtualTerminal(width, 12);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		// Keep the real InteractiveMode layout, but reserve exactly three rows
		// for transcript content. The active four-row block must therefore move
		// its declared T0 prefix to native history instead of merely clipping it.
		composer.setPreferences({ quiet: true });
		composer.setHeaderExtras([], []);
		const chromeRows = composer.renderFrame({ columns: width, rows: 1_000 }).viewport.length;
		const paddingRows = term.rows - chromeRows - 3;
		expect(paddingRows).toBeGreaterThanOrEqual(0);
		const paddingRender = Array.from({ length: paddingRows }, () => "");
		const padding: Component = {
			render: () => paddingRender,
		};
		mode.pendingMessagesContainer.addChild(padding);

		const markers = [
			"TRANSCRIPT_SEAM_S",
			"TRANSCRIPT_SEAM_T0",
			"TRANSCRIPT_SEAM_T1",
			"TRANSCRIPT_SEAM_T2",
			"TRANSCRIPT_SEAM_T3",
		] as const;
		const [S, T0, T1, T2, T3] = markers;
		const stableRows: readonly string[] = [S];
		const stableBlock = {
			render: () => stableRows,
			isTranscriptBlockFinalized: () => true,
		};
		let activeFinalized = false;
		const settledCursor = { marker: T0 };
		const activeRows: readonly string[] = [T0, T1, T2, T3];
		const activeBlock = {
			render: () => activeRows,
			isTranscriptBlockFinalized: () => activeFinalized,
			getTranscriptBlockSettledPrefix: (_renderWidth: number, rendered: readonly string[]) =>
				rendered[0] === T0 ? { rowCount: 1, cursor: settledCursor } : undefined,
			resolveTranscriptBlockSettledPrefix: (cursor: unknown, _renderWidth: number, rendered: readonly string[]) => {
				if (cursor !== settledCursor) return undefined;
				const index = rendered.indexOf(T0);
				return index < 0 ? undefined : index + 1;
			},
		};
		mode.chatContainer.addChild(stableBlock);
		mode.chatContainer.addChild(activeBlock);

		// History transport is synchronous; force enough discrete frames to
		// acknowledge the empty header, S, and the partial T0 offer.
		for (let frame = 0; frame < 4; frame++) mode.ui.renderNow();
		await term.flush();
		const markerTape = () =>
			plainRows(term.getScrollBuffer())
				.filter(row => markers.some(marker => row.includes(marker)))
				.map(row => markers.find(marker => row.includes(marker))!);
		expect(markerTape()).toEqual([...markers]);

		// Final retirement must append only the uncommitted suffix. T0 is already
		// immutable native history and must neither disappear nor be replayed.
		activeFinalized = true;
		for (let frame = 0; frame < 2; frame++) mode.ui.renderNow();
		await term.flush();
		expect(markerTape()).toEqual([...markers]);
	});

	it("streams a growing paragraph with inline code into native history before finalize", async () => {
		const width = 80;
		term = new VirtualTerminal(width, 10);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		composer.setPreferences({ quiet: true });
		composer.setHeaderExtras([], []);
		const assistant = new AssistantMessageComponent();
		mode.chatContainer.addChild(assistant);
		const usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const message = (text: string): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage,
			stopReason: "stop",
			timestamp: 1,
		});
		const markers = Array.from({ length: 36 }, (_, index) => `STREAMPARA${String(index).padStart(2, "0")}`);
		let text = "The `Enter/Exit` setting remains available while the response continues.";

		for (const marker of markers) {
			text += `${text ? " " : ""}${marker} ordinary prose keeps growing without a Markdown block boundary`;
			assistant.updateContent(message(text), { transient: true });
			mode.ui.renderNow();
			await term.flush();
		}

		const committedRows = plainRows(term.getScrollBuffer()).slice(0, term.getBufferPosition().baseY);
		expect(committedRows.some(row => row.includes(markers[0]!))).toBe(true);
		expect(plainRows(term.getViewport()).some(row => row.includes(markers.at(-1)!))).toBe(true);
		const streamingRows = plainRows(term.getScrollBuffer());
		for (const marker of markers) {
			expect(streamingRows.filter(row => row.includes(marker))).toHaveLength(1);
		}

		assistant.updateContent(message(text), { transient: false });
		assistant.markTranscriptBlockFinalized();
		for (let frame = 0; frame < 2; frame++) mode.ui.renderNow();
		await term.flush();

		const finalRows = plainRows(term.getScrollBuffer());
		for (const marker of markers) {
			expect(finalRows.filter(row => row.includes(marker))).toHaveLength(1);
		}
	});

	it("hides thinking already retired to native scrollback when Ctrl+T toggles", async () => {
		const usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const assistantText = (text: string): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage,
			stopReason: "stop",
			timestamp: 1,
		});
		const THINK = "RETIRED_REASONING_MARKER";
		const thinkingMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: THINK },
				{ type: "text", text: "First visible answer." },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage,
			stopReason: "stop",
			timestamp: 1,
		};

		// A short viewport forces the oldest finalized blocks into immutable
		// terminal history, which is where the regression hid (a plain viewport
		// repaint leaves retired rows untouched).
		term = new VirtualTerminal(120, 10);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		// Observed reasoning content unlocks Ctrl+T and renders the block visible.
		mode.noteDisplayableThinkingContent(thinkingMessage);
		mode.addMessageToChat(thinkingMessage);
		for (let i = 0; i < 12; i++) {
			mode.addMessageToChat(assistantText(`Filler answer number ${i} occupying a transcript row.`));
		}

		// Retirement offers one finalized batch per frame under capacity pressure;
		// drive frames until the thinking turn commits to native scrollback.
		const committedRows = () => {
			const { baseY } = term.getBufferPosition();
			return plainRows(term.getScrollBuffer()).slice(0, baseY);
		};
		for (let i = 0; i < 20 && !committedRows().some(row => row.includes(THINK)); i++) {
			mode.ui.requestRender(true);
			await term.waitForRender();
		}
		expect(committedRows().some(row => row.includes(THINK))).toBe(true);

		// A live editor draft must survive the toggle's history rebuild.
		term.sendInput("LIVE_EDITOR_DRAFT");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("LIVE_EDITOR_DRAFT")));

		// Ctrl+T (0x14): the real keybinding path toggles thinking hidden.
		term.sendInput("\x14");
		await term.waitForRender(() => !plainRows(term.getScrollBuffer()).some(row => row.includes(THINK)));

		// The retired history was cleared and replayed hidden — the marker is gone
		// from scrollback and viewport alike — while the live editor stays mounted.
		expect(plainRows(term.getScrollBuffer()).some(row => row.includes(THINK))).toBe(false);
		expect(plainRows(term.getViewport()).some(row => row.includes("LIVE_EDITOR_DRAFT"))).toBe(true);
	});

	it("collapses tool output that expansion retired to native scrollback", async () => {
		term = new VirtualTerminal(120, 32);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		const firstOutputMarker = "EXPANDED_TOOL_PREFIX_00";
		const output = Array.from(
			{ length: 80 },
			(_, index) => `EXPANDED_TOOL_PREFIX_${String(index).padStart(2, "0")}`,
		).join("\n");
		const execution = new BashExecutionComponent("emit-many-lines", mode.ui);
		execution.setComplete(0, false, { output });
		mode.chatContainer.addChild(execution);
		mode.ui.requestRender(true);
		await term.waitForRender();

		// The collapsed preview contains only the tail, so the first line starts hidden.
		expect(plainRows(term.getScrollBuffer()).some(row => row.includes(firstOutputMarker))).toBe(false);

		// Ctrl+O expands the block beyond the viewport. Capacity pressure retires it
		// into native scrollback, reproducing the boundary where a normal repaint can
		// no longer rewrite its rows.
		term.sendInput("\x0f");
		const committedRows = () => {
			const { baseY } = term.getBufferPosition();
			return plainRows(term.getScrollBuffer()).slice(0, baseY);
		};
		for (let frame = 0; frame < 20 && !committedRows().some(row => row.includes(firstOutputMarker)); frame++) {
			mode.ui.requestRender(true);
			await term.waitForRender();
		}
		expect(committedRows().some(row => row.includes(firstOutputMarker))).toBe(true);

		// A second Ctrl+O must collapse the complete transcript, including rows that
		// left the active viewport during expansion.
		term.sendInput("\x0f");
		await term.waitForRender();
		expect(plainRows(term.getScrollBuffer()).some(row => row.includes(firstOutputMarker))).toBe(false);
	});
});
