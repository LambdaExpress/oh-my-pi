import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "final answer" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		...overrides,
	};
}

function createFixture(opts: {
	streamingMessage: AssistantMessage;
	needsFinalScrollbackReset: boolean;
	isTtsrAbortPending?: boolean;
	retryAttempt?: number;
}) {
	const updateContent = vi.fn();
	const setComplete = vi.fn();
	const markTranscriptBlockFinalized = vi.fn();
	const needsFinalScrollbackReset = vi.fn(() => opts.needsFinalScrollbackReset);
	const setHideThinkingBlock = vi.fn();
	const streamingComponent = {
		updateContent,
		setComplete,
		markTranscriptBlockFinalized,
		needsFinalScrollbackReset,
		setHideThinkingBlock,
	};
	const requestRender = vi.fn();
	const requestComponentRender = vi.fn();
	const refreshDisplay = vi.fn();
	const resetDisplay = vi.fn();
	const addChild = vi.fn();

	const sessionMock = {
		isTtsrAbortPending: opts.isTtsrAbortPending ?? false,
		retryAttempt: opts.retryAttempt ?? 0,
	};
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		settings,
		ui: { requestRender, requestComponentRender, refreshDisplay, resetDisplay },
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		streamingComponent,
		streamingMessage: opts.streamingMessage,
		transcriptMessageComponents: new WeakMap(),
		chatContainer: { addChild, children: [] },
		pendingTools: new Map(),
		noteDisplayableThinkingContent: vi.fn(() => false),
		effectiveHideThinkingBlock: false,
		showPinnedError: vi.fn(),
		clearTransientSessionUi: vi.fn(),
		session: sessionMock,
		viewSession: sessionMock,
	} as unknown as InteractiveModeContext;

	const controller = new EventController(ctx);
	return {
		controller,
		ctx,
		streamingComponent,
		requestRender,
		refreshDisplay,
		resetDisplay,
		addChild,
	};
}

async function dispatchMessageEnd(controller: EventController, message: AssistantMessage): Promise<void> {
	await controller.handleEvent({ type: "message_end", message } as Extract<
		AgentSessionEvent,
		{ type: "message_end" }
	>);
}

beforeAll(async () => {
	await initTheme();
});

describe("EventController message_end final refresh", () => {
	beforeEach(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
	});

	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("uses a non-destructive final refresh when the assistant component needs final scrollback reset", async () => {
		const message = makeAssistantMessage();
		const { controller, streamingComponent, requestRender, refreshDisplay, resetDisplay } = createFixture({
			streamingMessage: message,
			needsFinalScrollbackReset: true,
		});

		await dispatchMessageEnd(controller, message);

		expect(streamingComponent.markTranscriptBlockFinalized).toHaveBeenCalledTimes(1);
		expect(refreshDisplay).toHaveBeenCalledTimes(1);
		expect(refreshDisplay).toHaveBeenCalledWith("assistant-final-scrollback-reset");
		expect(resetDisplay).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("uses the ordinary render path when no final scrollback reset is needed", async () => {
		const message = makeAssistantMessage();
		const { controller, streamingComponent, requestRender, refreshDisplay, resetDisplay } = createFixture({
			streamingMessage: message,
			needsFinalScrollbackReset: false,
		});

		await dispatchMessageEnd(controller, message);

		expect(streamingComponent.markTranscriptBlockFinalized).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalled();
		expect(refreshDisplay).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("keeps the final-refresh path non-destructive after adding a billed usage row", async () => {
		settings.set("display.showTokenUsage", true);
		const message = makeAssistantMessage({
			usage: {
				input: 0,
				output: 42,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 42,
				cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, total: 1 },
			},
			duration: 1200,
			ttft: 150,
		});
		const { controller, requestRender, refreshDisplay, resetDisplay, addChild } = createFixture({
			streamingMessage: message,
			needsFinalScrollbackReset: true,
		});

		await dispatchMessageEnd(controller, message);

		expect(addChild).toHaveBeenCalledTimes(1);
		expect(refreshDisplay).toHaveBeenCalledTimes(1);
		expect(refreshDisplay).toHaveBeenCalledWith("assistant-final-scrollback-reset");
		expect(resetDisplay).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
	});
});
