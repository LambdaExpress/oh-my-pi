import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/agent-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, type AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm, type CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { attachIrcWakeTurnMonitor } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import type { ServerWebSocket } from "bun";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const NATIVE_ERROR_CODE = "unsupported_native_inflight_message";
const NATIVE_ERROR_MESSAGE =
	"The experimental native turn lane cannot accept stateful WebSocket messages while a native turn is running. Start a new independent response.create turn instead.";
const NATIVE_ERROR_FRAME = { type: "error", error: { code: NATIVE_ERROR_CODE, message: NATIVE_ERROR_MESSAGE } };
const PRIOR_ANSWER = "先前任务已完成，保留了原始约束证据。";
const WAKE_BODY = "请重新核对先前记录的约束证据。";
const FINDINGS_BODY = "初步发现：正在比对合并前后的灯光门控，暂未修改源。";
const STREAMED_PROGRESS = "已读取真实约束层，继续检查合并状态。";
const STREAMED_FINISH = "当前检查完成，保留完整证据。";
const FIRST_CORRECTION = "源已经包含 Spot 门控；不得重复补写逻辑，请检查真实合并状态。";
const SECOND_CORRECTION = "同时核对 Light parent 的 active 状态，先不要修改源。";
const CORRECTED_ANSWER = "已按两条修正核对合并状态和父节点，原始检查结果已保留。";
const USAGE = { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } };

type Frame = Record<string, unknown>;
type PeerSocket = ServerWebSocket<undefined>;

/** A real loopback Responses peer; only its scripted server behavior is injected. */
function createPeer(onFrame: (frame: Frame, socket: PeerSocket) => void) {
	const frames: Array<{ frame: Frame; socket: PeerSocket }> = [];
	const sockets = new Set<PeerSocket>();
	const failure = Promise.withResolvers<never>();
	void failure.promise.catch(() => {});
	const server = Bun.serve<undefined>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (new URL(request.url).pathname === "/backend-api/codex/responses" && server.upgrade(request)) {
				return;
			}
			return new Response("Only the local Responses WebSocket is available", { status: 405 });
		},
		websocket: {
			open(socket) {
				sockets.add(socket);
			},
			message(socket, data) {
				try {
					const frame = JSON.parse(typeof data === "string" ? data : data.toString()) as Frame;
					frames.push({ frame, socket });
					onFrame(frame, socket);
				} catch (error) {
					failure.reject(error);
					socket.close();
				}
			},
			close(socket) {
				sockets.delete(socket);
			},
		},
	});
	return {
		baseUrl: `http://127.0.0.1:${server.port}/backend-api`,
		frames,
		wait: <T>(pending: Promise<T>): Promise<T> => Promise.race([pending, failure.promise]),
		close() {
			for (const socket of sockets) socket.close();
			server.stop(true);
		},
	};
}

function send(socket: PeerSocket, ...frames: Frame[]): void {
	for (const frame of frames) socket.send(JSON.stringify(frame));
}

