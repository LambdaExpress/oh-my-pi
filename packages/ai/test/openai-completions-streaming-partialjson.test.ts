/**
 * Contract: openai-completions streamed tool calls carry
 * `kStreamingPartialJson` on `toolcall_start`/`toolcall_delta` events, so the
 * interactive reveal path (write/edit/bash previews) can pace the args as the
 * JSON arrives. Without the symbol the TUI falls back to the throttled
 * `arguments` snapshot and long write payloads appear "直接出结果" instead of
 * streaming.
 */
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { kStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

function deepseekModel(): Model<"openai-completions"> {
	const bundled = getBundledModel("opencode-go", "deepseek-v4-flash") as Model<"openai-completions">;
	const { compat: _resolved, compatConfig, ...rest } = bundled;
	return { ...rest, compat: compatConfig } as Model<"openai-completions">;
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

const streamedWriteCall = [
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
		choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\\nline 02\\nline 03" } }] } }],
	},
	{ id: "5", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
];

describe("openai-completions streaming partialJson", () => {
	it("carries kStreamingPartialJson on streamed write tool calls", async () => {
		const events = streamOpenAICompletions(
			deepseekModel(),
			{
				sessionId: "probe",
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
				toolChoice: "auto",
				stream: true,
			} as never,
			{
				apiKey: "probe",
				fetch: createMockFetch(streamedWriteCall),
				baseUrl: "https://opencode.ai/zen/go/v1",
			} as never,
		);

		const frames: string[] = [];
		for await (const event of events) {
			if (event.type === "toolcall_start" || event.type === "toolcall_delta") {
				const block = event.partial.content[event.contentIndex ?? 0];
				if (block === null || typeof block !== "object" || !(kStreamingPartialJson in block)) continue;
				const partialJson = block[kStreamingPartialJson];
				if (typeof partialJson === "string") frames.push(partialJson);
			}
			if (event.type === "error") {
				const error = (event as { error?: { errorMessage?: string } }).error;
				throw new Error(`stream error: ${error?.errorMessage}`);
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

	it("clears the streaming partialJson once the tool call closes", async () => {
		const events = streamOpenAICompletions(
			deepseekModel(),
			{
				sessionId: "probe",
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
				toolChoice: "auto",
				stream: true,
			} as never,
			{
				apiKey: "probe",
				fetch: createMockFetch(streamedWriteCall),
				baseUrl: "https://opencode.ai/zen/go/v1",
			} as never,
		);

		for await (const event of events) {
			if (event.type === "toolcall_end") {
				const partialJson = (event.toolCall as unknown as Record<symbol, unknown>)[kStreamingPartialJson];
				expect(partialJson).toBeUndefined();
				expect(event.toolCall.arguments).toEqual({
					path: "src/demo.ts",
					content: "line 01\nline 02\nline 03",
				});
			}
			if (event.type === "error") {
				const error = (event as { error?: { errorMessage?: string } }).error;
				throw new Error(`stream error: ${error?.errorMessage}`);
			}
		}
	});
});
