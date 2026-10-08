import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import * as brokerClients from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonCompletionNotification,
} from "../../src/launch/protocol";
import { listServices, sendService, startService, waitForOwnedServiceCompletion } from "../../src/launch/services";
import type { ToolSession } from "../../src/tools";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";

interface EmbeddedBroker {
	/** Settles once this in-process broker has shut down and flushed its metadata. */
	finished: Promise<void>;
}

/**
 * Start the in-process broker and wait until it accepts connections. A client
 * that connects earlier spawns a broker process, which can claim the scope in a
 * broker-restart handoff; `finished` would then not track the broker that
 * flushes the metadata these tests read.
 */
async function startBroker(projectDir: string, runtimeDir: string): Promise<EmbeddedBroker> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const listening = Promise.withResolvers<boolean>();
	const finished = startDaemonBrokerFromEnvironment({ onListening: () => listening.resolve(true) });
	if (previousProjectDir === undefined) delete process.env[DAEMON_PROJECT_DIR_ENV];
	else process.env[DAEMON_PROJECT_DIR_ENV] = previousProjectDir;
	if (previousRuntimeDir === undefined) delete process.env[DAEMON_RUNTIME_DIR_ENV];
	else process.env[DAEMON_RUNTIME_DIR_ENV] = previousRuntimeDir;
	if (previousGrace === undefined) delete process.env[DAEMON_IDLE_GRACE_ENV];
	else process.env[DAEMON_IDLE_GRACE_ENV] = previousGrace;
	const claimed = await Promise.race([listening.promise, finished.then(() => false)]);
	if (!claimed) throw new Error("In-process daemon broker did not claim its scope");
	return { finished };
}

