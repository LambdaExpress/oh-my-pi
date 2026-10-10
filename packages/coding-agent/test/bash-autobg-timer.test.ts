/**
 * Regression test for #7235: Bash auto-background must release the threshold
 * timer once the command finishes first, instead of leaving a live `Bun.sleep`
 * timer that keeps the event loop alive until the threshold expires (delaying
 * SDK/headless shutdown). Timer keep-alive is only observable in a child
 * process, so this spawns the real BashTool auto-background path against a 30s
 * threshold and asserts the process exits promptly rather than after 30s.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";

const PROBE_PATH = path.join(import.meta.dir, "fixtures", "bash-autobg-exit-probe.ts");
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
// Fixed: probe exits ~0.5s. Buggy: held ~30s by the retained threshold timer.
const PROMPT_EXIT_MS = 15_000;

describe("bash auto-background threshold timer (#7235)", () => {
	it("does not keep the event loop alive after a fast command completes", async () => {
		const start = performance.now();
		const proc = Bun.spawn([process.execPath, PROBE_PATH], {
			cwd: REPO_ROOT,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		// Integration test of real event-loop keep-alive across a process boundary:
		// the child's wall-clock exit time IS the contract, so fake timers cannot
		// apply (they cannot control another process's clock). This real-timer
		// watchdog only bounds a wedged child — a retained threshold timer would
		// otherwise hold it for the full 30s.
		const watchdog = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {}
		}, 28_000);
		try {
			const [exitCode, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			const elapsedMs = performance.now() - start;

			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
			expect(JSON.parse(stdout.trim())).toEqual({ done: true, output: "hi" });
			expect(elapsedMs).toBeLessThan(PROMPT_EXIT_MS);
		} finally {
			clearTimeout(watchdog);
		}
	}, 30_000);
});

describe("Bash 显式前台执行", () => {
	it.each([
		{ exitCode: 0, timeout: 600 },
		{ exitCode: 7, timeout: 300 },
	])("async=false 在自动后台阈值之后返回最终结果（退出码 $exitCode）", async ({ exitCode, timeout }) => {
		const thresholdMs = 10;
		const deliveries: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: (_jobId, text) => {
				deliveries.push(text);
			},
		});
		const session = {
			cwd: process.cwd(),
			hasUI: false,
			skills: [],
			getSessionFile: () => null,
			getSessionId: () => "foreground-autobg-regression",
			asyncJobManager: manager,
			settings: Settings.isolated({
				"bash.autoBackground.enabled": true,
				"bash.autoBackground.thresholdMs": thresholdMs,
				"bashInterceptor.enabled": false,
			}),
			getClientBridge: () => undefined,
		} as unknown as ToolSession;

		try {
			const result = await new BashTool(session).execute("foreground-call", {
				command: `printf 'start\\n'; sleep 0.05; printf 'done\\n'; exit ${exitCode}`,
				timeout,
				pty: false,
				async: false,
			});
			const text = result.content.find(block => block.type === "text")?.text ?? "";

			expect(text).toContain("start\ndone");
			expect(result.isError).toBe(exitCode === 0 ? undefined : true);
			// Successful commands omit exit-code details; failures retain the final status.
			expect(result.details?.exitCode).toBe(exitCode === 0 ? undefined : exitCode);
			expect(result.details?.timeoutSeconds).toBe(timeout);
			expect(result.details?.wallTimeMs).toBeGreaterThanOrEqual(thresholdMs);
			expect(result.details?.async).toBeUndefined();
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 1 });
			expect(manager.getAllJobs()).toEqual([]);
			expect(deliveries).toEqual([]);
		} finally {
			await manager.dispose();
		}
	});
});
