import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { procmgr, setProcessName, TempDir } from "@oh-my-pi/pi-utils";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../../src/config/settings";
import { AsyncJobManager } from "../../src/async/job-manager";
import { ProcProtocolHandler } from "../../src/internal-urls/proc-protocol";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { SessionManager } from "../../src/session/session-manager";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import * as daemonClient from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonOperation,
	type DaemonRpcResult,
} from "../../src/launch/protocol";
import { BashTool } from "../../src/tools/bash";
import { WriteTool } from "../../src/tools/write";
import { sharedBrowserDaemonName } from "../../src/tools/browser/shared-daemon";
import type { ToolSession } from "../../src/tools";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";

async function startBroker(projectDir: string, runtimeDir: string): Promise<{ finished: Promise<void> }> {
	const previous = [
		process.env[DAEMON_PROJECT_DIR_ENV],
		process.env[DAEMON_RUNTIME_DIR_ENV],
		process.env[DAEMON_IDLE_GRACE_ENV],
	];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const listening = Promise.withResolvers<boolean>();
	const finished = startDaemonBrokerFromEnvironment({ onListening: () => listening.resolve(true) });
	for (const [index, key] of [DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV, DAEMON_IDLE_GRACE_ENV].entries()) {
		if (previous[index] === undefined) delete process.env[key];
		else process.env[key] = previous[index];
	}
	const claimed = await Promise.race([listening.promise, finished.then(() => false)]);
	if (!claimed) throw new Error("In-process daemon broker did not claim its scope");
	return { finished };
}

// Services really spawn the configured shell with POSIX command lines. Windows
// has no `/bin/sh`, so use the product's own Git Bash discovery there.
const SERVICE_SHELL = process.platform === "win32" ? procmgr.resolveWindowsShell() : "/bin/sh";

/**
 * Settles a broker-backed call with a plain `await`. On Windows, Bun's
 * `expect(promise).rejects` waits on the promise without servicing the
 * in-process broker's named-pipe I/O, so the request stalls until its timeout.
 */
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("Expected the promise to reject");
}

function toolSession(cwd: string, manager?: AsyncJobManager, options: { launch?: boolean } = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getAgentId: () => "Main",
		getSessionId: () => "Main",
		getSessionFile: () => null,
		asyncJobManager: manager,
		settings: Settings.isolated({
			"launch.enabled": options.launch ?? true,
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bash.autoBackground.thresholdMs": 60_000,
			"bashInterceptor.enabled": false,
			"worktree.clone": false,
			shellPath: SERVICE_SHELL,
		}),
	} as unknown as ToolSession;
}

function steeringContext(steeringSignal: AbortSignal): AgentToolContext {
	return {
		sessionManager: SessionManager.inMemory(),
		modelRegistry: undefined,
		model: undefined,
		isIdle: () => false,
		hasQueuedMessages: () => true,
		abort: () => {},
		toolNames: [],
		toolCall: {
			batchId: "batch-1",
			index: 0,
			total: 1,
			toolCalls: [{ id: "service", name: "bash" }],
			steeringSignal,
		},
	} as unknown as AgentToolContext;
}

