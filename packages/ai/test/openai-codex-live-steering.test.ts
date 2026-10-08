import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { planSteeredRequest } from "@oh-my-pi/pi-ai/providers/openai-codex/live-steering";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type {
	AssistantMessage,
	Context,
	FetchImpl,
	LiveSteerClaim,
	LiveSteering,
	Model,
	ProviderSessionState,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai/types";
import { __resetProxyCache } from "@oh-my-pi/pi-ai/utils/proxy";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as piUtils from "@oh-my-pi/pi-utils";
import { withEnv } from "./helpers";

const { getAgentDir, setAgentDir, TempDir } = piUtils;
const originalAgentDir = getAgentDir();
const originalWebSocket = global.WebSocket;
const USAGE = { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } };

beforeEach(() => {
	setAgentDir(TempDir.createSync("@pi-codex-steer-").path());
	vi.spyOn(piUtils, "getInstallId").mockReturnValue("00000000-0000-4000-8000-000000000001");
});

afterEach(() => {
	global.WebSocket = originalWebSocket;
	setAgentDir(originalAgentDir);
	vi.restoreAllMocks();
});

type Frame = Record<string, unknown>;

/** Scripted Responses WebSocket: `onFrame` answers each client frame via `emit`. */
class ScriptedWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: ScriptedWebSocket[] = [];
	static onFrame: (frame: Frame, socket: ScriptedWebSocket) => void = () => {};
	static sent: Frame[] = [];

	readyState = ScriptedWebSocket.CONNECTING;
	binaryType = "nodebuffer";
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: Event) => void) | null = null;

	constructor() {
		ScriptedWebSocket.instances.push(this);
		queueMicrotask(() => {
			this.readyState = ScriptedWebSocket.OPEN;
			this.onopen?.(new Event("open"));
		});
	}

	send(data: string): void {
		const frame = JSON.parse(data) as Frame;
		ScriptedWebSocket.sent.push(frame);
		ScriptedWebSocket.onFrame(frame, this);
	}

	close(): void {
		this.readyState = ScriptedWebSocket.CLOSED;
	}

	/** Deliver server frames asynchronously, in order. */
	emit(...frames: Frame[]): void {
		queueMicrotask(() => {
			for (const frame of frames) this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
		});
	}
}

function installSocket(onFrame: (frame: Frame, socket: ScriptedWebSocket) => void): void {
	ScriptedWebSocket.instances = [];
	ScriptedWebSocket.sent = [];
	ScriptedWebSocket.onFrame = onFrame;
	global.WebSocket = ScriptedWebSocket as unknown as typeof WebSocket;
}

function createGpt6Model(): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-6-sol",
		name: "GPT-6 Sol",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		preferWebsockets: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	});
}

function createToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function messageFrames(itemId: string, text: string): Frame[] {
	const item = { type: "message", id: itemId, role: "assistant", content: [{ type: "output_text", text }] };
	return [
		{ type: "response.output_item.added", item: { ...item, status: "in_progress", content: [] } },
		{ type: "response.output_text.delta", item_id: itemId, delta: text },
		{ type: "response.output_item.done", item: { ...item, status: "completed" } },
	];
}

/** A source holding one steering message; records how the provider settled it. */
function oneShotSteering(text: string): { source: LiveSteering; settled: () => "accepted" | "rejected" | undefined } {
	let claimed = false;
	let outcome: "accepted" | "rejected" | undefined;
	const idle = (signal: AbortSignal) => {
		const { promise, resolve } = Promise.withResolvers<void>();
		if (signal.aborted) resolve();
		else signal.addEventListener("abort", () => resolve(), { once: true });
		return promise;
	};
	const source: LiveSteering = {
		wait: async signal => (claimed ? idle(signal) : undefined),
		claim: async (): Promise<LiveSteerClaim | undefined> => {
			if (claimed) return undefined;
			claimed = true;
			return {
				messages: [{ role: "user", content: text, timestamp: Date.now() }],
				accept: () => {
					outcome = "accepted";
				},
				reject: () => {
					outcome = "rejected";
				},
			};
		},
	};
	return { source, settled: () => outcome };
}

function options(providerSessionState: Map<string, ProviderSessionState>, liveSteering?: LiveSteering) {
	return {
		apiKey: createToken(),
		sessionId: "ws-steer-session",
		providerSessionState,
		liveSteering,
		fetch: vi.fn(async () => {
			throw new Error("SSE fallback should not run");
		}) as FetchImpl,
	};
}

