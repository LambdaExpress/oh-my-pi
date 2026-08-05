/**
 * Contract: renderInitialMessages renders the live DISPLAY TRANSCRIPT according
 * to the configured compaction display policy. The transcript comes from
 * `viewSession.buildTranscriptSessionContext()`; `sessionManager.buildSessionContext()`
 * — the LLM-context builder — must not be consulted for display.
 *
 * Also guards the cold-launch terminal cleanup: `omp` / `omp -c` leave the
 * previous run's transcript in native scrollback because the TUI's initial
 * paint preserves it, so the cold-launch render must request a
 * scrollback-clearing repaint (`clearTerminalHistory`).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createCompactionSummaryMessage } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, Usage } from "@oh-my-pi/pi-ai";
import { kStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { StrippedToolCallsPlaceholder } from "@oh-my-pi/pi-coding-agent/modes/components/stripped-tool-calls-placeholder";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext, StrippedToolCallsMarker } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type Component, Container, Image, ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

interface DisplaySnapshotFixture {
	toolCallId: string;
	toolName: string;
	args: unknown;
	result?: {
		content: Array<{ type: string; text?: string }>;
		details?: unknown;
	};
	isPartial: boolean;
}

beforeAll(() => {
	initTheme();
});

beforeEach(async () => {
	// afterEach resets Settings, but renderInitialMessages reads the global
	// Settings (display.collapseCompacted) — re-init before every test.
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

const originalImageProtocol = TERMINAL.imageProtocol;

afterEach(() => {
	resetSettingsForTest();
	setTerminalImageProtocol(originalImageProtocol);
	vi.restoreAllMocks();
});

function makeEmptyContext(): SessionContext {
	return {
		messages: [],
		thinkingLevel: "off",
		serviceTier: undefined,
		models: {},
		injectedTtsrRules: [],
		mode: "none",
	};
}

/** Build a minimal InteractiveModeContext mock, returning spies for assertions. */
function makeCtx(): {
	ctx: InteractiveModeContext;
	transcriptSpy: Mock<(options?: { collapseCompactedHistory?: boolean }) => SessionContext>;
	llmContextSpy: Mock<() => SessionContext>;
	renderSessionContextSpy: Mock<(...args: unknown[]) => void>;
} {
	const transcriptSpy = vi.fn(() => makeEmptyContext());
	const unusedPrimarySessionTranscriptSpy = vi.fn(() => makeEmptyContext());
	const llmContextSpy = vi.fn(() => makeEmptyContext());
	const renderSessionContextSpy = vi.fn();

	const ctx = {
		chatContainer: { clear: vi.fn(), addChild: vi.fn() },
		pendingMessagesContainer: { clear: vi.fn(), disposeChildren: vi.fn() },
		pendingBashComponents: [],
		pendingPythonComponents: [],
		session: { buildTranscriptSessionContext: unusedPrimarySessionTranscriptSpy },
		viewSession: {
			buildTranscriptSessionContext: transcriptSpy,
			sessionManager: {
				buildSessionContext: llmContextSpy,
				getEntries: vi.fn(() => []),
				getCwd: vi.fn(() => "/tmp"),
			},
		},
		sessionManager: {
			buildSessionContext: llmContextSpy,
			getEntries: vi.fn(() => []),
			getCwd: vi.fn(() => "/tmp"),
		},
		renderSessionContext: renderSessionContextSpy,
		showStatus: vi.fn(),
		ui: { requestRender: vi.fn() },
		resetTranscript: () => ctx.chatContainer.clear(),
	} as unknown as InteractiveModeContext;

	return { ctx, transcriptSpy, llmContextSpy, renderSessionContextSpy };
}

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const pngImage: ImageContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
	mimeType: "image/png",
};

