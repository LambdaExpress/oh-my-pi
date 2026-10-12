// Integration tests use real child handles and broker sockets: fake timers cannot
// model a descendant retaining its parent's stdout/stderr after root termination.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient, DaemonBrokerRejectedError } from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonCompletionNotification,
} from "../../src/launch/protocol";
import type { DaemonSnapshot, DaemonSpec } from "@oh-my-pi/pi-tui/tools/daemon";

const NAME = "inherited-pipes";

interface Fixture {
	client: DaemonBrokerClient;
	projectDir: string;
	rootPath: string;
	pidsPath: string;
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
	using tempDir = TempDir.createSync("@omp-inherited-pipes-");
	const projectDir = path.join(tempDir.path(), "project");
	const runtimeDir = path.join(tempDir.path(), "runtime");
	const descendantPath = path.join(tempDir.path(), "descendant.ts");
	const rootPath = path.join(tempDir.path(), "root.ts");
	const pidsPath = path.join(tempDir.path(), "descendants.txt");
	await fs.mkdir(projectDir);
	await fs.writeFile(
		descendantPath,
		`await Bun.write(process.argv[2], "ready");
setInterval(() => {}, 1000);
`,
	);
	await fs.writeFile(
		rootPath,
		`import { appendFile } from "node:fs/promises";
const readyPath = ${JSON.stringify(tempDir.path())} + "/descendant-" + process.pid + ".ready";
const descendant = Bun.spawn([process.execPath, ${JSON.stringify(descendantPath)}, readyPath], {
	stdio: ["ignore", "inherit", "inherit"],
	detached: true,
	windowsHide: true,
});
descendant.unref();
await appendFile(${JSON.stringify(pidsPath)}, descendant.pid + "\\n");
while (!(await Bun.file(readyPath).exists())) await Bun.sleep(10);
console.log("ROOT_READY:" + process.pid);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async chunk => {
	input += chunk;
	if (!input.includes("exit\\n")) return;
	await Bun.write(Bun.stdout, "FINAL_STDOUT\\n");
	await Bun.write(Bun.stderr, "FINAL_STDERR\\n");
	process.exit(7);
});
`,
	);

	const previousTitle = process.title;
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const listening = Promise.withResolvers<void>();
	const broker = startDaemonBrokerFromEnvironment({
		onListening: () => listening.resolve(),
		restartBackoffBaseMs: 100,
	});
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	try {
		await Promise.race([
			listening.promise,
			broker.then(() => {
				throw new Error("Embedded broker did not claim its scope");
			}),
		]);
		await run({ client, projectDir, rootPath, pidsPath });
	} finally {
		await client.request({ op: "stop", name: NAME, timeoutMs: 100 }).catch(() => undefined);
		for (const pid of await descendantPids(pidsPath)) {
			const descendant = Process.fromPid(pid);
			if (descendant?.status() === "running") {
				await descendant.terminate({ group: true, gracefulMs: 0, timeoutMs: 2_000 });
			}
		}
		await client.request({ op: "shutdown" }).catch(() => undefined);
		client.close();
		await broker;
		process.title = previousTitle;
	}
}

async function descendantPids(file: string): Promise<number[]> {
	const text = await fs.readFile(file, "utf8").catch(() => "");
	return text.split("\n").filter(Boolean).map(Number);
}

function spec(fixture: Fixture, restart: DaemonSpec["restart"] = "no"): DaemonSpec {
	return {
		name: NAME,
		application: process.execPath,
		args: [fixture.rootPath],
		env: {},
		cwd: fixture.projectDir,
		pty: false,
		ready: { log: "ROOT_READY:[0-9]+", timeoutMs: 5_000 },
		restart,
		persist: false,
		detached: false,
	};
}

async function snapshot(client: DaemonBrokerClient): Promise<DaemonSnapshot> {
	const result = await client.request({ op: "describe", name: NAME });
	if (result.op !== "describe") throw new Error("Expected daemon description");
	return result.daemon;
}

async function waitForSnapshot(
	client: DaemonBrokerClient,
	condition: (daemon: DaemonSnapshot) => boolean,
): Promise<DaemonSnapshot> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const daemon = await snapshot(client);
		if (condition(daemon)) return daemon;
		await Bun.sleep(25);
	}
	throw new Error("Daemon did not reach the expected state");
}

async function logs(client: DaemonBrokerClient): Promise<string> {
	const result = await client.request({
		op: "logs",
		name: NAME,
		lines: 20,
		head: false,
		follow: false,
		timeoutMs: 1_000,
	});
	if (result.op !== "logs") throw new Error("Expected daemon logs");
	return result.text;
}

