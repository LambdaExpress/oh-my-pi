// Real-process integration: a worker-host child must survive cold startup
// without inheriting a terminal or an already-listening in-process broker.
// Fake timers cannot drive native pipe accepts, child startup, or PTY I/O.
// Set OMP_TEST_COMPILED_CLI to additionally exercise the built executable.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { daemonBrokerEndpoint } from "../../src/launch/paths";
import {
	DAEMON_BROKER_WORKER_ARG,
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonOperation,
	type DaemonRpcResult,
	parseDaemonRpcResult,
	parseDaemonWireMessage,
} from "../../src/launch/protocol";

const sourceEntry = path.resolve(import.meta.dir, "../../src/cli.ts");
const compiledEntry = process.env.OMP_TEST_COMPILED_CLI;

for (const mode of ["source", "compiled"] as const) {
	describe(`${mode} broker worker host`, () => {
		it.skipIf(mode === "compiled" && !compiledEntry)(
			"starts a cold broker and drives a real PTY",
			async () => {
				using temp = TempDir.createSync("@omp-broker-worker-host-");
				const projectDir = path.join(temp.path(), "project");
				const runtimeDir = path.join(temp.path(), "run");
				await fs.mkdir(projectDir);
				await fs.mkdir(runtimeDir);
				const token = crypto.randomUUID();
				await fs.writeFile(path.join(runtimeDir, "broker.token"), token);
				const script = path.join(projectDir, "input.ts");
				await fs.writeFile(
					script,
					`process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", data => {
	process.stdout.write("STDIN:" + JSON.stringify(data) + "\\n");
	process.exit(0);
});
process.stdout.write("WORKER-PTY-READY\\n");
`,
				);
				const env: NodeJS.ProcessEnv = {
					...process.env,
					[DAEMON_PROJECT_DIR_ENV]: projectDir,
					[DAEMON_RUNTIME_DIR_ENV]: runtimeDir,
					[DAEMON_IDLE_GRACE_ENV]: "30000",
				};
				delete env.BUN_BE_BUN;
				delete env.PI_COMPILED;
				const command = mode === "source" ? [process.execPath, sourceEntry] : [path.resolve(compiledEntry!)];
				const child = Bun.spawn([...command, DAEMON_BROKER_WORKER_ARG], {
					cwd: projectDir,
					env,
					stdin: "ignore",
					stdout: "ignore",
					stderr: "pipe",
					detached: true,
					windowsHide: true,
				});
				const stderr = new Response(child.stderr).text();
				let socket: IpcConnection | undefined;
				const pending = new Map<
					string,
					{
						operation: DaemonOperation;
						resolve: (result: DaemonRpcResult) => void;
						reject: (error: Error) => void;
						timer: NodeJS.Timeout;
					}
				>();
				const request = (operation: DaemonOperation): Promise<DaemonRpcResult> => {
					if (!socket) return Promise.reject(new Error("broker socket unavailable"));
					const id = crypto.randomUUID();
					const result = Promise.withResolvers<DaemonRpcResult>();
					const timer = setTimeout(() => {
						pending.delete(id);
						result.reject(new Error(`broker ${operation.op} request timed out`));
					}, 10_000);
					pending.set(id, { operation, ...result, timer });
					socket.send(JSON.stringify({ id, token, operation }));
					return result.promise;
				};
				try {
					const deadline = performance.now() + 10_000;
					while (!socket && child.exitCode === null && performance.now() < deadline) {
						try {
							socket = await IpcConnection.connect(daemonBrokerEndpoint(runtimeDir), {
								framing: "lines",
								timeoutMs: 100,
							});
						} catch {
							await Bun.sleep(25);
						}
					}
					if (!socket) throw new Error(`worker host did not bind its broker endpoint (exit=${child.exitCode})`);
					socket.start(
						line => {
							const message = parseDaemonWireMessage(JSON.parse(line));
							if ("event" in message) return;
							const entry = pending.get(message.id);
							if (!entry) return;
							pending.delete(message.id);
							clearTimeout(entry.timer);
							if (!message.ok) entry.reject(new Error(message.error));
							else entry.resolve(parseDaemonRpcResult(entry.operation, message.result));
						},
						() => {
							for (const entry of pending.values()) {
								clearTimeout(entry.timer);
								entry.reject(new Error("broker socket closed"));
							}
							pending.clear();
						},
					);
					const ping = await request({ op: "ping" });
					expect(ping.op).toBe("ping");
					expect(child.exitCode).toBeNull();
					const started = await request({
						op: "start",
						spec: {
							name: "worker-pty",
							application: process.execPath,
							args: [script],
							cwd: projectDir,
							env: {},
							pty: true,
							ready: { log: "WORKER-PTY-READY", timeoutMs: 5_000 },
							restart: "no",
							persist: false,
							detached: false,
						},
					});
					if (started.op !== "start") throw new Error("unexpected start response");
					expect(started.readyTimedOut).toBe(false);
					expect(started.daemon.pid).toBeGreaterThan(0);
					await request({ op: "send", name: "worker-pty", data: "q" });
					const exited = await request({ op: "wait", name: "worker-pty", for: "exit", timeoutMs: 5_000 });
					if (exited.op !== "wait") throw new Error("unexpected wait response");
					expect(exited.timedOut).toBe(false);
					expect(exited.daemon.exitCode).toBe(0);
					const logs = await request({
						op: "logs",
						name: "worker-pty",
						lines: 20,
						head: false,
						follow: false,
						timeoutMs: 1_000,
					});
					if (logs.op !== "logs") throw new Error("unexpected logs response");
					expect(logs.text).toContain('STDIN:"q"');
					await request({ op: "shutdown" });
					expect(await child.exited).toBe(0);
				} finally {
					if (socket && !socket.closed && child.exitCode === null) {
						await request({ op: "shutdown" }).catch(() => undefined);
					}
					for (const entry of pending.values()) {
						clearTimeout(entry.timer);
						entry.reject(new Error("broker test ended"));
					}
					pending.clear();
					socket?.destroy();
					if (child.exitCode === null) child.kill("SIGKILL");
					await child.exited;
					const errorOutput = await stderr;
					if (child.exitCode !== 0 && errorOutput) console.error(errorOutput);
				}
			},
			45_000,
		);
	});
}
