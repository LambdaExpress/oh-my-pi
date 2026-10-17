/**
 * Contract: openai-completions streamed tool calls carry
 * `kStreamingPartialJson` on the stored blocks in streaming event partials, so the
 * interactive reveal path (write/edit/bash previews) can pace the args as the
 * JSON arrives. Without the symbol the TUI falls back to the throttled
 * `arguments` snapshot and long write payloads appear "直接出结果" instead of
 * streaming.
 */
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { FetchImpl, Model, ModelSpec, ToolCall } from "@oh-my-pi/pi-ai/types";
import { kStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

function deepseekModel(): Model<"openai-completions"> {
	const bundled = getBundledModel("opencode-go", "deepseek-v4-flash") as Model<"openai-completions">;
	const { compat: _resolved, compatConfig, ...rest } = bundled;
	// Project back to spec stage and rebuild, exactly like the model manager
	// does: `buildModel` resolves the sparse `compatConfig` into the full
	// compat record the providers read (a bare spec-stage object would leave
	// `model.compat` undefined and crash the compat policy resolver).
	return buildModel({
		...rest,
		compat: compatConfig,
	} as ModelSpec<"openai-completions">) as Model<"openai-completions">;
}

function createSseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createMockFetch(events: unknown[]): FetchImpl {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		return createSseResponse(events);
	}
	return Object.assign(mockFetch, { preconnect: fetch.preconnect });
}

function streamedWriteCall(complete = true): unknown[] {
	return [
		{ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
		{
			id: "2",
			object: "chat.completion.chunk",
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{ index: 0, id: "call_1", type: "function", function: { name: "write", arguments: '{"path"' } },
						],
					},
				},
			],
		},
		{
			id: "3",
			object: "chat.completion.chunk",
			choices: [
				{
					index: 0,
					delta: { tool_calls: [{ index: 0, function: { arguments: ':"src/demo.ts","content":"line 01' } }] },
				},
			],
		},
		{
			id: "4",
			object: "chat.completion.chunk",
			choices: [
				{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\\nline 02\\nline 03" } }] } },
			],
		},
		...(complete
			? [
					{
						id: "5",
						object: "chat.completion.chunk",
						choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] } }],
					},
				]
			: []),
		{ id: "6", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
	];
}

describe("openai-completions streaming partialJson", () => {
	it("carries kStreamingPartialJson on streamed write tool calls", async () => {
		const events = streamOpenAICompletions(
			deepseekModel(),
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				tools: [
					{
						name: "write",
						description: "write a file",
						parameters: {
							type: "object",
							properties: { path: { type: "string" }, content: { type: "string" } },
						},
					},
				],
			},
			{
				apiKey: "probe",
				sessionId: "probe",
				toolChoice: "auto",
				fetch: createMockFetch(streamedWriteCall()),
			},
		);

		const frames: string[] = [];
		for await (const event of events) {
			if (event.type === "toolcall_start" || event.type === "toolcall_delta") {
				const block = event.partial.content[event.contentIndex];
				if (block === null || typeof block !== "object" || !(kStreamingPartialJson in block)) continue;
				const partialJson = block[kStreamingPartialJson];
				if (typeof partialJson === "string") frames.push(partialJson);
			}
			if (event.type === "error") {
				throw new Error(`stream error: ${event.error.errorMessage}`);
			}
		}

		// Each delta grows the raw JSON prefix; the last frame covers the whole
		// streamed arguments object before the call closes.
		expect(frames.length).toBeGreaterThan(0);
		const last = frames.at(-1) ?? "";
		expect(last).toContain('"path":"src/demo.ts"');
		expect(last).toContain('"content":"line 01');
		expect(last).toContain("line 03");
		// Prefixes grow monotonically, as the reveal path expects.
		for (let index = 1; index < frames.length; index++) {
			expect(frames[index]!.startsWith(frames[index - 1]!)).toBe(true);
		}
	});

	it.each([true, false])("clears stored streaming JSON after a call closes (complete: %s)", async complete => {
		const events = streamOpenAICompletions(
			deepseekModel(),
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				tools: [
					{
						name: "write",
						description: "write a file",
						parameters: {
							type: "object",
							properties: { path: { type: "string" }, content: { type: "string" } },
						},
					},
				],
			},
			{
				apiKey: "probe",
				sessionId: "probe",
				toolChoice: "auto",
				fetch: createMockFetch(streamedWriteCall(complete)),
			},
		);

		const closedCalls: ToolCall[] = [];
		for await (const event of events) {
			if (event.type === "toolcall_end") {
				const block = event.partial.content[event.contentIndex];
				if (block?.type !== "toolCall") throw new Error("Expected stored tool call");
				expect(Reflect.get(block, kStreamingPartialJson)).toBeUndefined();
				expect(block.arguments).toEqual(event.toolCall.arguments);
				closedCalls.push(event.toolCall);
			}
			if (event.type === "error") {
				throw new Error(`stream error: ${event.error.errorMessage}`);
			}
		}
		expect(closedCalls).toHaveLength(1);
		const call = closedCalls[0]!;
		if (complete) {
			expect(call.arguments).toEqual({
				path: "src/demo.ts",
				content: "line 01\nline 02\nline 03",
			});
		} else {
			expect(call.arguments).toEqual({
				__parseError: expect.any(String),
				__rawJson: '{"path":"src/demo.ts","content":"line 01\\nline 02\\nline 03',
			});
			expect(() =>
				validateToolArguments({ name: "write", description: "", parameters: { type: "object" } }, call),
			).toThrow("Tool call arguments are not valid JSON");
		}
		const result = await events.result();
		const stored = result.content.find(block => block.type === "toolCall");
		if (!stored) throw new Error("Expected completed stored tool call");
		expect(Reflect.get(stored, kStreamingPartialJson)).toBeUndefined();
		expect(stored.arguments).toEqual(call.arguments);
	});
});
