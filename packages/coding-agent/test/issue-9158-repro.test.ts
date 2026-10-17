/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/9158
 *
 * `createWorkerSubprocess` spawns every worker with `serialization: "advanced"`.
 * When a child sends a malformed or truncated advanced-IPC frame, Bun raises the
 * structured-clone decode failure as a process-level `uncaughtException` in the
 * PARENT (oven-sh/bun#37287) — not in the channel's `ipc()` callback. The global
 * postmortem handler treated that as fatal and exited the whole session with
 * code 1, defeating the entire point of isolating worker failures in a subprocess.
 *
 * The fix teaches the postmortem `uncaughtException` handler to recognize that
 * specific Bun decode error (`isWorkerIpcDeserializeError`), keep the session
 * alive, and fault every active advanced-IPC worker so its owning client rejects
 * in-flight requests and recycles. This test spawns a real parent process (which
 * installs the postmortem handler on import) whose worker emits a bad frame and
 * then STAYS ALIVE — proving the malformed frame itself faults the worker's error
 * channel rather than a coincidental clean exit — and pins that the parent
 * survives. On Windows the fixture wraps the raw IPC body in libuv's named-pipe
 * frame header so the malformed payload reaches Bun's deserializer.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";

describe("issue #9158 — malformed worker IPC frame must not terminate the parent", () => {
	it("contains an advanced-serialization decode failure to the worker instead of exiting the session", async () => {
		const repoRoot = path.resolve(import.meta.dir, "..");
		// Bun advanced-IPC frame with an invalid structured-clone body, written
		// raw to the IPC fd (3), then the child blocks forever. Staying alive is
		// the point: the malformed frame — not an exit — must fault the worker.
		// On Windows the IPC fd is a libuv ipc-mode named pipe that wraps every
		// write in a 16-byte frame header ({flags=HAS_DATA, 0, length, 0}); an
		// unwrapped raw write is rejected by libuv and silently closes the
		// channel without ever reaching Bun's deserializer.
		const childScript =
			'const body = Buffer.from([2, 4, 0, 0, 0, 0xde, 0xad, 0xbe, 0xef]); let frame = body; if (process.platform === "win32") { const header = Buffer.alloc(16); header.writeUInt32LE(1, 0); header.writeUInt32LE(body.length, 8); frame = Buffer.concat([header, body]); } require("node:fs").writeSync(3, frame); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);';
		// Runs in a spawned `bun -e` parent: importing worker-client pulls in the
		// postmortem module, which installs the global uncaughtException handler
		// under test.
		const wrapperScript = `
			import { createWorkerSubprocess } from "@oh-my-pi/pi-coding-agent/subprocess/worker-client";
			const worker = createWorkerSubprocess({
				spawnCommand: { cmd: [process.execPath, "-e", ${JSON.stringify(childScript)}] },
				env: {},
				exitLabel: "malformed IPC child",
				unref: false,
			});
			const { promise: errored, resolve } = Promise.withResolvers();
			worker.errors.add(resolve);
			const deadline = setTimeout(() => {
				worker.intentionalExit.value = true;
				worker.proc.kill("SIGKILL");
				process.exitCode = 2;
			}, 10000);
			// The bad frame is contained and faults the worker's error channel even
			// though the child never exits on its own.
			const err = await errored;
			if (!(err.cause instanceof TypeError)) throw err;
			await worker.proc.exited;
			await worker.stderrDrained;
			clearTimeout(deadline);
			process.stdout.write("FAULTED_AND_REAPED");
		`;
		const proc = Bun.spawn([process.execPath, "-e", wrapperScript], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, PI_TEST_RUNTIME: "0" },
		});
		try {
			const [stdout, , exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			// This marker is written only after the error channel faults and the
			// still-live worker is killed/reaped without terminating its parent.
			expect(exitCode).toBe(0);
			expect(stdout).toBe("FAULTED_AND_REAPED");
		} finally {
			proc.kill();
			await proc.exited;
		}
	}, 20_000);

	it("still faults on an unrelated TypeError with the same message but a real stack", async () => {
		// Guards the narrowed matcher: an application-thrown `TypeError` carrying
		// this exact message but a populated stack must stay on the fatal path,
		// so a genuine bug is never silently swallowed as a worker IPC frame.
		const repoRoot = path.resolve(import.meta.dir, "..");
		const wrapperScript = `
			import "@oh-my-pi/pi-coding-agent/subprocess/worker-client";
			process.stdout.write("BEFORE_THROW");
			queueMicrotask(() => { throw new TypeError("Unable to deserialize data."); });
		`;
		const proc = Bun.spawn([process.execPath, "-e", wrapperScript], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, PI_TEST_RUNTIME: "0" },
		});
		try {
			const [stdout, , exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(exitCode).toBe(1);
			expect(stdout).toBe("BEFORE_THROW");
		} finally {
			proc.kill();
			await proc.exited;
		}
	}, 20_000);
});
