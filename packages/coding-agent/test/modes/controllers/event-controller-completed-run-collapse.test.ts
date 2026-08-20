import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import {
	type CompletedRunCollapse,
	collapseCompletedRuns,
} from "@oh-my-pi/pi-coding-agent/modes/utils/transcript-render-helpers";
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

function fixture(
	collapseCompletedRuns = true,
	waitForMessagePersistence = vi.fn(async () => {}),
	recoverCompletedRunCollapses = vi.fn(() => false),
) {
	const settings = Settings.isolated({
		"display.collapseCompletedRuns": collapseCompletedRuns,
		"completion.notify": "off",
	});
	const recordCompletedRunCollapse = vi.fn();
	const rebuildChatFromMessages = vi.fn();
	const resetDisplay = vi.fn();
	const requestRender = vi.fn();
	const chatContainer = new TranscriptContainer();
	const session = {
		isStreaming: false,
		queuedUserMessageCount: 0,
		waitForMessagePersistence,
		// Set by the Enter force-flush path (input-controller) before aborting the
		// active run; survives the queue drain so the interrupted run's span can be
		// parked instead of destroyed when the queue is already empty by the time
		// the stale agent_end reaches the controller.
		forceFlushPending: false,
		clearForceFlushPending: () => {
			session.forceFlushPending = false;
		},
	};
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
		flushPendingCommandOutput: vi.fn(),
		recordCompletedRunCollapse,
		recoverCompletedRunCollapses,
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
		session,
		chatContainer,
		recordCompletedRunCollapse,
		recoverCompletedRunCollapses,
		rebuildChatFromMessages,
		resetDisplay,
		waitForMessagePersistence,
	};
}