const SYSTEM = ["You are a helpful assistant."];
const creates = () => ScriptedWebSocket.sent.filter(frame => frame.type === "response.create");
const steers = () => ScriptedWebSocket.sent.filter(frame => frame.type === "response.steer");

/** Exercise the production WebSocket against a real loopback protocol peer. */
async function withProtocolSocket(
	onFrame: (frame: Frame, send: (...frames: Frame[]) => void) => void,
	run: (baseUrl: string, sent: Frame[], connections: () => number) => Promise<void>,
): Promise<void> {
	await withEnv({ NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" }, async () => {
		__resetProxyCache();
		const sent: Frame[] = [];
		let connections = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, server) {
				if (server.upgrade(request)) return;
				return new Response("Expected WebSocket upgrade", { status: 400 });
			},
			websocket: {
				open() {
					connections++;
				},
				message(socket, data) {
					const frame = JSON.parse(String(data)) as Frame;
					sent.push(frame);
					onFrame(frame, (...frames) => {
						for (const event of frames) socket.send(JSON.stringify(event));
					});
				},
			},
		});
		try {
			await run(`${server.url.origin}/backend-api`, sent, () => connections);
		} finally {
			await server.stop(true);
			__resetProxyCache();
		}
	});
}

describe("codex live steering", () => {
	it("steers the streaming response and reads the server's automatic continuation without sending a request", async () => {
		installSocket((frame, socket) => {
			if (frame.type === "response.create") {
				// Stream part of an answer, then wait for the steer.
				socket.emit({ type: "response.created", response: { id: "resp_1" } }, ...messageFrames("msg_1", "Plan"));
				return;
			}
			socket.emit(
				{ type: "response.steer.accepted", steer: { id: "steer_1", previous_response_id: "resp_1" } },
				{
					type: "response.incomplete",
					response: {
						id: "resp_1",
						status: "incomplete",
						incomplete_details: { reason: "steered" },
						usage: USAGE,
					},
				},
				// The successor the server creates on its own from the queued input.
				{ type: "response.created", response: { id: "resp_2" } },
				...messageFrames("msg_2", "Tabs it is"),
				{ type: "response.completed", response: { id: "resp_2", status: "completed", usage: USAGE } },
			);
		});
		const model = createGpt6Model();
		const state = new Map<string, ProviderSessionState>();
		const steering = oneShotSteering("use tabs");
		const user: UserMessage = { role: "user", content: "Draft a plan", timestamp: Date.now() };

		const first = await streamOpenAICodexResponses(
			model,
			{ systemPrompt: SYSTEM, messages: [user] },
			options(state, steering.source),
		).result();

		expect(steering.settled()).toBe("accepted");
		expect(first.stopReason).toBe("stop");
		expect(steers()).toEqual([
			{
				type: "response.steer",
				previous_response_id: "resp_1",
				input: [{ role: "user", content: [{ type: "input_text", text: "use tabs" }] }],
			},
		]);

		const steerMessage: UserMessage = { role: "user", content: "use tabs", timestamp: Date.now() };
		const second = await streamOpenAICodexResponses(
			model,
			{ systemPrompt: SYSTEM, messages: [user, first, steerMessage] },
			options(state),
		).result();

		expect(second.responseId).toBe("resp_2");
		expect(second.content).toEqual([expect.objectContaining({ type: "text", text: "Tabs it is" })]);
		expect(creates()).toHaveLength(1);
		expect(ScriptedWebSocket.instances).toHaveLength(1);
	});

	it("returns pending tool output without repeating steering the server already queued", async () => {
		installSocket((frame, socket) => {
			if (frame.type === "response.create" && creates().length === 1) {
				const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "status", arguments: "{}" };
				socket.emit(
					{ type: "response.created", response: { id: "resp_1" } },
					{ type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
				);
				return;
			}
			if (frame.type === "response.steer") {
				const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "status", arguments: "{}" };
				socket.emit(
					{ type: "response.steer.accepted", steer: { id: "steer_1", previous_response_id: "resp_1" } },
					{ type: "response.output_item.done", output_index: 0, item: { ...call, status: "completed" } },
					{ type: "response.completed", response: { id: "resp_1", status: "completed", usage: USAGE } },
					{
						type: "response.steer.pending",
						steer: { id: "steer_1", previous_response_id: "resp_1" },
						reason: "waiting_for_required_input",
						required_input: [{ type: "function_call_output", call_id: "call_1", name: "status" }],
					},
				);
				return;
			}
			socket.emit(
				{ type: "response.created", response: { id: "resp_2" } },
				...messageFrames("msg_2", "Scoped down"),
				{ type: "response.completed", response: { id: "resp_2", status: "completed", usage: USAGE } },
			);
		});
		const model = createGpt6Model();
		const state = new Map<string, ProviderSessionState>();
		const steering = oneShotSteering("keep it small");
		const user: UserMessage = { role: "user", content: "Plan the project", timestamp: Date.now() };

		const first = await streamOpenAICodexResponses(
			model,
			{ systemPrompt: SYSTEM, messages: [user] },
			options(state, steering.source),
		).result();
		expect(steering.settled()).toBe("accepted");
		expect(first.stopReason).toBe("toolUse");
		const toolCall = first.content.find(block => block.type === "toolCall");
		if (toolCall?.type !== "toolCall") throw new Error("expected a tool call");
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: "design done" }],
			isError: false,
			timestamp: Date.now(),
		};
		const steerMessage: UserMessage = { role: "user", content: "keep it small", timestamp: Date.now() };

		await streamOpenAICodexResponses(
			model,
			{ systemPrompt: SYSTEM, messages: [user, first, toolResult, steerMessage] },
			options(state),
		).result();

		const continuation = creates()[1];
		expect(continuation?.previous_response_id).toBe("resp_1");
		expect(continuation?.input).toEqual([
			expect.objectContaining({ type: "function_call_output", call_id: "call_1", output: "design done" }),
		]);
	});

	it("hands rejected steering back and sends it as ordinary input next time", async () => {
		installSocket((frame, socket) => {
			if (frame.type === "response.create" && creates().length === 1) {
				socket.emit({ type: "response.created", response: { id: "resp_1" } }, ...messageFrames("msg_1", "Hi"));
				return;
			}
			if (frame.type === "response.steer") {
				socket.emit(
					{
						type: "response.steer.failed",
						steer: { previous_response_id: "resp_1", input: frame.input },
						error: { type: "invalid_request_error", code: "response_already_completed", message: "done" },
					},
					{ type: "response.completed", response: { id: "resp_1", status: "completed", usage: USAGE } },
				);
				return;
			}
			socket.emit({ type: "response.created", response: { id: "resp_2" } }, ...messageFrames("msg_2", "Sure"), {
				type: "response.completed",
				response: { id: "resp_2", status: "completed", usage: USAGE },
			});
		});
		const model = createGpt6Model();
		const state = new Map<string, ProviderSessionState>();
		const steering = oneShotSteering("one more thing");
		const user: UserMessage = { role: "user", content: "Hello", timestamp: Date.now() };

		const first: AssistantMessage = await streamOpenAICodexResponses(
			model,
			{ systemPrompt: SYSTEM, messages: [user] },
			options(state, steering.source),
		).result();
		expect(steering.settled()).toBe("rejected");

		const steerMessage: UserMessage = { role: "user", content: "one more thing", timestamp: Date.now() };
		const context: Context = { systemPrompt: SYSTEM, messages: [user, first, steerMessage] };
		await streamOpenAICodexResponses(model, context, options(state)).result();

		expect(creates()[1]?.previous_response_id).toBe("resp_1");
		expect(creates()[1]?.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "one more thing" }] },
		]);
	});
});