function startText(socket: PeerSocket, responseId: string, text: string): void {
	send(
		socket,
		{ type: "response.created", response: { id: responseId } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: `msg_${responseId}`, role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", item_id: `msg_${responseId}`, output_index: 0, delta: text },
	);
}

function finishText(socket: PeerSocket, responseId: string, text: string): void {
	send(
		socket,
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: `msg_${responseId}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{ type: "response.completed", response: { id: responseId, status: "completed", usage: USAGE } },
	);
}

function completeText(socket: PeerSocket, responseId: string, text: string): void {
	startText(socket, responseId, text);
	finishText(socket, responseId, text);
}

function messageText(message: AgentMessage): string {
	if (message.role === "assistant") {
		return message.content
			.filter(part => part.type === "text")
			.map(part => part.text)
			.join("");
	}
	if (message.role !== "user" && message.role !== "custom") return "";
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.join("");
}

function inputTexts(frame: Frame): string[] {
	if (!Array.isArray(frame.input)) throw new Error("Expected Responses input items");
	return frame.input.flatMap((item: Record<string, unknown>) => {
		if (typeof item.content === "string") return [item.content];
		if (!Array.isArray(item.content)) return [];
		return item.content.flatMap((part: Record<string, unknown>) =>
			typeof part.text === "string" ? [part.text] : [],
		);
	});
}

function occurrences(texts: readonly string[], body: string): number {
	return texts.reduce((count, text) => count + text.split(body).length - 1, 0);
}

/** Uses the real agent:// handler, bus, lifecycle owner, sessions, and wake monitor. */
function createHarness(tempDir: TempDir, model: Model<"openai-codex-responses">) {
	const parentId = `NativeParent${Snowflake.next()}`;
	const childId = `NativeChild${Snowflake.next()}`;
	const scopeId = `NativeScope${Snowflake.next()}`;
	const registry = AgentRegistry.global();
	const lifecycle = AgentLifecycleManager.global();
	const bus = IrcBus.global();
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"contextPromotion.enabled": false,
		"retry.enabled": false,
		"retry.modelFallback": false,
		"features.unexpectedStopDetection": "none",
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		"power.sleepPrevention": "off",
		"providers.openaiLiveSteering": true,
		steeringMode: "all",
	});
	const authStorage = createInMemoryAuthStorage();
	// An opaque local key avoids OAuth attestation and never reaches a paid backend.
	authStorage.keys.setRuntime("openai-codex", "local-irc-fixture-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings });
	const protocol = new AgentProtocolHandler();
	const toolSession = (id: string): ToolSession => ({
		cwd: tempDir.path(),
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => id,
		agentRegistry: registry,
		enableIrc: true,
		taskDepth: 1,
	});
	const writeMessage = (from: string, to: string, body: string) =>
		protocol.write(parseInternalUrl(`agent://${to}`), body, { session: toolSession(from) });
	const parentStreamStarted = Promise.withResolvers<void>();
	const parent = new AgentSession({
		agent: new Agent({
			initialState: { model, systemPrompt: ["Coordinate peer findings"], tools: [] },
			convertToLlm,
			streamFn: (_model, _context, options) => {
				const stream = new AssistantMessageEventStream();
				const signal = options?.signal;
				if (!signal) throw new Error("Expected parent run signal");
				if (signal.aborted) stream.fail(signal.reason);
				else signal.addEventListener("abort", () => stream.fail(signal.reason), { once: true });
				parentStreamStarted.resolve();
				return stream;
			},
		}),
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings,
		modelRegistry,
		agentId: parentId,
		agentKind: "sub",
		agentScopeId: scopeId,
		memoryEnabled: false,
	});
	const parentRef = registry.register({
		id: parentId,
		displayName: "parent",
		kind: "sub",
		scopeId,
		session: parent,
		status: "idle",
	});
	const parentRecords: CustomMessage[] = [];
	parent.subscribe(event => {
		if (event.type === "irc_message" && event.message.customType === "irc:incoming") {
			parentRecords.push(event.message);
		}
	});
	const findings: string[] = [];
	const progressSeen = Promise.withResolvers<void>();
	const messageEnds: Array<{ role: AgentMessage["role"]; text: string }> = [];
	const reportSchema = type({ message: "string" });
	const reportTool: AgentTool<typeof reportSchema> = {
		name: "report_findings",
		label: "Report findings",
		description: "Send interim findings to the parent without completing the investigation",
		parameters: reportSchema,
		async execute(_id, args) {
			const body = args.message;
			findings.push(body);
			const result = await writeMessage(childId, parentId, body);
			return { content: result.content, details: result.details ?? {}, isError: result.isError };
		},
	};
	const sessions: AgentSession[] = [parent];
	let childRef: AgentRef | undefined;
	const createChild = (sessionManager: SessionManager): AgentSession => {
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Investigate the real source and preserve earlier findings"],
				messages: sessionManager.buildSessionContext().messages,
				tools: [reportTool],
			},
			convertToLlm,
			steeringMode: "all",
			getApiKey: () => "local-irc-fixture-key",
			streamFn: (_model, context, options) =>
				streamOpenAICodexResponses(model, context, {
					...options,
					apiKey: "local-irc-fixture-key",
					preferWebsockets: true,
					responsesLite: false,
					streamFirstEventTimeoutMs: 5_000,
					streamIdleTimeoutMs: 5_000,
					fetch: async () => {
						throw new Error("HTTP fallback is disabled in the local IRC fixture");
					},
				}),
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			agentId: childId,
			agentKind: "sub",
			agentScopeId: scopeId,
			memoryEnabled: false,
		});
		session.subscribe(event => {
			if (event.type === "message_update" && event.message.role === "assistant") {
				if (messageText(event.message) === STREAMED_PROGRESS) progressSeen.resolve();
			}
			if (event.type === "message_end") {
				messageEnds.push({ role: event.message.role, text: messageText(event.message) });
			}
		});
		session.addDisposer(session.subscribeRunState(state => registry.setStatus(childId, state, session)));
		attachIrcWakeTurnMonitor(session, {
			id: childId,
			scopeId,
			agent: { name: "task", description: "investigate evidence", systemPrompt: "test", source: "bundled" },
		});
		sessions.push(session);
		return session;
	};
	return {
		parentId,
		childId,
		registry,
		bus,
		parent,
		parentRecords,
		findings,
		progressSeen: progressSeen.promise,
		messageEnds,
		async startParent() {
			void parent.agent.prompt("Coordinate the investigation").catch(() => {});
			await parentStreamStarted.promise;
		},
		createOriginalChild() {
			const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
			const child = createChild(sessionManager);
			childRef = registry.register({
				id: childId,
				displayName: "task",
				kind: "sub",
				parentId,
				scopeId,
				session: child,
				sessionFile: sessionManager.getSessionFile(),
				status: "idle",
			});
			lifecycle.adopt(
				childId,
				{
					idleTtlMs: 0,
					revive: async expected => {
						if (!expected.sessionFile) throw new Error("Expected persisted child transcript");
						const reopened = await SessionManager.open(expected.sessionFile, undefined, undefined, {
							suppressBreadcrumb: true,
							throwIfMissing: true,
						});
						return createChild(reopened);
					},
				},
				childRef,
			);
			return child;
		},
		park: () => lifecycle.park(childId),
		write: (body: string) => writeMessage(parentId, childId, body),
		async close() {
			try {
				if (childRef) await lifecycle.release(childId, childRef);
				for (const session of sessions) await session.dispose();
			} finally {
				registry.unregister(parentId, parentRef);
				authStorage.close();
			}
		},
	};
}

