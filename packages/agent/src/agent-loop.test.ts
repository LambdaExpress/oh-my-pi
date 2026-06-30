import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Context, Model, SimpleStreamOptions, ToolCall, TSchema, Usage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import {
	clearStreamingPartialJson,
	getStreamingPartialJson,
	setStreamingPartialJson,
} from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { Agent, type AgentTool } from ".";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

function usage(): Usage {
	return { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } };
}

function assistantMessage(model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function pushToolCallResponse(stream: AssistantMessageEventStream, model: Model, rawArgs: string): Promise<void> {
	const partial = assistantMessage(model);
	stream.push({ type: "start", partial });
	await Bun.sleep(0);

	const toolCall: ToolCall = {
		type: "toolCall",
		id: "call_1",
		name: "echo",
		arguments: {},
	};
	setStreamingPartialJson(toolCall, "");
	partial.content.push(toolCall);
	stream.push({ type: "toolcall_start", contentIndex: 0, partial });
	await Bun.sleep(0);

	toolCall.arguments = { path: "src/index.ts" };
	setStreamingPartialJson(toolCall, rawArgs);
	stream.push({ type: "toolcall_delta", contentIndex: 0, delta: rawArgs, partial });
	await Bun.sleep(0);

	clearStreamingPartialJson(toolCall);
	partial.stopReason = "toolUse";
	stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
	await Bun.sleep(0);
	stream.push({ type: "done", reason: "toolUse", message: partial });
}

async function pushTextResponse(stream: AssistantMessageEventStream, model: Model): Promise<void> {
	const partial = assistantMessage(model);
	stream.push({ type: "start", partial });
	await Bun.sleep(0);

	const text = { type: "text" as const, text: "done" };
	partial.content.push(text);
	stream.push({ type: "text_start", contentIndex: 0, partial });
	stream.push({ type: "text_delta", contentIndex: 0, delta: text.text, partial });
	stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial });
	partial.stopReason = "stop";
	stream.push({ type: "done", reason: "stop", message: partial });
}

describe("agent loop streaming snapshots", () => {
	it("preserves symbol-backed tool argument JSON on message_update snapshots", async () => {
		const rawArgs = '{"path":"src/index.ts"}';
		const model = createMockModel({ id: "streaming-symbol" });
		let requestCount = 0;
		const streamFn = (
			_model: Model,
			_context: Context,
			_options?: SimpleStreamOptions,
		): AssistantMessageEventStream => {
			const stream = new AssistantMessageEventStream();
			if (requestCount++ === 0) {
				void pushToolCallResponse(stream, model, rawArgs);
			} else {
				void pushTextResponse(stream, model);
			}
			return stream;
		};
		const echoTool: AgentTool<TSchema, { path?: unknown }> = {
			name: "echo",
			label: "Echo",
			description: "Echoes the path.",
			intent: "omit",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: { type: "string" },
				},
				required: ["path"],
			},
			async execute(_toolCallId, params) {
				const record =
					params && typeof params === "object" && !Array.isArray(params)
						? (params as Record<string, unknown>)
						: {};
				return { content: [{ type: "text", text: "ok" }], details: { path: record.path } };
			},
		};
		const agent = new Agent({
			initialState: {
				model,
				tools: [echoTool],
			},
			streamFn,
		});
		const seenPartialArgs: string[] = [];
		agent.subscribe(event => {
			if (event.type !== "message_update" || event.message.role !== "assistant") return;
			for (const block of event.message.content) {
				if (block.type !== "toolCall") continue;
				const partialJson = getStreamingPartialJson(block);
				if (partialJson !== undefined) seenPartialArgs.push(partialJson);
			}
		});

		await agent.prompt("call the tool");

		expect(seenPartialArgs).toContain(rawArgs);
	});
});
