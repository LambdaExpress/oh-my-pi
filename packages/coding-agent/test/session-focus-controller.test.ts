import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionFocusController } from "@oh-my-pi/pi-coding-agent/modes/controllers/session-focus-controller";
import type { InteractiveModeContext, RenderInitialMessagesOptions } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

interface SessionStub {
	session: AgentSession;
	/** Emit an event through the listener captured by the last subscribe(). */
	emit: (event: unknown) => Promise<void>;
	unsubscribeCalls: () => number;
	setStreaming: (streaming: boolean) => void;
}

function makeSessionStub(opts: { isStreaming?: boolean } = {}): SessionStub {
	let listener: ((event: AgentSessionEvent) => Promise<void> | void) | undefined;
	let unsubscribeCalls = 0;
	const stub = {
		isStreaming: opts.isStreaming ?? false,
		subscribe(fn: (event: AgentSessionEvent) => Promise<void> | void) {
			listener = fn;
			return () => {
				unsubscribeCalls++;
			};
		},
		async settleInFlightMessagePersistence() {},
		activeToolExecutionUpdates: () => [],
	};
	return {
		session: stub as unknown as AgentSession,
		emit: async event => {
			if (!listener) throw new Error("no listener captured: subscribe() was never called");
			await listener(event as AgentSessionEvent);
		},
		unsubscribeCalls: () => unsubscribeCalls,
		setStreaming: streaming => {
			stub.isStreaming = streaming;
		},
	};
}

interface Harness {
	ctx: InteractiveModeContext;
	controller: SessionFocusController;
	registry: AgentRegistry;
	main: SessionStub;
	handledEvents: unknown[];
	setSessionCalls: Array<[AgentSession, string | undefined]>;
	reloadTodoSessions: AgentSession[];
	counts: {
		clearTransientSessionUi: () => number;
		resetTranscriptAnchors: () => number;
		renderInitialMessages: () => Array<{
			clearTerminalHistory?: boolean;
			recoverCompletedRuns?: boolean;
			recoverCompletedRunAnchor?: boolean;
		}>;
		recoverCompletedRunCollapses: () => Array<{ includeLatest: boolean }>;
		updatePendingMessagesDisplay: () => number;
		mainUnsubscribe: () => number;
	};
}

function makeHarness(
	options: { mainIsStreaming?: boolean; renderInitialMessages?: () => void | Promise<void> } = {},
): Harness {
	const main = makeSessionStub({ isStreaming: options.mainIsStreaming });
	const handledEvents: unknown[] = [];
	const setSessionCalls: Array<[AgentSession, string | undefined]> = [];
	const reloadTodoSessions: AgentSession[] = [];
	let clearTransientSessionUi = 0;
	let resetTranscriptAnchors = 0;
	const renderInitialMessages: Array<{
		clearTerminalHistory?: boolean;
		recoverCompletedRuns?: boolean;
		recoverCompletedRunAnchor?: boolean;
	}> = [];
	const recoverCompletedRunCollapses: Array<{ includeLatest: boolean }> = [];
	let updatePendingMessagesDisplay = 0;
	let mainUnsubscribe = 0;

	const ctx = {
		session: main.session,
		unsubscribe: () => {
			mainUnsubscribe++;
		},
		eventController: {
			handleEvent: async (event: unknown) => {
				handledEvents.push(event);
			},
			resetTranscriptAnchors: () => {
				resetTranscriptAnchors++;
			},
		},
		statusLine: {
			setSession: (session: AgentSession, focusedAgentId?: string) => {
				setSessionCalls.push([session, focusedAgentId]);
			},
			invalidate() {},
		},
		clearTransientSessionUi: () => {
			clearTransientSessionUi++;
		},
		renderInitialMessages: async (renderOptions?: RenderInitialMessagesOptions) => {
			renderInitialMessages.push(renderOptions ?? {});
			await options.renderInitialMessages?.();
		},
		recoverCompletedRunCollapses: (options: { includeLatest: boolean }) => {
			recoverCompletedRunCollapses.push(options);
			return false;
		},
		updatePendingMessagesDisplay: () => {
			updatePendingMessagesDisplay++;
		},
		reloadTodos: async (source?: AgentSession) => {
			reloadTodoSessions.push(source ?? main.session);
		},
		updateEditorBorderColor() {},
		ui: { requestRender() {} },
		showStatus() {},
		collabGuest: undefined,
	} as unknown as InteractiveModeContext;

	const registry = new AgentRegistry();
	const lifecycle = new AgentLifecycleManager(registry);
	const controller = new SessionFocusController(ctx, registry, () => lifecycle);

	return {
		ctx,
		controller,
		registry,
		main,
		handledEvents,
		setSessionCalls,
		reloadTodoSessions,
		counts: {
			clearTransientSessionUi: () => clearTransientSessionUi,
			resetTranscriptAnchors: () => resetTranscriptAnchors,
			renderInitialMessages: () => renderInitialMessages,
			recoverCompletedRunCollapses: () => recoverCompletedRunCollapses,
			updatePendingMessagesDisplay: () => updatePendingMessagesDisplay,
			mainUnsubscribe: () => mainUnsubscribe,
		},
	};
}

