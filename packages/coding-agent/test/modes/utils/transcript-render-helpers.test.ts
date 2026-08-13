import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { setLocale } from "../../../src/i18n";
import { initTheme } from "../../../src/modes/theme/theme";
import {
	assistantUsageIsBilled,
	collapseCompletedRuns,
	createCompletedRunSummary,
	deriveCompletedRunAnchor,
	deriveCompletedRunCollapses,
} from "../../../src/modes/utils/transcript-render-helpers";

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	timestamp: number,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: usage(),
		stopReason,
		timestamp,
	};
}

beforeAll(async () => {
	await initTheme();
	setLocale("en");
});

describe("assistantUsageIsBilled", () => {
	it("suppresses the token badge only for turns that consumed nothing", () => {
		expect(assistantUsageIsBilled(usage())).toBe(false);
	});

	it("preserves cost transparency for empty replies whose prompt still cost input tokens", () => {
		expect(assistantUsageIsBilled(usage({ input: 321 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ output: 0, cacheRead: 512 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ cacheWrite: 128 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ premiumRequests: 1 }))).toBe(true);
	});

	// Documents the live/resume parity contract for #4532: both paths ask
	// `assistantUsageIsBilled` about `message.usage`, so an empty automated
	// reply that still cost input tokens renders identically on both surfaces.
	it("matches whether the assistant carrier renders visible content", () => {
		const emptyBilledMessage: Pick<AssistantMessage, "usage"> = { usage: usage({ input: 321 }) };
		const emptyFreeMessage: Pick<AssistantMessage, "usage"> = { usage: usage() };
		expect(assistantUsageIsBilled(emptyBilledMessage.usage)).toBe(true);
		expect(assistantUsageIsBilled(emptyFreeMessage.usage)).toBe(false);
	});
});

