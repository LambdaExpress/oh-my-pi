import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { DapClient } from "@oh-my-pi/pi-coding-agent/dap/client";
import * as dapModule from "@oh-my-pi/pi-coding-agent/dap/index";
import { dapSessionManager } from "@oh-my-pi/pi-coding-agent/dap/session";
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
import { getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { DebugTool, type DebugToolDetails, debugToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/debug";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";

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

const OWNER_ID = "Main";
const SCOPE_ID = "scope-main";

type EventHandler = (body: unknown, event: DapEventMessage) => void | Promise<void>;
type ReverseHandler = (args: unknown) => unknown | Promise<unknown>;

class WorkflowDapClient {
	readonly proc: DapClientState["proc"];
	readonly port = 8123;
	readonly requests: Array<{ command: string; args: unknown }> = [];
	readonly #events = new Map<string, Set<EventHandler>>();
	readonly #reverseHandlers = new Map<string, ReverseHandler>();
	readonly #exited = Promise.withResolvers<void>();
	readonly #requestWaiters: Array<{ command: string; count: number; resolve: () => void }> = [];
	#alive = true;
	#onContinue?: () => void;
	#threads: DapThread[] = [{ id: 7, name: "request-thread" }];
	#stackFrames: DapStackFrame[] = [
		{ id: 70, name: "handleRequest", line: 42, column: 3, source: { path: "/tmp/handler.ts" } },
	];
	#scopes: DapScope[] = [{ name: "Locals", presentationHint: "locals", variablesReference: 20, expensive: false }];
	#variables = new Map<number, DapVariable[]>([[20, [{ name: "body", value: "same-body", variablesReference: 0 }]]]);

	constructor() {
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
		return { supportsConfigurationDoneRequest: true };
	}

	async sendRequest(command: string, args?: unknown): Promise<unknown> {
		this.requests.push({ command, args });
		this.#settleRequestWaiters(command);
		if (command === "launch") {
			queueMicrotask(() => this.#emit("stopped", { reason: "entry", threadId: 7 }));
		}
		if (command === "continue") this.#onContinue?.();
		if (command === "threads") return { threads: this.#threads };
		if (command === "stackTrace") return { stackFrames: this.#stackFrames, totalFrames: this.#stackFrames.length };
		if (command === "scopes") return { scopes: this.#scopes };
		if (command === "variables") {
			const variablesReference =
				args &&
				typeof args === "object" &&
				"variablesReference" in args &&
				typeof args.variablesReference === "number"
					? args.variablesReference
					: undefined;
			return { variables: variablesReference === undefined ? [] : (this.#variables.get(variablesReference) ?? []) };
		}
		if (command.endsWith("Breakpoints")) {
			const requested =
				args && typeof args === "object" && "breakpoints" in args && Array.isArray(args.breakpoints)
					? args.breakpoints
					: [];
			return { breakpoints: requested.map((_, id) => ({ id, verified: true })) };
		}
		return {};
	}

	waitForEvent(event: string): Promise<unknown> {
		const result = Promise.withResolvers<unknown>();
		const unsubscribe = this.onEvent(event, body => {
			unsubscribe();
			result.resolve(body);
		});
		return result.promise;
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
		this.#alive = false;
		this.#exited.resolve();
	}

	setOnContinue(handler: () => void): void {
		this.#onContinue = handler;
	}

	setVariables(reference: number, variables: DapVariable[]): void {
		this.#variables.set(reference, variables);
	}

	emitStopped(body: Record<string, unknown> = { reason: "breakpoint", threadId: 7 }): void {
		this.#emit("stopped", body);
	}

	emitOutput(output: string, category = "console"): void {
		this.#emit("output", { output, category });
	}

	emitExited(exitCode: number): void {
		this.#emit("exited", { exitCode });
	}

	waitForRequestCount(command: string, count: number): Promise<void> {
		if (this.requests.filter(request => request.command === command).length >= count) return Promise.resolve();
		const waiter = Promise.withResolvers<void>();
		this.#requestWaiters.push({ command, count, resolve: waiter.resolve });
		return waiter.promise;
	}

	#settleRequestWaiters(command: string): void {
		const count = this.requests.filter(request => request.command === command).length;
		for (let index = this.#requestWaiters.length - 1; index >= 0; index--) {
			const waiter = this.#requestWaiters[index];
			if (!waiter || waiter.command !== command || count < waiter.count) continue;
			this.#requestWaiters.splice(index, 1);
			waiter.resolve();
		}
	}

	#emit(event: string, body: unknown): void {
		const message: DapEventMessage = { seq: 1, type: "event", event, body };
		for (const handler of this.#events.get(event) ?? []) void handler(body, message);
	}
}

interface Harness {
	client: WorkflowDapClient;
	debug: DebugTool;
	manager?: AsyncJobManager;
	session: ToolSession;
	deliveries: Array<{ jobId: string; text: string }>;
}

interface ControlledJob {
	id: string;
	resolve: (text: string) => void;
	reject: (error: unknown) => void;
}

const managers = new Set<AsyncJobManager>();

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(block => block.type === "text")?.text ?? "";
}

function debugDetails(result: { details?: DebugToolDetails }): DebugToolDetails {
	if (!result.details) throw new Error("Missing debug result details");
	return result.details;
}

function createToolSession(manager?: AsyncJobManager): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionId: () => SCOPE_ID,
		getAgentId: () => OWNER_ID,
		getAgentScopeId: () => SCOPE_ID,
		settings: Settings.isolated({
			"async.enabled": true,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
			"debug.enabled": true,
		}),
		...(manager ? { asyncJobManager: manager } : {}),
	};
}

async function createHarness(options: { withManager?: boolean } = {}): Promise<Harness> {
	const client = new WorkflowDapClient();
	spyOn(DapClient, "spawn").mockResolvedValue(client as unknown as DapClient);
	const deliveries: Array<{ jobId: string; text: string }> = [];
	const manager =
		options.withManager === false
			? undefined
			: new AsyncJobManager({
					retentionMs: 10_000,
					onJobComplete: async (jobId, text) => {
						deliveries.push({ jobId, text });
					},
				});
	if (manager) managers.add(manager);
	const session = createToolSession(manager);
	await dapSessionManager.launch(
		{ adapter: TEST_ADAPTER, program: import.meta.path, cwd: process.cwd() },
		undefined,
		1_000,
	);
	return { client, debug: new DebugTool(session), manager, session, deliveries };
}

function registerControlledJob(
	manager: AsyncJobManager,
	options: {
		type?: "bash" | "task";
		ownerId?: string;
		scopeId?: string;
		timeoutMs?: number;
	} = {},
): ControlledJob {
	const gate = Promise.withResolvers<string>();
	const id = manager.register(options.type ?? "bash", "controlled request", async () => gate.promise, {
		ownerId: options.ownerId ?? OWNER_ID,
		scopeId: options.scopeId ?? SCOPE_ID,
		timeoutMs: options.timeoutMs,
	});
	return { id, resolve: gate.resolve, reject: gate.reject };
}

async function startExecution(harness: Harness): Promise<string> {
	const result = await harness.debug.execute("continue", { action: "continue", wait_for_stop: false });
	const executionId = debugDetails(result).executionId;
	if (!executionId) throw new Error("Missing debug execution id");
	expect(debugDetails(result).state).toBe("running");
	expect(resultText(result)).toContain(`Execution: ${executionId}`);
	expect(resultText(result)).toContain(
		`{"action":"wait_for_stop","execution_id":"${executionId}","trigger_job_id":"<background-bash-job-id>"}`,
	);
	return executionId;
}

async function settleTriggerFirst(status: "completed" | "failed" | "cancelled"): Promise<void> {
	const harness = await createHarness();
	const manager = harness.manager;
	if (!manager) throw new Error("Missing async job manager");
	const executionId = await startExecution(harness);
	const job = registerControlledJob(manager);
	const waiting = harness.debug.execute("wait", {
		action: "wait_for_stop",
		execution_id: executionId,
		trigger_job_id: job.id,
	});
	if (status === "completed") job.resolve("request completed");
	if (status === "failed") job.reject(new Error("request failed"));
	if (status === "cancelled") {
		expect(manager.cancel(job.id, { ownerId: OWNER_ID, scopeId: SCOPE_ID, type: "bash" })).toBe(true);
		job.resolve("cancelled request exited");
	}

	const result = await waiting;
	expect(debugDetails(result).waitReason).toBe("trigger");
	expect(debugDetails(result).triggerJob?.status).toBe(status);
	expect(debugDetails(result).timedOut).toBe(false);
	expect(resultText(result)).toContain("Winner: trigger");
	await manager.drainDeliveries({ timeoutMs: 1_000 });
	expect(harness.deliveries).toEqual([]);

	harness.client.emitStopped();
	await expect(
		harness.debug.execute("late-stop", { action: "wait_for_stop", execution_id: executionId }),
	).resolves.toMatchObject({ details: { waitReason: "stopped" } });
}

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
});

afterEach(async () => {
	vi.useRealTimers();
	try {
		await dapSessionManager.terminate(undefined, 200);
	} catch {
		// A test may intentionally terminate the target first.
	}
	for (const manager of managers) await manager.dispose({ timeoutMs: 1_000 });
	managers.clear();
	vi.restoreAllMocks();
});

describe("DebugTool autonomous wait workflow", () => {
	it("keeps continue blocking by default and attaches a stop snapshot", async () => {
		const harness = await createHarness();
		const waiting = harness.debug.execute("continue", { action: "continue" });
		await harness.client.waitForRequestCount("continue", 1);
		harness.client.emitOutput("default continue output");
		harness.client.emitStopped({ reason: "breakpoint", threadId: 7, description: "default wait" });

		const result = await waiting;
		expect(debugDetails(result)).toMatchObject({ waitReason: "stopped", state: "stopped", timedOut: false });
		expect(debugDetails(result).stopSnapshot).toBeDefined();
		expect(resultText(result)).toContain("Winner: stopped");
	});

	it("returns a non-blocking execution id before the next stop", async () => {
		const harness = await createHarness();
		const executionId = await startExecution(harness);
		expect(executionId).toMatch(/^exec_\d+$/);
		expect(dapSessionManager.hasExecution(executionId)).toBe(true);
		expect(dapSessionManager.getExecutionOutcome(executionId)).toBeNull();
	});

	it("returns a stopped snapshot first and restores delivery for a still-running trigger", async () => {
		const harness = await createHarness();
		const manager = harness.manager;
		if (!manager) throw new Error("Missing async job manager");
		const executionId = await startExecution(harness);
		const job = registerControlledJob(manager);
		const waiting = harness.debug.execute("wait", {
			action: "wait_for_stop",
			execution_id: executionId,
			trigger_job_id: job.id,
		});
		harness.client.emitOutput("request reached breakpoint");
		harness.client.emitStopped();

		const result = await waiting;
		expect(debugDetails(result)).toMatchObject({ waitReason: "stopped", timedOut: false });
		expect(debugDetails(result).triggerJob?.status).toBe("running");
		expect(debugDetails(result).stopSnapshot?.output).toContain("request reached breakpoint");

		job.resolve("request response");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 1_000 });
		expect(harness.deliveries).toEqual([{ jobId: job.id, text: "request response" }]);
		expect(resultText(result)).toContain('{"action":"continue","wait_for_stop":false}');
		expect(resultText(result)).toContain(`{"op":"wait","ids":["${job.id}"]}`);
	});

	it("returns and consumes a completed trigger before a late stop", async () => {
		await settleTriggerFirst("completed");
	});

	it("returns and consumes a failed trigger before a late stop", async () => {
		await settleTriggerFirst("failed");
	});

	it("returns and consumes a cancelled trigger before a late stop", async () => {
		await settleTriggerFirst("cancelled");
	});

	it("reports trigger deadlines and prevents replay when the trigger finishes first", async () => {
		const harness = await createHarness();
		const manager = harness.manager;
		if (!manager) throw new Error("Missing async job manager");
		const executionId = await startExecution(harness);
		const job = registerControlledJob(manager, { timeoutMs: 60_000 });
		const waiting = harness.debug.execute("wait", {
			action: "wait_for_stop",
			execution_id: executionId,
			trigger_job_id: job.id,
		});
		job.reject(new Error("request timed out"));

		const result = await waiting;
		expect(debugDetails(result).triggerJob).toMatchObject({
			id: job.id,
			status: "failed",
			deadlineAt: expect.any(Number),
		});
		expect(resultText(result)).toContain("Trigger deadline:");
		expect(resultText(result)).toContain("Do not replay");
		expect(resultText(result)).toContain(`{"action":"wait_for_stop","execution_id":"${executionId}"}`);
		expect(resultText(result)).not.toContain(
			`{"action":"wait_for_stop","execution_id":"${executionId}","trigger_job_id":"${job.id}"}`,
		);
	});

	it("returns target termination first and restores delivery for a running trigger", async () => {
		const harness = await createHarness();
		const manager = harness.manager;
		if (!manager) throw new Error("Missing async job manager");
		const executionId = await startExecution(harness);
		const job = registerControlledJob(manager);
		const waiting = harness.debug.execute("wait", {
			action: "wait_for_stop",
			execution_id: executionId,
			trigger_job_id: job.id,
		});
		harness.client.emitExited(23);

		const result = await waiting;
		expect(debugDetails(result)).toMatchObject({ waitReason: "target_terminal", state: "terminated" });
		expect(debugDetails(result).triggerJob?.status).toBe("running");
		expect(resultText(result)).toContain("Exit code: 23");

		job.resolve("terminal response");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 1_000 });
		expect(harness.deliveries).toEqual([{ jobId: job.id, text: "terminal response" }]);
	});

	it("leaves both legs alive after timeout and permits a same-id retry", async () => {
		const harness = await createHarness();
		const manager = harness.manager;
		if (!manager) throw new Error("Missing async job manager");
		const executionId = await startExecution(harness);
		const job = registerControlledJob(manager);
		vi.useFakeTimers();
		try {
			const waiting = harness.debug.execute("wait", {
				action: "wait_for_stop",
				execution_id: executionId,
				trigger_job_id: job.id,
				timeout: 5,
			});
			await Promise.resolve();
			vi.advanceTimersByTime(5_000);
			await Promise.resolve();
			const result = await waiting;
			expect(debugDetails(result)).toMatchObject({ waitReason: "timeout", state: "running", timedOut: true });
			expect(debugDetails(result).triggerJob?.status).toBe("running");
			expect(dapSessionManager.getExecutionOutcome(executionId)).toBeNull();
		} finally {
			vi.useRealTimers();
		}

		harness.client.emitStopped();
		await expect(
			harness.debug.execute("retry", { action: "wait_for_stop", execution_id: executionId }),
		).resolves.toMatchObject({ details: { waitReason: "stopped" } });
		job.resolve("timeout response");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 1_000 });
		expect(harness.deliveries).toEqual([{ jobId: job.id, text: "timeout response" }]);
	});

	it("aborts only the observation and restores an unconsumed trigger delivery", async () => {
		const harness = await createHarness();
		const manager = harness.manager;
		if (!manager) throw new Error("Missing async job manager");
		const executionId = await startExecution(harness);
		const job = registerControlledJob(manager);
		const controller = new AbortController();
		const waiting = harness.debug.execute(
			"wait",
			{ action: "wait_for_stop", execution_id: executionId, trigger_job_id: job.id },
			controller.signal,
		);
		controller.abort(new Error("caller stopped waiting"));
		await expect(waiting).rejects.toThrow("Operation aborted");
		expect(dapSessionManager.getExecutionOutcome(executionId)).toBeNull();

		job.resolve("after abort");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 1_000 });
		expect(harness.deliveries).toEqual([{ jobId: job.id, text: "after abort" }]);
		harness.client.emitStopped();
		await expect(
			harness.debug.execute("retry", { action: "wait_for_stop", execution_id: executionId }),
		).resolves.toMatchObject({ details: { waitReason: "stopped" } });
	});

	it("uses stopped over trigger when both settle in the same millisecond", async () => {
		const harness = await createHarness();
		const manager = harness.manager;
		if (!manager) throw new Error("Missing async job manager");
		const executionId = await startExecution(harness);
		const job = registerControlledJob(manager);
		const waiting = harness.debug.execute("wait", {
			action: "wait_for_stop",
			execution_id: executionId,
			trigger_job_id: job.id,
		});
		const nowSpy = spyOn(Date, "now").mockReturnValue(12_345);
		try {
			harness.client.emitStopped();
			job.resolve("same tick");
			await manager.getJob(job.id)?.promise;
			const result = await waiting;
			expect(debugDetails(result).waitReason).toBe("stopped");
			expect(debugDetails(result).triggerJob?.status).toBe("completed");
			expect(harness.deliveries).toEqual([]);
		} finally {
			nowSpy.mockRestore();
		}
	});

	it("rejects missing executions and trigger jobs outside the exact owner, scope, or type", async () => {
		const harness = await createHarness();
		const manager = harness.manager;
		if (!manager) throw new Error("Missing async job manager");
		await expect(harness.debug.execute("missing", { action: "wait_for_stop" })).rejects.toThrow(
			"execution_id is required",
		);
		await expect(
			harness.debug.execute("unknown", { action: "wait_for_stop", execution_id: "exec_missing" }),
		).rejects.toThrow("Unknown debug execution");

		const executionId = await startExecution(harness);
		const wrongOwner = registerControlledJob(manager, { ownerId: "Other" });
		const wrongScope = registerControlledJob(manager, { scopeId: "scope-other" });
		const wrongType = registerControlledJob(manager, { type: "task" });
		for (const job of [wrongOwner, wrongScope]) {
			await expect(
				harness.debug.execute("hidden", {
					action: "wait_for_stop",
					execution_id: executionId,
					trigger_job_id: job.id,
				}),
			).rejects.toThrow("is not visible to this session");
		}
		await expect(
			harness.debug.execute("wrong-type", {
				action: "wait_for_stop",
				execution_id: executionId,
				trigger_job_id: wrongType.id,
			}),
		).rejects.toThrow("requires a Bash job");
		wrongOwner.resolve("done");
		wrongScope.resolve("done");
		wrongType.resolve("done");
	});

	it("reports the explicit missing-manager error only when a trigger is supplied", async () => {
		const harness = await createHarness({ withManager: false });
		const executionId = await startExecution(harness);
		await expect(
			harness.debug.execute("no-manager", {
				action: "wait_for_stop",
				execution_id: executionId,
				trigger_job_id: "bash_missing",
			}),
		).rejects.toThrow("Background job manager unavailable for this session.");
		harness.client.emitStopped();
		await expect(
			harness.debug.execute("without-trigger", { action: "wait_for_stop", execution_id: executionId }),
		).resolves.toMatchObject({ details: { waitReason: "stopped" } });
	});

	it("keeps renderer text, folding, and truncation stable while applying semantic colors in dark and light themes", async () => {
		const longVariable = `secret = ${"x".repeat(5_000)}`;
		const nextInput = '{"action":"wait_for_stop","execution_id":"exec_9","trigger_job_id":"bash_9"}';
		const originalText = [
			"Execution: exec_9",
			"Winner: stopped",
			"Trigger: bash_9 (running)",
			longVariable,
			"[stdout] standard output",
			"[stderr] failure output",
			"[console] console output",
			"[telemetry] telemetry output",
			"Next:",
			`Continue observing: ${nextInput}`,
			"detail line 11",
			"detail line 12",
			"expanded tail line 13",
		].join("\n");
		const renderedResult = {
			content: [{ type: "text", text: originalText }],
			details: {
				action: "wait_for_stop",
				success: true,
				executionId: "exec_9",
				waitReason: "stopped",
				triggerJob: { id: "bash_9", type: "bash", status: "running", label: "request", durationMs: 1 },
				ownerId: "owner-secret",
				scopeId: "scope-secret",
				snapshot: {
					id: "session_9",
					adapter: "debugpy",
					status: "stopped",
					cwd: "C:\\workspace\\app",
					program: "C:\\workspace\\app\\main.py",
					stopReason: "breakpoint",
					frameName: "runMain",
					source: { path: "C:\\workspace\\app\\main.py" },
					line: 14,
					column: 2,
					needsConfigurationDone: false,
				},
			},
		};

		for (const themeName of ["dark", "light"] as const) {
			const theme = await getThemeByName(themeName);
			if (!theme) throw new Error(`Missing ${themeName} theme`);
			const collapsedRaw = debugToolRenderer
				.renderResult(renderedResult as never, { expanded: false, isPartial: false }, theme, {
					action: "wait_for_stop",
				})
				.render(140)
				.join("\n");
			const expandedRaw = debugToolRenderer
				.renderResult(renderedResult as never, { expanded: true, isPartial: false }, theme, {
					action: "wait_for_stop",
				})
				.render(140)
				.join("\n");
			const collapsed = Bun.stripANSI(collapsedRaw);
			const expanded = Bun.stripANSI(expandedRaw);
			const renderedLine = (needle: string): string =>
				expandedRaw.split("\n").find(line => Bun.stripANSI(line).includes(needle)) ?? "";

			expect(renderedResult.content[0].text).toBe(originalText);
			expect(Bun.stripANSI(originalText)).toBe(originalText);
			expect(collapsed).toContain("Execution: exec_9");
			expect(collapsed).toContain("Winner: stopped");
			expect(collapsed).toContain("Trigger: bash_9 (running)");
			expect(collapsed).toContain("… 10 more lines");
			expect(collapsed).not.toContain("standard output");
			expect(expanded).toContain("standard output");
			expect(expanded).toContain("failure output");
			expect(expanded).toContain("console output");
			expect(expanded).toContain("telemetry output");
			expect(expanded).toContain(`Continue observing: ${nextInput}`);
			expect(expanded).toContain("expanded tail line 13");
			expect(expanded).not.toContain("more lines");
			expect(expanded).toContain("secret = ");
			expect(expanded).not.toContain("x".repeat(200));
			expect(expanded).not.toContain("owner-secret");
			expect(expanded).not.toContain("scope-secret");

			expect(renderedLine("Session session_9")).toContain(theme.fg("dim", "Session "));
			expect(renderedLine("Session session_9")).toContain(theme.fg("accent", "session_9"));
			expect(renderedLine("Status: stopped")).toContain(theme.fg("warning", "stopped"));
			expect(renderedLine("CWD: C:\\workspace\\app")).toContain(theme.fg("accent", "C:\\workspace\\app"));
			expect(renderedLine("Frame: runMain")).toContain(theme.fg("accent", "runMain"));
			expect(renderedLine("Execution: exec_9")).toContain(theme.fg("dim", "Execution: "));
			expect(renderedLine("Execution: exec_9")).toContain(theme.fg("accent", "exec_9"));
			expect(renderedLine("Trigger: bash_9 (running)")).toContain(theme.fg("accent", "bash_9"));
			expect(renderedLine("Trigger: bash_9 (running)")).toContain(theme.fg("accent", "running"));
			expect(renderedLine("[stdout] standard output")).toContain(theme.fg("dim", "[stdout]"));
			expect(renderedLine("[stdout] standard output")).toContain(theme.fg("toolOutput", "standard output"));
			expect(renderedLine("[stderr] failure output")).toContain(theme.fg("error", "[stderr]"));
			expect(renderedLine("[stderr] failure output")).toContain(theme.fg("error", "failure output"));
			expect(renderedLine("[console] console output")).toContain(theme.fg("dim", "[console]"));
			expect(renderedLine("[console] console output")).toContain(theme.fg("toolOutput", "console output"));
			expect(renderedLine("[telemetry] telemetry output")).toContain(theme.fg("muted", "[telemetry]"));
			expect(renderedLine("[telemetry] telemetry output")).toContain(theme.fg("muted", "telemetry output"));
			expect(renderedLine("Next:")).toContain(theme.fg("dim", "Next:"));
			expect(renderedLine(`Continue observing: ${nextInput}`)).toContain(theme.fg("dim", "Continue observing: "));
			expect(renderedLine(`Continue observing: ${nextInput}`)).toContain(theme.fg("toolOutput", nextInput));
		}
	});

	it("preflights every configured adapter without launching a session", async () => {
		const availableAdapter: DapResolvedAdapter = {
			...TEST_ADAPTER,
			name: "available-adapter",
			command: "node",
			resolvedCommand: process.execPath,
		};
		spyOn(dapModule, "getAdapterConfigs").mockReturnValue({
			"available-adapter": {
				command: "node",
				args: [],
				languages: ["javascript"],
				fileTypes: [".js"],
				rootMarkers: [],
				launchDefaults: {},
				attachDefaults: {},
			},
			"missing-adapter": {
				command: "missing-adapter",
				args: [],
				languages: ["example"],
				fileTypes: [".example"],
				rootMarkers: [],
				launchDefaults: {},
				attachDefaults: {},
			},
		});
		const availableSpy = spyOn(dapModule, "getAvailableAdapters").mockReturnValue([availableAdapter]);
		const spawnSpy = spyOn(DapClient, "spawn");
		const debug = new DebugTool(createToolSession());

		const result = await debug.execute("adapters", { action: "adapters" });

		expect(debugDetails(result).adapters).toEqual([
			expect.objectContaining({
				name: "available-adapter",
				available: true,
				resolvedCommand: process.execPath,
			}),
			expect.objectContaining({
				name: "missing-adapter",
				available: false,
				command: "missing-adapter",
			}),
		]);
		expect(resultText(result)).toContain("available-adapter: available");
		expect(resultText(result)).toContain("missing-adapter: missing");
		expect(spawnSpy).not.toHaveBeenCalled();
		expect(availableSpy).toHaveBeenCalledTimes(1);
	});

	it("waits for output readiness without polling", async () => {
		const harness = await createHarness();
		await startExecution(harness);
		const waiting = harness.debug.execute("ready", {
			action: "output",
			wait_for: "READY port=\\d+",
			timeout: 5,
		});
		harness.client.emitOutput("READY port=", "console");
		harness.client.emitOutput("4450", "stdout");

		const result = await waiting;
		expect(debugDetails(result)).toMatchObject({ outputMatched: true, timedOut: false });
		expect(debugDetails(result).output).toBe("READY port=4450");
		expect(resultText(result)).toContain("[console] READY port=");
		expect(resultText(result)).toContain("[stdout] 4450");
	});

	it("shows only categorized output from the current execution generation", async () => {
		const harness = await createHarness();
		let executionId = await startExecution(harness);
		harness.client.emitOutput("old failure\n", "stderr");
		harness.client.emitStopped();
		await harness.debug.execute("first-stop", { action: "wait_for_stop", execution_id: executionId });

		const resumed = await harness.debug.execute("resume", { action: "continue", wait_for_stop: false });
		executionId = debugDetails(resumed).executionId ?? "";
		harness.client.emitOutput("ptvsd", "console");
		harness.client.emitOutput("debugpy", "console");
		harness.client.emitOutput("READY\n", "stdout");
		harness.client.emitStopped();

		const result = await harness.debug.execute("second-stop", {
			action: "wait_for_stop",
			execution_id: executionId,
		});
		expect(debugDetails(result).stopSnapshot?.output).toBe("ptvsddebugpyREADY\n");
		expect(debugDetails(result).stopSnapshot?.outputSegments).toEqual([
			{ category: "console", output: "ptvsd" },
			{ category: "console", output: "debugpy" },
			{ category: "stdout", output: "READY\n" },
		]);
		expect(resultText(result)).not.toContain("old failure");
		expect(resultText(result)).toContain("[console] ptvsd\n[console] debugpy\n[stdout] READY");
	});

	it("returns the terminal snapshot after terminate completes", async () => {
		const harness = await createHarness();

		const result = await harness.debug.execute("terminate", { action: "terminate" });

		expect(debugDetails(result).snapshot?.status).toBe("terminated");
		expect(resultText(result)).toContain("Status: terminated");
		expect(resultText(result)).not.toContain("Status: stopped");
		expect(dapSessionManager.listSessions()).toEqual([]);
	});

	it("runs the real async Bash request-breakpoint-resume-replay loop without duplicate delivery", async () => {
		const client = new WorkflowDapClient();
		spyOn(DapClient, "spawn").mockResolvedValue(client as unknown as DapClient);
		spyOn(dapModule, "selectLaunchAdapter").mockReturnValue({ kind: "adapter", adapter: TEST_ADAPTER });
		const deliveries: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			retentionMs: 10_000,
			onJobComplete: async (jobId, text) => {
				deliveries.push({ jobId, text });
			},
		});
		managers.add(manager);
		const session = createToolSession(manager);
		const debug = new DebugTool(session);
		const bash = new BashTool(session);
		const hub = new HubTool(session);
		const exchanges = Array.from({ length: 2 }, () => ({
			arrived: Promise.withResolvers<void>(),
			resumed: Promise.withResolvers<void>(),
			respond: Promise.withResolvers<void>(),
		}));
		const requests: Array<{ method: string; path: string; body: string }> = [];
		let activeExchange: (typeof exchanges)[number] | undefined;
		let requestIndex = 0;
		client.setOnContinue(() => {
			activeExchange?.resumed.resolve();
			activeExchange = undefined;
		});
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const exchange = exchanges[requestIndex];
				if (!exchange) return new Response("unexpected request", { status: 500 });
				const index = requestIndex++;
				const url = new URL(request.url);
				requests.push({ method: request.method, path: `${url.pathname}${url.search}`, body: await request.text() });
				activeExchange = exchange;
				client.emitOutput(`request-${index + 1} reached handler\n`);
				client.emitStopped({ reason: "breakpoint", threadId: 7, description: `request-${index + 1}` });
				exchange.arrived.resolve();
				await exchange.resumed.promise;
				await exchange.respond.promise;
				return new Response(`response-${index + 1}`);
			},
		});
		try {
			await debug.execute("launch", { action: "launch", program: import.meta.path });
			await debug.execute("breakpoint", { action: "set_breakpoint", file: import.meta.path, line: 1 });
			let executionId = debugDetails(
				await debug.execute("continue-1", { action: "continue", wait_for_stop: false }),
			).executionId;
			if (!executionId) throw new Error("Missing first execution id");
			const requestParams = {
				command:
					"bun -e 'const response = await fetch(Bun.env.REQUEST_URL, { method: \"POST\", body: Bun.env.REQUEST_BODY }); console.log(await response.text());'",
				cwd: process.cwd(),
				env: {
					REQUEST_URL: `http://127.0.0.1:${server.port}/debug/replay?case=same`,
					REQUEST_BODY: "same-body",
				},
				timeout: 30,
				pty: false,
				async: true,
			} as const;

			for (let index = 0; index < 2; index++) {
				const bashResult = await bash.execute(`bash-${index + 1}`, requestParams);
				const jobId = bashResult.details?.async?.jobId;
				if (!jobId) throw new Error("Missing async Bash job id");
				const stopped = await debug.execute(`wait-${index + 1}`, {
					action: "wait_for_stop",
					execution_id: executionId,
					trigger_job_id: jobId,
				});
				expect(debugDetails(stopped)).toMatchObject({
					waitReason: "stopped",
					triggerJob: { id: jobId, status: "running" },
				});
				expect(debugDetails(stopped).stopSnapshot?.stackFrames).toHaveLength(1);
				expect(debugDetails(stopped).stopSnapshot?.scopes[0]?.variables).toEqual([
					{ name: "body", value: "same-body", variablesReference: 0 },
				]);
				expect(debugDetails(stopped).stopSnapshot?.output).toContain(`request-${index + 1} reached handler`);

				const resumed = await debug.execute(`continue-${index + 2}`, {
					action: "continue",
					wait_for_stop: false,
				});
				executionId = debugDetails(resumed).executionId;
				if (!executionId) throw new Error("Missing resumed execution id");
				const hubWait = hub.execute(`hub-${index + 1}`, { op: "wait", ids: [jobId], timeoutMs: 5_000 });
				exchanges[index]?.respond.resolve();
				const hubResult = await hubWait;
				const hubDetails = hubResult.details;
				const jobs = hubDetails && "jobs" in hubDetails ? (hubDetails.jobs ?? []) : [];
				expect(jobs).toHaveLength(1);
				expect(jobs[0]).toMatchObject({ id: jobId, type: "bash", status: "completed" });
				expect(jobs[0]?.resultText).toContain(`response-${index + 1}`);
			}

			expect(requests).toEqual([
				{ method: "POST", path: "/debug/replay?case=same", body: "same-body" },
				{ method: "POST", path: "/debug/replay?case=same", body: "same-body" },
			]);
			await manager.drainDeliveries({ timeoutMs: 1_000 });
			expect(deliveries).toEqual([]);
		} finally {
			for (const exchange of exchanges) {
				exchange.resumed.resolve();
				exchange.respond.resolve();
			}
			await server.stop(true);
		}
	}, 20_000);
});
