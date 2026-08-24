import { describe, expect, test } from "bun:test";
import { describeChunkFailure } from "./ci-test-ts.ts";

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
