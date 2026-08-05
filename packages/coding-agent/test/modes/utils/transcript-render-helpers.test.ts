import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { initTheme } from "../../../src/modes/theme/theme";
import {
	assistantUsageIsBilled,
	collapseCompletedRuns,
	createCompletedRunSummary,
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
});
