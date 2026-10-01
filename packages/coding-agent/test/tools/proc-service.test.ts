import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setProcessName, TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { AsyncJobManager } from "../../src/async/job-manager";
import { ProcProtocolHandler } from "../../src/internal-urls/proc-protocol";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient } from "../../src/launch/client";
import * as daemonClient from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";
import { BashTool } from "../../src/tools/bash";
import { WriteTool } from "../../src/tools/write";
import type { ToolSession } from "../../src/tools";

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
		}),
	} as unknown as ToolSession;
}

async function expectProcError(request: Promise<unknown>, message: string): Promise<void> {
	// Await broker-backed requests before asserting so asynchronous matchers
	// cannot re-enter a pending pipe completion.
	let failure: unknown;
	try {
		await request;
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(Error);
	expect(failure).toMatchObject({ message: expect.stringContaining(message) });
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
			await expectProcError(protocol.resolve(parseInternalUrl("proc://")), "requires a tool session");
			await expectProcError(protocol.write(parseInternalUrl(`proc://${id}/kill`), ""), "requires a tool session");
			const list = await protocol.resolve(parseInternalUrl("proc://"), { session });
			expect(list.content).toContain(`${id} [bash] running`);
			expect(list.content).not.toContain("other-job");
			expect(list.details?.proc?.jobs).toMatchObject([{ id, status: "running" }]);
			await expectProcError(protocol.resolve(parseInternalUrl("proc://other-job"), { session }), "not found");
			await expectProcError(protocol.write(parseInternalUrl("proc://other-job/kill"), "", { session }), "not found");
			const running = await protocol.resolve(parseInternalUrl(`proc://${id}`), { session });
			expect(running.content).toContain("compiling assets");
			expect(running.content).toContain("building 50%");
			expect(running.details?.proc?.job).toMatchObject({ id, status: "running" });
			await expectProcError(
				protocol.write(parseInternalUrl(`proc://${id}`), "input", { session }),
				"stdin is only available for services",
			);
			await expectProcError(protocol.resolve(parseInternalUrl(`proc://${id}/kill`), { session }), "writable only");
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
			await expectProcError(
				write.execute("invalid-cancel", {
					path: `proc://${id}`,
					content: '</antml>\n<parameter name="i">Cancelling background test run',
				}),
				"stdin is only available for services",
			);
			await expectProcError(
				write.execute("empty-stdin", { path: `proc://${id}`, content: "" }),
				"stdin is only available for services",
			);
			await expectProcError(
				write.execute("missing-stdin", write.parameters.assert({ path: `proc://${id}` })),
				"content is required",
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
			await expectProcError(protocol.resolve(parseInternalUrl("proc://owned-job"), { session }), "not found");
			await expectProcError(protocol.write(parseInternalUrl("proc://owned-job/kill"), "", { session }), "not found");
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
		await expectProcError(
			write.execute("missing-content", write.parameters.assert({ path: file })),
			"content is required",
		);
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
process.stdin.on("data", chunk => {
	input += chunk;
	for (;;) {
		const newline = input.indexOf("\\n");
		if (newline < 0) break;
		const line = input.slice(0, newline).replace(/\\r$/, "");
		input = input.slice(newline + 1);
		process.stdout.write("ACK:[" + line + "]\\n");
	}
});
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch() { return new Response(process.argv[2]); }
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
			await expectProcError(
				proc.resolve(parseInternalUrl("proc://echo-service"), { session }),
				"both job echo-service and service echo-service",
			);
			await expectProcError(
				proc.write(parseInternalUrl("proc://echo-service/kill"), "", { session }),
				"both job echo-service and service echo-service",
			);
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
			const metadata: { spec: { persist: boolean } } = await Bun.file(
				path.join(runtimeDir, "daemons", "echo-service", "meta.json"),
			).json();
			expect(metadata.spec.persist).toBeTrue();
			const sessionMode = await proc.write(parseInternalUrl("proc://echo-service/mode"), "session", { session });
			expect(sessionMode.details?.proc).toMatchObject({
				action: "mode",
				mode: "session",
				daemon: { persist: false },
			});
			const sessionMetadata: { spec: { persist: boolean } } = await Bun.file(
				path.join(runtimeDir, "daemons", "echo-service", "meta.json"),
			).json();
			expect(sessionMetadata.spec.persist).toBeFalse();
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
			const detached = await proc.write(parseInternalUrl("proc://detach-candidate/mode"), "detached", { session });
			expect(detached.details?.proc).toMatchObject({
				action: "mode",
				mode: "detached",
				daemon: { detached: true, persist: true },
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
			const detachedPort = detachedReady.daemon.readyMatch?.match(/RUNNING:(\d+)/)?.[1];
			if (!detachedPort) throw new Error("Detached service did not publish its HTTP port");
			expect(await (await fetch(`http://127.0.0.1:${detachedPort}/`)).text()).toBe("RUNNING");
			const detachedMetadata: { spec: { persist: boolean; detached: boolean } } = await Bun.file(
				path.join(runtimeDir, "daemons", "detach-candidate", "meta.json"),
			).json();
			expect(detachedMetadata.spec).toMatchObject({ detached: true, persist: true });
			await expectProcError(
				proc.write(parseInternalUrl("proc://detach-candidate/mode"), "session", { session }),
				"must remain persistent",
			);
			await proc.write(parseInternalUrl("proc://detach-candidate/kill"), "", { session });
			await expectProcError(
				bash.execute("invalid", { command: "true", name: "bad", async: true }),
				"does not accept async or timeout",
			);
			await expectProcError(
				bash.execute("invalid", { command: "true", name: "bad", timeout: 1 }),
				"does not accept async or timeout",
			);
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

	it("runs a finite command when blank service names accompany readiness fields", async () => {
		const bash = new BashTool(toolSession(process.cwd()));
		const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
			result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("");
		const result = await bash.execute("materialized", {
			command: "printf 'PLAIN\\n'",
			cwd: process.cwd(),
			pty: false,
			async: false,
			name: "   ",
			ready: { log: "", port: 1, host: "", timeout: 1 },
		});
		expect(result.details?.service).toBeUndefined();
		expect(textOf(result)).toContain("PLAIN");
	});
});
