import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import { EVAL_BROWSER_ACTIVITY_OP } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";
import { evalToolRenderer } from "@oh-my-pi/pi-tui/tools/eval";

const cellReleases: Array<() => void> = [];
const jobManagers: AsyncJobManager[] = [];

function createJobManager(options: ConstructorParameters<typeof AsyncJobManager>[0] = {}): AsyncJobManager {
	const manager = new AsyncJobManager(options);
	jobManagers.push(manager);
	return manager;
}

function createCellGate(): PromiseWithResolvers<void> {
	const gate = Promise.withResolvers<void>();
	cellReleases.push(gate.resolve);
	return gate;
}

function makeSession(settings: Settings, asyncJobManager: AsyncJobManager): ToolSession {
	const identity = crypto.randomUUID();
	return {
		cwd: "/tmp/eval-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getEvalSessionId: () => identity,
		getEvalKernelOwnerId: () => identity,
		settings,
		asyncJobManager,
	};
}

function baseResult(overrides: Record<string, unknown> = {}) {
	return {
		output: "",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		artifactId: undefined,
		totalLines: 0,
		totalBytes: 0,
		outputLines: 0,
		outputBytes: 0,
		displayOutputs: [] as unknown[],
		...overrides,
	};
}

/**
 * Mock the JS backend with a cell that streams one chunk immediately and then
 * blocks until the returned `release()` gate opens — so backgrounding is decided
 * by the tool's own threshold/steer race, never by a guessed sleep.
 */
function mockGatedCell(finalOutput: string): { release: () => void } {
	const gate = createCellGate();
	vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async (
		_code: string,
		options: { onChunk?: (chunk: string) => void },
	) => {
		options.onChunk?.("start\n");
		await gate.promise;
		return baseResult({ output: finalOutput });
	}) as never);
	return { release: gate.resolve };
}

function steeringContext(steeringSignal: AbortSignal): AgentToolContext {
	return {
		sessionManager: SessionManager.inMemory(),
		modelRegistry: {
			find: () => undefined,
			getAll: () => [],
			getApiKey: async () => undefined,
		} as unknown as AgentToolContext["modelRegistry"],
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
		toolNames: [],
		toolCall: {
			batchId: "batch-1",
			index: 0,
			total: 1,
			toolCalls: [{ id: "call-steer", name: "eval" }],
			steeringSignal,
		},
	} as AgentToolContext;
}

/**
 * Defends the eval auto-background contract (mirror of bash's): a cell that
 * finishes before the threshold resolves inline with no job leftovers, a cell
 * that outlives the threshold converts into a running async job whose result is
 * delivered later, and a steering interrupt backgrounds the cell immediately so
 * the queued message can inject while the kernel keeps working.
 */
