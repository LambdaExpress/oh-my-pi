import { afterEach, describe, expect, it } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const PARTIAL_TEXT = "Here is the first part of the answer.";
const RECOVERED_TEXT = "Recovered after transport interruption.";
const encode = (event: unknown): string => `data: ${JSON.stringify(event)}\n\n`;
type InterruptedOutput = "empty" | "thinking" | "text" | "tool";

function interruptedEvents(output: InterruptedOutput): object[] {
	if (output === "empty") return [{ type: "response.created", response: { id: "resp_partial" } }];
	if (output === "thinking") {
		return [
			{ type: "response.output_item.added", item: { type: "reasoning", id: "rs_partial", summary: [] } },
			{
				type: "response.reasoning_summary_text.delta",
				item_id: "rs_partial",
				summary_index: 0,
				delta: "Checking the result.",
			},
		];
	}
	if (output === "tool") {
		return [
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "fc_partial", call_id: "call_partial", name: "write", arguments: "" },
			},
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_partial",
				delta: '{"path":"result.txt","content":"result"}',
			},
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_partial",
					call_id: "call_partial",
					name: "write",
					arguments: '{"path":"result.txt","content":"result"}',
				},
			},
		];
	}
	return [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_partial", role: "assistant", content: [] },
		},
		{ type: "response.content_part.added", item_id: "msg_partial", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", item_id: "msg_partial", delta: PARTIAL_TEXT },
	];
}

function completedEvents(): object[] {
	return [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_complete", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: RECOVERED_TEXT },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_complete",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: RECOVERED_TEXT }],
			},
		},
		{
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
}

interface Scenario {
	session: AgentSession;
	requests: AgentMessage[][];
	retryEvents: AgentSessionEvent[];
	serverRequests(): number;
	callerSignals: AbortSignal[];
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function scenario(output: InterruptedOutput, callerAbort = false): Promise<Scenario> {
	const tempDir = TempDir.createSync("@pi-transport-abort-");
	cleanups.push(() => tempDir.removeSync());
	const storage = await AuthStorage.create(tempDir.join("auth.db"));
	cleanups.push(() => storage.close());
	let serverRequests = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			serverRequests += 1;
			if (serverRequests > 1) {
				return new Response(completedEvents().map(encode).join(""), {
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(interruptedEvents(output).map(encode).join("")));
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	cleanups.push(() => {
		server.stop(true);
	});
	const model = buildModel({
		id: "transport-abort-test",
		name: "Transport abort test",
		api: "openai-codex-responses",
		provider: "transport-abort-test",
		baseUrl: server.url.href,
		reasoning: true,
		preferWebsockets: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	});
	storage.keys.setRuntime(model.provider, "test-key");
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": true,
		"retry.baseDelayMs": 1,
		"retry.maxDelayMs": 100,
		"retry.maxRetries": 1,
		"retry.modelFallback": false,
		"features.unexpectedStopDetection": "none",
	});
	const registry = new ModelRegistry(storage, tempDir.join("models.yml"), { settings });
	const transport = new AbortController();
	let transportRequests = 0;
	const fetchImpl: FetchImpl = (input, init) => {
		transportRequests += 1;
		if (transportRequests > 1) return fetch(input, init);
		return fetch(input, {
			...init,
			signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), transport.signal]),
		});
	};
	const requests: AgentMessage[][] = [];
	const callerSignals: AbortSignal[] = [];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn(_requestedModel, context, options) {
			requests.push(structuredClone(context.messages) as AgentMessage[]);
			if (options?.signal) callerSignals.push(options.signal);
			return streamOpenAICodexResponses(model, context, {
				...options,
				apiKey: "test-key",
				fetch: requests.length === 1 ? fetchImpl : fetch,
				onSseEvent(event) {
					const abortEvent =
						output === "empty"
							? "response.created"
							: output === "thinking"
								? "response.reasoning_summary_text.delta"
								: output === "text"
									? "response.output_text.delta"
									: "response.output_item.done";
					if (event.data.includes(abortEvent)) {
						if (callerAbort) agent.abort();
						else transport.abort();
					}
				},
			});
		},
	});
	const session = new AgentSession({
		agent,
		settings,
		modelRegistry: registry,
		sessionManager: SessionManager.inMemory(),
	});
	cleanups.push(() => session.dispose());
	const retryEvents: AgentSessionEvent[] = [];
	session.subscribe(event => {
		if (event.type === "auto_retry_start" || event.type === "auto_retry_end") retryEvents.push(event);
	});
	await session.prompt("Exercise a transport interruption.");
	await session.waitForIdle();
	return { session, requests, retryEvents, callerSignals, serverRequests: () => serverRequests };
}

describe("AgentSession native transport abort recovery", () => {
	it("recovers an empty response abort without requiring another user prompt", async () => {
		const result = await scenario("empty");
		expect(result.session.getLastAssistantMessage()).toMatchObject({
			stopReason: "stop",
			content: [expect.objectContaining({ type: "text", text: RECOVERED_TEXT })],
		});
		expect(result.session.agent.state.messages.filter(message => message.role === "user")).toHaveLength(1);
	});

	it("retries a fetch abort during thinking when the caller did not cancel", async () => {
		const result = await scenario("thinking");
		expect(result.serverRequests()).toBe(2);
		expect(result.callerSignals[0]?.aborted).toBe(false);
		expect(result.session.getLastAssistantMessage()).toMatchObject({
			stopReason: "stop",
			content: [expect.objectContaining({ type: "text", text: RECOVERED_TEXT })],
		});
		expect(result.retryEvents).toEqual([
			expect.objectContaining({ type: "auto_retry_start", attempt: 1 }),
			expect.objectContaining({ type: "auto_retry_end", success: true }),
		]);
		expect(result.requests[1]?.filter(message => message.role === "assistant")).toEqual([]);
	});

	it("preserves committed text in the next request instead of replaying it", async () => {
		const result = await scenario("text");
		expect(result.serverRequests()).toBe(2);
		expect(result.session.getLastAssistantMessage()?.stopReason).toBe("stop");
		expect(result.requests[1]).toContainEqual(
			expect.objectContaining({
				role: "assistant",
				content: [expect.objectContaining({ type: "text", text: PARTIAL_TEXT })],
			}),
		);
		expect(result.requests[1]?.filter(message => message.role === "user" && !message.synthetic)).toHaveLength(1);
	});

	it("keeps interrupted tool calls paired with explicit unexecuted results", async () => {
		const result = await scenario("tool");
		expect(result.serverRequests()).toBe(2);
		expect(result.session.getLastAssistantMessage()?.stopReason).toBe("stop");
		expect(result.requests[1]).toContainEqual(
			expect.objectContaining({
				role: "toolResult",
				toolCallId: "call_partial|fc_partial",
				isError: true,
				details: expect.objectContaining({ __synthetic: true, executed: false }),
			}),
		);
	});

	it("settles a caller cancellation without making another request", async () => {
		const result = await scenario("thinking", true);
		expect(result.serverRequests()).toBe(1);
		expect(result.session.getLastAssistantMessage()?.stopReason).toBe("aborted");
		expect(result.retryEvents).toEqual([]);
	});
});
