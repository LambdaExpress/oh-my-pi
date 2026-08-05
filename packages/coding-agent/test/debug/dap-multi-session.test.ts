import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { DapClient, DapRequestRejectedError } from "@oh-my-pi/pi-coding-agent/dap/client";
import { DapSessionManager } from "@oh-my-pi/pi-coding-agent/dap/session";
import type {
	DapCapabilities,
	DapClientState,
	DapEventMessage,
	DapResolvedAdapter,
	DapScope,
	DapStackFrame,
	DapThread,
	DapVariable,
} from "@oh-my-pi/pi-coding-agent/dap/types";

const TEST_ADAPTER: DapResolvedAdapter = {
	name: "js-debug-adapter",
	command: "node",
	args: ["dapDebugServer.js", "$" + "{port}", "127.0.0.1"],
	resolvedCommand: "node",
	languages: ["javascript", "typescript"],
	fileTypes: [".js", ".ts"],
	rootMarkers: ["package.json"],
	launchDefaults: { request: "launch", type: "pwa-node", stopOnEntry: true },
	attachDefaults: { request: "attach", type: "pwa-node" },
	connectMode: "tcp",
	acceptsDirectoryProgram: false,
};

type EventHandler = (body: unknown, event: DapEventMessage) => void | Promise<void>;
type ReverseHandler = (args: unknown) => unknown | Promise<unknown>;

interface FakeOptions {
	/** Threads returned by this session's `threads` request. */
	threads?: DapThread[];
	/** Thread id reported by the synthetic `stopped` event (defaults to 7). */
	stopThreadId?: number;
}

class FakeDapClient {
	readonly proc: DapClientState["proc"];
	readonly port = 8123;
	readonly requests: Array<{ command: string; args: unknown }> = [];
	readonly #events = new Map<string, Set<EventHandler>>();
	readonly #reverseHandlers = new Map<string, ReverseHandler>();
	readonly #exited = Promise.withResolvers<void>();
	#alive = true;
	disposed = false;
	#nextContinueStop?: Record<string, unknown>;
	#nextContinueError?: Error;
	#threads: DapThread[] = [{ id: 7, name: "target.js" }];
	#stackFrames: DapStackFrame[] = [{ id: 70, name: "main", line: 2, column: 1, source: { path: "/tmp/target.js" } }];
	#totalFrames?: number;
	#scopes: DapScope[] = [];
	#variables = new Map<number, DapVariable[]>();
	#variableErrors = new Map<number, Error>();
	#requestGates = new Map<string, { promise: Promise<void>; resolve: () => void; markEntered: () => void }>();
	#stopDuringRequest?: { command: string; stopped: Record<string, unknown> };
	#capabilities: DapCapabilities = { supportsConfigurationDoneRequest: true };

	constructor(
		readonly childConfiguration?: Record<string, unknown>,
		readonly childRequest: "launch" | "attach" = "launch",
		readonly stopOnStart = true,
		readonly options: FakeOptions = {},
	) {
		this.proc = {
			exited: this.#exited.promise,
			exitCode: null,
			stdin: { write: () => 0, flush: () => undefined },
			stdout: new ReadableStream<Uint8Array>(),
			stderr: new ReadableStream<Uint8Array>(),
			peekStderr: () => "",
			kill: () => {
				this.#alive = false;
				this.#exited.resolve();
				return true;
			},
		} as unknown as DapClientState["proc"];
	}