describe("proc:// background jobs", () => {
	it("lists owned jobs, preserves delivery on read, and scopes kill to the owner", async () => {
		const manager = new AsyncJobManager({});
		const pending = Promise.withResolvers<string>();
		const id = manager.register(
			"bash",
			"compiling assets",
			async ({ reportProgress }) => {
				// Keep cleanup pending until the test releases it: cancellation
				// requests are observable before the job has actually settled.
				await reportProgress("building 50%", { output: "building 50%" });
				return pending.promise;
			},
			{ id: "build-job", ownerId: "Main" },
		);
		const otherPending = Promise.withResolvers<string>();
		manager.register(
			"bash",
			"other owner's work",
			async ({ signal }) => {
				signal.addEventListener("abort", () => otherPending.resolve("cancelled"), { once: true });
				return otherPending.promise;
			},
			{ id: "other-job", ownerId: "Other" },
		);
		const session = toolSession(process.cwd(), manager, { launch: false });
		const protocol = new ProcProtocolHandler();
		try {
			expect(await rejectionMessage(protocol.resolve(parseInternalUrl("proc://")))).toContain(
				"requires a tool session",
			);
			expect(await rejectionMessage(protocol.write(parseInternalUrl(`proc://${id}/kill`), ""))).toContain(
				"requires a tool session",
			);
			const list = await protocol.resolve(parseInternalUrl("proc://"), { session });
			expect(list.content).toContain(`${id} [bash] running`);
			expect(list.content).not.toContain("other-job");
			expect(list.details?.proc?.jobs).toMatchObject([{ id, status: "running" }]);
			expect(await rejectionMessage(protocol.resolve(parseInternalUrl("proc://other-job"), { session }))).toContain(
				"not found",
			);
			expect(
				await rejectionMessage(protocol.write(parseInternalUrl("proc://other-job/kill"), "", { session })),
			).toContain("not found");
			const running = await protocol.resolve(parseInternalUrl(`proc://${id}`), { session });
			expect(running.content).toContain("compiling assets");
			expect(running.content).toContain("building 50%");
			expect(running.details?.proc?.job).toMatchObject({ id, status: "running" });
			expect(
				await rejectionMessage(protocol.write(parseInternalUrl(`proc://${id}`), "input", { session })),
			).toContain("stdin is only available for services");
			expect(await rejectionMessage(protocol.resolve(parseInternalUrl(`proc://${id}/kill`), { session }))).toContain(
				"writable only",
			);
			expect(manager.getJob(id)?.status).toBe("running");
			const cancelled = await protocol.write(parseInternalUrl(`proc://${id}/kill`), "ignored payload", { session });
			expect(cancelled.details?.proc).toMatchObject({ op: "cancel", cancelled: [{ id, status: "cancelled" }] });
			expect(manager.getJob(id)?.abortController.signal.aborted).toBeTrue();
			expect(manager.getJob(id)?.settledAt).toBeUndefined();
			expect(manager.getJob("other-job")?.status).toBe("running");
			pending.resolve("cancelled");
			await manager.getJob(id)?.promise;
			expect(manager.getJob(id)?.status).toBe("cancelled");
			expect(manager.getJob(id)?.settledAt).toBeDefined();
			const settledId = manager.register("bash", "completed command", async () => "DONE", {
				id: "settled-job",
				ownerId: "Main",
			});
			await manager.getJob(settledId)?.promise;
			const settled = await protocol.resolve(parseInternalUrl(`proc://${settledId}`), { session });
			expect(settled.content).toContain("DONE");
			expect(manager.isJobResultConsumed(settledId)).toBeFalse();
		} finally {
			pending.resolve("cancelled");
			await manager.dispose();
		}
	});

	it("kills without content and never interprets bare job writes as cancellation", async () => {
		const manager = new AsyncJobManager({});
		const pending = Promise.withResolvers<string>();
		const id = manager.register(
			"bash",
			"running command",
			async ({ signal }) => {
				signal.addEventListener("abort", () => pending.resolve("cancelled"), { once: true });
				return pending.promise;
			},
			{ ownerId: "Main" },
		);
		const write = new WriteTool(toolSession(process.cwd(), manager, { launch: false }));
		try {
			expect(
				await rejectionMessage(
					write.execute("invalid-cancel", {
						path: `proc://${id}`,
						content: '</antml>\n<parameter name="i">Cancelling background test run',
					}),
				),
			).toContain("stdin is only available for services");
			expect(await rejectionMessage(write.execute("empty-stdin", { path: `proc://${id}`, content: "" }))).toContain(
				"stdin is only available for services",
			);
			expect(
				await rejectionMessage(write.execute("missing-stdin", write.parameters.assert({ path: `proc://${id}` }))),
			).toContain("content is required");
			expect(manager.getJob(id)?.status).toBe("running");
			const result = await write.execute("kill", write.parameters.assert({ path: `proc://${id}/kill` }));
			await manager.getJob(id)?.promise;
			expect(result.details?.proc).toMatchObject({ op: "cancel", cancelled: [{ id, status: "cancelled" }] });
			expect(manager.getJob(id)?.status).toBe("cancelled");
		} finally {
			await manager.dispose();
		}
	});

	it.each([
		{ label: "plan mode", deviceOnlyWrite: false },
		{ label: "plan mode with device-only write", deviceOnlyWrite: true },
	])("kills owned jobs under $label while stdin stays guarded (issue #13803)", async ({ deviceOnlyWrite }) => {
		const manager = new AsyncJobManager({});
		const pending = Promise.withResolvers<string>();
		const id = manager.register(
			"task",
			"exploring the wrong track",
			async ({ signal }) => {
				signal.addEventListener("abort", () => pending.resolve("cancelled"), { once: true });
				return pending.promise;
			},
			{ ownerId: "Main" },
		);
		const session = toolSession(process.cwd(), manager, { launch: false });
		session.getPlanModeState = () => ({
			enabled: true,
			planFilePath: "local://PLAN.md",
			workflow: "parallel",
			reentry: false,
		});
		session.deviceOnlyWrite = deviceOnlyWrite || undefined;
		const write = new WriteTool(session);
		try {
			await expect(write.execute("stdin", { path: `proc://${id}`, content: "go" })).rejects.toThrow(
				deviceOnlyWrite ? "limited to the xd:// device transport" : "Plan mode",
			);
			expect(manager.getJob(id)?.status).toBe("running");
			const result = await write.execute("kill", write.parameters.assert({ path: `proc://${id}/kill` }));
			await manager.getJob(id)?.promise;
			expect(result.details?.proc).toMatchObject({ op: "cancel", cancelled: [{ id, status: "cancelled" }] });
			expect(manager.getJob(id)?.status).toBe("cancelled");
		} finally {
			await manager.dispose();
		}
	});

	it("scopes a caller without an agent id to unowned jobs and parentless agents", async () => {
		const manager = new AsyncJobManager({});
		const pending = Promise.withResolvers<string>();
		manager.register(
			"bash",
			"main's work",
			async ({ signal }) => {
				signal.addEventListener("abort", () => pending.resolve("cancelled"), { once: true });
				return pending.promise;
			},
			{ id: "owned-job", ownerId: "Main" },
		);
		manager.register("bash", "unowned work", async () => "done", { id: "unowned-job" });
		const registry = new AgentRegistry();
		registry.register({ id: "Foreign", displayName: "Foreign", kind: "sub", parentId: "Main", session: null });
		const session = toolSession(process.cwd(), manager, { launch: false });
		session.getAgentId = () => null;
		session.agentRegistry = registry;
		const protocol = new ProcProtocolHandler();
		try {
			const list = await protocol.resolve(parseInternalUrl("proc://"), { session });
			expect(list.details?.proc?.jobs).toMatchObject([{ id: "unowned-job" }]);
			expect(await rejectionMessage(protocol.resolve(parseInternalUrl("proc://owned-job"), { session }))).toContain(
				"not found",
			);
			expect(
				await rejectionMessage(protocol.write(parseInternalUrl("proc://owned-job/kill"), "", { session })),
			).toContain("not found");
			expect(manager.getJob("owned-job")?.status).toBe("running");
			const denied = await protocol.write(parseInternalUrl("proc://Foreign/kill"), "", { session });
			expect(denied.details?.proc).toMatchObject({ cancelled: [{ id: "Foreign", status: "not_found" }] });
			expect(registry.get("Foreign")?.status).toBe("running");
		} finally {
			await manager.dispose();
		}
	});

	it.each([false, true])("kills only owned jobless agents (job manager: %s)", async withManager => {
		const manager = withManager ? new AsyncJobManager({}) : undefined;
		const registry = new AgentRegistry();
		registry.register({ id: "Worker", displayName: "Worker", kind: "sub", parentId: "Main", session: null });
		registry.register({ id: "Foreign", displayName: "Foreign", kind: "sub", parentId: "Other", session: null });
		const session = toolSession(process.cwd(), manager, { launch: false });
		session.agentRegistry = registry;
		const write = new WriteTool(session);
		try {
			const denied = await write.execute("foreign", { path: "proc://Foreign/kill" });
			expect(denied.details?.proc).toMatchObject({ cancelled: [{ id: "Foreign", status: "not_found" }] });
			expect(registry.get("Foreign")?.status).toBe("running");
			const killed = await write.execute("worker", { path: "proc://Worker/kill" });
			expect(killed.details?.proc).toMatchObject({ cancelled: [{ id: "Worker", status: "cancelled" }] });
			expect(registry.get("Worker")).toBeUndefined();
		} finally {
			await manager?.dispose();
		}
	});

	it("requires file content instead of silently truncating a file", async () => {
		using temp = TempDir.createSync("@omp-proc-write-");
		const file = path.join(temp.path(), "keep.txt");
		await Bun.write(file, "keep this");
		const write = new WriteTool(toolSession(temp.path(), undefined, { launch: false }));
		expect(
			await rejectionMessage(write.execute("missing-content", write.parameters.assert({ path: file }))),
		).toContain("content is required");
		expect(await Bun.file(file).text()).toBe("keep this");
		await write.execute("empty-file", { path: file, content: "" });
		expect(await Bun.file(file).text()).toBe("");
	});

	it("lists settled jobs with their frozen run duration instead of their age", async () => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const manager = new AsyncJobManager({});
		const release = Promise.withResolvers<string>();
		const doneId = manager.register("bash", "sleep 2; echo fast-done", () => release.promise, { ownerId: "Main" });
		const blocked = Promise.withResolvers<string>();
		const runningId = manager.register(
			"bash",
			"sleep 60",
			async ({ signal }) => {
				signal.addEventListener("abort", () => blocked.resolve("cancelled"), { once: true });
				return blocked.promise;
			},
			{ ownerId: "Main" },
		);
		const session = toolSession(process.cwd(), manager, { launch: false });
		try {
			clock.mockReturnValue(3_000);
			release.resolve("fast-done");
			await manager.getJob(doneId)?.promise;
			clock.mockReturnValue(40_000);
			const list = await new ProcProtocolHandler().resolve(parseInternalUrl("proc://"), { session });
			expect(list.content).toContain(`${doneId} [bash] completed in 2.0s — sleep 2; echo fast-done`);
			expect(list.content).toContain(`${runningId} [bash] running up 39.0s — sleep 60`);
			expect(list.details?.proc?.jobs).toMatchObject([
				{ id: doneId, durationMs: 2_000 },
				{ id: runningId, durationMs: 39_000 },
			]);
		} finally {
			clock.mockRestore();
			await manager.dispose();
		}
	});

	it("keeps listing jobs and agents when the daemon broker hangs, flagging agents with no live turn", async () => {
		const broker = vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue({
			request: async () => {
				throw new Error("Daemon list request timed out");
			},
			onCompletion: () => () => {},
		} as unknown as daemonClient.DaemonBrokerClient);
		const manager = new AsyncJobManager({});
		const blocked = Promise.withResolvers<string>();
		manager.register(
			"bash",
			"long build",
			async ({ signal }) => {
				signal.addEventListener("abort", () => blocked.resolve("cancelled"), { once: true });
				return blocked.promise;
			},
			{ id: "build-job", ownerId: "Main" },
		);
		const registry = new AgentRegistry();
		// Claims `running` but no session is streaming: the run is over.
		registry.register({ id: "Visuals", displayName: "Visuals", kind: "sub", parentId: "Main", session: null });
		const session = toolSession(process.cwd(), manager, { launch: true });
		session.agentRegistry = registry;
		const proc = new ProcProtocolHandler();
		try {
			const list = await proc.resolve(parseInternalUrl("proc://"), { session });
			expect(list.content).toContain("build-job [bash] running");
			expect(list.content).toContain("Visuals [task] running up");
			expect(list.content).toContain("no turn in flight");
			expect(list.content).toContain("Services unavailable (daemon broker): Daemon list request timed out");
			const single = await proc.resolve(parseInternalUrl("proc://Visuals"), { session });
			expect(single.content).toContain("no turn in flight");
			await expect(proc.resolve(parseInternalUrl("proc://web"), { session })).rejects.toThrow(
				"services unavailable: Daemon list request timed out",
			);
			// The suggested kill works without the broker; service-only actions still surface its error.
			const killed = await proc.write(parseInternalUrl("proc://Visuals/kill"), "", { session });
			expect(killed.details?.proc).toMatchObject({ cancelled: [{ id: "Visuals", status: "cancelled" }] });
			expect(registry.get("Visuals")).toBeUndefined();
			const killedJob = await proc.write(parseInternalUrl("proc://build-job/kill"), "", { session });
			expect(killedJob.details?.proc).toMatchObject({ cancelled: [{ id: "build-job", status: "cancelled" }] });
			await expect(proc.write(parseInternalUrl("proc://web"), "go\n", { session })).rejects.toThrow(
				"Daemon list request timed out",
			);
		} finally {
			broker.mockRestore();
			await manager.dispose();
		}
	});
});

