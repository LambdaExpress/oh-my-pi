import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeVmContextsByOwner } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import * as toolTimeouts from "@oh-my-pi/pi-coding-agent/tools/tool-timeouts";

const kernelOwners: string[] = [];

function makeSession(): ToolSession {
	const identity = crypto.randomUUID();
	kernelOwners.push(identity);
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getEvalSessionId: () => identity,
		getEvalKernelOwnerId: () => identity,
		settings: Settings.isolated(),
	};
}

/**
 * Defends the contract that a cell which does not delegate to an `agent()`/
 * `completion()` bridge call is bounded by a plain runtime-work timeout, even
 * while ordinary stdout is active. Timeout and worker-exit paths must both
 * release the retained kernel so the next cell can run.
 */
describe("EvalTool timeout semantics", () => {
	afterEach(async () => {
		await Promise.all(kernelOwners.splice(0).map(owner => disposeVmContextsByOwner(owner)));
		vi.restoreAllMocks();
	});

	it("disables the cell timeout when timeout is zero", async () => {
		// Keep the integration path real while making a mistakenly armed timeout
		// fail quickly. Fake timers cannot drive the isolated worker's clock, and
		// a zero timeout must bypass the production clamp entirely.
		vi.spyOn(toolTimeouts, "clampTimeout").mockReturnValue(0.05);
		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-unlimited-timeout", {
			language: "js",
			code: "await Bun.sleep(100); print('completed');",
			timeout: 0,
		});

		expect(result.content.some(block => block.type === "text" && block.text.includes("completed"))).toBe(true);
		expect(result.details?.cells?.[0]?.status).toBe("complete");
	});

	it("bounds a compute cell (no agent/completion) by a plain wall-clock timeout", async () => {
		// Exercise the real worker cancellation path without spending a full
		// second waiting for the requested public timeout. Warm this test's own
		// worker first so the short budget measures compute, not cold startup.
		const tool = new EvalTool(makeSession());
		await tool.execute("call-compute-seed", { language: "js", code: "", timeout: 0 });
		vi.spyOn(toolTimeouts, "clampTimeout").mockReturnValue(0.05);
		const result = await tool.execute("call-compute-timeout", {
			language: "js",
			code: "print('compute entered'); for (var tick = 0; tick < 200; tick++) { await Bun.sleep(10); print(tick); } print('never');",
			timeout: 1,
		});

		const cell = result.details?.cells?.[0];
		expect(result.isError).toBe(true);
		expect(cell?.status).toBe("error");
		expect(cell?.exitCode).toBeUndefined();
		expect(cell?.output).toContain("compute entered");
		expect(cell?.output).not.toContain("never");

		const next = await tool.execute("call-after-timeout", {
			language: "js",
			code: "print(6 * 7);",
			timeout: 0,
		});
		expect(next.isError === true).toBe(false);
		expect(next.details?.cells?.[0]?.status).toBe("complete");
		expect(next.details?.cells?.[0]?.output).toBe("42");
	});

	it("reports a dead JS worker instead of waiting for the cell timeout", async () => {
		const tool = new EvalTool(makeSession());
		await tool.execute("call-worker-seed", { language: "js", code: "", timeout: 0 });
		const result = await tool.execute("call-worker-exit", {
			language: "js",
			code: "process.exit(0);",
			timeout: 1,
		});

		const cell = result.details?.cells?.[0];
		expect(result.isError).toBe(true);
		expect(cell?.status).toBe("error");
		expect(cell?.exitCode).toBe(1);

		const next = await tool.execute("call-after-worker-exit", {
			language: "js",
			code: "print(7 * 6);",
			timeout: 0,
		});
		expect(next.isError === true).toBe(false);
		expect(next.details?.cells?.[0]?.status).toBe("complete");
		expect(next.details?.cells?.[0]?.output).toBe("42");
	});
});
