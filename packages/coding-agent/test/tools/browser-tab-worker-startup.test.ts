import { describe, expect, it, spyOn } from "bun:test";
import type {
	ReadyInfo,
	Transport,
	WorkerInbound,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { initializeTabWorkerForTest } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";

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