	async initialize(): Promise<DapCapabilities> {
		queueMicrotask(() => this.#emit("initialized", {}));
		return this.#capabilities;
	}

	async sendRequest(command: string, args?: unknown): Promise<unknown> {
		this.requests.push({ command, args });
		const gate = this.#requestGates.get(command);
		if (gate) {
			this.#requestGates.delete(command);
			gate.markEntered();
			await gate.promise;
		}
		const injectedStop = this.#stopDuringRequest;
		if (injectedStop?.command === command) {
			this.#stopDuringRequest = undefined;
			this.#emit("stopped", injectedStop.stopped);
		}
		if (command === "launch") {
			if (this.childConfiguration) {
				queueMicrotask(() => {
					void this.#emitReverse("startDebugging", {
						request: this.childRequest,
						configuration: this.childConfiguration,
					});
				});
			} else if (this.stopOnStart) {
				queueMicrotask(() => this.#emit("stopped", { reason: "entry", threadId: this.options.stopThreadId ?? 7 }));
			}
		}
		if (command === "continue") {
			const error = this.#nextContinueError;
			this.#nextContinueError = undefined;
			if (error) throw error;
			const stopped = this.#nextContinueStop;
			this.#nextContinueStop = undefined;
			if (stopped) this.#emit("stopped", stopped);
		}
		if (command === "threads") return { threads: this.options.threads ?? this.#threads };
		if (command === "stackTrace") {
			return { stackFrames: this.#stackFrames, totalFrames: this.#totalFrames };
		}
		if (command === "scopes") return { scopes: this.#scopes };
		if (command === "variables") {
			const variablesReference = (args as { variablesReference?: number } | undefined)?.variablesReference;
			if (variablesReference === undefined) throw new Error("variablesReference missing");
			const error = this.#variableErrors.get(variablesReference);
			if (error) throw error;
			return { variables: this.#variables.get(variablesReference) ?? [] };
		}
		if (command.endsWith("Breakpoints")) {
			const breakpointArgs = args as { breakpoints?: unknown[] } | undefined;
			return { breakpoints: (breakpointArgs?.breakpoints ?? []).map((_, id) => ({ id, verified: true })) };
		}
		return {};
	}

	waitForEvent(event: string): Promise<unknown> {
		const { promise, resolve } = Promise.withResolvers<unknown>();
		const unsubscribe = this.onEvent(event, body => {
			unsubscribe();
			resolve(body);
		});
		return promise;
	}

	onEvent(event: string, handler: EventHandler): () => void {
		const handlers = this.#events.get(event) ?? new Set<EventHandler>();
		handlers.add(handler);
		this.#events.set(event, handlers);
		return () => handlers.delete(handler);
	}

	onReverseRequest(command: string, handler: ReverseHandler): () => void {
		this.#reverseHandlers.set(command, handler);
		return () => this.#reverseHandlers.delete(command);
	}

	isAlive(): boolean {
		return this.#alive;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.#alive = false;
		this.#exited.resolve();
	}

	stopBeforeNextContinueResponse(stopped: Record<string, unknown>): void {
		this.#nextContinueStop = stopped;
	}

	rejectNextContinue(error: Error): void {
		this.#nextContinueError = error;
	}

	setThreads(threads: DapThread[]): void {
		this.#threads = threads;
	}
	setCapabilities(capabilities: DapCapabilities): void {
		this.#capabilities = { supportsConfigurationDoneRequest: true, ...capabilities };
	}

	setStackFrames(stackFrames: DapStackFrame[], totalFrames?: number): void {
		this.#stackFrames = stackFrames;
		this.#totalFrames = totalFrames;
	}

	setScopes(scopes: DapScope[]): void {
		this.#scopes = scopes;
	}

	setVariables(variablesReference: number, variables: DapVariable[]): void {
		this.#variables.set(variablesReference, variables);
	}

	failVariables(variablesReference: number, error: Error): void {
		this.#variableErrors.set(variablesReference, error);
	}

	stopOnRequest(command: string, stopped: Record<string, unknown>): void {
		this.#stopDuringRequest = { command, stopped };
	}

	holdNextRequest(command: string): { entered: Promise<void>; release: () => void } {
		const release = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		this.#requestGates.set(command, {
			promise: release.promise,
			resolve: release.resolve,
			markEntered: entered.resolve,
		});
		return { entered: entered.promise, release: release.resolve };
	}

	async exitAdapter(): Promise<void> {
		this.#alive = false;
		this.#exited.resolve();
		await Promise.resolve();
	}

	#emit(event: string, body: unknown): void {
		const message: DapEventMessage = { seq: 1, type: "event", event, body };
		for (const handler of this.#events.get(event) ?? []) void handler(body, message);
	}

	emit(event: string, body: unknown): void {
		this.#emit(event, body);
	}

	async startChild(configuration: Record<string, unknown>, request: "launch" | "attach" = "launch"): Promise<void> {
		await this.#emitReverse("startDebugging", { request, configuration });
	}

	/** Drive an adapter-initiated reverse request (e.g. a late `startDebugging`). */
	async triggerReverse(command: string, args: unknown): Promise<void> {
		await this.#emitReverse(command, args);
	}

	async #emitReverse(command: string, args: unknown): Promise<void> {
		const handler = this.#reverseHandlers.get(command);
		if (!handler) throw new Error(`Missing reverse handler for ${command}`);
		await handler(args);
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("DAP multi-session debugging", () => {
	it("routes recursive js-debug children, breakpoints, and termination through one session tree", async () => {
		const root = new FakeDapClient({
			name: "target.js",
			type: "pwa-node",
			__pendingTargetId: "child",
			program: "/tmp/target.js",
		});
		const child = new FakeDapClient({
			name: "[worker 1]",
			type: "pwa-node",
			__pendingTargetId: "grandchild",
		});
		const grandchild = new FakeDapClient();
		const children = [child, grandchild];
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		spyOn(DapClient, "connect").mockImplementation(async () => {
			const next = children.shift();
			if (!next) throw new Error("Unexpected child DAP connection");
			return next as unknown as DapClient;
		});
		const manager = new DapSessionManager();

		const launched = await manager.launch(
			{ adapter: TEST_ADAPTER, program: "/tmp/target.js", cwd: "/tmp" },
			undefined,
			1_000,
		);

		expect(launched.status).toBe("stopped");
		expect(launched.parentSessionId).toBeDefined();
		expect(launched.line).toBe(2);
		expect(manager.listSessions()).toHaveLength(3);

		const breakpoint = await manager.setBreakpoint("/tmp/target.js", 2, undefined, undefined, 1_000);
		expect(breakpoint.breakpoints).toEqual([
			{ line: 2, condition: undefined, id: 0, verified: true, message: undefined },
		]);
		for (const client of [root, child, grandchild]) {
			expect(client.requests.filter(request => request.command === "setBreakpoints")).toHaveLength(1);
		}

		await manager.terminate(undefined, 1_000);
		expect(manager.listSessions()).toEqual([]);
		for (const client of [root, child, grandchild]) {
			expect(client.requests.some(request => request.command === "disconnect")).toBe(true);
			expect(client.disposed).toBe(true);
		}
	});

	it("targets a running attach child before it emits a stopped event", async () => {
		const root = new FakeDapClient(
			{
				name: "attached.js",
				type: "pwa-node",
				__pendingTargetId: "attached-child",
			},
			"attach",
			true,
			// Threadless launcher: answers `threads` with an empty list.
			{ threads: [] },
		);
		const child = new FakeDapClient(undefined, "launch", false);
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		spyOn(DapClient, "connect").mockResolvedValue(child as unknown as DapClient);
		const manager = new DapSessionManager();

		await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/attached.js", cwd: "/tmp" }, undefined, 25);
		const active = manager.getActiveSession();
		const threads = await manager.threads(undefined, 100);

		expect(active?.parentSessionId).toBeDefined();
		expect(threads.threads).toEqual([{ id: 7, name: "target.js" }]);
		expect(child.requests.filter(request => request.command === "threads")).toHaveLength(1);
		// The root is queried too (no topology guess), but being threadless it
		// contributes nothing.
		expect(root.requests.filter(request => request.command === "threads")).toHaveLength(1);

		await manager.terminate(undefined, 100);
	});

	it("reactivates a live session when the active child terminates", async () => {
		const root = new FakeDapClient({
			name: "target.js",
			type: "pwa-node",
			__pendingTargetId: "child",
		});
		const child = new FakeDapClient();
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		spyOn(DapClient, "connect").mockResolvedValue(child as unknown as DapClient);
		const manager = new DapSessionManager();

		const launched = await manager.launch(
			{ adapter: TEST_ADAPTER, program: "/tmp/target.js", cwd: "/tmp" },
			undefined,
			1_000,
		);
		expect(launched.parentSessionId).toBeDefined();

		child.emit("terminated", {});
		await child.dispose();

		const active = manager.getActiveSession();
		expect(active).not.toBeNull();
		expect(active?.id).not.toBe(launched.id);
		expect(active?.status).not.toBe("terminated");

		const threads = await manager.threads(undefined, 100);
		expect(threads.threads).toEqual([{ id: 7, name: "target.js" }]);
		expect(root.requests.filter(request => request.command === "threads")).toHaveLength(1);

		await manager.terminate(undefined, 100);
	});

	it("late-reads a stop after non-blocking continue returns", async () => {
		const root = new FakeDapClient();
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		const manager = new DapSessionManager();

		await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/target.js", cwd: "/tmp" }, undefined, 1_000);
		const started = await manager.startContinue(undefined, 1_000);
		expect(started).toMatchObject({ executionId: "exec_1", state: "running" });

		root.emit("stopped", {
			reason: "breakpoint",
			threadId: 7,
			description: "request handler",
			hitBreakpointIds: [42],
		});
		const outcome = await manager.waitForExecution(started.executionId, undefined, 1_000);

		expect(outcome).toMatchObject({
			executionId: "exec_1",
			reason: "stopped",
			state: "stopped",
			timedOut: false,
			sourceSessionId: started.snapshot.id,
			stoppedEvent: {
				reason: "breakpoint",
				threadId: 7,
				description: "request handler",
				hitBreakpointIds: [42],
			},
		});
		await manager.terminate(undefined, 100);
	});

	it("keeps an execution late-readable across timeout and abort", async () => {
		const root = new FakeDapClient();
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		const manager = new DapSessionManager();

		await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/target.js", cwd: "/tmp" }, undefined, 1_000);
		const started = await manager.startContinue(undefined, 1_000);
		const timedOut = await manager.waitForExecution(started.executionId, undefined, 1);
		expect(timedOut).toMatchObject({ executionId: "exec_1", reason: "timeout", timedOut: true });

		const abortController = new AbortController();
		abortController.abort(new Error("cancel this observation"));
		await expect(manager.waitForExecution(started.executionId, abortController.signal, 1_000)).rejects.toThrow(
			"cancel this observation",
		);

		root.emit("stopped", { reason: "breakpoint", threadId: 7 });
		const retried = await manager.waitForExecution(started.executionId, undefined, 1_000);
		expect(retried).toMatchObject({ executionId: "exec_1", reason: "stopped", timedOut: false });
		await manager.terminate(undefined, 100);
	});

	it("settles an execution with the target exit source", async () => {
		const root = new FakeDapClient();
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		const manager = new DapSessionManager();

		await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/target.js", cwd: "/tmp" }, undefined, 1_000);
		const started = await manager.startContinue(undefined, 1_000);
		root.emit("exited", { exitCode: 17 });
		const outcome = await manager.waitForExecution(started.executionId, undefined, 1_000);

		expect(outcome).toMatchObject({
			executionId: "exec_1",
			reason: "exited",
			state: "terminated",
			sourceSessionId: started.snapshot.id,
			exitCode: 17,
		});
		await manager.terminate(undefined, 100);
	});

	it("ignores an unrelated sibling termination while the control target stays live", async () => {
		const root = new FakeDapClient({ name: "first.js", type: "pwa-node" });
		const firstChild = new FakeDapClient();
		const secondChild = new FakeDapClient();
		const children = [firstChild, secondChild];
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		spyOn(DapClient, "connect").mockImplementation(async () => {
			const next = children.shift();
			if (!next) throw new Error("Unexpected child DAP connection");
			return next as unknown as DapClient;
		});
		const manager = new DapSessionManager();

		await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/root.js", cwd: "/tmp" }, undefined, 1_000);
		await root.startChild({ name: "second.js", type: "pwa-node" });
		const started = await manager.startContinue(undefined, 1_000);

		firstChild.emit("terminated", {});
		const stillRunning = await manager.waitForExecution(started.executionId, undefined, 1);
		expect(stillRunning).toMatchObject({ reason: "timeout", state: "running", timedOut: true });

		secondChild.emit("stopped", { reason: "breakpoint", threadId: 7 });
		const stopped = await manager.waitForExecution(started.executionId, undefined, 1_000);
		expect(stopped).toMatchObject({
			reason: "stopped",
			sourceSessionId: started.snapshot.id,
			targetSessionId: started.snapshot.id,
		});
		await manager.terminate(undefined, 100);
	});

	it("latches a stop emitted before the continue response", async () => {
		const root = new FakeDapClient();
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		const manager = new DapSessionManager();

		await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/target.js", cwd: "/tmp" }, undefined, 1_000);
		root.stopBeforeNextContinueResponse({ reason: "breakpoint", threadId: 7, hitBreakpointIds: [9] });
		const started = await manager.startContinue(undefined, 1_000);
		expect(started).toMatchObject({ executionId: "exec_1", state: "stopped" });

		const outcome = await manager.waitForExecution(started.executionId, undefined, 1_000);
		expect(outcome).toMatchObject({
			reason: "stopped",
			stoppedEvent: { reason: "breakpoint", threadId: 7, hitBreakpointIds: [9] },
		});
		await manager.terminate(undefined, 100);
	});

	it("settles a wait that was already observing when the stop arrives", async () => {
		const root = new FakeDapClient();
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		const manager = new DapSessionManager();

		await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/target.js", cwd: "/tmp" }, undefined, 1_000);
		const started = await manager.startContinue(undefined, 1_000);
		const waiting = manager.waitForExecution(started.executionId, undefined, 1_000);
		root.emit("stopped", { reason: "step", threadId: 7 });

		await expect(waiting).resolves.toMatchObject({
			executionId: "exec_1",
			reason: "stopped",
			stoppedEvent: { reason: "step", threadId: 7 },
		});
		await manager.terminate(undefined, 100);
	});

	it("does not let the previous stop satisfy a new execution and rejects concurrent control", async () => {
		const root = new FakeDapClient();
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		const manager = new DapSessionManager();

		const launched = await manager.launch(
			{ adapter: TEST_ADAPTER, program: "/tmp/target.js", cwd: "/tmp" },
			undefined,
			1_000,
		);
		expect(launched.stopReason).toBe("entry");
		const started = await manager.startContinue(undefined, 1_000);
		expect(manager.getExecutionOutcome(started.executionId)).toBeNull();
		await expect(manager.startContinue(undefined, 1_000)).rejects.toThrow(
			"Debug target debug-1 is already running under execution exec_1.",
		);
		await expect(manager.waitForExecution(started.executionId, undefined, 1)).resolves.toMatchObject({
			reason: "timeout",
			timedOut: true,
		});

		root.emit("stopped", { reason: "breakpoint", threadId: 7 });
		await manager.waitForExecution(started.executionId, undefined, 1_000);
		await manager.terminate(undefined, 100);
	});

	it("rolls back state and removes the record after an explicit continue rejection", async () => {
		const root = new FakeDapClient();
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		const manager = new DapSessionManager();

		await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/target.js", cwd: "/tmp" }, undefined, 1_000);
		root.rejectNextContinue(new DapRequestRejectedError("continue", "continue rejected"));
		await expect(manager.startContinue(undefined, 1_000)).rejects.toThrow("continue rejected");
		expect(manager.getExecutionOutcome("exec_1")).toBeNull();
		expect(manager.getActiveSession()).toMatchObject({ status: "stopped", stopReason: "entry", threadId: 7 });

		root.stopBeforeNextContinueResponse({ reason: "breakpoint", threadId: 7 });
		const retried = await manager.startContinue(undefined, 1_000);
		expect(retried.executionId).toBe("exec_2");
		await manager.waitForExecution(retried.executionId, undefined, 1_000);
		await manager.terminate(undefined, 100);
	});

	it("retains an uncertain execution and exposes its id after a transport failure", async () => {
		const root = new FakeDapClient();
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		const manager = new DapSessionManager();

		await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/target.js", cwd: "/tmp" }, undefined, 1_000);
		root.rejectNextContinue(new Error("connection closed"));
		await expect(manager.startContinue(undefined, 1_000)).rejects.toThrow(
			'connection closed Debug execution exec_1 may have started; call wait_for_stop with execution_id="exec_1".',
		);
		expect(manager.getExecutionOutcome("exec_1")).toBeNull();

		root.emit("stopped", { reason: "breakpoint", threadId: 7 });
		await expect(manager.waitForExecution("exec_1", undefined, 1_000)).resolves.toMatchObject({
			reason: "stopped",
		});
		await manager.terminate(undefined, 100);
	});

	it("settles on a target terminated event", async () => {
		const root = new FakeDapClient();
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		const manager = new DapSessionManager();

		await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/target.js", cwd: "/tmp" }, undefined, 1_000);
		const started = await manager.startContinue(undefined, 1_000);
		root.emit("terminated", {});

		await expect(manager.waitForExecution(started.executionId, undefined, 1_000)).resolves.toMatchObject({
			reason: "terminated",
			state: "terminated",
			sourceSessionId: started.snapshot.id,
		});
		await manager.terminate(undefined, 100);
	});

	it("settles on adapter process exit", async () => {
		const root = new FakeDapClient();
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		const manager = new DapSessionManager();

		await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/target.js", cwd: "/tmp" }, undefined, 1_000);
		const started = await manager.startContinue(undefined, 1_000);
		const waiting = manager.waitForExecution(started.executionId, undefined, 1_000);
		await root.exitAdapter();

		await expect(waiting).resolves.toMatchObject({
			reason: "adapter_exit",
			state: "terminated",
			sourceSessionId: started.snapshot.id,
		});
		await manager.terminate(undefined, 100);
	});

	it("settles an active observer before session disposal removes the record", async () => {
		const root = new FakeDapClient();
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		const manager = new DapSessionManager();

		await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/target.js", cwd: "/tmp" }, undefined, 1_000);
		const started = await manager.startContinue(undefined, 1_000);
		const waiting = manager.waitForExecution(started.executionId, undefined, 1_000);
		await manager.terminate(undefined, 100);

		await expect(waiting).resolves.toMatchObject({
			reason: "session_disposed",
			state: "terminated",
			sourceSessionId: started.snapshot.id,
		});
		expect(manager.listSessions()).toEqual([]);
	});

	it("preserves the child source when another tree member initiated control", async () => {
		const root = new FakeDapClient({ name: "child.js", type: "pwa-node" });
		const child = new FakeDapClient();
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		spyOn(DapClient, "connect").mockResolvedValue(child as unknown as DapClient);
		const manager = new DapSessionManager();

		await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/root.js", cwd: "/tmp" }, undefined, 1_000);
		const childSession = manager.listSessions().find(session => session.parentSessionId !== undefined);
		expect(childSession).toBeDefined();
		root.emit("stopped", { reason: "pause", threadId: 7 });
		const started = await manager.startContinue(undefined, 1_000);
		expect(started.snapshot.parentSessionId).toBeUndefined();

		child.emit("stopped", { reason: "breakpoint", threadId: 7 });
		await expect(manager.waitForExecution(started.executionId, undefined, 1_000)).resolves.toMatchObject({
			reason: "stopped",
			sourceSessionId: childSession?.id,
			targetSessionId: started.snapshot.id,
		});
		await manager.terminate(undefined, 100);
	});

	it("captures a bounded snapshot from the child that actually stopped", async () => {
		const root = new FakeDapClient({ name: "child.js", type: "pwa-node" });
		const child = new FakeDapClient();
		child.setCapabilities({ supportsVariablePaging: true });
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		spyOn(DapClient, "connect").mockResolvedValue(child as unknown as DapClient);
		const manager = new DapSessionManager();

		await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/root.js", cwd: "/tmp" }, undefined, 1_000);
		const childSession = manager.listSessions().find(session => session.parentSessionId !== undefined);
		if (!childSession) throw new Error("Expected a child session");
		root.emit("stopped", { reason: "pause", threadId: 7 });
		const started = await manager.startContinue(undefined, 1_000);

		child.setThreads(Array.from({ length: 60 }, (_, index) => ({ id: index + 7, name: `fresh-thread-${index}` })));
		child.setStackFrames(
			Array.from({ length: 25 }, (_, index) => ({
				id: 700 + index,
				name: `frame-${index}`,
				line: index + 1,
				column: 1,
				source: { path: `/tmp/source-${index}.ts` },
			})),
			100,
		);
		child.setScopes([
			{ name: "Registers", presentationHint: "registers", variablesReference: 30, expensive: false },
			{ name: "Expensive", variablesReference: 99, expensive: true },
			{ name: "Other", variablesReference: 40, expensive: false },
			{ name: "Locals", presentationHint: "locals", variablesReference: 20, expensive: false },
			{ name: "Arguments", presentationHint: "arguments", variablesReference: 10, expensive: false },
			{ name: "Extra", variablesReference: 50, expensive: false },
		]);
		child.setVariables(
			10,
			Array.from({ length: 55 }, (_, index) => ({
				name: `argument-${index}`,
				value: index === 0 ? "v".repeat(2_100) : String(index),
				variablesReference: 0,
			})),
		);
		child.setVariables(20, [{ name: "local", value: "ok", variablesReference: 0 }]);
		child.setVariables(30, [{ name: "register", value: "0x1", variablesReference: 0 }]);
		child.setVariables(40, [{ name: "other", value: "value", variablesReference: 0 }]);
		root.requests.length = 0;
		child.requests.length = 0;

		const stoppedEvent = {
			reason: "breakpoint",
			description: "request handler",
			threadId: 7,
			preserveFocusHint: true,
			text: "breakpoint condition matched",
			allThreadsStopped: true,
			hitBreakpointIds: [3, 4],
		};
		child.emit("output", { output: `${"x".repeat(17 * 1024)}TAIL` });
		child.emit("stopped", stoppedEvent);
		const outcome = await manager.waitForExecution(started.executionId, undefined, 1_000);
		const snapshot = outcome.stopSnapshot;
		if (!snapshot) throw new Error("Expected a stop snapshot");

		expect(snapshot.complete).toBe(true);
		expect(snapshot.sessionId).toBe(childSession.id);
		expect(snapshot.stoppedEvent).toEqual(stoppedEvent);
		expect(snapshot.threads).toHaveLength(50);
		expect(snapshot.threads[0]?.name).toBe("fresh-thread-0");
		expect(snapshot.threadsTruncated).toBe(true);
		expect(snapshot.stackFrames).toHaveLength(20);
		expect(snapshot.stackFramesTruncated).toBe(true);
		expect(snapshot.totalFrames).toBe(100);
		expect(snapshot.scopes.map(entry => entry.scope.name)).toEqual(["Arguments", "Locals", "Registers", "Other"]);
		expect(snapshot.scopesTruncated).toBe(true);
		expect(snapshot.scopes[0]).toMatchObject({
			variablesTruncated: true,
			truncatedValueCount: 1,
		});
		expect(snapshot.scopes[0]?.variables).toHaveLength(50);
		expect(snapshot.scopes[0]?.variables[0]?.value).toHaveLength(2_000);
		expect(Buffer.byteLength(snapshot.output, "utf-8")).toBeLessThanOrEqual(16 * 1024);
		expect(snapshot.output.endsWith("TAIL")).toBe(true);
		expect(snapshot.outputTruncated).toBe(true);
		expect(root.requests).toEqual([]);
		expect(child.requests.map(request => request.command)).toEqual([
			"threads",
			"stackTrace",
			"scopes",
			"variables",
			"variables",
			"variables",
			"variables",
		]);
		expect(child.requests.find(request => request.command === "variables")?.args).toEqual({
			variablesReference: 10,
			start: 0,
			count: 50,
		});
		await manager.terminate(undefined, 100);
	});

	it("omits variable paging for adapters that do not advertise it", async () => {
		const root = new FakeDapClient();
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		const manager = new DapSessionManager();

		await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/target.js", cwd: "/tmp" }, undefined, 1_000);
		root.setScopes([{ name: "Locals", presentationHint: "locals", variablesReference: 20, expensive: false }]);
		root.setVariables(
			20,
			Array.from({ length: 51 }, (_, index) => ({
				name: `local-${index}`,
				value: String(index),
				variablesReference: 0,
			})),
		);
		root.requests.length = 0;
		const started = await manager.startContinue(undefined, 1_000);
		root.emit("stopped", { reason: "breakpoint", threadId: 7 });

		const outcome = await manager.waitForExecution(started.executionId, undefined, 1_000);
		expect(root.requests.find(request => request.command === "variables")?.args).toEqual({
			variablesReference: 20,
		});
		expect(outcome.stopSnapshot?.scopes[0]).toMatchObject({
			variablesTruncated: true,
		});
		expect(outcome.stopSnapshot?.scopes[0]?.variables).toHaveLength(50);
		await manager.terminate(undefined, 100);
	});

	it("returns retained data and a structured error when one scope variable request fails", async () => {
		const root = new FakeDapClient();
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		const manager = new DapSessionManager();

		await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/target.js", cwd: "/tmp" }, undefined, 1_000);
		root.setScopes([
			{ name: "Arguments", presentationHint: "arguments", variablesReference: 10, expensive: false },
			{ name: "Locals", presentationHint: "locals", variablesReference: 20, expensive: false },
		]);
		root.setVariables(10, [{ name: "request", value: "kept", variablesReference: 0 }]);
		root.failVariables(20, new Error("locals unavailable"));
		const started = await manager.startContinue(undefined, 1_000);
		root.emit("stopped", { reason: "breakpoint", threadId: 7 });

		const outcome = await manager.waitForExecution(started.executionId, undefined, 1_000);
		expect(outcome.reason).toBe("stopped");
		expect(outcome.timedOut).toBe(false);
		expect(outcome.stopSnapshot).toMatchObject({
			complete: false,
			scopes: [
				{ scope: { name: "Arguments" }, variables: [{ name: "request", value: "kept" }] },
				{ scope: { name: "Locals" }, variables: [] },
			],
			errors: [
				{
					stage: "variables",
					message: "locals unavailable",
					scopeName: "Locals",
					variablesReference: 20,
				},
			],
		});
		await manager.terminate(undefined, 100);
	});

	it("returns a state error without mixing a later stop generation", async () => {
		const root = new FakeDapClient();
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		const manager = new DapSessionManager();

		await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/target.js", cwd: "/tmp" }, undefined, 1_000);
		root.setScopes([{ name: "Locals", presentationHint: "locals", variablesReference: 20, expensive: false }]);
		root.stopOnRequest("scopes", { reason: "step", threadId: 7, description: "later stop" });
		const started = await manager.startContinue(undefined, 1_000);
		root.emit("stopped", { reason: "breakpoint", threadId: 7, description: "original stop" });

		const outcome = await manager.waitForExecution(started.executionId, undefined, 1_000);
		expect(outcome.reason).toBe("stopped");
		expect(outcome.stopSnapshot).toMatchObject({
			complete: false,
			stoppedEvent: { reason: "breakpoint", description: "original stop" },
			scopes: [],
			errors: [{ stage: "state" }],
		});
		expect(outcome.stopSnapshot?.errors[0]?.message).toContain("generation");
		await manager.terminate(undefined, 100);
	});

	it("keeps shared snapshot capture alive when one observer aborts", async () => {
		const root = new FakeDapClient();
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		const manager = new DapSessionManager();

		await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/target.js", cwd: "/tmp" }, undefined, 1_000);
		const started = await manager.startContinue(undefined, 1_000);
		const threadsGate = root.holdNextRequest("threads");
		root.emit("stopped", { reason: "breakpoint", threadId: 7 });
		const abortController = new AbortController();
		const firstObserver = manager.waitForExecution(started.executionId, abortController.signal, 1_000);
		await threadsGate.entered;
		expect(root.requests.filter(request => request.command === "threads")).toHaveLength(1);

		abortController.abort(new Error("stop observing"));
		await expect(firstObserver).rejects.toThrow("stop observing");
		const retry = manager.waitForExecution(started.executionId, undefined, 1_000);
		threadsGate.release();
		await expect(retry).resolves.toMatchObject({
			reason: "stopped",
			stopSnapshot: { complete: true },
		});
		expect(root.requests.filter(request => request.command === "threads")).toHaveLength(1);
		await manager.terminate(undefined, 100);
	});
	it("keeps focus on the stopped script child when a worker attaches later", async () => {
		const root = new FakeDapClient(
			{
				name: "script.mts",
				type: "pwa-node",
				__pendingTargetId: "main",
				program: "/tmp/script.mts",
			},
			"launch",
			true,
			// Threadless launcher: it answers `threads` with an empty list.
			{ threads: [] },
		);
		// The script child stops on entry (thread 1), then a worker session
		// attaches afterwards via a late reverse `startDebugging`.
		const main = new FakeDapClient(undefined, "launch", true, {
			threads: [{ id: 1, name: "script.mts" }],
			stopThreadId: 1,
		});
		const worker = new FakeDapClient(undefined, "launch", false, {
			threads: [{ id: 1, name: "[worker 1]" }],
		});
		const children = [main, worker];
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		spyOn(DapClient, "connect").mockImplementation(async () => {
			const next = children.shift();
			if (!next) throw new Error("Unexpected child DAP connection");
			return next as unknown as DapClient;
		});
		const manager = new DapSessionManager();

		const launched = await manager.launch(
			{ adapter: TEST_ADAPTER, program: "/tmp/script.mts", cwd: "/tmp" },
			undefined,
			1_000,
		);
		expect(launched.status).toBe("stopped");
		const scriptSessionId = launched.id;

		// A worker_threads spawn triggers a late child attach on the launcher.
		await root.triggerReverse("startDebugging", {
			request: "launch",
			configuration: { name: "[worker 1]", type: "pwa-node" },
		});
		expect(manager.listSessions()).toHaveLength(3);

		// Focus must stay on the stopped script child, not jump to the worker.
		const active = manager.getActiveSession();
		expect(active?.id).toBe(scriptSessionId);
		expect(active?.threadId).toBe(1);

		// `threads` must surface every live thread across the tree, not just one.
		const threads = await manager.threads(undefined, 1_000);
		expect(threads.threads).toHaveLength(2);
		expect(threads.threads).toEqual(
			expect.arrayContaining([
				{ id: 1, name: "script.mts" },
				{ id: 1, name: "[worker 1]" },
			]),
		);
		// The launcher is still queried, but being threadless it contributes none.
		expect(root.requests.filter(request => request.command === "threads")).toHaveLength(1);

		await manager.terminate(undefined, 1_000);
	});

	it("preserves per-session threads that share an id and name across children", async () => {
		const root = new FakeDapClient(
			{ name: "pool.mjs", type: "pwa-node", __pendingTargetId: "main", program: "/tmp/pool.mjs" },
			"launch",
			true,
			{ threads: [] },
		);
		// Two identical worker scripts each expose the same session-local thread
		// id and name; DAP scopes ids per session, so both are distinct threads.
		const main = new FakeDapClient(undefined, "launch", true, {
			threads: [{ id: 1, name: "worker.js" }],
			stopThreadId: 1,
		});
		const worker = new FakeDapClient(undefined, "launch", false, {
			threads: [{ id: 1, name: "worker.js" }],
		});
		const children = [main, worker];
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		spyOn(DapClient, "connect").mockImplementation(async () => {
			const next = children.shift();
			if (!next) throw new Error("Unexpected child DAP connection");
			return next as unknown as DapClient;
		});
		const manager = new DapSessionManager();

		await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/pool.mjs", cwd: "/tmp" }, undefined, 1_000);
		await root.triggerReverse("startDebugging", {
			request: "launch",
			configuration: { name: "worker #2", type: "pwa-node" },
		});
		expect(manager.listSessions()).toHaveLength(3);

		const threads = await manager.threads(undefined, 1_000);
		// Both identical threads survive aggregation \u2014 not collapsed into one.
		expect(threads.threads).toEqual([
			{ id: 1, name: "worker.js" },
			{ id: 1, name: "worker.js" },
		]);

		await manager.terminate(undefined, 1_000);
	});
});