function assistantToolCall(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet",
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function transcriptWith(messages: AgentMessage[]): SessionContext {
	return { ...makeEmptyContext(), messages };
}

function countImageComponents(component: Component): number {
	const own = component instanceof Image ? 1 : 0;
	if (!("children" in component) || !Array.isArray(component.children)) return own;
	return own + component.children.reduce((count, child) => count + countImageComponents(child), 0);
}

function hasImageComponent(component: Component): boolean {
	return countImageComponents(component) > 0;
}

function makeRenderCtx(
	transcript: SessionContext | ((options?: { collapseCompactedHistory?: boolean }) => SessionContext),
	showImages = true,
	hideToolActivity = false,
	toolExecutionDisplaySnapshots: ReadonlyMap<string, DisplaySnapshotFixture> = new Map(),
): { ctx: InteractiveModeContext; chatContainer: Container } {
	const chatContainer = new Container();
	const buildTranscriptSessionContext = typeof transcript === "function" ? transcript : () => transcript;
	const putBlobSync = vi.fn(() => ({
		hash: "hash",
		path: "/tmp/hash",
		displayPath: "/tmp/hash.png",
		ref: "blob:sha256:hash",
	}));
	let helpers: UiHelpers;
	const ctx = {
		chatContainer,
		pendingMessagesContainer: new Container(),
		pendingBashComponents: [],
		pendingPythonComponents: [],
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		updateEditorTopBorder: vi.fn(),
		ui: { requestRender: vi.fn(), imageBudget: undefined },
		resetTranscript: () => chatContainer.clear(),
		// Rebuild paths honor terminal.showImages since the native-image work;
		// keep it on so the image-replay contracts below stay meaningful.
		settings: {
			get: (key: string) => {
				if (key === "terminal.showImages") return showImages;
				if (key === "display.hideToolActivity") return hideToolActivity;
				return false;
			},
		},
		toolOutputExpanded: false,
		hideToolActivity,
		hideThinkingBlock: false,
		focusedAgentId: undefined,
		editor: { addToHistory: vi.fn() },
		viewSession: {
			buildTranscriptSessionContext,
			getToolByName: () => undefined,
			getToolExecutionDisplaySnapshots: () => toolExecutionDisplaySnapshots,
			extensionRunner: undefined,
			sessionManager: {
				getEntries: vi.fn(() => []),
				getCwd: vi.fn(() => "/tmp"),
				putBlobSync,
			},
		},
		sessionManager: {
			getEntries: vi.fn(() => []),
			getCwd: vi.fn(() => "/tmp"),
			putBlobSync,
		},
		getUserMessageText: (message: AgentMessage) => {
			if (message.role !== "user" && message.role !== "developer") return "";
			const content = message.content;
			if (typeof content === "string") return content;
			return content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map(block => block.text)
				.join("\n");
		},
		addMessageToChat: (message: AgentMessage, options?: { populateHistory?: boolean }) =>
			helpers.addMessageToChat(message, options),
		renderSessionContext: (
			context: SessionContext,
			options?: { updateFooter?: boolean; populateHistory?: boolean },
		) => helpers.renderSessionContext(context, options),
		showStatus: vi.fn(),
	} as unknown as InteractiveModeContext;
	helpers = new UiHelpers(ctx);
	return { ctx, chatContainer };
}

describe("UiHelpers.renderInitialMessages — transcript source", () => {
	it("renders the collapsed live display transcript, never the LLM context", async () => {
		await Settings.init({ inMemory: true });
		const { ctx, transcriptSpy, llmContextSpy, renderSessionContextSpy } = makeCtx();
		const transcript = makeEmptyContext();
		transcriptSpy.mockReturnValue(transcript);

		new UiHelpers(ctx).renderInitialMessages();

		expect(transcriptSpy).toHaveBeenCalledTimes(1);
		const [transcriptOptions] = transcriptSpy.mock.calls[0] ?? [];
		expect(transcriptOptions?.collapseCompactedHistory).toBe(true);
		expect(llmContextSpy).not.toHaveBeenCalled();
		expect(renderSessionContextSpy).toHaveBeenCalledWith(transcript, {
			updateFooter: true,
			populateHistory: true,
		});
	});

	it("keeps pre-compaction display history visible when collapsing is disabled", () => {
		Settings.instance.set("display.collapseCompacted", false);
		const compactionSummary = createCompactionSummaryMessage(
			"Earlier work was summarized for the provider.",
			12345,
			new Date(0).toISOString(),
		);
		const fullDisplayTranscript = transcriptWith([
			{ role: "user", content: "pre-compaction user request must remain scrollable", timestamp: 1 },
			compactionSummary,
			{ role: "user", content: "post-compaction follow-up remains visible", timestamp: 2 },
		]);
		const collapsedTranscript = transcriptWith([
			compactionSummary,
			{ role: "user", content: "post-compaction follow-up remains visible", timestamp: 2 },
		]);
		const buildTranscriptSessionContext = vi.fn((options?: { collapseCompactedHistory?: boolean }) =>
			options?.collapseCompactedHistory ? collapsedTranscript : fullDisplayTranscript,
		);
		const { ctx, chatContainer } = makeRenderCtx(buildTranscriptSessionContext);

		new UiHelpers(ctx).renderInitialMessages();

		const rendered = Bun.stripANSI(chatContainer.render(100).join("\n"));
		expect(rendered).toContain("pre-compaction user request must remain scrollable");
		expect(rendered).toContain("compacted");
		expect(rendered).toContain("post-compaction follow-up remains visible");
	});
});

describe("UiHelpers.renderInitialMessages — clearTerminalHistory", () => {
	it("requests a scrollback-clearing repaint when clearTerminalHistory is set", async () => {
		await Settings.init({ inMemory: true });
		const { ctx } = makeCtx();
		new UiHelpers(ctx).renderInitialMessages({ clearTerminalHistory: true });
		expect(ctx.ui.requestRender).toHaveBeenCalledWith(true, { clearScrollback: true });
	});

	it("never clears scrollback when clearTerminalHistory is unset", async () => {
		await Settings.init({ inMemory: true });
		const { ctx } = makeCtx();
		new UiHelpers(ctx).renderInitialMessages();
		const clearedCall = (ctx.ui.requestRender as Mock<(...a: unknown[]) => void>).mock.calls.find(
			([force, opts]) => force === true && (opts as { clearScrollback?: boolean } | undefined)?.clearScrollback,
		);
		expect(clearedCall).toBeUndefined();
	});
});

describe("UiHelpers.renderInitialMessages — image replay", () => {
	it("restores read tool image blocks onto the rebuilt assistant transcript", async () => {
		await Settings.init({ inMemory: true, overrides: { "terminal.showImages": true } });
		setTerminalImageProtocol(ImageProtocol.Sixel);
		const transcript = transcriptWith([
			assistantToolCall("read-image", "read", { path: "sample.png" }),
			{
				role: "toolResult",
				toolCallId: "read-image",
				toolName: "read",
				content: [{ type: "text", text: "Read image: sample.png" }, pngImage],
				isError: false,
				timestamp: 2,
			},
		]);
		const { ctx, chatContainer } = makeRenderCtx(transcript);

		new UiHelpers(ctx).renderInitialMessages();

		expect(hasImageComponent(chatContainer)).toBe(true);
		expect(Bun.stripANSI(chatContainer.render(100).join("\n"))).toContain("Read sample.png");
	});

	it("restores eval display image blocks onto rebuilt tool output", async () => {
		await Settings.init({ inMemory: true, overrides: { "terminal.showImages": true } });
		setTerminalImageProtocol(ImageProtocol.Sixel);
		const transcript = transcriptWith([
			assistantToolCall("eval-image", "eval", { language: "py", code: "display(image)" }),
			{
				role: "toolResult",
				toolCallId: "eval-image",
				toolName: "eval",
				content: [{ type: "text", text: "(displayed 1 image; no text output)" }, pngImage],
				details: {
					language: "python",
					cells: [{ index: 0, code: "display(image)", output: "display image 1: 1x1", status: "complete" }],
				},
				isError: false,
				timestamp: 2,
			},
		]);

		const { ctx, chatContainer } = makeRenderCtx(transcript);

		new UiHelpers(ctx).renderInitialMessages();

		expect(hasImageComponent(chatContainer)).toBe(true);
		expect(Bun.stripANSI(chatContainer.render(100).join("\n"))).toContain("display image 1: 1x1");
	});

	it("preserves hidden read images so enabling them later can replay the image", async () => {
		await Settings.init({ inMemory: true, overrides: { "terminal.showImages": false } });
		setTerminalImageProtocol(ImageProtocol.Sixel);
		const transcript = transcriptWith([
			assistantToolCall("read-hidden", "read", { path: "hidden.png" }),
			{
				role: "toolResult",
				toolCallId: "read-hidden",
				toolName: "read",
				content: [{ type: "text", text: "Read image: hidden.png" }, pngImage],
				isError: false,
				timestamp: 2,
			},
		]);
		const { ctx, chatContainer } = makeRenderCtx(transcript, false);

		new UiHelpers(ctx).renderInitialMessages();

		expect(hasImageComponent(chatContainer)).toBe(false);
		const assistant = chatContainer.children.find(
			(child): child is AssistantMessageComponent => child instanceof AssistantMessageComponent,
		);
		expect(assistant).toBeDefined();
		assistant?.setImagesVisible(true);
		expect(hasImageComponent(chatContainer)).toBe(true);
	});

	it("preserves tool-result images while tool activity is hidden so revealing it can replay the image", async () => {
		await Settings.init({ inMemory: true, overrides: { "terminal.showImages": true } });
		setTerminalImageProtocol(ImageProtocol.Sixel);
		const transcript = transcriptWith([
			assistantToolCall("read-tool-hidden", "read", { path: "tool-hidden.png" }),
			{
				role: "toolResult",
				toolCallId: "read-tool-hidden",
				toolName: "read",
				content: [{ type: "text", text: "Read image: tool-hidden.png" }, pngImage],
				isError: false,
				timestamp: 2,
			},
		]);
		const { ctx, chatContainer } = makeRenderCtx(transcript, true, true);

		new UiHelpers(ctx).renderInitialMessages();

		expect(hasImageComponent(chatContainer)).toBe(false);
		const assistant = chatContainer.children.find(
			(child): child is AssistantMessageComponent => child instanceof AssistantMessageComponent,
		);
		expect(assistant).toBeDefined();
		assistant?.setToolResultImagesVisible(true);
		expect(hasImageComponent(chatContainer)).toBe(true);
	});

	it("replays reopened session image blocks through the cold-start rebuild path", async () => {
		await Settings.init({ inMemory: true, overrides: { "terminal.showImages": true } });
		setTerminalImageProtocol(ImageProtocol.Sixel);
		using tempDir = TempDir.createSync("@pi-render-initial-image-replay-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage(assistantToolCall("read-reopened", "read", { path: "reopened.png" }));
		session.appendMessage({
			role: "toolResult",
			toolCallId: "read-reopened",
			toolName: "read",
			content: [{ type: "text", text: "Read image: reopened.png" }, pngImage],
			isError: false,
			timestamp: 2,
		});
		session.appendMessage(assistantToolCall("eval-reopened", "eval", { language: "py", code: "display(image)" }));
		session.appendMessage({
			role: "toolResult",
			toolCallId: "eval-reopened",
			toolName: "eval",
			content: [{ type: "text", text: "(displayed 1 image; no text output)" }, pngImage],
			details: {
				language: "python",
				cells: [{ index: 0, code: "display(image)", output: "display image 1: 1x1", status: "complete" }],
			},
			isError: false,
			timestamp: 4,
		});
		await session.flush();
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		const reloaded = await SessionManager.open(sessionFile);
		const transcript = reloaded.buildSessionContext({ transcript: true });
		const { ctx, chatContainer } = makeRenderCtx(transcript);

		new UiHelpers(ctx).renderInitialMessages({ clearTerminalHistory: true });

		expect(countImageComponents(chatContainer)).toBe(2);
		expect(Bun.stripANSI(chatContainer.render(100).join("\n"))).toContain("Read reopened.png");
		expect(ctx.ui.requestRender).toHaveBeenCalledWith(true, { clearScrollback: true });
	});
});

describe("UiHelpers.renderInitialMessages — hidden tool activity", () => {
	it("hides replayed tool cards without discarding them from the persisted transcript", () => {
		const toolCallId = "replayed-hidden-tool";
		const toolArgumentMarker = "REPLAYED TOOL ARGUMENT MARKER";
		const toolResultMarker = "REPLAYED TOOL RESULT MARKER";
		const narrationMarker = "ASSISTANT NARRATION STAYS VISIBLE";
		const finalMarker = "FINAL ASSISTANT RESPONSE STAYS VISIBLE";
		const transcript = transcriptWith([
			{
				...assistantToolCall(toolCallId, "contract_probe", { value: toolArgumentMarker }),
				content: [
					{ type: "text", text: narrationMarker },
					{ type: "toolCall", id: toolCallId, name: "contract_probe", arguments: { value: toolArgumentMarker } },
				],
			},
			{
				role: "toolResult",
				toolCallId,
				toolName: "contract_probe",
				content: [{ type: "text", text: toolResultMarker }],
				isError: false,
				timestamp: 2,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: finalMarker }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet",
				usage: emptyUsage,
				stopReason: "stop",
				timestamp: 3,
			},
		]);

		const hidden = makeRenderCtx(transcript, true, true);
		new UiHelpers(hidden.ctx).renderInitialMessages();
		const hiddenRender = Bun.stripANSI(hidden.chatContainer.render(120).join("\n"));
		expect(hiddenRender).toContain(narrationMarker);
		expect(hiddenRender).toContain(finalMarker);
		expect(hiddenRender).not.toContain(toolArgumentMarker);
		expect(hiddenRender).not.toContain(toolResultMarker);

		const visible = makeRenderCtx(transcript, true, false);
		new UiHelpers(visible.ctx).renderInitialMessages();
		const visibleRender = Bun.stripANSI(visible.chatContainer.render(120).join("\n"));
		expect(visibleRender).toContain(toolArgumentMarker);
		expect(visibleRender).toContain(toolResultMarker);
	});

	it("hides the stripped-tool-calls placeholder with tool activity and restores it on reveal", () => {
		const strippedAssistant: AgentMessage & StrippedToolCallsMarker = {
			role: "assistant",
			content: [{ type: "text", text: "narration" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage: emptyUsage,
			stopReason: "stop",
			timestamp: 1,
			strippedToolCalls: 2,
		};
		const transcript = transcriptWith([strippedAssistant]);

		const hidden = makeRenderCtx(transcript, true, true);
		new UiHelpers(hidden.ctx).renderInitialMessages();
		expect(Bun.stripANSI(hidden.chatContainer.render(120).join("\n"))).not.toContain(
			"elided — no result on this branch",
		);

		// A live reveal must restore the placeholder without a transcript rebuild.
		for (const child of hidden.chatContainer.children) {
			if (child instanceof StrippedToolCallsPlaceholder) child.setToolActivityVisible(true);
		}
		expect(Bun.stripANSI(hidden.chatContainer.render(120).join("\n"))).toContain(
			"2 tool calls elided — no result on this branch",
		);
	});
});

describe("UiHelpers.renderSessionContext — error-stop tool calls", () => {
	it("keeps the synthetic assistant error result instead of replaying a later tool result", async () => {
		await Settings.init({ inMemory: true });
		const transcript = transcriptWith([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "error-tool",
						name: "eval",
						arguments: { language: "py", code: "raise RuntimeError('boom')" },
					},
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet",
				usage: emptyUsage,
				stopReason: "error",
				errorMessage: "synthetic assistant stop error",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "error-tool",
				toolName: "eval",
				content: [{ type: "text", text: "late tool result must not replace the assistant stop error" }],
				isError: false,
				timestamp: 2,
			},
		]);
		const { ctx, chatContainer } = makeRenderCtx(transcript);

		new UiHelpers(ctx).renderInitialMessages();

		const rendered = Bun.stripANSI(chatContainer.render(120).join("\n"));
		expect(rendered).toContain("synthetic assistant stop error");
		expect(rendered).not.toContain("late tool result must not replace the assistant stop error");
	});
});

describe("UiHelpers.renderSessionContext — mid-stream tool call rebuild", () => {
	it("decodes streamed write content from partialJson, not the provider's stale parsed arguments", async () => {
		// A transcript rebuild (theme change, settings edit, focus replay) can land
		// while a write's args still stream. The provider re-parses `arguments`
		// only every STREAMING_JSON_PARSE_MIN_GROWTH bytes, so the parsed snapshot
		// lags the raw buffer. The rebuilt preview must decode from the buffer —
		// exactly like the live reveal path — or the write body freezes at the
		// last throttled parse until more bytes arrive.
		await Settings.init({ inMemory: true });
		const staleContent = "line one of the streamed write";
		const grownBuffer = `{"path":"/tmp/mid.ts","content":"${staleContent}\\nGROWN_TAIL_SENTINEL`;
		const transcript = transcriptWith([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "write-mid",
						name: "write",
						// Provider-parsed snapshot from BEFORE the buffer grew.
						arguments: { path: "/tmp/mid.ts", content: staleContent },
						[kStreamingPartialJson]: grownBuffer,
					},
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet",
				usage: emptyUsage,
				stopReason: "toolUse",
				timestamp: 1,
			},
		]);
		const { ctx, chatContainer } = makeRenderCtx(transcript);

		new UiHelpers(ctx).renderInitialMessages();

		const rendered = Bun.stripANSI(chatContainer.render(120).join("\n"));
		expect(rendered).toContain("GROWN_TAIL_SENTINEL");
	});
});
describe("UiHelpers.renderSessionContext — active tool restoration", () => {
	it("restores a running Task snapshot and keeps it attached for later progress", async () => {
		await Settings.init({ inMemory: true });
		const toolCallId = "task-focus-return";
		const taskArgs = {
			context: "# Goal\nInvestigate the focused-session rebuild.",
			tasks: [
				{
					id: "FocusResearch",
					role: "Researcher",
					assignment: "# Target\nTrace the running Task.",
				},
			],
			agent: "scout",
		};
		const progress = {
			index: 0,
			id: "FocusResearch",
			agent: "scout",
			agentSource: "bundled" as const,
			status: "running" as const,
			task: "Trace the running Task.",
			assignment: "# Target\nTrace the running Task.",
			recentTools: [],
			recentOutput: [],
			toolCount: 4,
			requests: 7,
			tokens: 0,
			contextTokens: 39_060,
			contextWindow: 372_000,
			cost: 0.44,
			durationMs: 1_000,
		};
		const details = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: [progress],
		};
		const snapshots = new Map<string, DisplaySnapshotFixture>([
			[
				toolCallId,
				{
					toolCallId,
					toolName: "task",
					args: taskArgs,
					result: { content: [{ type: "text", text: "running" }], details },
					isPartial: true,
				},
			],
		]);
		const transcript = transcriptWith([assistantToolCall(toolCallId, "task", taskArgs)]);
		const { ctx, chatContainer } = makeRenderCtx(transcript, true, false, snapshots);

		new UiHelpers(ctx).renderInitialMessages({ clearTerminalHistory: true });

		const restored = ctx.pendingTools.get(toolCallId);
		expect(restored).toBeDefined();
		expect(Bun.stripANSI(chatContainer.render(120).join("\n"))).toContain("7 req");

		restored?.updateResult(
			{
				content: [{ type: "text", text: "still running" }],
				details: { ...details, progress: [{ ...progress, requests: 8 }] },
			},
			true,
			toolCallId,
		);
		expect(Bun.stripANSI(chatContainer.render(120).join("\n"))).toContain("8 req");

		restored?.updateResult(
			{
				content: [{ type: "text", text: "finished" }],
				details: {
					projectAgentsDir: null,
					results: [
						{
							index: 0,
							id: "FocusResearch",
							agent: "scout",
							agentSource: "bundled",
							task: "Trace the running Task.",
							exitCode: 0,
							output: "focus restoration complete",
							stderr: "",
							truncated: false,
							durationMs: 2_000,
							tokens: 0,
							requests: 8,
						},
					],
					totalDurationMs: 2_000,
				},
			},
			false,
			toolCallId,
		);
		expect(Bun.stripANSI(chatContainer.render(120).join("\n"))).toContain("1 succeeded");
	});
});