function createModel(baseUrl: string): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-6.1-sol",
		name: "Local Codex IRC fixture",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl,
		reasoning: true,
		preferWebsockets: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	});
}

function incomingBodies(records: readonly CustomMessage[]): string[] {
	return records.map(record => {
		const body =
			record.details && typeof record.details === "object" ? Reflect.get(record.details, "message") : undefined;
		if (typeof body !== "string") throw new Error("Expected an incoming IRC body");
		return body;
	});
}

describe("IRC native in-flight steering", () => {
	it("revives a completed child and preserves its live work while consuming two parent corrections once in order", async () => {
		await using tempDir = await TempDir.create("@omp-irc-native-steering-");
		const investigating = Promise.withResolvers<PeerSocket>();
		const steerReceived = Promise.withResolvers<PeerSocket>();
		let creates = 0;
		const peer = createPeer((frame, socket) => {
			if (frame.type === "response.steer") {
				steerReceived.resolve(socket);
				return;
			}
			if (frame.type !== "response.create") throw new Error(`Unexpected client frame: ${frame.type}`);
			creates++;
			if (creates === 1) {
				completeText(socket, "resp_prior", PRIOR_ANSWER);
			} else if (creates === 2) {
				startText(socket, "resp_findings", FINDINGS_BODY);
				const call = {
					type: "function_call",
					id: "fc_findings",
					call_id: "call_findings",
					name: "report_findings",
					arguments: JSON.stringify({ message: FINDINGS_BODY }),
				};
				send(
					socket,
					{ type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "" } },
					{ type: "response.output_item.done", output_index: 1, item: { ...call, status: "completed" } },
				);
				finishText(socket, "resp_findings", FINDINGS_BODY);
			} else if (creates === 3) {
				startText(socket, "resp_investigation", STREAMED_PROGRESS);
				investigating.resolve(socket);
			} else if (creates === 4) {
				completeText(socket, "resp_corrected", CORRECTED_ANSWER);
			} else {
				throw new Error("The child repeated completed work or a correction request");
			}
		});
		const harness = createHarness(tempDir, createModel(peer.baseUrl));
		try {
			await harness.startParent();
			const original = harness.createOriginalChild();
			await peer.wait(original.agent.prompt("Finish the original task"));
			await original.waitForIdle();
			await harness.park();
			expect(harness.registry.get(harness.childId)).toMatchObject({ status: "parked", session: null });

			const revival = await harness.write(WAKE_BODY);
			expect(revival.isError).toBe(false);
			expect(revival.details?.message?.receipts).toEqual([{ to: harness.childId, outcome: "revived" }]);
			const liveSocket = await peer.wait(investigating.promise);
			const child = harness.registry.get(harness.childId)?.session;
			if (!child) throw new Error("The parked child was not restored");
			await peer.wait(harness.progressSeen);
			expect(child).not.toBe(original);
			expect(child.isStreaming).toBe(true);
			expect(incomingBodies(harness.parentRecords)).toEqual([FINDINGS_BODY]);

			const delivered = await harness.write(FIRST_CORRECTION);
			expect(delivered.isError).toBe(false);
			expect(delivered.details?.message?.receipts).toEqual([{ to: harness.childId, outcome: "injected" }]);
			expect(await peer.wait(steerReceived.promise)).toBe(liveSocket);
			// The second write arrives while the first native submission is unacknowledged.
			const second = await harness.write(SECOND_CORRECTION);
			expect(second.details?.message?.receipts).toEqual([{ to: harness.childId, outcome: "injected" }]);
			send(liveSocket, NATIVE_ERROR_FRAME, {
				type: "response.output_text.delta",
				item_id: "msg_resp_investigation",
				output_index: 0,
				delta: STREAMED_FINISH,
			});
			finishText(liveSocket, "resp_investigation", STREAMED_PROGRESS + STREAMED_FINISH);
			await peer.wait(child.waitForIdle());
			await child.waitForIrcReplies();

			expect(peer.frames.map(({ frame }) => frame.type)).toEqual([
				"response.create",
				"response.create",
				"response.create",
				"response.steer",
				"response.create",
			]);
			const steer = peer.frames[3]!.frame;
			expect(steer.previous_response_id).toBe("resp_investigation");
			expect(occurrences(inputTexts(steer), FIRST_CORRECTION)).toBe(1);
			expect(occurrences(inputTexts(steer), SECOND_CORRECTION)).toBe(0);
			const followUp = peer.frames[4]!;
			expect(followUp.socket).toBe(liveSocket);
			expect(followUp.frame.previous_response_id).toBeUndefined();
			const followUpInput = inputTexts(followUp.frame);
			expect(occurrences(followUpInput, FIRST_CORRECTION)).toBe(1);
			expect(occurrences(followUpInput, SECOND_CORRECTION)).toBe(1);
			expect(followUpInput.join("\n").indexOf(FIRST_CORRECTION)).toBeLessThan(
				followUpInput.join("\n").indexOf(SECOND_CORRECTION),
			);
			expect(occurrences(followUpInput, PRIOR_ANSWER)).toBe(1);
			expect(occurrences(followUpInput, STREAMED_PROGRESS + STREAMED_FINISH)).toBe(1);
			expect(harness.findings).toEqual([FINDINGS_BODY]);
			const assistants = child.messages.filter(message => message.role === "assistant");
			expect(assistants.map(messageText)).toEqual([
				PRIOR_ANSWER,
				FINDINGS_BODY,
				STREAMED_PROGRESS + STREAMED_FINISH,
				CORRECTED_ANSWER,
			]);
			expect(assistants.map(message => message.stopReason)).toEqual(["stop", "toolUse", "stop", "stop"]);
			const corrections = child.messages.filter(
				message =>
					message.role === "user" &&
					(messageText(message).includes(FIRST_CORRECTION) || messageText(message).includes(SECOND_CORRECTION)),
			);
			expect(corrections).toHaveLength(2);
			expect(corrections.map(message => message.role === "user" && message.liveSteered === true)).toEqual([
				false,
				false,
			]);
			expect(occurrences(corrections.map(messageText), FIRST_CORRECTION)).toBe(1);
			expect(occurrences(corrections.map(messageText), SECOND_CORRECTION)).toBe(1);
			const completedProgress = harness.messageEnds.findIndex(
				message => message.role === "assistant" && message.text === STREAMED_PROGRESS + STREAMED_FINISH,
			);
			const firstConsumedCorrection = harness.messageEnds.findIndex(
				message => message.role === "user" && message.text.includes(FIRST_CORRECTION),
			);
			const secondConsumedCorrection = harness.messageEnds.findIndex(
				message => message.role === "user" && message.text.includes(SECOND_CORRECTION),
			);
			expect(completedProgress).toBeGreaterThanOrEqual(0);
			expect(completedProgress).toBeLessThan(firstConsumedCorrection);
			expect(firstConsumedCorrection).toBeLessThan(secondConsumedCorrection);
			expect(harness.registry.get(harness.childId)?.status).toBe("idle");
			expect(harness.bus.inbox(harness.childId)).toEqual([]);
			expect(child.drainPendingIrcInboxMessages(harness.childId)).toEqual([]);
			// A prior interim reply suppresses only the redundant success relay, not failures.
			expect(incomingBodies(harness.parentRecords)).toEqual([FINDINGS_BODY]);
		} finally {
			try {
				await harness.close();
			} finally {
				peer.close();
			}
		}
	}, 20_000);

	it("reports the same native error when no steering submission owns it, without replaying the wake", async () => {
		await using tempDir = await TempDir.create("@omp-irc-native-error-owner-");
		const investigating = Promise.withResolvers<PeerSocket>();
		let creates = 0;
		const peer = createPeer((frame, socket) => {
			if (frame.type !== "response.create") throw new Error(`Unexpected client frame: ${frame.type}`);
			creates++;
			if (creates === 1) completeText(socket, "resp_prior", PRIOR_ANSWER);
			else if (creates === 2) {
				startText(socket, "resp_unowned_error", STREAMED_PROGRESS);
				investigating.resolve(socket);
			} else throw new Error("The wake replayed a response-scoped failure");
		});
		const harness = createHarness(tempDir, createModel(peer.baseUrl));
		try {
			await harness.startParent();
			const original = harness.createOriginalChild();
			await peer.wait(original.agent.prompt("Finish the original task"));
			await original.waitForIdle();
			await harness.park();
			const handoff = await harness.write(WAKE_BODY);
			expect(handoff.isError).toBe(false);
			expect(handoff.details?.message?.receipts).toEqual([{ to: harness.childId, outcome: "revived" }]);
			const socket = await peer.wait(investigating.promise);
			const child = harness.registry.get(harness.childId)?.session;
			if (!child) throw new Error("The parked child was not restored");
			await peer.wait(harness.progressSeen);
			send(socket, NATIVE_ERROR_FRAME);
			await peer.wait(child.waitForIdle());
			await child.waitForIrcReplies();

			const last = child.getLastAssistantMessage();
			expect(last?.stopReason).toBe("error");
			expect(last?.errorMessage).toContain(NATIVE_ERROR_CODE);
			expect(last && messageText(last)).toBe(STREAMED_PROGRESS);
			expect(peer.frames.map(({ frame }) => frame.type)).toEqual(["response.create", "response.create"]);
			const notifications = incomingBodies(harness.parentRecords);
			expect(notifications).toHaveLength(1);
			expect(notifications[0]).toContain(NATIVE_ERROR_CODE);
			expect(harness.bus.inbox(harness.childId)).toEqual([]);
			expect(child.drainPendingIrcInboxMessages(harness.childId)).toEqual([]);
		} finally {
			try {
				await harness.close();
			} finally {
				peer.close();
			}
		}
	}, 20_000);
});