describe("completed-run collapse projection", () => {
	it("keeps the initial request across a manual interrupt and later successful continuation", () => {
		const initial = { role: "user", content: "build it", timestamp: 1 } as const;
		const interrupted = assistant([{ type: "text", text: "partial work" }], "aborted", 2);
		interrupted.errorMessage = "Interrupted by user";
		const continuation = { role: "user", content: "continue and finish", timestamp: 3 } as const;
		const final = assistant([{ type: "text", text: "done" }], "stop", 4);
		const next = { role: "user", content: "next request", timestamp: 5 } as const;
		const messages = [initial, interrupted, continuation, final, next] as AgentMessage[];

		const collapses = deriveCompletedRunCollapses(messages, { includeLatest: false });
		expect(collapses).toEqual([
			expect.objectContaining({
				firstMessage: initial,
				initialUserMessage: initial,
				finalAssistantMessage: final,
			}),
		]);
		const context = { messages, models: {}, injectedTtsrRules: [], mode: "none" };
		const projection = collapseCompletedRuns(context, collapses);
		expect(projection.context.messages).toEqual([initial, final, next]);
		expect(projection.summaries).toEqual([
			{ afterMessage: initial, agentTextSegments: 1, toolCalls: 0, durationMs: 3 },
		]);
	});

	it("keeps the initial request across a persisted upstream stream interruption", () => {
		const initial = { role: "user", content: "build it", timestamp: 1 } as const;
		const loop = assistant(
			[
				{ type: "text", text: "working before disconnect" },
				{ type: "toolCall", id: "tc", name: "read", arguments: {} },
			],
			"toolUse",
			2,
		);
		const interrupted = assistant([], "error", 3);
		interrupted.errorMessage = "stream_interrupted: Upstream stream interrupted after output began.";
		interrupted.errorId = 0;
		interrupted.stopDetails = {
			type: "stream_interrupted_after_content",
			category: null,
			explanation: interrupted.errorMessage,
		};
		const continuation = { role: "user", content: "continue", timestamp: 4 } as const;
		const final = assistant([{ type: "text", text: "done" }], "stop", 5);
		const next = { role: "user", content: "next request", timestamp: 6 } as const;
		const messages = [initial, loop, interrupted, continuation, final, next] as AgentMessage[];

		const collapses = deriveCompletedRunCollapses(messages, { includeLatest: false });
		expect(collapses).toEqual([
			expect.objectContaining({
				firstMessage: initial,
				initialUserMessage: initial,
				finalAssistantMessage: final,
			}),
		]);
		const context = { messages, models: {}, injectedTtsrRules: [], mode: "none" };
		const projection = collapseCompletedRuns(context, collapses);
		expect(projection.context.messages).toEqual([initial, final, next]);
		expect(projection.summaries).toEqual([
			{ afterMessage: initial, agentTextSegments: 1, toolCalls: 1, durationMs: 4 },
		]);
	});

	it("recovers only an unfinished request as the next continuation anchor", () => {
		const initial = { role: "user", content: "unfinished deployment", timestamp: 1 } as const;
		const loop = assistant(
			[
				{ type: "text", text: "working" },
				{ type: "toolCall", id: "tc", name: "write", arguments: {} },
			],
			"toolUse",
			2,
		);
		const result = {
			role: "toolResult",
			toolCallId: "tc",
			toolName: "write",
			content: [{ type: "text", text: "Skipped due to queued user message." }],
			isError: true,
			timestamp: 3,
		} as AgentMessage;

		expect(deriveCompletedRunAnchor([initial, loop, result])).toEqual({
			initialUserMessage: initial,
			messages: [initial, loop, result],
		});

		const final = assistant([{ type: "text", text: "done" }], "stop", 4);
		expect(deriveCompletedRunAnchor([initial, loop, result, final])).toBeUndefined();
	});

	it("starts a fresh anchor after a terminal error", () => {
		const failed = { role: "user", content: "invalid request", timestamp: 1 } as const;
		const error = assistant([], "error", 2);
		error.errorMessage = "401 Unauthorized";
		error.stopDetails = { type: "authentication_error", category: null };
		const next = { role: "user", content: "independent request", timestamp: 3 } as const;

		expect(deriveCompletedRunAnchor([failed, error, next])).toEqual({
			initialUserMessage: next,
			messages: [next],
		});
	});

	it.each([
		["refusal", "stream_interrupted_after_content"],
		["sensitive", "stream_interrupted_after_content"],
		[null, "authentication_error"],
	] as const)("keeps a %s terminal error isolated from the next request", (category, type) => {
		const initial = { role: "user", content: "blocked request", timestamp: 1 } as const;
		const errored = assistant([], "error", 2);
		errored.errorMessage = category ? `Provider ${category}` : "401 Unauthorized";
		errored.stopDetails = { type, category };
		const next = { role: "user", content: "independent request", timestamp: 3 } as const;
		const final = assistant([{ type: "text", text: "done" }], "stop", 4);
		const after = { role: "user", content: "after", timestamp: 5 } as const;

		const collapses = deriveCompletedRunCollapses([initial, errored, next, final, after] as AgentMessage[], {
			includeLatest: false,
		});
		expect(collapses).toEqual([
			expect.objectContaining({
				firstMessage: next,
				initialUserMessage: next,
				finalAssistantMessage: final,
			}),
		]);
	});

	it("reconstructs one completed request across an interrupt, compaction, and resumed continuation", () => {
		const initial = { role: "user", content: "build it", timestamp: 1 } as const;
		const loop = assistant(
			[
				{ type: "text", text: "working before disconnect" },
				{ type: "toolCall", id: "tc", name: "read", arguments: {} },
			],
			"toolUse",
			2,
		);
		const interrupted = assistant([], "aborted", 3);
		interrupted.errorMessage = "Previous OMP process exited before completing the turn.";
		const compaction = {
			role: "compactionSummary",
			summary: "Earlier work was compacted",
			tokensBefore: 100,
			timestamp: 4,
		} as AgentMessage;
		const continuation = { role: "user", content: "continue", timestamp: 5 } as const;
		const final = assistant([{ type: "text", text: "done" }], "stop", 6);
		const next = { role: "user", content: "next request", timestamp: 7 } as const;
		const fullMessages = [initial, loop, interrupted, compaction, continuation, final, next] as AgentMessage[];
		const collapses = deriveCompletedRunCollapses(fullMessages, { includeLatest: false });

		expect(collapses).toHaveLength(1);
		expect(collapses[0]).toEqual(
			expect.objectContaining({
				firstMessage: initial,
				initialUserMessage: initial,
				finalAssistantMessage: final,
				durationMs: 5,
			}),
		);

		// The compacted live transcript no longer contains the original request.
		// Projection must use the full persisted transcript as its boundary source
		// and restore only that request plus the final answer.
		const visibleContext = {
			messages: [compaction, continuation, final, next] as AgentMessage[],
			models: {},
			injectedTtsrRules: [],
			mode: "none",
		};
		const projection = collapseCompletedRuns(visibleContext, collapses, fullMessages);
		expect(projection.context.messages).toEqual([initial, final, next]);
		expect(projection.summaries).toEqual([
			{ afterMessage: initial, agentTextSegments: 1, toolCalls: 1, durationMs: 5 },
		]);
	});

	it("counts only hidden assistant text segments and tool calls", () => {
		const initial = { role: "user", content: "build it", timestamp: 1 } as const;
		const loop = assistant(
			[
				{ type: "text", text: "first update" },
				{ type: "text", text: "   " },
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "toolCall", id: "one", name: "read", arguments: {} },
				{ type: "text", text: "second update" },
				{ type: "toolCall", id: "two", name: "grep", arguments: {} },
			],
			"toolUse",
			2,
		);
		const result = {
			role: "toolResult",
			toolCallId: "one",
			toolName: "read",
			content: [{ type: "text", text: "data" }],
			timestamp: 3,
		} as AgentMessage;
		const final = assistant(
			[
				{ type: "thinking", thinking: "final private reasoning" },
				{ type: "text", text: "done" },
			],
			"stop",
			4,
		);
		const source = [initial, loop, result, final] as AgentMessage[];
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
		expect(projection.summaries).toEqual([
			{ afterMessage: initial, agentTextSegments: 2, toolCalls: 2, durationMs: 65_000 },
		]);
		expect(source).toHaveLength(4);
		expect(final.content).toHaveLength(2);
	});

	it("renders the recap-style English summary as one line with singular counts", () => {
		const request = { role: "user", content: "build it", timestamp: 1 } as const;
		const component = createCompletedRunSummary(
			{ afterMessage: request, agentTextSegments: 1, toolCalls: 1, durationMs: 65_000 },
			"Alt+O",
		);
		const lines = component.render(120);

		expect(lines).toHaveLength(1);
		expect(Bun.stripANSI(lines[0]!).trim()).toBe(
			"※ collapsed: 1 agent text segment · 1 tool call · 1m5s elapsed · Alt+O to expand",
		);
	});

	it("uses plural counts and omits a disabled shortcut hint", () => {
		const request = { role: "user", content: "build it", timestamp: 1 } as const;
		const component = createCompletedRunSummary(
			{ afterMessage: request, agentTextSegments: 0, toolCalls: 3, durationMs: 500 },
			undefined,
		);

		expect(Bun.stripANSI(component.render(120)[0]!).trim()).toBe(
			"※ collapsed: 0 agent text segments · 3 tool calls · 500ms elapsed",
		);
	});

	it("projects a force-flushed interrupted span and its continuation as two adjacent summaries", () => {
		const initialA = { role: "user", content: "first request", timestamp: 1 } as const;
		const loopA = assistant(
			[
				{ type: "text", text: "working on A" },
				{ type: "toolCall", id: "tc-a", name: "read", arguments: {} },
			],
			"toolUse",
			2,
		);
		const resultA = {
			role: "toolResult",
			toolCallId: "tc-a",
			toolName: "read",
			content: [{ type: "text", text: "data" }],
			timestamp: 3,
		} as AgentMessage;
		const abortedA = assistant([], "aborted", 4);
		abortedA.errorMessage = "Interrupted by user";
		const initialB = { role: "user", content: "force-flushed follow-up", steering: true, timestamp: 5 } as const;
		const loopB = assistant(
			[
				{ type: "text", text: "working on B" },
				{ type: "toolCall", id: "tc-b", name: "edit", arguments: {} },
			],
			"toolUse",
			6,
		);
		const resultB = {
			role: "toolResult",
			toolCallId: "tc-b",
			toolName: "edit",
			content: [{ type: "text", text: "done" }],
			timestamp: 7,
		} as AgentMessage;
		const finalB = assistant([{ type: "text", text: "both collapsed" }], "stop", 8);
		const source = [initialA, loopA, resultA, abortedA, initialB, loopB, resultB, finalB] as AgentMessage[];
		const context = {
			messages: source,
			models: {},
			injectedTtsrRules: [],
			mode: "none",
		};

		const projection = collapseCompletedRuns(context, [
			{
				firstMessage: initialA,
				initialUserMessage: initialA,
				spanEndMessage: abortedA,
				durationMs: 40_000,
			},
			{
				firstMessage: initialB,
				initialUserMessage: initialB,
				finalAssistantMessage: finalB,
				durationMs: 60_000,
			},
		]);

		// A's interrupted span is fully hidden (its aborted boundary included);
		// B keeps its initial request and text-only final answer.
		expect(projection.context.messages.map(message => message.role)).toEqual(["user", "user", "assistant"]);
		expect(projection.context.messages[0]).toBe(initialA);
		expect(projection.context.messages[1]).toBe(initialB);
		expect((projection.context.messages[2] as AssistantMessage).content).toEqual([
			{ type: "text", text: "both collapsed" },
		]);
		expect(projection.summaries).toEqual([
			{ afterMessage: initialA, agentTextSegments: 1, toolCalls: 1, durationMs: 40_000 },
			{ afterMessage: initialB, agentTextSegments: 1, toolCalls: 1, durationMs: 60_000 },
		]);
		expect(source).toHaveLength(8);
	});
});

afterAll(() => {
	setLocale(null);
});