beforeAll(async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

afterEach(() => vi.restoreAllMocks());

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

	it("does not recover future persisted runs while handling agent_start", async () => {
		const recoverCompletedRunCollapses = vi.fn(() => true);
		const { controller, rebuildChatFromMessages, resetDisplay } = fixture(
			true,
			vi.fn(async () => {}),
			recoverCompletedRunCollapses,
		);

		await controller.handleEvent({ type: "agent_start" });

		expect(recoverCompletedRunCollapses).not.toHaveBeenCalled();
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
		expect(controller.commitCompletedRunCollapses({ rebuild: false })).toBe(true);
		expect(recoverCompletedRunCollapses).toHaveBeenCalledWith({ includeLatest: true });
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
			mode: "none",
		};
		const projection = collapseCompletedRuns(context, [
			{ firstMessage: initial, initialUserMessage: initial, finalAssistantMessage: final, durationMs: 65_000 },
		]);
		expect(projection.context.messages.map(message => message.role)).toEqual(["user", "assistant"]);
		expect(projection.context.messages[0]).toBe(initial);
		expect((projection.context.messages[1] as AssistantMessage).content).toEqual([{ type: "text", text: "done" }]);
		expect(projection.summaries).toEqual([
			{ afterMessage: initial, agentTextSegments: 1, toolCalls: 1, durationMs: 65_000 },
		]);
		expect(source).toHaveLength(6);
		expect(final.content).toHaveLength(2);
	});

	it("defers the collapse until the user sends the next content", async () => {
		const { controller, chatContainer, recordCompletedRunCollapse, rebuildChatFromMessages, resetDisplay } =
			fixture();
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
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
		now.mockReturnValue(66_000);
		await controller.handleEvent({ type: "agent_end", messages: [initial, adjustment, followUp, final] });
		// The run stays fully expanded while the answer is on screen: the end of
		// the model's final text alone does not commit the collapse.
		expect(recordCompletedRunCollapse).not.toHaveBeenCalled();
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
		// Sending the next content starts a new turn, which commits the collapse.
		await controller.handleEvent({ type: "agent_start" });
		expect(recordCompletedRunCollapse).toHaveBeenCalledTimes(1);
		expect(recordCompletedRunCollapse).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 65_000 }));
		expect(rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("collapses a naturally completed turn when a queued follow-up starts in the same agent lifecycle", async () => {
		const persisted = Promise.withResolvers<void>();
		const waitForMessagePersistence = vi.fn(() => persisted.promise);
		const { controller, recordCompletedRunCollapse, rebuildChatFromMessages, resetDisplay } = fixture(
			true,
			waitForMessagePersistence,
		);
		const initial = { role: "user", content: "explain the modes", timestamp: 10 } as AgentMessage;
		const final = assistant("first answer", "stop", 11);
		const followUp = { role: "user", content: "now fix the bug", timestamp: 12 } as AgentMessage;

		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent({ type: "message_start", message: initial });
		await controller.handleEvent({ type: "message_end", message: initial });
		await controller.handleEvent({ type: "message_end", message: final });

		// Agent-core drains Ctrl+Up follow-ups without emitting another agent_start.
		// The follow-up user message itself is therefore the completed-turn boundary.
		const startingFollowUp = controller.handleEvent({ type: "message_start", message: followUp });
		await Promise.resolve();
		expect(waitForMessagePersistence).toHaveBeenCalledWith(final);
		expect(recordCompletedRunCollapse).not.toHaveBeenCalled();
		persisted.resolve();
		await startingFollowUp;

		expect(recordCompletedRunCollapse).toHaveBeenCalledTimes(1);
		expect(recordCompletedRunCollapse).toHaveBeenCalledWith(
			expect.objectContaining({
				firstMessage: initial,
				initialUserMessage: initial,
				finalAssistantMessage: final,
			}),
		);
		expect(rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("lets an explicit visibility toggle claim a completed run without rebuilding twice", async () => {
		const { controller, recordCompletedRunCollapse, rebuildChatFromMessages, resetDisplay } = fixture();
		const initial = { role: "user", content: "build it", timestamp: 10 } as AgentMessage;
		const final = assistant("done", "stop", 11);
		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent({ type: "message_start", message: initial });
		await controller.handleEvent({ type: "message_end", message: initial });
		await controller.handleEvent({ type: "message_end", message: final });
		await controller.handleEvent({ type: "agent_end", messages: [initial, final] });

		expect(controller.commitCompletedRunCollapses({ rebuild: false })).toBe(true);
		expect(recordCompletedRunCollapse).toHaveBeenCalledTimes(1);
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("waits for a late final message_end before parking the completed run", async () => {
		const persisted = Promise.withResolvers<void>();
		const waitForMessagePersistence = vi.fn(() => persisted.promise);
		const { controller, recordCompletedRunCollapse, rebuildChatFromMessages, resetDisplay } = fixture(
			true,
			waitForMessagePersistence,
		);
		const initial = { role: "user", content: "build it", timestamp: 14 } as AgentMessage;
		const final = assistant("done", "stop", 15);
		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent({ type: "message_start", message: initial });
		await controller.handleEvent({ type: "message_end", message: initial });

		const ending = controller.handleEvent({ type: "agent_end", messages: [initial, final] });
		await Promise.resolve();
		expect(waitForMessagePersistence).toHaveBeenCalledWith(final);
		expect(recordCompletedRunCollapse).not.toHaveBeenCalled();

		await controller.handleEvent({ type: "message_end", message: final });
		persisted.resolve();
		await ending;

		expect(recordCompletedRunCollapse).not.toHaveBeenCalled();
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
		await controller.handleEvent({ type: "agent_start" });
		expect(recordCompletedRunCollapse).toHaveBeenCalledTimes(1);
		expect(rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("keeps the collapse span when a queued follow-up starts before the prior agent_end settles", async () => {
		const persisted = Promise.withResolvers<void>();
		const waitForMessagePersistence = vi.fn(() => persisted.promise);
		const { controller, session, recordCompletedRunCollapse } = fixture(true, waitForMessagePersistence);
		const initial = { role: "user", content: "build it", timestamp: 20 } as AgentMessage;
		const firstFinal = assistant("first answer", "stop", 21);
		const followUp = { role: "user", content: "also update the tests", timestamp: 22 } as AgentMessage;
		const final = assistant("updated answer", "stop", 23);

		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent({ type: "message_start", message: initial });
		await controller.handleEvent({ type: "message_end", message: initial });
		await controller.handleEvent({ type: "message_end", message: firstFinal });
		const firstEnding = controller.handleEvent({ type: "agent_end", messages: [initial, firstFinal] });
		await Promise.resolve();

		session.isStreaming = true;
		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent({ type: "message_start", message: followUp });
		await controller.handleEvent({ type: "message_end", message: followUp });
		persisted.resolve();
		await firstEnding;
		expect(recordCompletedRunCollapse).not.toHaveBeenCalled();

		await controller.handleEvent({ type: "message_end", message: final });
		session.isStreaming = false;
		await controller.handleEvent({ type: "agent_end", messages: [followUp, final] });
		expect(recordCompletedRunCollapse).not.toHaveBeenCalled();
		await controller.handleEvent({ type: "agent_start" });
		expect(recordCompletedRunCollapse).toHaveBeenCalledTimes(1);
		expect(recordCompletedRunCollapse).toHaveBeenCalledWith(
			expect.objectContaining({ initialUserMessage: initial, finalAssistantMessage: final }),
		);
	});

	it("keeps the original collapse span when a queued correction resumes a user interrupt", async () => {
		const { controller, session, recordCompletedRunCollapse } = fixture();
		const initial = { role: "user", content: "build it", timestamp: 24 } as AgentMessage;
		const interrupted = assistant("", "aborted", 25);
		interrupted.errorMessage = "Interrupted by user";
		const correction = {
			role: "user",
			content: "correct it",
			steering: true,
			timestamp: 26,
		} as AgentMessage;
		const final = assistant("done", "stop", 27);

		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent({ type: "message_start", message: initial });
		await controller.handleEvent({ type: "message_end", message: initial });
		await controller.handleEvent({ type: "message_end", message: interrupted });
		session.queuedUserMessageCount = 1;
		await controller.handleEvent({ type: "agent_end", messages: [initial, interrupted] });
		expect(recordCompletedRunCollapse).not.toHaveBeenCalled();

		session.isStreaming = true;
		await controller.handleEvent({ type: "agent_start" });
		session.queuedUserMessageCount = 0;
		await controller.handleEvent({ type: "message_start", message: correction });
		await controller.handleEvent({ type: "message_end", message: correction });
		await controller.handleEvent({ type: "message_end", message: final });
		session.isStreaming = false;
		await controller.handleEvent({ type: "agent_end", messages: [correction, final] });

		expect(recordCompletedRunCollapse).not.toHaveBeenCalled();
		await controller.handleEvent({ type: "agent_start" });
		expect(recordCompletedRunCollapse).toHaveBeenCalledTimes(1);
		expect(recordCompletedRunCollapse).toHaveBeenCalledWith(
			expect.objectContaining({ initialUserMessage: initial, finalAssistantMessage: final }),
		);
	});

	it("parks the interrupted run and collapses A and B with separate summaries after the force-flushed continuation settles", async () => {
		const { controller, session, recordCompletedRunCollapse, rebuildChatFromMessages, resetDisplay } = fixture();
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const initial = { role: "user", content: "build it", timestamp: 40 } as AgentMessage;
		const loopA1 = assistant("working", "toolUse", 41);
		loopA1.content.push({ type: "toolCall", id: "tc-a1", name: "read", arguments: {} });
		const resultA1 = {
			role: "toolResult",
			toolCallId: "tc-a1",
			toolName: "read",
			content: [{ type: "text", text: "data" }],
			timestamp: 42,
		} as AgentMessage;
		const loopA2 = assistant("", "toolUse", 43);
		loopA2.content.push({ type: "toolCall", id: "tc-a2", name: "grep", arguments: {} });
		const resultA2 = {
			role: "toolResult",
			toolCallId: "tc-a2",
			toolName: "grep",
			content: [{ type: "text", text: "hits" }],
			timestamp: 44,
		} as AgentMessage;
		const interrupted = assistant("", "aborted", 45);
		interrupted.errorMessage = "Interrupted by user";
		const steer = { role: "user", content: "adjust it", steering: true, timestamp: 46 } as AgentMessage;
		const loopB1 = assistant("working B", "toolUse", 47);
		loopB1.content.push({ type: "toolCall", id: "tc-b1", name: "read", arguments: {} });
		const resultB1 = {
			role: "toolResult",
			toolCallId: "tc-b1",
			toolName: "read",
			content: [{ type: "text", text: "data" }],
			timestamp: 48,
		} as AgentMessage;
		const loopB2 = assistant("", "toolUse", 49);
		loopB2.content.push({ type: "toolCall", id: "tc-b2", name: "edit", arguments: {} });
		const resultB2 = {
			role: "toolResult",
			toolCallId: "tc-b2",
			toolName: "edit",
			content: [{ type: "text", text: "done" }],
			timestamp: 50,
		} as AgentMessage;
		const finalB = assistant("done", "stop", 51);

		// Run A starts and works through two text segments and two tool calls.
		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent({ type: "message_start", message: initial });
		await controller.handleEvent({ type: "message_end", message: initial });
		await controller.handleEvent({ type: "message_end", message: loopA1 });
		await controller.handleEvent({ type: "message_end", message: resultA1 });
		await controller.handleEvent({ type: "message_end", message: loopA2 });
		await controller.handleEvent({ type: "message_end", message: resultA2 });

		// The second message queued while A was streaming is force-flushed with
		// Enter: the source marks the flush and the drain already consumed the
		// queue by the time A's stale agent_end reaches the controller.
		session.forceFlushPending = true;
		now.mockReturnValue(160_000);
		await controller.handleEvent({
			type: "agent_end",
			messages: [initial, loopA1, resultA1, loopA2, resultA2, interrupted],
		});

		// A must stay fully expanded while B runs: no collapse, no rebuild, no reset.
		expect(recordCompletedRunCollapse).not.toHaveBeenCalled();
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();

		// Run B starts on the force-flushed steer and completes normally.
		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent({ type: "message_start", message: steer });
		await controller.handleEvent({ type: "message_end", message: steer });
		await controller.handleEvent({ type: "message_end", message: loopB1 });
		await controller.handleEvent({ type: "message_end", message: resultB1 });
		await controller.handleEvent({ type: "message_end", message: loopB2 });
		await controller.handleEvent({ type: "message_end", message: resultB2 });
		now.mockReturnValue(320_000);
		await controller.handleEvent({ type: "message_end", message: finalB });
		await controller.handleEvent({
			type: "agent_end",
			messages: [steer, loopB1, resultB1, loopB2, resultB2, finalB],
		});

		// The chain stays fully expanded while B's answer is on screen: neither
		// the interruption nor B's settle commits the collapse.
		expect(recordCompletedRunCollapse).not.toHaveBeenCalled();
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();

		// The next user turn commits both runs atomically: A first, B second,
		// each with its own span.
		await controller.handleEvent({ type: "agent_start" });
		expect(recordCompletedRunCollapse).toHaveBeenCalledTimes(2);
		const aCollapse = recordCompletedRunCollapse.mock.calls[0]![0] as CompletedRunCollapse;
		const bCollapse = recordCompletedRunCollapse.mock.calls[1]![0] as CompletedRunCollapse;
		expect(aCollapse).toEqual(
			expect.objectContaining({
				firstMessage: initial,
				initialUserMessage: initial,
				spanEndMessage: interrupted,
				durationMs: 159_000,
			}),
		);
		expect(aCollapse.finalAssistantMessage).toBeUndefined();
		expect(bCollapse).toEqual(
			expect.objectContaining({
				firstMessage: steer,
				initialUserMessage: steer,
				finalAssistantMessage: finalB,
				durationMs: 160_000,
			}),
		);
		expect(rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("parks the interrupted run when the abort lands in the turn gap without a synthesized aborted assistant", async () => {
		const { controller, session, recordCompletedRunCollapse, rebuildChatFromMessages, resetDisplay } = fixture();
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const initial = { role: "user", content: "build it", timestamp: 60 } as AgentMessage;
		const loopA = assistant("working", "toolUse", 61);
		loopA.content.push({ type: "toolCall", id: "tc-a", name: "read", arguments: {} });
		const resultA = {
			role: "toolResult",
			toolCallId: "tc-a",
			toolName: "read",
			content: [{ type: "text", text: "data" }],
			timestamp: 62,
		} as AgentMessage;
		const steer = { role: "user", content: "adjust it", steering: true, timestamp: 63 } as AgentMessage;
		const finalB = assistant("done", "stop", 64);

		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent({ type: "message_start", message: initial });
		await controller.handleEvent({ type: "message_end", message: initial });
		await controller.handleEvent({ type: "message_end", message: loopA });
		await controller.handleEvent({ type: "message_end", message: resultA });

		// Abort lands between tool turns: agent-loop emits no aborted assistant,
		// so A's agent_end carries only the completed tool-use turn.
		session.forceFlushPending = true;
		now.mockReturnValue(120_000);
		await controller.handleEvent({ type: "agent_end", messages: [initial, loopA, resultA] });
		expect(recordCompletedRunCollapse).not.toHaveBeenCalled();

		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent({ type: "message_start", message: steer });
		await controller.handleEvent({ type: "message_end", message: steer });
		now.mockReturnValue(180_000);
		await controller.handleEvent({ type: "message_end", message: finalB });
		await controller.handleEvent({ type: "agent_end", messages: [steer, finalB] });

		expect(recordCompletedRunCollapse).not.toHaveBeenCalled();
		await controller.handleEvent({ type: "agent_start" });
		expect(recordCompletedRunCollapse).toHaveBeenCalledTimes(2);
		const aCollapse = recordCompletedRunCollapse.mock.calls[0]![0] as CompletedRunCollapse;
		const bCollapse = recordCompletedRunCollapse.mock.calls[1]![0] as CompletedRunCollapse;
		expect(aCollapse.spanEndMessage).toBe(resultA);
		expect(aCollapse.finalAssistantMessage).toBeUndefined();
		expect(bCollapse.finalAssistantMessage).toBe(finalB);
		expect(rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("does not commit a parked run when the continuation ends without a qualifying final reply", async () => {
		const { controller, session, recordCompletedRunCollapse, rebuildChatFromMessages, resetDisplay } = fixture();
		const initial = { role: "user", content: "build it", timestamp: 70 } as AgentMessage;
		const loopA = assistant("working", "toolUse", 71);
		loopA.content.push({ type: "toolCall", id: "tc-a", name: "read", arguments: {} });
		const resultA = {
			role: "toolResult",
			toolCallId: "tc-a",
			toolName: "read",
			content: [{ type: "text", text: "data" }],
			timestamp: 72,
		} as AgentMessage;
		const interrupted = assistant("", "aborted", 73);
		interrupted.errorMessage = "Interrupted by user";
		const steer = { role: "user", content: "adjust it", steering: true, timestamp: 74 } as AgentMessage;
		const errored = assistant("", "error", 75);

		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent({ type: "message_start", message: initial });
		await controller.handleEvent({ type: "message_end", message: initial });
		await controller.handleEvent({ type: "message_end", message: loopA });
		await controller.handleEvent({ type: "message_end", message: resultA });
		session.forceFlushPending = true;
		await controller.handleEvent({
			type: "agent_end",
			messages: [initial, loopA, resultA, interrupted],
		});

		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent({ type: "message_start", message: steer });
		await controller.handleEvent({ type: "message_end", message: steer });
		await controller.handleEvent({ type: "message_end", message: errored });
		await controller.handleEvent({ type: "agent_end", messages: [steer, errored] });

		// Neither run collapses: the continuation failed, so the parked span was
		// discarded and the next user turn has nothing to flush.
		await controller.handleEvent({ type: "agent_start" });
		expect(recordCompletedRunCollapse).not.toHaveBeenCalled();
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("keeps one live collapse span across an upstream stream interruption and manual continuation", async () => {
		const { controller, recordCompletedRunCollapse } = fixture();
		const initial = { role: "user", content: "build it", timestamp: 76 } as AgentMessage;
		const interrupted = assistant("", "error", 77);
		interrupted.errorMessage = "stream_interrupted: Upstream stream interrupted after output began.";
		interrupted.stopDetails = {
			type: "stream_interrupted_after_content",
			category: null,
			explanation: interrupted.errorMessage,
		};
		const continuation = { role: "user", content: "continue", timestamp: 78 } as AgentMessage;
		const final = assistant("done", "stop", 79);

		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent({ type: "message_start", message: initial });
		await controller.handleEvent({ type: "message_end", message: initial });
		await controller.handleEvent({ type: "message_end", message: interrupted });
		await controller.handleEvent({ type: "agent_end", messages: [initial, interrupted] });

		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent({ type: "message_start", message: continuation });
		await controller.handleEvent({ type: "message_end", message: continuation });
		await controller.handleEvent({ type: "message_end", message: final });
		await controller.handleEvent({ type: "agent_end", messages: [continuation, final] });

		expect(recordCompletedRunCollapse).not.toHaveBeenCalled();
		await controller.handleEvent({ type: "agent_start" });
		expect(recordCompletedRunCollapse).toHaveBeenCalledTimes(1);
		expect(recordCompletedRunCollapse.mock.calls[0]![0]).toEqual(
			expect.objectContaining({
				firstMessage: initial,
				initialUserMessage: initial,
				finalAssistantMessage: final,
			}),
		);
	});

	it("restores the original run anchor after navigating to an unfinished branch", async () => {
		const { controller, recordCompletedRunCollapse } = fixture();
		const initial = { role: "user", content: "deploy every service", timestamp: 76 } as AgentMessage;
		const loop = assistant("working before the branch", "toolUse", 77);
		loop.content.push({ type: "toolCall", id: "tc", name: "write", arguments: {} });
		const skipped = {
			role: "toolResult",
			toolCallId: "tc",
			toolName: "write",
			content: [{ type: "text", text: "Skipped due to queued user message." }],
			isError: true,
			timestamp: 78,
		} as AgentMessage;
		const continuation = { role: "user", content: "continue", timestamp: 79 } as AgentMessage;
		const final = assistant("done", "stop", 80);

		controller.restoreCompletedRunAnchor([initial, loop, skipped]);
		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent({ type: "message_start", message: continuation });
		await controller.handleEvent({ type: "message_end", message: continuation });
		await controller.handleEvent({ type: "message_end", message: final });
		await controller.handleEvent({ type: "agent_end", messages: [continuation, final] });

		expect(recordCompletedRunCollapse).not.toHaveBeenCalled();
		await controller.handleEvent({ type: "agent_start" });
		expect(recordCompletedRunCollapse).toHaveBeenCalledTimes(1);
		expect(recordCompletedRunCollapse).toHaveBeenCalledWith(
			expect.objectContaining({
				firstMessage: initial,
				initialUserMessage: initial,
				finalAssistantMessage: final,
			}),
		);
	});

	it("keeps the original run anchor after focus reattachment and repeated steering", async () => {
		const { controller, recordCompletedRunCollapse } = fixture();
		const initial = { role: "user", content: "fix every failing test", timestamp: 80 } as AgentMessage;
		const loop = assistant("working before focus changed", "toolUse", 81);
		loop.content.push({ type: "toolCall", id: "tc", name: "task", arguments: {} });
		const firstSteer = {
			role: "user",
			content: "are you done yet?",
			steering: true,
			timestamp: 82,
		} as AgentMessage;
		const progress = assistant("still working", "toolUse", 83);
		progress.content.push({ type: "toolCall", id: "tc-2", name: "bash", arguments: {} });
		const secondSteer = {
			role: "user",
			content: "finish and commit",
			steering: true,
			timestamp: 84,
		} as AgentMessage;
		const final = assistant("done", "stop", 85);

		// Returning from a focused subagent rebuilds this anchor from persisted
		// main-session history, then synthesizes the missed live agent_start.
		controller.restoreCompletedRunAnchor([initial, loop]);
		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent({ type: "message_start", message: firstSteer });
		await controller.handleEvent({ type: "message_end", message: firstSteer });
		await controller.handleEvent({ type: "message_end", message: progress });
		await controller.handleEvent({ type: "message_start", message: secondSteer });
		await controller.handleEvent({ type: "message_end", message: secondSteer });
		await controller.handleEvent({ type: "message_end", message: final });
		await controller.handleEvent({ type: "agent_end", messages: [firstSteer, progress, secondSteer, final] });

		// Alt+O claims the parked run immediately. The collapse must still begin at
		// the original request, not at either post-focus steering message.
		expect(controller.commitCompletedRunCollapses({ rebuild: false })).toBe(true);
		expect(recordCompletedRunCollapse).toHaveBeenCalledTimes(1);
		expect(recordCompletedRunCollapse).toHaveBeenCalledWith(
			expect.objectContaining({
				firstMessage: initial,
				initialUserMessage: initial,
				finalAssistantMessage: final,
			}),
		);
	});

	it("keeps every parked span across repeated force-flushes and commits all three summaries at the end of the chain", async () => {
		const { controller, session, recordCompletedRunCollapse, rebuildChatFromMessages, resetDisplay } = fixture();
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const initial = { role: "user", content: "build it", timestamp: 80 } as AgentMessage;
		const interruptedA = assistant("", "aborted", 81);
		interruptedA.errorMessage = "Interrupted by user";
		const steerB = { role: "user", content: "adjust it", steering: true, timestamp: 82 } as AgentMessage;
		const interruptedB = assistant("", "aborted", 83);
		interruptedB.errorMessage = "Interrupted by user";
		const steerC = { role: "user", content: "one more adjustment", steering: true, timestamp: 84 } as AgentMessage;
		const finalC = assistant("done", "stop", 85);

		// A runs, then is force-flushed into B.
		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent({ type: "message_start", message: initial });
		await controller.handleEvent({ type: "message_end", message: initial });
		session.forceFlushPending = true;
		now.mockReturnValue(10_000);
		await controller.handleEvent({ type: "agent_end", messages: [initial, interruptedA] });

		// B runs, then is force-flushed into C.
		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent({ type: "message_start", message: steerB });
		await controller.handleEvent({ type: "message_end", message: steerB });
		session.forceFlushPending = true;
		now.mockReturnValue(20_000);
		await controller.handleEvent({ type: "agent_end", messages: [steerB, interruptedB] });

		// C completes normally.
		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent({ type: "message_start", message: steerC });
		await controller.handleEvent({ type: "message_end", message: steerC });
		now.mockReturnValue(30_000);
		await controller.handleEvent({ type: "message_end", message: finalC });
		await controller.handleEvent({ type: "agent_end", messages: [steerC, finalC] });

		expect(recordCompletedRunCollapse).not.toHaveBeenCalled();
		await controller.handleEvent({ type: "agent_start" });
		// All three runs collapse with their own summaries, committed atomically
		// when the user sends the next content.
		expect(recordCompletedRunCollapse).toHaveBeenCalledTimes(3);
		const [aCollapse, bCollapse, cCollapse] = recordCompletedRunCollapse.mock.calls.map(
			call => call[0] as CompletedRunCollapse,
		);
		expect(aCollapse).toEqual(expect.objectContaining({ initialUserMessage: initial, spanEndMessage: interruptedA }));
		expect(aCollapse.finalAssistantMessage).toBeUndefined();
		expect(bCollapse).toEqual(expect.objectContaining({ initialUserMessage: steerB, spanEndMessage: interruptedB }));
		expect(bCollapse.finalAssistantMessage).toBeUndefined();
		expect(cCollapse).toEqual(expect.objectContaining({ initialUserMessage: steerC, finalAssistantMessage: finalC }));
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
		// Even the next user turn has nothing to collapse: aborted runs park no
		// record, so the transcript stays fully expanded.
		await controller.handleEvent({ type: "agent_start" });
		chatContainer.render(80);
		expect(chatContainer.getNativeScrollbackLiveRegionStart()).toBeUndefined();
		expect(recordCompletedRunCollapse).not.toHaveBeenCalled();
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("retains a manually interrupted tool run when its correction starts after agent_end", async () => {
		const { controller, recordCompletedRunCollapse, rebuildChatFromMessages, resetDisplay } = fixture();
		const initial = { role: "user", content: "open the pull request", timestamp: 90 } as AgentMessage;
		const progress = assistant("merging the pull request", "toolUse", 91);
		progress.content.push({ type: "toolCall", id: "tc", name: "pwsh", arguments: {} });
		const result = {
			role: "toolResult",
			toolCallId: "tc",
			toolName: "pwsh",
			content: [{ type: "text", text: "merged" }],
			timestamp: 92,
		} as AgentMessage;
		const interrupted = assistant("", "aborted", 93);
		interrupted.errorMessage = "Interrupted by user";
		const correction = { role: "user", content: "open it, do not merge it", timestamp: 94 } as AgentMessage;
		const final = assistant("I will repair it", "stop", 95);

		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent({ type: "message_start", message: initial });
		await controller.handleEvent({ type: "message_end", message: initial });
		await controller.handleEvent({ type: "message_end", message: progress });
		await controller.handleEvent({ type: "message_end", message: result });
		await controller.handleEvent({ type: "message_end", message: interrupted });
		await controller.handleEvent({
			type: "agent_end",
			messages: [initial, progress, result, interrupted],
		});

		// Keep the interrupted work expanded until the user explicitly toggles it.
		expect(recordCompletedRunCollapse).not.toHaveBeenCalled();
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
		expect(controller.commitCompletedRunCollapses({ rebuild: false })).toBe(false);

		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent({ type: "message_start", message: correction });
		await controller.handleEvent({ type: "message_end", message: correction });
		await controller.handleEvent({ type: "message_end", message: final });
		await controller.handleEvent({ type: "agent_end", messages: [correction, final] });
		expect(controller.commitCompletedRunCollapses({ rebuild: false })).toBe(true);
		expect(recordCompletedRunCollapse).toHaveBeenCalledTimes(1);
		const collapse = recordCompletedRunCollapse.mock.calls[0]![0] as CompletedRunCollapse;
		expect(collapse).toEqual(
			expect.objectContaining({
				firstMessage: initial,
				initialUserMessage: initial,
				finalAssistantMessage: final,
			}),
		);
	});
});
