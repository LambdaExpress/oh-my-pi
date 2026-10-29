// Native execution is gated explicitly and deadlines use fake timers, so no
// npm install, wall-clock sleep, or long-lived child
// is needed to reproduce a missing/stalled command behind a running job row.
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { OutputSink, type OutputSummary } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { AsyncJobManager } from "../src/async";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { executeBash } from "../src/exec/bash-executor";
import * as direnv from "../src/exec/direnv";
import { parseInternalUrl } from "../src/internal-urls/parse";
import { ProcProtocolHandler } from "../src/internal-urls/proc-protocol";
import type { ToolSession } from "../src/tools";
import { BashTool } from "../src/tools/bash";
import * as snapshots from "../src/utils/shell-snapshot";

let cwd: string;

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-shell-launch-deadline-"));
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd });
	vi.spyOn(snapshots, "getOrCreateSnapshot").mockResolvedValue(null);
	vi.spyOn(direnv, "loadDirenvEnv").mockResolvedValue(null);
});

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	resetSettingsForTest();
	await fs.rm(cwd, { recursive: true, force: true });
});

describe("shell launch deadlines", () => {
	it("keeps the native abort adapter Promise-returning without an active command", async () => {
		const shell = new natives.Shell();
		const completion = shell.abort();
		expect(completion).toBeInstanceOf(Promise);
		await completion;
	});

	it("bounds settings startup and never launches after a late settings resolution", async () => {
		const settings = await Settings.init();
		vi.useFakeTimers();
		const gate = Promise.withResolvers<Settings>();
		vi.spyOn(Settings, "init").mockImplementation(() => gate.promise);
		const run = vi.spyOn(natives.Shell.prototype, "run").mockResolvedValue({
			exitCode: 0,
			cancelled: false,
			timedOut: false,
		});
		try {
			const pending = executeBash("printf should-not-run", { cwd, timeout: 25 });
			vi.advanceTimersByTime(25);
			const result = await pending;
			expect(result).toMatchObject({ cancelled: true, timedOut: true, exitCode: undefined });
			expect(result.output).toContain("command was not launched");
			expect(run).not.toHaveBeenCalled();
		} finally {
			gate.resolve(settings);
			await gate.promise;
		}
		await Promise.resolve();
		expect(run).not.toHaveBeenCalled();
	});

	it("bounds a preflight backend that never acknowledges cancellation", async () => {
		vi.useFakeTimers();
		const gate = Promise.withResolvers<null>();
		const entered = Promise.withResolvers<void>();
		const preflight = vi.spyOn(direnv, "loadDirenvEnv").mockImplementation(() => {
			entered.resolve();
			return gate.promise;
		});
		const run = vi.spyOn(natives.Shell.prototype, "run").mockResolvedValue({
			exitCode: 0,
			cancelled: false,
			timedOut: false,
		});
		try {
			const pending = executeBash("printf should-not-run", { cwd, timeout: 25 });
			await entered.promise;
			vi.advanceTimersByTime(25);
			const result = await pending;
			expect(result.timedOut).toBe(true);
			expect(preflight.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
			expect(run).not.toHaveBeenCalled();
		} finally {
			gate.resolve(null);
			await gate.promise;
		}
		await Promise.resolve();
		expect(run).not.toHaveBeenCalled();
	});

	it("passes only the remaining launch budget to the native backend", async () => {
		const run = vi.spyOn(natives.Shell.prototype, "run").mockResolvedValue({
			exitCode: 0,
			cancelled: false,
			timedOut: false,
		});
		const result = await executeBash("true", {
			cwd,
			timeout: 2_000,
			deadlineAt: performance.now() + 500,
			sessionKey: "remaining-launch-budget",
		});
		expect(result.cancelled).toBe(false);
		expect(run.mock.calls[0]?.[0].timeoutMs).toBeGreaterThan(0);
		expect(run.mock.calls[0]?.[0].timeoutMs).toBeLessThanOrEqual(500);
	});

	it("settles with explicit cleanup state when result capture is wedged", async () => {
		vi.useFakeTimers();
		const capture = Promise.withResolvers<OutputSummary>();
		const captureStarted = Promise.withResolvers<void>();
		vi.spyOn(OutputSink.prototype, "dump").mockImplementation(() => {
			captureStarted.resolve();
			return capture.promise;
		});
		vi.spyOn(natives.Shell.prototype, "run").mockImplementation((_options, onChunk) => {
			onChunk?.(null, "captured-before-stall\n");
			return Promise.resolve({ exitCode: 0, cancelled: false, timedOut: false });
		});
		try {
			const pending = executeBash("true", { cwd, timeout: 25, sessionKey: "capture-backstop" });
			await captureStarted.promise;
			vi.advanceTimersByTime(5_025);
			const result = await pending;
			expect(result).toMatchObject({ cancelled: true, timedOut: true, exitCode: undefined });
			expect(result.output).toContain("captured-before-stall");
			expect(result.output).toContain("cleanup requested, termination not yet confirmed");
			expect(result.artifactId).toBeUndefined();
		} finally {
			capture.resolve({
				output: "",
				truncated: false,
				totalLines: 0,
				totalBytes: 0,
				outputLines: 0,
				outputBytes: 0,
			});
			await capture.promise;
		}
	});

	it("shows an unlaunched async command as starting and terminates its launch deadline", async () => {
		vi.useFakeTimers();
		const artifact = Promise.withResolvers<{ path: string; id: string }>();
		const manager = new AsyncJobManager({});
		const session: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionId: () => cwd,
			getSessionSpawns: () => "*",
			asyncJobManager: manager,
			allocateOutputArtifact: () => artifact.promise,
			settings: Settings.isolated({ "launch.enabled": false, "bashInterceptor.enabled": false }),
		};
		const run = vi.spyOn(natives.Shell.prototype, "run").mockResolvedValue({
			exitCode: 0,
			cancelled: false,
			timedOut: false,
		});
		try {
			const result = await new BashTool(session).execute("launch-pending", {
				command: "npm.cmd ci",
				timeout: 1,
				async: true,
				pty: false,
			});
			const id = result.details?.async?.jobId;
			if (!id) throw new Error("expected managed bash job");
			expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Launch pending") });
			expect(manager.getJob(id)?.process?.pids()).toEqual([]);
			const proc = new ProcProtocolHandler();
			const inspection = await proc.resolve(parseInternalUrl(`proc://${id}`), { session });
			expect(inspection.content).toContain("starting (launch pending)");
			const roster = await proc.resolve(parseInternalUrl("proc://"), { session });
			expect(roster.content).toContain("starting (launch pending)");
			vi.advanceTimersByTime(1_000);
			await manager.waitForAll();
			expect(manager.getJob(id)?.status).toBe("failed");
			expect(manager.getJob(id)?.errorText).toContain("during launch preparation; command was not launched");
			expect(run).not.toHaveBeenCalled();
		} finally {
			artifact.resolve({ path: path.join(cwd, "late-artifact"), id: "late-artifact" });
			await manager.dispose();
		}
	});

	it("keeps async:false finite while launch artifact allocation is stalled", async () => {
		vi.useFakeTimers();
		const artifact = Promise.withResolvers<{ path: string; id: string }>();
		const allocationStarted = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({});
		const session: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionId: () => cwd,
			getSessionSpawns: () => "*",
			asyncJobManager: manager,
			allocateOutputArtifact: () => {
				allocationStarted.resolve();
				return artifact.promise;
			},
			settings: Settings.isolated({
				"launch.enabled": false,
				"bashInterceptor.enabled": false,
				"bash.autoBackground.enabled": true,
				"bash.autoBackground.thresholdMs": 1,
			}),
		};
		try {
			const pending = new BashTool(session).execute("foreground-launch", {
				command: "printf should-not-run",
				timeout: 1,
				async: false,
			});
			await allocationStarted.promise;
			vi.advanceTimersByTime(1_000);
			const result = await pending;
			expect(result.isError).toBe(true);
			expect(result.details?.timedOut).toBe(true);
			expect(result.details?.async).toBeUndefined();
			expect(manager.getAllJobs()).toEqual([]);
			expect(result.content[0]).toMatchObject({
				type: "text",
				text: expect.stringContaining("during launch preparation; command was not launched"),
			});
		} finally {
			artifact.resolve({ path: path.join(cwd, "late-foreground-artifact"), id: "late-foreground-artifact" });
			await manager.dispose();
		}
	});
});