describe("daemon broker inherited pipe lifetime", () => {
	it("settles a root exit, retains final output, and delivers one completion before descendants close the pipes", async () => {
		await withFixture(async fixture => {
			const completions: DaemonCompletionNotification[] = [];
			const completed = Promise.withResolvers<void>();
			fixture.client.onCompletion("pipe-owner", notification => {
				completions.push(notification);
				completed.resolve();
			});
			await fixture.client.request({ op: "ping" });
			await fixture.client.request({ op: "start", owner: "pipe-owner", spec: spec(fixture) });
			const [pid] = await descendantPids(fixture.pidsPath);
			if (pid === undefined) throw new Error("Descendant did not start");
			const descendant = Process.fromPid(pid);
			await fixture.client.request({ op: "send", name: NAME, data: "exit\n" });

			const exited = await fixture.client.request({ op: "wait", name: NAME, for: "exit", timeoutMs: 2_000 });
			if (exited.op !== "wait") throw new Error("Expected exit wait result");
			expect(exited.timedOut).toBe(false);
			expect(exited.daemon).toMatchObject({ state: "failed", exitCode: 7 });
			expect(exited.daemon.pid).toBeUndefined();
			expect(descendant?.status()).toBe(ProcessStatus.Running);
			const output = await logs(fixture.client);
			expect(output).toContain("FINAL_STDOUT");
			expect(output).toContain("FINAL_STDERR");

			await completed.promise;
			expect(completions).toHaveLength(1);
			expect(completions[0]?.daemon).toMatchObject({ state: "failed", exitCode: 7 });
			await descendant?.terminate({ group: true, gracefulMs: 0, timeoutMs: 2_000 });
			await fixture.client.request({ op: "describe", name: NAME });
			expect(completions).toHaveLength(1);
		});
	}, 20_000);

	it("keeps an automatically restarted generation alive when old inherited pipes finally close", async () => {
		await withFixture(async fixture => {
			const started = await fixture.client.request({ op: "start", spec: spec(fixture, "always") });
			if (started.op !== "start") throw new Error("Expected daemon start");
			const originalPid = started.daemon.pid;
			const [descendantPid] = await descendantPids(fixture.pidsPath);
			if (descendantPid === undefined) throw new Error("Descendant did not start");
			const descendant = Process.fromPid(descendantPid);
			await fixture.client.request({ op: "send", name: NAME, data: "exit\n" });
			const restarted = await waitForSnapshot(
				fixture.client,
				daemon => daemon.state === "ready" && daemon.restartCount === 1 && daemon.pid !== originalPid,
			);
			expect(descendant?.status()).toBe(ProcessStatus.Running);
			expect(restarted.pid).toBeDefined();
			await descendant?.terminate({ group: true, gracefulMs: 0, timeoutMs: 2_000 });
			expect(await snapshot(fixture.client)).toMatchObject({
				state: "ready",
				pid: restarted.pid,
				restartCount: 1,
			});
			expect(await logs(fixture.client)).toContain(`ROOT_READY:${restarted.pid}`);
		});
	}, 20_000);

	it("stops reporting stopping after the root is killed while a descendant retains both pipes", async () => {
		await withFixture(async fixture => {
			const started = await fixture.client.request({ op: "start", spec: spec(fixture) });
			if (started.op !== "start" || started.daemon.pid === undefined) throw new Error("Expected daemon PID");
			const [pid] = await descendantPids(fixture.pidsPath);
			if (pid === undefined) throw new Error("Descendant did not start");
			const descendant = Process.fromPid(pid);
			const root = Process.fromPid(started.daemon.pid);
			// Kill only the root, not its tree, so the OS pipes demonstrably stay
			// open while the broker reconciles the root's terminal state.
			process.kill(started.daemon.pid, "SIGKILL");
			await root?.waitForExit({ timeoutMs: 2_000 });
			const stopped = await fixture.client.request({ op: "stop", name: NAME, timeoutMs: 100 });
			if (stopped.op !== "stop") throw new Error("Expected daemon stop");
			expect(["exited", "failed"]).toContain(stopped.daemon.state);
			expect(stopped.daemon.pid).toBeUndefined();
			expect(root?.status()).toBe(ProcessStatus.Exited);
			expect(descendant?.status()).toBe(ProcessStatus.Running);
		});
	}, 20_000);

	it("serializes explicit restarts and stops the owned tree after pipe retention is detached", async () => {
		await withFixture(async fixture => {
			const started = await fixture.client.request({ op: "start", spec: spec(fixture) });
			if (started.op !== "start") throw new Error("Expected daemon start");
			const attempts = await Promise.allSettled([
				fixture.client.request({ op: "restart", name: NAME }),
				fixture.client.request({ op: "restart", name: NAME }),
			]);
			const succeeded = attempts.filter(result => result.status === "fulfilled");
			const rejected = attempts.find(result => result.status === "rejected");
			expect(succeeded).toHaveLength(1);
			if (rejected?.status !== "rejected") throw new Error("Concurrent restart was not rejected");
			expect(rejected.reason).toBeInstanceOf(DaemonBrokerRejectedError);
			const restarted = await waitForSnapshot(fixture.client, daemon => daemon.state === "ready");
			expect(restarted.pid).not.toBe(started.daemon.pid);
			const retained = await fixture.client.request({ op: "mode", name: NAME, mode: "detached" });
			if (retained.op !== "mode") throw new Error("Expected retention change");
			expect(retained.daemon).toMatchObject({ pid: restarted.pid, detached: true, persist: true });
			const root = restarted.pid === undefined ? null : Process.fromPid(restarted.pid);
			const descendants = (await descendantPids(fixture.pidsPath)).map(pid => Process.fromPid(pid));
			const stopped = await fixture.client.request({ op: "stop", name: NAME, timeoutMs: 100 });
			if (stopped.op !== "stop") throw new Error("Expected daemon stop");
			expect(stopped.daemon.state).toBe("exited");
			expect(stopped.daemon.pid).toBeUndefined();
			expect(root?.status()).not.toBe(ProcessStatus.Running);
			for (const descendant of descendants) expect(descendant?.status()).not.toBe(ProcessStatus.Running);
		});
	}, 20_000);
});