describe("codex native steering protocol", () => {
	it("rejects only the native steer and delivers its input once at an independent boundary", async () => {
		let createCount = 0;
		await withProtocolSocket(
			(frame, send) => {
				if (frame.type === "response.steer") {
					send(
						{
							type: "error",
							error: { code: "unsupported_native_inflight_message", message: "native rejection" },
						},
						...messageFrames("msg_final", "Original answer"),
						{ type: "response.completed", response: { id: "resp_1", status: "completed", usage: USAGE } },
					);
					return;
				}
				createCount++;
				if (createCount === 1) {
					send(
						{ type: "response.created", response: { id: "resp_1" } },
						...messageFrames("msg_partial", "Working"),
					);
					return;
				}
				const responseId = `resp_${createCount}`;
				send(
					{ type: "response.created", response: { id: responseId } },
					...messageFrames(`msg_${createCount}`, createCount === 2 ? "Correction applied" : "Next answer"),
					{ type: "response.completed", response: { id: responseId, status: "completed", usage: USAGE } },
				);
			},
			async (baseUrl, sent, connections) => {
				const model = { ...createGpt6Model(), baseUrl };
				const state = new Map<string, ProviderSessionState>();
				const steering = oneShotSteering("correct course");
				const user: UserMessage = { role: "user", content: "Start work", timestamp: 1000 };
				const firstStream = streamOpenAICodexResponses(
					model,
					{ systemPrompt: SYSTEM, messages: [user] },
					options(state, steering.source),
				);
				const deltas: string[] = [];
				for await (const event of firstStream) {
					if (event.type === "text_delta") deltas.push(event.delta);
				}
				const first = await firstStream.result();
				expect(first.stopReason).toBe("stop");
				expect(first.responseId).toBe("resp_1");
				expect(deltas).toEqual(["Working", "Original answer"]);
				expect(steering.settled()).toBe("rejected");

				const correction: UserMessage = { role: "user", content: "correct course", timestamp: 1001 };
				const messages = [user, first, correction];
				const second = await streamOpenAICodexResponses(
					model,
					{ systemPrompt: SYSTEM, messages },
					options(state),
				).result();
				expect(second.stopReason).toBe("stop");
				expect(second.content).toEqual([expect.objectContaining({ type: "text", text: "Correction applied" })]);
				await streamOpenAICodexResponses(
					model,
					{
						systemPrompt: SYSTEM,
						messages: [...messages, second, { role: "user", content: "Continue", timestamp: 1002 }],
					},
					options(state),
				).result();

				const requests = sent.filter(frame => frame.type === "response.create");
				expect(requests.map(frame => frame.previous_response_id)).toEqual([undefined, undefined, "resp_2"]);
				const independentInput = requests[1]?.input as Frame[];
				expect(independentInput.filter(item => item.role === "user")).toEqual([
					{ role: "user", content: [{ type: "input_text", text: "Start work" }] },
					{ role: "user", content: [{ type: "input_text", text: "correct course" }] },
				]);
				expect(sent.filter(frame => frame.type === "response.steer")).toEqual([
					{
						type: "response.steer",
						previous_response_id: "resp_1",
						input: [{ role: "user", content: [{ type: "input_text", text: "correct course" }] }],
					},
				]);
				expect(connections()).toBe(1);
			},
		);
	});

	it("reads an accepted successor before applying the rejected input independently", async () => {
		let createCount = 0;
		let steerCount = 0;
		await withProtocolSocket(
			(frame, send) => {
				if (frame.type === "response.steer") {
					steerCount++;
					if (steerCount === 1) {
						send({ type: "response.steer.accepted", steer: { id: "steer_1", previous_response_id: "resp_1" } });
						return;
					}
					send(
						{ type: "error", code: "unsupported_native_inflight_message" },
						{ type: "response.completed", response: { id: "resp_1", status: "completed", usage: USAGE } },
						{ type: "response.created", response: { id: "resp_2" } },
						...messageFrames("msg_2", "Accepted continuation"),
						{ type: "response.completed", response: { id: "resp_2", status: "completed", usage: USAGE } },
					);
					return;
				}
				createCount++;
				const responseId = createCount === 1 ? "resp_1" : "resp_3";
				send(
					{ type: "response.created", response: { id: responseId } },
					...messageFrames(`msg_${responseId}`, createCount === 1 ? "Original answer" : "Rejected input applied"),
				);
				if (createCount > 1) {
					send({ type: "response.completed", response: { id: responseId, status: "completed", usage: USAGE } });
				}
			},
			async (baseUrl, sent, connections) => {
				const model = { ...createGpt6Model(), baseUrl };
				const state = new Map<string, ProviderSessionState>();
				const settled: string[] = [];
				const input = ["accepted correction", "rejected correction"];
				let next = 0;
				const source: LiveSteering = {
					wait: async signal => {
						if (next < input.length || signal.aborted) return;
						const { promise, resolve } = Promise.withResolvers<void>();
						signal.addEventListener("abort", () => resolve(), { once: true });
						await promise;
					},
					claim: async () => {
						const text = input[next++];
						if (!text) return undefined;
						return {
							messages: [{ role: "user", content: text, timestamp: 1000 + next }],
							accept: () => settled.push(`accepted:${text}`),
							reject: () => settled.push(`rejected:${text}`),
						};
					},
				};
				const user: UserMessage = { role: "user", content: "Start", timestamp: 1000 };
				const first = await streamOpenAICodexResponses(
					model,
					{ systemPrompt: SYSTEM, messages: [user] },
					options(state, source),
				).result();
				const accepted: UserMessage = { role: "user", content: input[0]!, timestamp: 1001 };
				const messages = [user, first, accepted];
				const second = await streamOpenAICodexResponses(
					model,
					{ systemPrompt: SYSTEM, messages },
					options(state),
				).result();
				const third = await streamOpenAICodexResponses(
					model,
					{
						systemPrompt: SYSTEM,
						messages: [...messages, second, { role: "user", content: input[1]!, timestamp: 1002 }],
					},
					options(state),
				).result();
				expect(settled).toEqual(["accepted:accepted correction", "rejected:rejected correction"]);
				expect(first.stopReason).toBe("stop");
				expect(second.content).toEqual([expect.objectContaining({ type: "text", text: "Accepted continuation" })]);
				expect(second.responseId).toBe("resp_2");
				expect(third.content).toEqual([expect.objectContaining({ type: "text", text: "Rejected input applied" })]);
				expect(sent.map(frame => frame.type)).toEqual([
					"response.create",
					"response.steer",
					"response.steer",
					"response.create",
				]);
				expect(sent.at(-1)?.previous_response_id).toBeUndefined();
				expect(connections()).toBe(1);
			},
		);
	});

	it.each(["no pending steer", "response scoped", "wrong target", "different code", "already accepted"] as const)(
		"surfaces a native or unrelated response error with %s",
		async kind => {
			const code = kind === "different code" ? "invalid_request_error" : "unsupported_native_inflight_message";
			await withProtocolSocket(
				(frame, send) => {
					const failure: Frame = { type: "error", error: { code, message: "Protocol failure" } };
					if (kind === "response scoped") failure.response = { id: "resp_1" };
					if (kind === "wrong target") failure.previous_response_id = "resp_other";
					if (frame.type === "response.create") {
						send({ type: "response.created", response: { id: "resp_1" } }, ...messageFrames("msg_1", "Partial"));
						if (kind === "no pending steer") send(failure);
						return;
					}
					if (kind === "already accepted") {
						send({ type: "response.steer.accepted", steer: { id: "steer_1", previous_response_id: "resp_1" } });
					}
					send(failure);
					if (kind !== "already accepted") {
						// Settle the actual command separately; this error is not its acknowledgement.
						send({
							type: "response.steer.failed",
							steer: { previous_response_id: "resp_1" },
							error: { code: "response_already_completed", message: "response ended" },
						});
					}
				},
				async (baseUrl, sent) => {
					const state = new Map<string, ProviderSessionState>();
					const steering = oneShotSteering("correction");
					const result = await streamOpenAICodexResponses(
						{ ...createGpt6Model(), baseUrl },
						{ systemPrompt: SYSTEM, messages: [{ role: "user", content: "Start", timestamp: 1000 }] },
						options(state, kind === "no pending steer" ? undefined : steering.source),
					).result();
					expect(result.stopReason).toBe("error");
					expect(result.errorMessage).toContain(code);
					expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "Partial" })]);
					expect(sent.filter(frame => frame.type === "response.create")).toHaveLength(1);
					if (kind !== "no pending steer") {
						expect(steering.settled()).toBe(kind === "already accepted" ? "accepted" : "rejected");
					}
				},
			);
		},
	);
});