describe("session-owned supervised services", () => {
	it.each([false, true])(
		"retains process state across session exit and restores session cleanup (pty: %s)",
		async pty => {
			using tempDir = TempDir.createSync("@omp-service-session-exit-");
			const projectDir = path.join(tempDir.path(), "project");
			const servicePath = path.join(tempDir.path(), "service.ts");
			const launcherPath = path.join(tempDir.path(), "launcher.ts");
			const runtimeInfoPath = path.join(tempDir.path(), "runtime.json");
			await fs.mkdir(projectDir);
			await Bun.write(
				servicePath,
				`const token = crypto.randomUUID();
let counter = 0;
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", chunk => {
	input += chunk;
	for (;;) {
		const newline = input.indexOf("\\n");
		if (newline < 0) break;
		input = input.slice(newline + 1);
		counter++;
		console.log("COUNT:" + counter);
	}
});
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch() { return Response.json({ pid: process.pid, token, counter }); }
});
console.log("STATE:" + JSON.stringify({ pid: process.pid, token, counter, port: server.port }));
`,
			);
			await Bun.write(
				launcherPath,
				`import * as fs from "node:fs/promises";
import { daemonClientForProject, closeDaemonClients } from ${JSON.stringify(new URL("../../src/launch/client.ts", import.meta.url).href)};
import { daemonRuntimeDir } from ${JSON.stringify(new URL("../../src/launch/paths.ts", import.meta.url).href)};
import { registerDaemonProjectPresence } from ${JSON.stringify(new URL("../../src/launch/presence.ts", import.meta.url).href)};
const client = await daemonClientForProject(${JSON.stringify(projectDir)});
const runtimeDir = daemonRuntimeDir(client.projectDir);
await fs.writeFile(${JSON.stringify(runtimeInfoPath)}, JSON.stringify({ runtimeDir }));
// Match the real session's startup lease: the fixture's short idle grace must
// not retire a freshly listening broker between the client's connect probes.
const presence = await registerDaemonProjectPresence(client.projectDir, runtimeDir);
try {
const started = await client.request({
	op: "start",
	owner: "original-session",
	spec: {
		name: "retained-service",
		application: process.execPath,
		args: [${JSON.stringify(servicePath)}],
		env: {},
		cwd: client.projectDir,
		pty: ${JSON.stringify(pty)},
		ready: { log: "STATE:\\\\{[^\\\\n]+\\\\}", timeoutMs: 5000 },
		restart: "no",
		persist: false,
		detached: false
	}
});
if (started.op !== "start") throw new Error("Expected service start");
const state = JSON.parse(started.daemon.readyMatch.slice("STATE:".length));
await client.request({ op: "send", name: "retained-service", data: "before-detach\\r" });
const mutated = await client.request({ op: "wait", name: "retained-service", for: "exit", pattern: "COUNT:1", timeoutMs: 5000 });
if (mutated.op !== "wait" || mutated.matched !== "COUNT:1") throw new Error("Service did not retain input state");
const detached = await client.request({ op: "mode", name: "retained-service", mode: "detached" });
if (detached.op !== "mode") throw new Error("Expected mode transition");
const broker = JSON.parse(await fs.readFile(runtimeDir + "/broker.pid", "utf8"));
console.log(JSON.stringify({ before: started.daemon, after: detached.daemon, state, brokerPid: broker.pid }));
} finally {
	await presence.close();
	await closeDaemonClients();
}
`,
			);
			const launcher = Bun.spawn([process.execPath, launcherPath], {
				cwd: projectDir,
				env: {
					...process.env,
					HOME: tempDir.path(),
					USERPROFILE: tempDir.path(),
					PI_CONFIG_DIR: ".omp",
					PI_CODING_AGENT_DIR: "",
					OMP_PROFILE: "",
					PI_PROFILE: "",
					XDG_DATA_HOME: "",
					XDG_STATE_HOME: "",
					XDG_CACHE_HOME: "",
					[DAEMON_IDLE_GRACE_ENV]: "50",
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			let client: brokerClients.DaemonBrokerClient | undefined;
			let brokerPid: number | undefined;
			try {
				const [stdout, stderr, exitCode] = await Promise.all([
					Bun.readableStreamToText(launcher.stdout),
					Bun.readableStreamToText(launcher.stderr),
					launcher.exited,
				]);
				if (exitCode !== 0) throw new Error(`Launching session failed: ${stderr}`);
				const result = JSON.parse(stdout.trim()) as {
					before: DaemonSnapshot;
					after: DaemonSnapshot;
					state: { pid: number; token: string; counter: number; port: number };
					brokerPid: number;
				};
				brokerPid = result.brokerPid;
				expect(result.after).toMatchObject({
					id: result.before.id,
					pid: result.before.pid,
					startedAt: result.before.startedAt,
					readyAt: result.before.readyAt,
					readyMatch: result.before.readyMatch,
					restartCount: result.before.restartCount,
					detached: true,
					persist: true,
				});
				// Cross the real last-client shutdown grace with no client connected.
				// These are OS processes and broker timers, not fake-time callbacks.
				await Bun.sleep(150);
				expect(await (await fetch(`http://127.0.0.1:${result.state.port}/`)).json()).toEqual({
					pid: result.state.pid,
					token: result.state.token,
					counter: 1,
				});
				const { runtimeDir } = (await Bun.file(runtimeInfoPath).json()) as { runtimeDir: string };
				client = await brokerClients.createDaemonBrokerClient(projectDir, { runtimeDir });
				const reconnected = await client.request({ op: "describe", name: "retained-service" });
				if (reconnected.op !== "describe") throw new Error("Expected reconnected service description");
				expect(reconnected.daemon).toMatchObject({
					pid: result.before.pid,
					id: result.before.id,
					startedAt: result.before.startedAt,
					readyAt: result.before.readyAt,
				});
				await client.request({ op: "send", name: "retained-service", data: "after-session-exit\r" });
				const observed = await client.request({
					op: "wait",
					name: "retained-service",
					for: "exit",
					pattern: "COUNT:2",
					timeoutMs: 5_000,
				});
				expect(observed.op === "wait" && observed.matched).toBe("COUNT:2");
				expect(await (await fetch(`http://127.0.0.1:${result.state.port}/`)).json()).toEqual({
					pid: result.state.pid,
					token: result.state.token,
					counter: 2,
				});
				const logs = await client.request({
					op: "logs",
					name: "retained-service",
					lines: 10,
					head: false,
					follow: false,
					timeoutMs: 1_000,
				});
				if (logs.op !== "logs") throw new Error("Expected retained service output");
				expect(logs.text).toContain("COUNT:1");
				expect(logs.text).toContain("COUNT:2");
				const restored = await client.request({ op: "mode", name: "retained-service", mode: "session" });
				if (restored.op !== "mode") throw new Error("Expected session retention");
				expect(restored.daemon).toMatchObject({
					pid: result.before.pid,
					startedAt: result.before.startedAt,
					detached: false,
					persist: false,
				});
				client.close();
				const childProcess = Process.fromPid(result.state.pid);
				const deadline = Date.now() + 5_000;
				while (childProcess?.status() === "running" && Date.now() < deadline) await Bun.sleep(25);
				expect(childProcess?.status()).not.toBe("running");
			} finally {
				if (launcher.exitCode === null) {
					launcher.kill();
					await launcher.exited;
				}
				const runtimeInfo = (await Bun.file(runtimeInfoPath)
					.json()
					.catch(() => undefined)) as { runtimeDir: string } | undefined;
				if (runtimeInfo) {
					client ??= await brokerClients.createDaemonBrokerClient(projectDir, {
						runtimeDir: runtimeInfo.runtimeDir,
					});
					const broker = (await Bun.file(path.join(runtimeInfo.runtimeDir, "broker.pid"))
						.json()
						.catch(() => undefined)) as { pid: number } | undefined;
					brokerPid ??= broker?.pid;
					await client.request({ op: "stop", name: "retained-service", timeoutMs: 1_000 }).catch(() => undefined);
					await client.request({ op: "shutdown" }).catch(() => undefined);
				}
				client?.close();
				if (brokerPid !== undefined) {
					const processRef = Process.fromPid(brokerPid);
					const deadline = Date.now() + 5_000;
					while (processRef?.status() === "running" && Date.now() < deadline) await Bun.sleep(25);
					if (processRef?.status() === "running") {
						await processRef.terminate({ group: true, gracefulMs: 0, timeoutMs: 2_000 });
					}
				}
			}
		},
		30_000,
	);

	it("delivers a failed service only to its session when another session shares the broker", async () => {
		using tempDir = TempDir.createSync("@omp-service-completion-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const client = await brokerClients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = await startBroker(projectDir, runtimeDir);
		const settings = Settings.isolated();
		const firstCompletions: DaemonCompletionNotification[] = [];
		const secondCompletions: DaemonCompletionNotification[] = [];
		const delivered = Promise.withResolvers<string>();
		const makeSession = (sessionId: string, completions: DaemonCompletionNotification[]): ToolSession => ({
			cwd: projectDir,
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => "Main",
			getSessionId: () => sessionId,
			queueLaunchCompletion: notification => {
				delivered.resolve(sessionId);
				completions.push(notification);
				return Promise.resolve();
			},
		});
		const first = makeSession("first-session", firstCompletions);
		const second = makeSession("second-session", secondCompletions);
		try {
			vi.spyOn(brokerClients, "daemonClientForProject").mockResolvedValue(client);
			const started = await startService(first, {
				name: "failing-service",
				command: "echo service-ready; read answer; exit 3",
				ready: { log: "service-ready", timeout: 5 },
			});
			expect(started.daemon.state).toBe("ready");
			await listServices(second);
			const firstFinished = waitForOwnedServiceCompletion(first);
			await sendService(first, "failing-service", "go\n");
			expect(await delivered.promise).toBe("first-session");
			await firstFinished;
			expect(firstCompletions.map(({ daemon }) => [daemon.name, daemon.state, daemon.exitCode])).toEqual([
				["failing-service", "failed", 3],
			]);
			expect(secondCompletions).toEqual([]);
			expect(started.daemon.owner).toBe("first-session");
		} finally {
			vi.restoreAllMocks();
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker.finished;
			process.title = previousTitle;
		}
	}, 15_000);

	it("replays a completion to its session when that session is resumed after a switch", async () => {
		using tempDir = TempDir.createSync("@omp-service-transition-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const client = await brokerClients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = await startBroker(projectDir, runtimeDir);
		let sessionId = "old-session";
		const callbacks: Array<() => void> = [];
		const deliveries: Array<[string, DaemonCompletionNotification]> = [];
		const session: ToolSession = {
			cwd: projectDir,
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => "Main",
			getSessionId: () => sessionId,
			registerSessionChangeCallback: callback => {
				callbacks.push(callback);
			},
			queueLaunchCompletion: notification => {
				deliveries.push([sessionId, notification]);
				return Promise.resolve();
			},
		};
		const switchTo = (nextSessionId: string): void => {
			sessionId = nextSessionId;
			for (const callback of callbacks) callback();
		};
		try {
			vi.spyOn(brokerClients, "daemonClientForProject").mockResolvedValue(client);
			await startService(session, {
				name: "old-service",
				command: "echo service-ready; read answer; exit 3",
				ready: { log: "service-ready", timeout: 5 },
			});
			switchTo("new-session");
			await listServices(session);
			await sendService(session, "old-service", "go\n");
			const exited = await client.request({ op: "wait", name: "old-service", for: "exit", timeoutMs: 5_000 });
			if (exited.op !== "wait") throw new Error("Expected daemon exit wait");
			expect(exited.daemon.state).toBe("failed");
			expect(deliveries).toEqual([]);

			switchTo("old-session");
			// The broker writes the replay before the list response, so the sink has already run.
			await listServices(session);
			expect(
				deliveries.map(([receiver, { owner, daemon }]) => [receiver, owner, daemon.name, daemon.state]),
			).toEqual([["old-session", "old-session", "old-service", "failed"]]);
			await client.request({ op: "shutdown" });
			await broker.finished;
			const metadata = (await Bun.file(path.join(runtimeDir, "daemons", "old-service", "meta.json")).json()) as {
				pendingCompletions: DaemonCompletionNotification[];
			};
			expect(metadata.pendingCompletions).toEqual([]);
		} finally {
			vi.restoreAllMocks();
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker.finished;
			process.title = previousTitle;
		}
	}, 15_000);

	it("replays a detached service exit only when its original session resumes after broker restart", async () => {
		using tempDir = TempDir.createSync("@omp-service-detached-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		let client = await brokerClients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		let broker = await startBroker(projectDir, runtimeDir);
		let daemonPid: number | undefined;
		const laterCompletions: DaemonCompletionNotification[] = [];
		const resumedCompletions: DaemonCompletionNotification[] = [];
		const resumedDelivery = Promise.withResolvers<DaemonCompletionNotification>();
		const disposeOriginal: Array<() => void> = [];
		const makeSession = (
			sessionId: string,
			completions: DaemonCompletionNotification[],
			onDispose?: (callback: () => void) => void,
		): ToolSession => ({
			cwd: projectDir,
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => "Main",
			getSessionId: () => sessionId,
			registerDisposeCallback: onDispose,
			queueLaunchCompletion: notification => {
				completions.push(notification);
				if (completions === resumedCompletions) resumedDelivery.resolve(notification);
				return Promise.resolve();
			},
		});
		try {
			vi.spyOn(brokerClients, "daemonClientForProject").mockImplementation(async () => client);
			await listServices(makeSession("original-session", [], callback => disposeOriginal.push(callback)));
			const started = await client.request({
				op: "start",
				owner: "original-session",
				spec: {
					name: "detached-service",
					application: process.execPath,
					args: ["-e", "Bun.serve({port: 0, fetch() { return new Response('ok'); } })"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: true,
					detached: true,
				},
			});
			if (started.op !== "start" || started.daemon.pid === undefined) throw new Error("Expected detached daemon");
			daemonPid = started.daemon.pid;
			for (const dispose of disposeOriginal) dispose();
			await client.request({ op: "ping" });
			await client.request({ op: "shutdown" });
			client.close();
			await broker.finished;

			// Old brokers did not record the launch transport. Their detached
			// services still have file-backed output and must remain recoverable.
			const metadataPath = path.join(runtimeDir, "daemons", "detached-service", "meta.json");
			const legacyMetadata = (await Bun.file(metadataPath).json()) as Record<string, unknown>;
			delete legacyMetadata.fileOutput;
			await Bun.write(metadataPath, JSON.stringify(legacyMetadata));

			client = await brokerClients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			broker = await startBroker(projectDir, runtimeDir);
			const running = await listServices(makeSession("later-session", laterCompletions));
			expect(running.find(daemon => daemon.name === "detached-service")?.pid).toBe(daemonPid);
			let rejected = false;
			try {
				await client.request({ op: "mode", name: "detached-service", mode: "session" });
			} catch (error) {
				rejected = error instanceof brokerClients.DaemonBrokerRejectedError;
			}
			expect(rejected).toBeTrue();
			const stillDetached = await client.request({ op: "describe", name: "detached-service" });
			if (stillDetached.op !== "describe") throw new Error("Expected detached service description");
			expect(stillDetached.daemon).toMatchObject({ pid: daemonPid, detached: true, persist: true });
			const processRef = Process.fromPid(daemonPid);
			if (!processRef) throw new Error("Recovered detached daemon disappeared");
			await processRef.terminate({ group: true, gracefulMs: 0, timeoutMs: 2_000 });
			const exited = await client.request({ op: "wait", name: "detached-service", for: "exit", timeoutMs: 5_000 });
			if (exited.op !== "wait") throw new Error("Expected daemon exit wait");
			expect(exited.timedOut).toBe(false);
			expect(laterCompletions).toEqual([]);

			await listServices(makeSession("original-session", resumedCompletions));
			const completion = await resumedDelivery.promise;
			expect(completion.owner).toBe("original-session");
			expect(completion.daemon.name).toBe("detached-service");
			await client.request({ op: "shutdown" });
			// Closed before the broker drops its socket, so no completion reconnect spawns a
			// broker process that recovers and rewrites the metadata read below.
			client.close();
			await broker.finished;
			const metadata = (await Bun.file(
				path.join(runtimeDir, "daemons", "detached-service", "meta.json"),
			).json()) as {
				pendingCompletions: DaemonCompletionNotification[];
			};
			expect(metadata.pendingCompletions).toEqual([]);
		} finally {
			vi.restoreAllMocks();
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker.finished;
			if (daemonPid !== undefined) {
				const processRef = Process.fromPid(daemonPid);
				if (processRef?.status() === "running") {
					await processRef.terminate({ group: true, gracefulMs: 0, timeoutMs: 2_000 });
				}
			}
			process.title = previousTitle;
		}
	}, 20_000);
});