function registerSub(registry: AgentRegistry, id: string, session: AgentSession, parentId?: string) {
	return registry.register({ id, displayName: id, kind: "sub", parentId, session, status: "running" });
}

/** Settle the async unfocus chain (registry event → void unfocus() → #attach). */
async function flushAsync(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("SessionFocusController", () => {
	it("focusAgent retargets subscription, transcript anchors, and status line onto the worker session", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		await h.controller.focusAgent("Worker");

		expect(h.controller.focusedAgentId).toBe("Worker");
		expect(h.controller.target).toBe(worker.session);
		expect(h.counts.mainUnsubscribe()).toBe(1);
		expect(h.counts.clearTransientSessionUi()).toBe(1);
		expect(h.counts.resetTranscriptAnchors()).toBe(1);
		expect(h.counts.renderInitialMessages()).toEqual([
			{ clearTerminalHistory: true, recoverCompletedRunAnchor: true },
		]);
		expect(h.counts.recoverCompletedRunCollapses()).toEqual([{ includeLatest: true }]);
		expect(h.reloadTodoSessions).toEqual([worker.session]);
		expect(h.setSessionCalls).toEqual([[worker.session, "Worker"]]);

		const event = { type: "message_start", message: { role: "user" } };
		await worker.emit(event);
		expect(h.handledEvents).toEqual([event]);
	});

	it("re-attaching the main session refreshes the todo HUD so it can't freeze at the pre-focus snapshot (#9571)", async () => {
		// While a subagent is focused the main session's `todo` completions never
		// reach the HUD (the event subscription points at the subagent). Returning
		// to the main session rebuilds the transcript from committed messages but
		// must also reload the HUD, or it stays stuck on the pre-focus snapshot
		// (e.g. a `todo init` 0/N) while the transcript shows current progress.
		const h = makeHarness();
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		await h.controller.focusAgent("Worker");
		expect(h.reloadTodoSessions).toEqual([worker.session]);

		await h.controller.unfocus();
		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.setSessionCalls.at(-1)).toEqual([h.main.session, undefined]);
		expect(h.reloadTodoSessions).toEqual([worker.session, h.main.session]);
	});

	it("does not let a superseded focus attachment restore the worker todo HUD after unfocusing", async () => {
		let releaseWorkerRender: (() => void) | undefined;
		let markWorkerRenderStarted: (() => void) | undefined;
		const workerRender = new Promise<void>(resolve => {
			releaseWorkerRender = resolve;
		});
		const workerRenderStarted = new Promise<void>(resolve => {
			markWorkerRenderStarted = resolve;
		});
		let renderCalls = 0;
		const h = makeHarness({
			renderInitialMessages: () => {
				renderCalls++;
				if (renderCalls !== 1) return;
				markWorkerRenderStarted?.();
				return workerRender;
			},
		});
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		const focus = h.controller.focusAgent("Worker");
		await workerRenderStarted;
		await h.controller.unfocus();
		expect(h.reloadTodoSessions).toEqual([h.main.session]);

		releaseWorkerRender?.();
		await focus;
		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.setSessionCalls.at(-1)).toEqual([h.main.session, undefined]);
		expect(h.reloadTodoSessions).toEqual([h.main.session]);
	});

	it("mid-turn attach synthesizes agent_start, and an orphaned assistant message_update gets a synthesized message_start", async () => {
		const h = makeHarness();
		const worker = makeSessionStub({ isStreaming: true });
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		await h.controller.focusAgent("Worker");
		expect(h.handledEvents).toEqual([{ type: "agent_start" }]);

		const message = { role: "assistant", content: "partial" };
		await worker.emit({ type: "message_update", message });
		expect(h.handledEvents.slice(1)).toEqual([
			{ type: "message_start", message },
			{ type: "message_update", message },
		]);

		// Guard fires once: subsequent updates pass through unsynthesized.
		await worker.emit({ type: "message_update", message });
		expect(h.handledEvents.slice(3)).toEqual([{ type: "message_update", message }]);
	});

	it("focusParent walks parentId to a registered non-main agent, then re-attaches the main session", async () => {
		const h = makeHarness();
		const parent = makeSessionStub();
		const worker = makeSessionStub();
		registerSub(h.registry, "Parent", parent.session, MAIN_AGENT_ID);
		registerSub(h.registry, "Worker", worker.session, "Parent");

		await h.controller.focusAgent("Worker");
		await h.controller.focusParent();
		expect(h.controller.focusedAgentId).toBe("Parent");
		expect(h.setSessionCalls).toEqual([
			[worker.session, "Worker"],
			[parent.session, "Parent"],
		]);

		// Parent's parent is Main → unfocus back to ctx.session.
		await h.controller.focusParent();
		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.controller.target).toBeUndefined();
		expect(h.setSessionCalls).toEqual([
			[worker.session, "Worker"],
			[parent.session, "Parent"],
			[h.main.session, undefined],
		]);
	});

	it("parking the focused agent auto-unfocuses back to the main session", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		await h.controller.focusAgent("Worker");
		expect(h.controller.focusedAgentId).toBe("Worker");

		h.registry.setStatus("Worker", "parked");
		await flushAsync();

		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.setSessionCalls).toEqual([
			[worker.session, "Worker"],
			[h.main.session, undefined],
		]);
	});

	it("rebuilds the pending bar on every attach so queued steer/follow-up chips survive a focus round-trip", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		// Focus swaps the pending bar onto the worker view session…
		await h.controller.focusAgent("Worker");
		expect(h.counts.updatePendingMessagesDisplay()).toBe(1);

		// …and returning re-attaches the main session, restoring the main
		// session's queued messages instead of leaving the bar empty.
		await h.controller.unfocus();
		expect(h.counts.updatePendingMessagesDisplay()).toBe(2);
	});

	it("recovers the main run anchor after a mid-run focus round-trip", async () => {
		const h = makeHarness({ mainIsStreaming: true });
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		await h.controller.focusAgent("Worker");
		await h.controller.unfocus();

		expect(h.counts.renderInitialMessages()).toEqual([
			{ clearTerminalHistory: true, recoverCompletedRunAnchor: true },
			{ clearTerminalHistory: true, recoverCompletedRunAnchor: true },
		]);
	});
});
describe("AgentSession tool display snapshots", () => {
	it("retains live Task progress until its authoritative tool result arrives", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
		});
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		const toolCallId = "task-focus-return";
		const args = { tasks: [{ assignment: "Trace the running Task." }], agent: "scout" };
		const partialResult = {
			content: [{ type: "text" as const, text: "running" }],
			details: { progress: [{ id: "FocusResearch", requests: 7 }] },
		};

		try {
			agent.emitExternalEvent({
				type: "tool_execution_start",
				toolCallId,
				toolName: "task",
				args,
			});
			agent.emitExternalEvent({
				type: "tool_execution_update",
				toolCallId,
				toolName: "task",
				args,
				partialResult,
			});

			const running = session.getToolExecutionDisplaySnapshots().get(toolCallId);
			expect(running?.result).toEqual(partialResult);
			expect(running?.isPartial).toBe(true);

			const finalResult = {
				content: [{ type: "text" as const, text: "finished" }],
				details: { results: [{ id: "FocusResearch", output: "done" }] },
			};
			agent.emitExternalEvent({
				type: "tool_execution_end",
				toolCallId,
				toolName: "task",
				result: finalResult,
				isError: false,
			});
			expect(session.getToolExecutionDisplaySnapshots().get(toolCallId)?.isPartial).toBe(false);

			agent.emitExternalEvent({
				type: "message_end",
				message: {
					role: "toolResult",
					toolCallId,
					toolName: "task",
					content: finalResult.content,
					details: finalResult.details,
					isError: false,
					timestamp: Date.now(),
				},
			});
			expect(session.getToolExecutionDisplaySnapshots().has(toolCallId)).toBe(false);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
});