describe("planSteeredRequest", () => {
	const steer = { role: "user", content: [{ type: "input_text", text: "use tabs" }] };
	const output = { type: "function_call_output", call_id: "call_1", output: "ok" };
	const other = { role: "user", content: [{ type: "input_text", text: "also lint" }] };

	it("attaches when the request is exactly the accepted steering", () => {
		// Responses Lite strips the image `detail` hint from request bodies only.
		const imageSteer = { role: "user", content: [{ type: "input_image", image_url: "u", detail: "auto" }] };
		expect(
			planSteeredRequest([{ role: "user", content: [{ type: "input_image", image_url: "u" }] }], [imageSteer]),
		).toEqual({ kind: "attach" });
	});

	it("sends only the tool output the server awaits", () => {
		expect(planSteeredRequest([output, steer], [steer])).toEqual({ kind: "create", input: [output] });
	});

	it("discards when the request cannot line up with the server queue", () => {
		// Extra input would run alongside the automatic successor.
		expect(planSteeredRequest([steer, other], [steer])).toEqual({ kind: "discard" });
		// The accepted steering is missing from the transcript.
		expect(planSteeredRequest([output], [steer])).toEqual({ kind: "discard" });
		// The chain broke, so the server's continuation point is unusable.
		expect(planSteeredRequest(undefined, [steer])).toEqual({ kind: "discard" });
	});
});
