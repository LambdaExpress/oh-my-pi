import { describe, expect, test } from "bun:test";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";
import { describeChunkFailure } from "./ci-test-ts.ts";

describe("test runner watchdog", () => {
	// Parent fake timers cannot drive the real watchdog inside the isolated runner process.
	test("kills a stalled chunk, reports failure, and continues the queue", async () => {
		using dir = TempDir.createSync("omp-test-runner-watchdog-");
		const started = dir.join("started");
		const completed = dir.join("completed");
		const continued = dir.join("continued");
		const stalledCommand = [
			process.execPath,
			"-e",
			`await Bun.write(${JSON.stringify(started)}, "started"); await Bun.sleep(60_000); await Bun.write(${JSON.stringify(completed)}, "completed");`,
		];
		const nextCommand = [process.execPath, "-e", `await Bun.write(${JSON.stringify(continued)}, "continued");`];
		const commands = [
			{ label: "stalled chunk", cwd: ".", command: stalledCommand },
			{ label: "following chunk", cwd: ".", command: nextCommand },
		];
		const result = await ptree.exec(
			[
				process.execPath,
				"-e",
				`import { runTestCommandsInParallel } from ${JSON.stringify(import.meta.resolve("./ci-test-ts.ts"))}; await runTestCommandsInParallel(${JSON.stringify(commands)}, 1);`,
			],
			{
				env: { ...Bun.env, OMP_TEST_CHUNK_TIMEOUT: "1", NO_COLOR: "1" },
				timeout: 10_000,
				detached: true,
				allowNonZero: true,
			},
		);

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("[watchdog]");
		expect(await Bun.file(started).exists()).toBe(true);
		expect(await Bun.file(completed).exists()).toBe(false);
		expect(await Bun.file(continued).text()).toBe("continued");
	}, 15_000);
});

async function spawnBunExitCode(exitCode: number): Promise<number> {
	const proc = Bun.spawn([process.execPath, "-e", `process.exit(${exitCode})`], {
		stdout: "ignore",
		stderr: "ignore",
	});
	return await proc.exited;
}

// POSIX reports SIGKILL as 128 + 9. Windows has no equivalent signal-exit
// convention, so drive the same observable runner input through a real child.
async function spawnUnownedSigkillExitCode(): Promise<number> {
	if (process.platform === "win32") return await spawnBunExitCode(137);
	const proc = Bun.spawn([process.execPath, "-e", 'process.kill(process.pid, "SIGKILL")'], {
		stdout: "ignore",
		stderr: "ignore",
	});
	return await proc.exited;
}

// Re-hosts the sequential runner's failure tail: spawn, watchdog, attribute.
// `runTestCommand` itself is not injectable (it builds argv from the repo
// layout), so the decision under test is driven directly. A child-ready signal
// deterministically triggers the same state change and kill as the watchdog.
async function runWithWatchdog(): Promise<string> {
	const proc = Bun.spawn(
		[process.execPath, "-e", 'console.log("ready"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)'],
		{
			stdout: "pipe",
			stderr: "ignore",
		},
	);
	const reader = proc.stdout.getReader();
	const ready = await reader.read();
	reader.releaseLock();
	if (ready.done || !new TextDecoder().decode(ready.value).includes("ready")) {
		throw new Error("Watchdog fixture child exited before becoming ready");
	}
	const timedOut = true;
	proc.kill("SIGKILL");
	const exitCode = await proc.exited;
	return describeChunkFailure(exitCode, timedOut);
}

describe("describeChunkFailure", () => {
	test("an exit 137 that the watchdog did not cause is attributed to the OOM killer", async () => {
		const exitCode = await spawnUnownedSigkillExitCode();
		expect(exitCode).toBe(137);

		const message = describeChunkFailure(exitCode, false);
		expect(message).toContain("OOM killer");
		expect(message).toContain("chunkSize");
		// The old wording carried no cause at all; it must not come back.
		expect(message).not.toBe("failed with exit code 137");
	});

	test("a watchdog kill is attributed to the watchdog, not to memory", async () => {
		const message = await runWithWatchdog();
		expect(message).toContain("chunk watchdog");
		expect(message).toContain("OMP_TEST_CHUNK_TIMEOUT");
		expect(message).not.toContain("OOM killer");
	});

	test("the two SIGKILL causes produce different messages from the same exit code", async () => {
		const oomKilled = describeChunkFailure(137, false);
		const watchdogKilled = describeChunkFailure(137, true);
		expect(oomKilled).not.toBe(watchdogKilled);
	});

	test("an ordinary test failure keeps the plain wording", async () => {
		const exitCode = await spawnBunExitCode(1);
		expect(exitCode).toBe(1);
		expect(describeChunkFailure(exitCode, false)).toBe("failed with exit code 1");
	});

	test("a bun crash exit keeps the plain wording so the retry log still reads naturally", () => {
		expect(describeChunkFailure(134, false)).toBe("failed with exit code 134");
		expect(describeChunkFailure(139, false)).toBe("failed with exit code 139");
	});

	test("the watchdog message reports the configured timeout", () => {
		const previous = Bun.env.OMP_TEST_CHUNK_TIMEOUT;
		Bun.env.OMP_TEST_CHUNK_TIMEOUT = "42";
		try {
			expect(describeChunkFailure(137, true)).toContain("42s");
		} finally {
			if (previous === undefined) delete Bun.env.OMP_TEST_CHUNK_TIMEOUT;
			else Bun.env.OMP_TEST_CHUNK_TIMEOUT = previous;
		}
	});
});
