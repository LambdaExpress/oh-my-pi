import { describe, expect, it } from "bun:test";
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
			off: () => {},
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
		new WorkerCore(transport, loadPuppeteer as never);
		transport.deliver({
			type: "init",
			payload: {
				mode: "attach",
				browserWSEndpoint: "ws://127.0.0.1/devtools/browser/test",
				safeDir: "/tmp/omp-puppeteer",
				targetId: "target-visible",
				activatePageBeforeRun: true,
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