describe("EvalTool auto-background", () => {
	afterEach(async () => {
		for (const release of cellReleases.splice(0)) release();
		const managers = jobManagers.splice(0);
		for (const manager of managers) manager.cancelAll();
		await Promise.all(managers.map(manager => manager.waitForAll()));
		await Promise.all(managers.map(manager => manager.dispose()));
		vi.restoreAllMocks();
	});

	it("preserves browser classification when a foreground-backed job is cancelled", async () => {
		const asyncJobManager = createJobManager();
		const gate = createCellGate();
		const browserEntered = Promise.withResolvers<void>();
		vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation(async (_code, options) => {
			options.onStatus?.({ op: EVAL_BROWSER_ACTIVITY_OP });
			await gate.promise;
			return { ...baseResult(), exitCode: undefined, cancelled: true, displayOutputs: [] };
		});
		const tool = new EvalTool(
			makeSession(
				Settings.isolated({
					"eval.autoBackground.enabled": true,
					"eval.autoBackground.thresholdMs": 2_000,
				}),
				asyncJobManager,
			),
		);
		const controller = new AbortController();
		const execution = tool.execute(
			"browser-cancel",
			{ language: "js", code: "await browser.tabs()" },
			controller.signal,
			update => {
				if (update.details?.hasBrowserActivity) browserEntered.resolve();
			},
		);
		try {
			await browserEntered.promise;
			controller.abort();
			const result = tool.createAbortedResult(
				"browser-cancel",
				{ language: "js", code: "await browser.tabs()" },
				controller.signal,
			);
			expect(result.isError).toBe(true);
			expect(result.details?.hasBrowserActivity).toBe(true);
			expect(result.details?.cells?.[0]?.status).toBe("error");
			await expect(execution).rejects.toBeInstanceOf(ToolAbortError);
		} finally {
			controller.abort();
			gate.resolve();
			await asyncJobManager.waitForAll();
		}
	});

	it("updates a backgrounded call's folded category when browser activity starts later", async () => {
		const asyncJobManager = createJobManager();
		const startBrowser = Promise.withResolvers<void>();
		cellReleases.push(startBrowser.resolve);
		const gate = createCellGate();
		const browserLabel = Promise.withResolvers<string>();
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("theme unavailable");
		const args = { language: "js" as const, code: "await browser.tabs()", title: "Background inspection" };
		const unsubscribe = asyncJobManager.onJobChange(job => {
			if (job.latestDetails?.hasBrowserActivity === true) {
				browserLabel.resolve(
					evalToolRenderer.activitySummary(args, {
						expanded: false,
						isPartial: true,
						theme,
						result: { content: [], details: job.latestDetails },
					}).label,
				);
			}
		});
		vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation(async (_code, options) => {
			await startBrowser.promise;
			options.onStatus?.({ op: EVAL_BROWSER_ACTIVITY_OP });
			await gate.promise;
			return { ...baseResult(), displayOutputs: [] };
		});
		const tool = new EvalTool(
			makeSession(
				Settings.isolated({
					"eval.autoBackground.enabled": true,
					"eval.autoBackground.thresholdMs": 0,
				}),
				asyncJobManager,
			),
		);
		try {
			const initial = await tool.execute("browser-background", args);
			expect(
				evalToolRenderer.activitySummary(args, { expanded: false, isPartial: false, theme, result: initial }).label,
			).toBe("Eval");
			startBrowser.resolve();
			expect(await browserLabel.promise).toBe("Browser");
		} finally {
			startBrowser.resolve();
			gate.resolve();
			await asyncJobManager.waitForAll();
			unsubscribe();
		}
	});

	it("keeps fast cells inline without a job row or delivery", async () => {
		const deliveries: string[] = [];
		const asyncJobManager = createJobManager({
			onJobComplete: async (_jobId, text) => {
				deliveries.push(text);
			},
		});
		vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async () =>
			baseResult({ output: "quick\n" })) as never);

		const tool = new EvalTool(
			makeSession(
				Settings.isolated({
					"eval.autoBackground.enabled": true,
					"eval.autoBackground.thresholdMs": 2_000,
				}),
				asyncJobManager,
			),
		);
		const result = await tool.execute("call-inline", { language: "js", code: "print('quick')" });

		expect(result.isError === true).toBe(false);
		expect(result.details?.async).toBeUndefined();
		expect(result.details?.cells?.[0]?.status).toBe("complete");
		await asyncJobManager.waitForAll();
		await asyncJobManager.drainDeliveries({ timeoutMs: 1 });
		expect(asyncJobManager.getAllJobs()).toEqual([]);
		expect(deliveries).toEqual([]);
	});

	it("backgrounds a cell that outlives the threshold and delivers its result", async () => {
		const deliveries: Array<{ jobId: string; text: string }> = [];
		const updates: Array<{ text: string; state?: string }> = [];
		const asyncJobManager = createJobManager({
			onJobComplete: async (jobId, text) => {
				deliveries.push({ jobId, text });
			},
		});
		const cell = mockGatedCell("start\ndone\n");

		const tool = new EvalTool(
			makeSession(
				Settings.isolated({
					"eval.autoBackground.enabled": true,
					"eval.autoBackground.thresholdMs": 10,
				}),
				asyncJobManager,
			),
		);
		// The gated cell cannot finish on its own, so execute() returning proves
		// the threshold path backgrounded it.
		const result = await tool.execute(
			"call-background",
			{ language: "js", code: "print('start'); await work(); print('done')" },
			undefined,
			update => {
				updates.push({
					text: update.content?.find(block => block.type === "text")?.text ?? "",
					state: update.details?.async?.state,
				});
			},
		);

		expect(result.details?.async?.state).toBe("running");
		expect(result.details?.async?.type).toBe("eval");
		const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("Backgrounded as job");
		// No `timeout` given, backgrounded after its foreground wait: the deadline is eval's 30 s
		// default counted over the cell's whole run, not time left.
		expect(text).toContain("(killed once it has run 30s in total; `timeout: 0` disables the deadline)");
		// The snapshot keeps the running cell (with its streamed tail) for the transcript.
		expect(result.details?.cells?.[0]?.status).toBe("running");

		const jobId = result.details?.async?.jobId;
		if (!jobId) {
			throw new Error("expected an auto-backgrounded job id");
		}
		const runningJob = asyncJobManager.getJob(jobId);
		expect(runningJob?.status).toBe("running");
		const updatesAtBackground = updates.length;
		cell.release();
		await runningJob?.promise;
		await asyncJobManager.drainDeliveries({ timeoutMs: 1 });
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]?.jobId).toBe(jobId);
		expect(deliveries[0]?.text).toContain("done");
		// The job keeps filling the call's card and settles it with its outcome.
		const jobFrames = updates.slice(updatesAtBackground);
		expect(jobFrames.every(frame => frame.state !== undefined)).toBe(true);
		expect(jobFrames.at(-1)?.state).toBe("completed");
		expect(jobFrames.at(-1)?.text).toContain("done");
	});

	it("backgrounds a running cell when the steering signal fires mid-wait", async () => {
		const asyncJobManager = createJobManager();
		const cell = mockGatedCell("steered\n");

		const tool = new EvalTool(
			makeSession(
				Settings.isolated({
					"eval.autoBackground.enabled": true,
					// High threshold: only the steering signal can background this.
					"eval.autoBackground.thresholdMs": 60_000,
				}),
				asyncJobManager,
			),
		);
		const steering = new AbortController();
		steering.abort();
		const result = await tool.execute(
			"call-steer",
			{ language: "js", code: "await work()" },
			undefined,
			undefined,
			steeringContext(steering.signal),
		);

		// The steer backgrounds the cell instead of killing it: the call returns a
		// running job and the cell finishes on its own.
		expect(result.details?.async?.state).toBe("running");
		const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("Backgrounded early to handle an incoming message");
		const jobId = result.details?.async?.jobId;
		if (!jobId) {
			throw new Error("expected a steer-backgrounded job id");
		}
		const job = asyncJobManager.getJob(jobId);
		expect(job?.status).toBe("running");
		cell.release();
		await job?.promise;
		expect(asyncJobManager.getJob(jobId)?.status).toBe("completed");
	});
});