describe("bash services via proc://", () => {
	it("starts at log readiness, delivers stdin, switches persistence, and restarts a live name", async () => {
		using temp = TempDir.createSync("@omp-proc-service-");
		const cwd = path.join(temp.path(), "project");
		const runtimeDir = path.join(temp.path(), "runtime");
		await fs.mkdir(cwd);
		const scriptPath = path.join(cwd, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
let input = "";
const token = crypto.randomUUID();
let counter = 0;
process.stdin.on("data", chunk => {
	input += chunk;
	for (;;) {
		const newline = input.indexOf("\\n");
		if (newline < 0) break;
		const line = input.slice(0, newline).replace(/\\r$/, "");
		input = input.slice(newline + 1);
		counter++;
		process.stdout.write("ACK:[" + line + "]\\n");
	}
});
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		return new URL(request.url).pathname === "/state"
			? Response.json({ pid: process.pid, token, counter })
			: new Response(process.argv[2]);
	}
});
process.stdout.write(process.argv[2] + ":" + server.port + "\\n");
`,
		);
		// Quoted, slash-normalized executable paths work in both the default
		// Windows shell and POSIX shells; service behavior is not shell syntax.
		const serviceCommand = (marker: string) =>
			`"${process.execPath.replace(/\\/g, "/")}" "${scriptPath.replace(/\\/g, "/")}" ${marker}`;
		const client = await createDaemonBrokerClient(cwd, { runtimeDir, idleGraceMs: 5_000 });
		const spy = vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
		const oldTitle = process.title;
		const broker = await startBroker(cwd, runtimeDir);
		const manager = new AsyncJobManager({});
		const session = toolSession(cwd, manager);
		const bash = new BashTool(session);
		const proc = new ProcProtocolHandler();
		try {
			const started = await bash.execute("service", {
				command: serviceCommand("READY"),
				name: "echo-service",
				ready: { log: "READY", timeout: 5 },
				pty: false,
			});
			expect(started.details?.service?.ready).toBeTrue();
			const startedLog = started.content[0]?.type === "text" ? started.content[0].text : "";
			const startedPort = startedLog.match(/READY:(\d+)/)?.[1];
			if (!startedPort) throw new Error("Ready service did not publish its HTTP port");
			expect(await (await fetch(`http://127.0.0.1:${startedPort}/`)).text()).toBe("READY");
			const list = await proc.resolve(parseInternalUrl("proc://"), { session });
			expect(list.content).toContain("echo-service [service]");
			expect(list.details?.proc?.daemons).toMatchObject([{ name: "echo-service", state: "ready" }]);
			const pending = Promise.withResolvers<string>();
			const collisionId = manager.register(
				"bash",
				"colliding job",
				async ({ signal }) => {
					signal.addEventListener("abort", () => pending.resolve("cancelled"), { once: true });
					return pending.promise;
				},
				{ id: "echo-service", ownerId: "Main" },
			);
			expect(collisionId).toBe("echo-service");
			expect(await rejectionMessage(proc.resolve(parseInternalUrl("proc://echo-service"), { session }))).toContain(
				"both job echo-service and service echo-service",
			);
			expect(
				await rejectionMessage(proc.write(parseInternalUrl("proc://echo-service/kill"), "", { session })),
			).toContain("both job echo-service and service echo-service");
			manager.cancel(collisionId, { ownerId: "Main" });
			await manager.getJob(collisionId)?.promise;
			await manager.dispose({ timeoutMs: 1_000 });
			session.asyncJobManager = undefined;
			const sent = await proc.write(parseInternalUrl("proc://echo-service"), "hello", { session });
			expect(sent.details?.proc).toMatchObject({
				action: "stdin",
				daemon: { name: "echo-service" },
				input: "hello",
			});
			const observed = await client.request({
				op: "wait",
				name: "echo-service",
				for: "exit",
				pattern: "ACK:\\[hello\\]",
				timeoutMs: 2_000,
			});
			expect(observed.op === "wait" && observed.matched).toBe("ACK:[hello]");
			const read = await proc.resolve(parseInternalUrl("proc://echo-service"), { session });
			expect(read.content).toContain("ACK:[hello]");
			expect(read.details?.proc).toMatchObject({
				daemon: { name: "echo-service" },
				log: expect.stringContaining("ACK:[hello]"),
			});
			await proc.write(parseInternalUrl("proc://echo-service"), "", { session });
			const blank = await client.request({
				op: "wait",
				name: "echo-service",
				for: "exit",
				pattern: "ACK:\\[\\]",
				timeoutMs: 2_000,
			});
			expect(blank.op === "wait" && blank.matched).toBe("ACK:[]");
			const persisted = await proc.write(parseInternalUrl("proc://echo-service/mode"), "persist", { session });
			expect(persisted.details?.proc).toMatchObject({ action: "mode", mode: "persist", daemon: { persist: true } });
			const spec: { persist: boolean } = await Bun.file(
				path.join(runtimeDir, "daemons", "echo-service", "spec.json"),
			).json();
			expect(spec.persist).toBeTrue();
			const sessionMode = await proc.write(parseInternalUrl("proc://echo-service/mode"), "session", { session });
			expect(sessionMode.details?.proc).toMatchObject({
				action: "mode",
				mode: "session",
				daemon: { persist: false },
			});
			const sessionSpec: { persist: boolean } = await Bun.file(
				path.join(runtimeDir, "daemons", "echo-service", "spec.json"),
			).json();
			expect(sessionSpec.persist).toBeFalse();
			const restarted = await bash.execute("restart", {
				command: serviceCommand("REPLACED"),
				name: "echo-service",
				ready: { log: "REPLACED", host: "", timeout: 5 },
				pty: false,
				async: false,
			});
			expect(restarted.details?.service?.ready).toBeTrue();
			const restartedLog = restarted.content[0]?.type === "text" ? restarted.content[0].text : "";
			const restartedPort = restartedLog.match(/REPLACED:(\d+)/)?.[1];
			if (!restartedPort) throw new Error("Replacement service did not publish its HTTP port");
			expect(await (await fetch(`http://127.0.0.1:${restartedPort}/`)).text()).toBe("REPLACED");
			const write = new WriteTool(session);
			const stopped = await write.execute("kill", write.parameters.assert({ path: "proc://echo-service/kill" }));
			expect(stopped.details?.proc).toMatchObject({ action: "stop", daemon: { name: "echo-service" } });
			const background = await bash.execute("detach-candidate", {
				command: serviceCommand("RUNNING"),
				name: "detach-candidate",
				ready: { log: "RUNNING:\\d+", timeout: 5 },
				pty: false,
			});
			expect(background.details?.service?.ready).toBeTrue();
			const beforeDetach = await client.request({ op: "describe", name: "detach-candidate" });
			if (beforeDetach.op !== "describe") throw new Error("Expected service description");
			const originalPort = beforeDetach.daemon.readyMatch?.match(/RUNNING:(\d+)/)?.[1];
			if (!originalPort) throw new Error("Service did not publish its HTTP port");
			const originalState = (await (await fetch(`http://127.0.0.1:${originalPort}/state`)).json()) as {
				pid: number;
				token: string;
				counter: number;
			};
			await proc.write(parseInternalUrl("proc://detach-candidate"), "before-detach", { session });
			await client.request({
				op: "wait",
				name: "detach-candidate",
				for: "exit",
				pattern: "ACK:\\[before-detach\\]",
				timeoutMs: 2_000,
			});
			const detached = await proc.write(parseInternalUrl("proc://detach-candidate/mode"), "detached", { session });
			expect(detached.details?.proc).toMatchObject({
				action: "mode",
				mode: "detached",
				daemon: {
					detached: true,
					persist: true,
					id: beforeDetach.daemon.id,
					pid: beforeDetach.daemon.pid,
					startedAt: beforeDetach.daemon.startedAt,
					readyAt: beforeDetach.daemon.readyAt,
					readyMatch: beforeDetach.daemon.readyMatch,
					restartCount: beforeDetach.daemon.restartCount,
				},
			});
			expect(await (await fetch(`http://127.0.0.1:${originalPort}/state`)).json()).toEqual({
				...originalState,
				counter: 1,
			});
			await proc.write(parseInternalUrl("proc://detach-candidate"), "after-detach", { session });
			const afterDetach = await client.request({
				op: "wait",
				name: "detach-candidate",
				for: "exit",
				pattern: "ACK:\\[after-detach\\]",
				timeoutMs: 2_000,
			});
			expect(afterDetach.op === "wait" && afterDetach.matched).toBe("ACK:[after-detach]");
			expect(await (await fetch(`http://127.0.0.1:${originalPort}/state`)).json()).toEqual({
				...originalState,
				counter: 2,
			});
			const detachedReady = await client.request({
				op: "wait",
				name: "detach-candidate",
				for: "ready",
				timeoutMs: 2_000,
			});
			if (detachedReady.op !== "wait") throw new Error("Expected detached service readiness");
			expect(detachedReady.timedOut).toBeFalse();
			const detachedRead = await proc.resolve(parseInternalUrl("proc://detach-candidate"), { session });
			expect(detachedRead.details?.proc?.daemon).toMatchObject({ detached: true, persist: true });
			expect(detachedRead.details?.proc?.log).toContain("ACK:[before-detach]");
			expect(detachedRead.details?.proc?.log).toContain("ACK:[after-detach]");
			const detachedPort = detachedReady.daemon.readyMatch?.match(/RUNNING:(\d+)/)?.[1];
			if (!detachedPort) throw new Error("Detached service did not publish its HTTP port");
			expect(await (await fetch(`http://127.0.0.1:${detachedPort}/`)).text()).toBe("RUNNING");
			const detachedSpec: { persist: boolean; detached: boolean; pty: boolean } = await Bun.file(
				path.join(runtimeDir, "daemons", "detach-candidate", "spec.json"),
			).json();
			expect(detachedSpec).toMatchObject({ detached: true, persist: true, pty: false });
			await proc.write(parseInternalUrl("proc://detach-candidate/mode"), "persist", {
				session,
			});
			const attachedPersist = await client.request({ op: "describe", name: "detach-candidate" });
			if (attachedPersist.op !== "describe") throw new Error("Expected persistent service description");
			expect(attachedPersist.daemon).toMatchObject({
				pid: beforeDetach.daemon.pid,
				detached: false,
				persist: true,
			});
			await proc.write(parseInternalUrl("proc://detach-candidate/mode"), "session", {
				session,
			});
			const attachedSession = await client.request({ op: "describe", name: "detach-candidate" });
			if (attachedSession.op !== "describe") throw new Error("Expected session service description");
			expect(attachedSession.daemon).toMatchObject({
				pid: beforeDetach.daemon.pid,
				detached: false,
				persist: false,
			});
			await proc.write(parseInternalUrl("proc://detach-candidate/kill"), "", { session });
			expect(
				await rejectionMessage(bash.execute("invalid", { command: "true", name: "bad", async: true })),
			).toContain("does not accept async or timeout");
			expect(
				await rejectionMessage(bash.execute("invalid", { command: "true", name: "bad", timeout: 1 })),
			).toContain("does not accept async or timeout");
		} finally {
			await client.request({ op: "stop", name: "echo-service", timeoutMs: 1_000 }).catch(() => undefined);
			await client.request({ op: "stop", name: "detach-candidate", timeoutMs: 1_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			await manager.dispose({ timeoutMs: 1_000 });
			client.close();
			await broker.finished;
			setProcessName(oldTitle);
			spy.mockRestore();
		}
	}, 25_000);

	it("ends the readiness wait on a queued steer only after the broker launched the service", async () => {
		using temp = TempDir.createSync("@omp-proc-service-steer-");
		const cwd = path.join(temp.path(), "project");
		const runtimeDir = path.join(temp.path(), "runtime");
		await fs.mkdir(cwd);
		const client = await createDaemonBrokerClient(cwd, { runtimeDir, idleGraceMs: 5_000 });
		const spy = vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
		const oldTitle = process.title;
		const broker = await startBroker(cwd, runtimeDir);
		// Already queued when the call starts, i.e. before the broker connection.
		const steering = new AbortController();
		steering.abort();
		try {
			// Readiness would wait 300s, past the test timeout; only the steer ends the call early.
			const result = await new BashTool(toolSession(cwd)).execute(
				"service",
				{
					command: "sleep 30",
					name: "slow-service",
					ready: { log: "never-printed", timeout: 300 },
					pty: false,
				},
				undefined,
				undefined,
				steeringContext(steering.signal),
			);
			expect(result.details?.service).toMatchObject({ name: "slow-service", state: "starting", ready: false });
			expect(result.details?.service?.pid).toBeNumber();
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("proc://slow-service");
			const read = await new ProcProtocolHandler().resolve(parseInternalUrl("proc://slow-service"), {
				session: toolSession(cwd),
			});
			expect(read.details?.proc).toMatchObject({ daemon: { name: "slow-service", state: "starting" } });
		} finally {
			await client.request({ op: "stop", name: "slow-service", timeoutMs: 1_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker.finished;
			setProcessName(oldTitle);
			spy.mockRestore();
		}
	}, 20_000);

	it("still rejects validation and launch failures when a steer is queued", async () => {
		const steering = new AbortController();
		const client = {
			projectDir: process.cwd(),
			onCompletion: () => () => {},
			close() {},
			async request(operation: DaemonOperation): Promise<DaemonRpcResult> {
				if (operation.op === "start") {
					// The steer lands while the launch request is in flight.
					steering.abort();
					throw new Error("Daemon cwd is not a directory");
				}
				throw new Error(`Unexpected broker op ${operation.op}`);
			},
		} as unknown as DaemonBrokerClient;
		const spy = vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
		const bash = new BashTool(toolSession(process.cwd()));
		try {
			expect(
				await rejectionMessage(
					bash.execute(
						"launch-failure",
						{ command: "sleep 600", name: "launch-failure", ready: { log: "never-printed", timeout: 300 } },
						undefined,
						undefined,
						steeringContext(steering.signal),
					),
				),
			).toContain("Daemon cwd is not a directory");
			expect(
				await rejectionMessage(
					bash.execute(
						"bad-regex",
						{ command: "true", name: "bad-regex", ready: { log: "(", timeout: 300 } },
						undefined,
						undefined,
						steeringContext(steering.signal),
					),
				),
			).toContain("Invalid readiness regex");
		} finally {
			spy.mockRestore();
		}
	});

	it("keeps the settled service result when a steer arrives during log retrieval", async () => {
		const now = Date.now();
		const daemon: DaemonSnapshot = {
			name: "ready-service",
			id: "ready-service-id",
			state: "starting",
			pid: 12345,
			owner: "Main",
			createdAt: now,
			startedAt: now,
			restartCount: 0,
			outputBytes: 0,
			persist: false,
			detached: false,
		};
		const logsRequested = Promise.withResolvers<void>();
		const logs = Promise.withResolvers<DaemonRpcResult>();
		const client = {
			projectDir: process.cwd(),
			onCompletion: () => () => {},
			close() {},
			async request(operation: DaemonOperation): Promise<DaemonRpcResult> {
				if (operation.op === "start") return { op: "start", daemon, readyTimedOut: false };
				if (operation.op === "wait")
					return { op: "wait", daemon: { ...daemon, state: "ready", readyAt: now }, timedOut: false };
				if (operation.op === "logs") {
					logsRequested.resolve();
					return logs.promise;
				}
				throw new Error(`Unexpected broker op ${operation.op}`);
			},
		} as unknown as DaemonBrokerClient;
		const spy = vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
		const steering = new AbortController();
		try {
			const pending = new BashTool(toolSession(process.cwd())).execute(
				"ready-service",
				{ command: "printf 'READY\n'", name: "ready-service", ready: { log: "READY", timeout: 300 } },
				undefined,
				undefined,
				steeringContext(steering.signal),
			);
			await logsRequested.promise;
			steering.abort();
			logs.resolve({
				op: "logs",
				name: "ready-service",
				text: "READY\n",
				cursor: 6,
				timedOut: false,
				state: "ready",
			});
			const result = await pending;
			expect(result.details?.service).toMatchObject({
				name: "ready-service",
				state: "ready",
				ready: true,
				pid: 12345,
			});
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("READY");
		} finally {
			spy.mockRestore();
		}
	});

	it.each([
		{
			label: "materialized placeholders",
			name: "",
			ready: { log: "", port: 0, host: "", timeout: 30 },
			ignored: false,
		},
		{ label: "blank fields", name: "   ", ready: { log: "", host: "" }, ignored: false },
		{ label: "timeout only", ready: { timeout: 30 }, ignored: false },
		{ label: "host only", ready: { host: "127.0.0.1" }, ignored: false },
		{ label: "log condition", ready: { log: "READY", port: 0, timeout: 30 }, ignored: true },
		{ label: "port condition", name: "", ready: { log: "", port: 1, host: "", timeout: 1 }, ignored: true },
		{
			label: "blank name with readiness",
			name: "   ",
			ready: { log: "", port: 1, host: "", timeout: 1 },
			ignored: true,
		},
	])("runs plain commands with $label and only warns for readiness conditions", async ({ name, ready, ignored }) => {
		const bash = new BashTool(toolSession(process.cwd()));
		const result = await bash.execute("plain", {
			command: "printf 'PLAIN\\n'",
			timeout: 10,
			cwd: process.cwd(),
			pty: false,
			async: false,
			name,
			ready,
		});
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("");
		expect(result.details?.service).toBeUndefined();
		expect(text).toContain("PLAIN\n");
		expect(text.includes("Ignored ready:")).toBe(ignored);
	});

	it("refuses to detach the project-shared browser, which the broker would relaunch on an unprepared profile", async () => {
		const name = sharedBrowserDaemonName(true);
		const now = Date.now();
		const daemon: DaemonSnapshot = {
			name,
			id: "shared",
			state: "ready",
			createdAt: now,
			startedAt: now,
			readyAt: now,
			restartCount: 0,
			outputBytes: 0,
			persist: false,
			detached: false,
		};
		const operations: DaemonOperation["op"][] = [];
		const client = {
			projectDir: process.cwd(),
			onCompletion: () => () => {},
			close() {},
			async request(operation: DaemonOperation): Promise<DaemonRpcResult> {
				operations.push(operation.op);
				if (operation.op === "list") return { op: "list", daemons: [daemon] };
				// The real broker answers by relaunching the browser as a detached process.
				if (operation.op === "mode") return { op: "mode", daemon: { ...daemon, detached: true } };
				throw new Error(`Unexpected broker op ${operation.op}`);
			},
		} as unknown as DaemonBrokerClient;
		const spy = vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
		try {
			await rejectionMessage(
				new ProcProtocolHandler().write(parseInternalUrl(`proc://${name}/mode`), "detached", {
					session: toolSession(process.cwd()),
				}),
			);
			expect(operations).not.toContain("mode");
		} finally {
			spy.mockRestore();
		}
	});
});
