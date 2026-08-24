import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import {
	acquireBrowser,
	type BrowserHandle,
	holdBrowser,
	releaseBrowser,
} from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import type {
	ReadyInfo,
	Transport,
	WorkerInbound,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { acquireTab, initializeTabWorkerForTest } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

class FakeStartupWorker {
	#errorHandlers = new Set<(error: Error) => void>();
	#messageHandlers = new Set<(msg: WorkerOutbound) => void>();
	readonly sent: WorkerInbound[] = [];
	readonly mode = "worker" as const;

	send(msg: WorkerInbound): void {
		this.sent.push(msg);
	}

	onMessage(handler: (msg: WorkerOutbound) => void): () => void {
		this.#messageHandlers.add(handler);
		return () => this.#messageHandlers.delete(handler);
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errorHandlers.add(handler);
		return () => this.#errorHandlers.delete(handler);
	}

	async terminate(): Promise<void> {}

	emitReady(info: ReadyInfo): void {
		for (const handler of this.#messageHandlers) handler({ type: "ready", info });
	}
	emitSetup(): void {
		for (const handler of this.#messageHandlers) handler({ type: "setup" });
	}

	emitInitFailed(error: { name: string; message: string; isToolError: boolean; isAbort: boolean }): void {
		for (const handler of this.#messageHandlers) handler({ type: "init-failed", error });
	}

	emitError(error: Error): void {
		for (const handler of this.#errorHandlers) handler(error);
	}
}

class FakeWorkerTransport implements Transport {
	#handler?: (message: WorkerInbound | WorkerOutbound) => void;
	readonly messages: WorkerOutbound[] = [];
	readonly ready = Promise.withResolvers<void>();
	readonly result = Promise.withResolvers<Extract<WorkerOutbound, { type: "result" }>>();

	send(message: WorkerInbound | WorkerOutbound): void {
		if (message.type === "ready") this.ready.resolve();
		if (message.type === "result") this.result.resolve(message);
		this.messages.push(message as WorkerOutbound);
	}

	onMessage(handler: (message: WorkerInbound | WorkerOutbound) => void): () => void {
		this.#handler = handler;
		return () => {
			if (this.#handler === handler) this.#handler = undefined;
		};
	}

	close(): void {}

	deliver(message: WorkerInbound): void {
		this.#handler?.(message);
	}
}

const initPayload = {
	mode: "headless" as const,
	browserWSEndpoint: "ws://127.0.0.1/devtools/browser/test",
	safeDir: "/tmp/omp-puppeteer",
	timeoutMs: 1_000,
};

describe("browser tab worker startup", () => {
	it("surfaces worker startup errors instead of waiting for the generic init timeout", async () => {
		const worker = new FakeStartupWorker();
		const pending = initializeTabWorkerForTest(worker, initPayload, 1_000);

		worker.emitError(new Error("Cannot find tab-worker-entry.ts"));

		await expect(pending).rejects.toThrow("Tab worker failed during startup: Cannot find tab-worker-entry.ts");
		expect(worker.sent).toEqual([{ type: "init", payload: initPayload }]);
	});

	it("resolves with ready info when the worker sends setup before ready", async () => {
		const worker = new FakeStartupWorker();
		const info: ReadyInfo = {
			url: "about:blank",
			title: "Test",
			viewport: { width: 1280, height: 720 },
			targetId: "target-1",
		};
		const pending = initializeTabWorkerForTest(worker, initPayload, 1_000);

		worker.emitSetup();
		// The inline transport delivers messages on microtasks, so `ready` can
		// land in the same tick as `setup`; the single listener spanning both
		// phases must resolve it instead of dropping it.
		worker.emitReady(info);

		await expect(pending).resolves.toEqual(info);
	});

	it("rejects with the setup timeout when the worker never signals setup", async () => {
		const worker = new FakeStartupWorker();
		// timeoutMs 3_000 -> setup budget = max(2s, min(10s, 1s)) = 2s: the stall
		// must reject under the setup guard, not consume the full init budget.
		const pending = initializeTabWorkerForTest(worker, initPayload, 3_000);

		await expect(pending).rejects.toThrow("Timed out waiting for tab worker setup");
	});

	it("surfaces a reported init failure that arrives after setup", async () => {
		const worker = new FakeStartupWorker();
		const pending = initializeTabWorkerForTest(worker, initPayload, 3_000);

		worker.emitSetup();
		// A fast `init-failed` that lands right behind `setup` — a `page.goto`
		// rejection without a macrotask boundary — must surface the real
		// failure instead of the generic init timeout.
		worker.emitInitFailed({ name: "Error", message: "connect failed", isToolError: false, isAbort: false });

		await expect(pending).rejects.toThrow("connect failed");
	});

	it("bounds a retried attempt by the caller's remaining budget, not a fresh budget", async () => {
		const worker = new FakeStartupWorker();
		// Simulate the inline-fallback retry: the failed isolated attempt
		// already consumed 25 s of the caller's 30 s init budget.
		const pending = initializeTabWorkerForTest(worker, initPayload, 30_000, performance.now() - 25_000);
		const startedAt = performance.now();

		await expect(pending).rejects.toThrow("Timed out waiting for tab worker setup");

		// 5 s remain → guard min(10 s, 5 s / 3) = 1.67 s → floored to 2 s.
		// A fresh (un-carried) budget would guard for 10 s.
		expect(performance.now() - startedAt).toBeLessThan(8_000);
	});
});

describe("browser init budget exhaustion", () => {
	it("bounds a pre-exhausted init to the setup floor instead of a fresh budget", async () => {
		const worker = new FakeStartupWorker();
		// The caller's budget is fully elapsed before this attempt began: the
		// result can only be discarded by the post-init abort check, so the
		// init must not stretch past the setup floor.
		const startedAt = performance.now() - 30_000;
		const started = performance.now();
		const pending = initializeTabWorkerForTest(worker, initPayload, 30_000, startedAt);

		await expect(pending).rejects.toThrow("Timed out waiting for tab worker setup");
		expect(performance.now() - started).toBeLessThan(3_000);
	});
});

describe("browser init deadline carry-over", () => {
	let sharedHeadless: BrowserHandle | undefined;

	beforeAll(async () => {
		if (!CHROMIUM_AVAILABLE) return;
		sharedHeadless = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
	});

	afterAll(async () => {
		if (sharedHeadless) await releaseBrowser(sharedHeadless, { kill: true });
	});

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"counts caller time already spent before acquisition against the worker-init budget",
		async () => {
			const launched = sharedHeadless;
			if (!launched) throw new Error("Expected a shared headless browser");
			// The hang server makes the ready phase burn its (floor-clamped) budget
			// without resolving, so the first init attempt fails on its own.
			const server = Bun.serve({
				port: 0,
				fetch: () => Promise.withResolvers<Response>().promise,
			});
			let failure: unknown;
			try {
				// The caller's deadline started before browser acquisition and that
				// phase consumed the whole budget (simulated with a backdated
				// `deadlineStartMs`): `acquireTabImpl` must count that elapsed time
				// against the worker-init budget instead of starting a fresh
				// `timeoutMs + GRACE_MS` clock. An exhausted budget fails fast with
				// the original init error — never the wrapped inline-fallback error.
				const deadlineStart = performance.now() - 60_000;
				const started = performance.now();
				// Mirror BrowserTool's outer acquisition lease. Its timeout can
				// release this lease before acquireTab spends the supervisor's
				// phase floors, but acquireTab must retain its own hold so target
				// cleanup still has a connected Puppeteer handle.
				holdBrowser(launched);
				const acquisition = acquireTab(
					`deadline-carry-${process.pid}-${Math.random().toString(36).slice(2)}`,
					launched,
					{
						url: `http://127.0.0.1:${server.port}/hang`,
						waitUntil: "domcontentloaded",
						timeoutMs: 5_000,
						deadlineStartMs: deadlineStart,
					},
				);
				await releaseBrowser(launched, { kill: false });
				if (!("browser" in launched)) throw new Error("Expected a puppeteer-backed browser handle");
				const connectedAfterCallerRelease = launched.browser.connected;
				try {
					await acquisition;
				} catch (error) {
					failure = error;
				}
				const elapsed = performance.now() - started;
				expect(connectedAfterCallerRelease).toBeTrue();
				expect(failure).toBeDefined();
				expect(String((failure as Error).message)).not.toContain("inline fallback also failed");
				// Only the first attempt's floors are spent (setup floor 2 s + ready
				// floor 500 ms), never a second full budget cycle.
				expect(elapsed).toBeLessThan(4_000);
			} finally {
				await server.stop(true);
			}
		},
		30_000,
	);
});

describe("browser tab worker page activation", () => {
	it("activates a managed visible page before running user code", async () => {
		const calls: string[] = [];
		const target = {
			_targetId: "target-visible",
			page: async () => page,
		};
		const page = {
			target: () => target,
			url: () => "data:text/html,visible",
			title: async () => {
				calls.push("title");
				return "Visible fixture";
			},
			viewport: () => ({ width: 390, height: 844, deviceScaleFactor: 1 }),
			bringToFront: async () => {
				calls.push("bringToFront");
			},
			isClosed: () => false,
			on: () => {},
			once: () => {},
			off: () => {},
			removeAllListeners: () => {},
			mainFrame: () => undefined,
			setRequestInterception: async () => {},
		};
		const browser = {
			targets: () => [target],
			connected: true,
			disconnect: () => {},
		};
		const loadPuppeteer = async () => ({
			connect: async () => browser,
		});
		const transport = new FakeWorkerTransport();
		new WorkerCore(transport, false, loadPuppeteer as never);
		transport.deliver({
			type: "init",
			payload: {
				mode: "attach",
				browserWSEndpoint: "ws://127.0.0.1/devtools/browser/test",
				safeDir: "/tmp/omp-puppeteer",
				targetId: "target-visible",
				activatePageBeforeRun: true,
				timeoutMs: 1_000,
			},
		});
		await transport.ready.promise;
		calls.length = 0;

		transport.deliver({
			type: "run",
			id: "run-visible",
			name: "visible",
			code: "return await page.title();",
			timeoutMs: 1_000,
			session: { cwd: process.cwd() },
		});
		const result = await transport.result.promise;

		expect(result.ok).toBe(true);
		expect(calls[0]).toBe("bringToFront");
		if (result.ok) expect(result.payload.returnValue).toBe("Visible fixture");
	});
});

describe("browser tab worker run interception cleanup", () => {
	interface FakePage {
		target(): unknown;
		url(): string;
		title(): Promise<string>;
		viewport(): unknown;
		isClosed(): boolean;
		on(): void;
		once(): void;
		off(): void;
		removeAllListeners(): void;
		mainFrame(): undefined;
		setRequestInterception(enabled: boolean): Promise<void>;
	}

	function makePage(setRequestInterception: (enabled: boolean) => Promise<void>): FakePage {
		const target = {
			_targetId: "target-interception",
			page: async () => page,
		};
		const page: FakePage = {
			target: () => target,
			url: () => "data:text/html,interception",
			title: async () => "Interception fixture",
			viewport: () => ({ width: 390, height: 844, deviceScaleFactor: 1 }),
			isClosed: () => false,
			on: () => {},
			once: () => {},
			off: () => {},
			removeAllListeners: () => {},
			mainFrame: () => undefined,
			setRequestInterception,
		};
		return page;
	}

	async function runOnPage(page: FakePage, code: string): Promise<Extract<WorkerOutbound, { type: "result" }>> {
		const target = {
			_targetId: "target-interception",
			page: async () => page,
		};
		const browser = {
			targets: () => [target],
			connected: true,
			disconnect: () => {},
		};
		const loadPuppeteer = async () => ({
			connect: async () => browser,
		});
		const transport = new FakeWorkerTransport();
		new WorkerCore(transport, false, loadPuppeteer as never);
		transport.deliver({
			type: "init",
			payload: {
				mode: "attach",
				browserWSEndpoint: "ws://127.0.0.1/devtools/browser/test",
				safeDir: "/tmp/omp-puppeteer",
				targetId: "target-interception",
				timeoutMs: 1_000,
			},
		});
		await transport.ready.promise;
		transport.deliver({
			type: "run",
			id: "run-interception",
			name: "interception",
			code,
			timeoutMs: 1_000,
			session: { cwd: process.cwd() },
		});
		return await transport.result.promise;
	}

	it("skips interception cleanup when the run never enabled interception", async () => {
		const page = makePage(async () => {});
		const setRequestInterception = spyOn(page, "setRequestInterception");

		const result = await runOnPage(page, "return await page.title();");

		expect(result.ok).toBe(true);
		expect(setRequestInterception).not.toHaveBeenCalled();
	});

	it("reports RequestInterceptionCleanupError when disabling interception fails", async () => {
		const calls: boolean[] = [];
		const page = makePage(async enabled => {
			calls.push(enabled);
			if (!enabled) throw new Error("CDP session gone");
		});

		const result = await runOnPage(page, "await page.setRequestInterception(true); return await page.title();");

		expect(result.ok).toBe(false);
		expect(calls).toEqual([true, false]);
		if (!result.ok) {
			expect(result.error.message).toBe("Failed to clear browser request interception after browser.run");
			expect(result.error.isToolError).toBe(true);
			expect(result.error.recoverTab).toBe(true);
		}
	});

	it("disables interception at cleanup when the run left it enabled", async () => {
		const calls: boolean[] = [];
		const page = makePage(async enabled => {
			calls.push(enabled);
		});

		const result = await runOnPage(page, "await page.setRequestInterception(true); return await page.title();");

		expect(result.ok).toBe(true);
		expect(calls).toEqual([true, false]);
	});
});

describe("browser tab worker screenshot visibility gating", () => {
	// 1x1 PNG (67 bytes) — valid input for the Bun.Image resize pipeline.
	const TINY_PNG = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
		"base64",
	);

	function makeScreenshotPage(calls: string[]) {
		const target = {
			_targetId: "target-screenshot",
			page: async () => page,
		};
		const page = {
			target: () => target,
			url: () => "data:text/html,screenshot",
			title: async () => "Screenshot fixture",
			viewport: () => ({ width: 390, height: 844, deviceScaleFactor: 1 }),
			bringToFront: async () => {
				calls.push("bringToFront");
			},
			// The user is looking at another window: the adopted tab reports hidden.
			evaluate: async () => {
				calls.push("evaluate");
				return false;
			},
			screenshot: async () => {
				calls.push("screenshot");
				return TINY_PNG;
			},
			isClosed: () => false,
			on: () => {},
			once: () => {},
			off: () => {},
			removeAllListeners: () => {},
			mainFrame: () => undefined,
			setRequestInterception: async () => {},
		};
		return page;
	}

	async function runScreenshot(
		calls: string[],
		extraInit: Record<string, unknown>,
	): Promise<Extract<WorkerOutbound, { type: "result" }>> {
		const page = makeScreenshotPage(calls);
		const target = { _targetId: "target-screenshot", page: async () => page };
		const browser = { targets: () => [target], connected: true, disconnect: () => {} };
		const loadPuppeteer = async () => ({ connect: async () => browser });
		const transport = new FakeWorkerTransport();
		new WorkerCore(transport, false, loadPuppeteer as never);
		transport.deliver({
			type: "init",
			payload: {
				mode: "attach",
				browserWSEndpoint: "ws://127.0.0.1/devtools/browser/test",
				safeDir: "/tmp/omp-puppeteer",
				targetId: "target-screenshot",
				activateForScreenshot: false,
				timeoutMs: 1_000,
				...extraInit,
			},
		});
		await transport.ready.promise;
		calls.length = 0;
		transport.deliver({
			type: "run",
			id: "run-screenshot",
			name: "screenshot",
			code: "const dest = await tab.screenshot({ silent: true }); return dest.length > 0;",
			timeoutMs: 1_000,
			session: { cwd: process.cwd() },
		});
		return await transport.result.promise;
	}

	it("captures a backgrounded relay/connected tab when userDriven", async () => {
		const calls: string[] = [];
		const result = await runScreenshot(calls, { userDriven: true });

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.payload.returnValue).toBe(true);
		// Never raised (no focus theft) and never gated on document visibility.
		expect(calls).not.toContain("bringToFront");
		expect(calls).not.toContain("evaluate");
		expect(calls).toContain("screenshot");
	});

	it("rejects a backgrounded tab when the supervisor kept strict visibility", async () => {
		const calls: string[] = [];
		const result = await runScreenshot(calls, {});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toBe(
				"The attached browser tab is not visible; switch to it before taking a screenshot",
			);
			expect(result.error.isToolError).toBe(true);
		}
		expect(calls).toContain("evaluate");
		expect(calls).not.toContain("screenshot");
	});
});
