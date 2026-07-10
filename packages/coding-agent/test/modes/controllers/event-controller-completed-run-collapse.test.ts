import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { collapseCompletedRuns } from "@oh-my-pi/pi-coding-agent/modes/utils/transcript-render-helpers";
import { Text } from "@oh-my-pi/pi-tui";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(text: string, stopReason: AssistantMessage["stopReason"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage,
		stopReason,
		timestamp,
	};
}

function fixture(collapseCompletedRuns = true) {
	const settings = Settings.isolated({
		"display.collapseCompletedRuns": collapseCompletedRuns,
		"completion.notify": "off",
	});
	const recordCompletedRunCollapse = vi.fn();
	const rebuildChatFromMessages = vi.fn();
	const resetDisplay = vi.fn();
	const requestRender = vi.fn();
	const chatContainer = new TranscriptContainer();
	const session = { isStreaming: false };
	const ctx = {
		isInitialized: true,
		settings,
		session,
		viewSession: session,
		statusLine: { markActivityStart: vi.fn(), markActivityEnd: vi.fn(), invalidate: vi.fn() },
		ui: { requestRender, requestComponentRender: vi.fn(), resetDisplay },
		chatContainer,
		statusContainer: { disposeChildren: vi.fn() },
		pendingTools: new Map(),
		clearPinnedError: vi.fn(),
		ensureLoadingAnimation: vi.fn(),
		flushPendingModelSwitch: vi.fn(async () => {}),
		recordCompletedRunCollapse,
		rebuildChatFromMessages,
		getUserMessageText: (message: AgentMessage) =>
			message.role === "user" && typeof message.content === "string" ? message.content : "",
		addMessageToChat: vi.fn((message: AgentMessage) => {
			if (message.role !== "user") return [];
			const component = new Text("user");
			chatContainer.addChild(component);
			return [component];
		}),
		locallySubmittedUserSignatures: new Set(),
		optimisticUserMessageSignature: undefined,
		clearOptimisticUserMessage: vi.fn(),
		replaceOptimisticUserMessage: vi.fn(),
		editor: { setText: vi.fn(), getText: () => "" },
		updatePendingMessagesDisplay: vi.fn(),
		setWorkingMessage: vi.fn(),
		showPinnedError: vi.fn(),
		noteDisplayableThinkingContent: vi.fn(() => false),
		effectiveHideThinkingBlock: false,
		toolOutputExpanded: false,
		sessionManager: { getCwd: () => process.cwd(), getSessionName: () => undefined },
	};
	return {
		controller: new EventController(ctx as never),
		chatContainer,
		recordCompletedRunCollapse,
		rebuildChatFromMessages,
		resetDisplay,
	};
}

beforeAll(async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

describe("completed run collapse", () => {
	it("is disabled by default", () => {
		expect(Settings.isolated().get("display.collapseCompletedRuns")).toBe(false);
	});

	it("does not install a transcript gate while disabled", async () => {
		const { controller, chatContainer } = fixture(false);
		const initial = { role: "user", content: "build it", timestamp: 0 } as AgentMessage;
		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent({ type: "message_start", message: initial });
		chatContainer.render(80);
		expect(chatContainer.getNativeScrollbackLiveRegionStart()).toBeUndefined();
	});
	it("projects a completed run to the initial request and text-only final answer", () => {
		const initial = { role: "user", content: "build it", timestamp: 1 } as const;
		const loop = assistant("working", "toolUse", 2);
		loop.content.push({ type: "toolCall", id: "tc", name: "read", arguments: {} });
		const result = {
			role: "toolResult",
			toolCallId: "tc",
			toolName: "read",
			content: [{ type: "text", text: "data" }],
			timestamp: 3,
		} as AgentMessage;
		const steer = { role: "user", content: "adjust it", steering: true, timestamp: 4 } as AgentMessage;
		const followUp = { role: "user", content: "one more adjustment", timestamp: 5 } as AgentMessage;
		const final = assistant("done", "stop", 6);
		final.content.unshift({ type: "thinking", thinking: "private path" });
		const source = [initial, loop, result, steer, followUp, final] as AgentMessage[];
		const context = {
			messages: source,
			models: {},
			injectedTtsrRules: [],
			selectedMCPToolNames: [],
			hasPersistedMCPToolSelection: false,
			mode: "none",
		};
		const projected = collapseCompletedRuns(context, [
			{ firstMessage: initial, initialUserMessage: initial, finalAssistantMessage: final },
		]);
		expect(projected.messages.map(message => message.role)).toEqual(["user", "assistant"]);
		expect(projected.messages[0]).toBe(initial);
		expect((projected.messages[1] as AssistantMessage).content).toEqual([{ type: "text", text: "done" }]);
		expect(source).toHaveLength(6);
		expect(final.content).toHaveLength(2);
	});

	it("triggers collapse only after a normal final stop", async () => {
		const { controller, chatContainer, recordCompletedRunCollapse, rebuildChatFromMessages, resetDisplay } =
			fixture();
		const initial = { role: "user", content: "build it", timestamp: 10 } as AgentMessage;
		const adjustment = { role: "user", content: "adjust it", steering: true, timestamp: 11 } as AgentMessage;
		const followUp = { role: "user", content: "one more adjustment", timestamp: 12 } as AgentMessage;
		const final = assistant("done", "stop", 13);
		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent({ type: "message_start", message: initial });
		// The initial request is finalizable, while the zero-row gate starts the
		// live region immediately after it so intermediate loops cannot commit.
		chatContainer.render(80);
		expect(chatContainer.getNativeScrollbackLiveRegionStart()).toBe(1);
		await controller.handleEvent({ type: "message_end", message: initial });
		await controller.handleEvent({ type: "message_end", message: adjustment });
		await controller.handleEvent({ type: "message_end", message: followUp });
		await controller.handleEvent({ type: "message_end", message: final });
		await controller.handleEvent({ type: "agent_end", messages: [initial, adjustment, followUp, final] });
		expect(recordCompletedRunCollapse).toHaveBeenCalledTimes(1);
		expect(rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("retains the full run after an abort", async () => {
		const { controller, chatContainer, recordCompletedRunCollapse, rebuildChatFromMessages, resetDisplay } =
			fixture();
		const initial = { role: "user", content: "build it", timestamp: 20 } as AgentMessage;
		const final = assistant("partial", "aborted", 21);
		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent({ type: "message_start", message: initial });
		await controller.handleEvent({ type: "message_end", message: initial });
		await controller.handleEvent({ type: "message_end", message: final });
		await controller.handleEvent({ type: "agent_end", messages: [initial, final] });
		chatContainer.render(80);
		expect(chatContainer.getNativeScrollbackLiveRegionStart()).toBeUndefined();
		expect(recordCompletedRunCollapse).not.toHaveBeenCalled();
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
	});
});
