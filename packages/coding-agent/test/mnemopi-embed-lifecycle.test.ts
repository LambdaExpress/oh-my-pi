import { describe, expect, it, spyOn, vi } from "bun:test";
import { MnemopiEmbedClient, type MnemopiEmbedWorkerHandle } from "@oh-my-pi/pi-coding-agent/mnemopi/embed-client";
import type {
	MnemopiEmbedWorkerInbound,
	MnemopiEmbedWorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/mnemopi/embed-protocol";

const IDLE_TIMEOUT_MS = 100;
const REQUEST_TIMEOUT_MS = 10_000;
const MODEL = "fast-bge-base-en-v1.5";
const CACHE_DIR = "/tmp/cache";

class ControlledEmbedWorker implements MnemopiEmbedWorkerHandle {
	terminated = 0;
	#requests: MnemopiEmbedWorkerInbound[] = [];
	#requestWaiters: Array<(message: MnemopiEmbedWorkerInbound) => void> = [];
	#messageHandler: ((message: MnemopiEmbedWorkerOutbound) => void) | undefined;

	constructor(private readonly termination?: Promise<void>) {}

	send(message: MnemopiEmbedWorkerInbound): void {
		if (this.terminated > 0) throw new Error("request sent to terminated embedding worker");
		const waiter = this.#requestWaiters.shift();
		if (waiter) waiter(message);
		else this.#requests.push(message);
	}

	nextRequest(): Promise<MnemopiEmbedWorkerInbound> {
		const request = this.#requests.shift();
		if (request) return Promise.resolve(request);
		const { promise, resolve } = Promise.withResolvers<MnemopiEmbedWorkerInbound>();
		this.#requestWaiters.push(resolve);
		return promise;
	}

	onMessage(handler: (message: MnemopiEmbedWorkerOutbound) => void): () => void {
		this.#messageHandler = handler;
		return () => {
			if (this.#messageHandler === handler) this.#messageHandler = undefined;
		};
	}

	onError(): () => void {
		return () => {};
	}

	ref(): void {}
	unref(): void {}

	complete(request: MnemopiEmbedWorkerInbound, vectors: number[][] = []): void {
		if (!this.#messageHandler) throw new Error("embedding worker has no response listener");
		if (request.type === "init") this.#messageHandler({ type: "ready", id: request.id });
		else if (request.type === "embed") this.#messageHandler({ type: "vectors", id: request.id, vectors });
		else this.#messageHandler({ type: "pong", id: request.id });
	}

	terminate(): Promise<void> {
		this.terminated += 1;
		this.#messageHandler = undefined;
		return this.termination ?? Promise.resolve();
	}
}

interface EmbedHarness {
	client: MnemopiEmbedClient;
	workers: ControlledEmbedWorker[];
	firstSpawn: Promise<ControlledEmbedWorker>;
}

function createHarness(firstTermination?: Promise<void>): EmbedHarness {
	const workers: ControlledEmbedWorker[] = [];
	const firstSpawn = Promise.withResolvers<ControlledEmbedWorker>();
	const client = new MnemopiEmbedClient(
		() => {
			const worker = new ControlledEmbedWorker(workers.length === 0 ? firstTermination : undefined);
			workers.push(worker);
			firstSpawn.resolve(worker);
			return worker;
		},
		REQUEST_TIMEOUT_MS,
		IDLE_TIMEOUT_MS,
	);
	return { client, workers, firstSpawn: firstSpawn.promise };
}

async function initialize(harness: EmbedHarness) {
	const initializing = harness.client.initialize(MODEL, CACHE_DIR);
	const worker = await harness.firstSpawn;
	worker.complete(await worker.nextRequest());
	const model = await initializing;
	if (!model) throw new Error("controlled embedding worker failed to initialize");
	return { worker, model };
}

describe("mnemopi embedding worker idle lifecycle", () => {
	it("reuses a warm worker, releases it after inactivity, and reloads through the cached model", async () => {
		vi.useFakeTimers();
		const harness = createHarness();
		try {
			const { worker, model } = await initialize(harness);
			vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 1);
			expect(worker.terminated).toBe(0);

			const warmEmbedding = model.embed(["warm recall"])[Symbol.asyncIterator]().next();
			worker.complete(await worker.nextRequest(), [[0.25, 0.75]]);
			expect(await warmEmbedding).toEqual({ done: false, value: [[0.25, 0.75]] });
			expect(harness.workers).toHaveLength(1);

			vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 1);
			expect(worker.terminated).toBe(0);
			vi.advanceTimersByTime(1);
			expect(worker.terminated).toBe(1);

			const reloadedEmbedding = model.embed(["recall after idle release"])[Symbol.asyncIterator]().next();
			const reloadedWorker = harness.workers[1];
			reloadedWorker.complete(await reloadedWorker.nextRequest(), [[0.5, 0.5]]);
			expect(await reloadedEmbedding).toEqual({ done: false, value: [[0.5, 0.5]] });
			expect(harness.workers).toHaveLength(2);
		} finally {
			await harness.client.terminate();
			vi.useRealTimers();
		}
	});

	it("never treats initialization or overlapping embeddings as idle", async () => {
		vi.useFakeTimers();
		const harness = createHarness();
		try {
			const initializing = harness.client.initialize(MODEL, CACHE_DIR);
			const worker = await harness.firstSpawn;
			const init = await worker.nextRequest();
			vi.advanceTimersByTime(IDLE_TIMEOUT_MS * 3);
			expect(worker.terminated).toBe(0);
			worker.complete(init);
			const model = await initializing;
			if (!model) throw new Error("controlled embedding worker failed to initialize");

			const firstEmbedding = model.embed(["first recall"])[Symbol.asyncIterator]().next();
			const first = await worker.nextRequest();
			const secondEmbedding = model.embed(["second recall"])[Symbol.asyncIterator]().next();
			const second = await worker.nextRequest();
			vi.advanceTimersByTime(IDLE_TIMEOUT_MS * 3);
			expect(worker.terminated).toBe(0);

			worker.complete(first, [[1, 0]]);
			expect(await firstEmbedding).toEqual({ done: false, value: [[1, 0]] });
			vi.advanceTimersByTime(IDLE_TIMEOUT_MS * 3);
			expect(worker.terminated).toBe(0);
			worker.complete(second, [[0, 1]]);
			expect(await secondEmbedding).toEqual({ done: false, value: [[0, 1]] });

			vi.advanceTimersByTime(IDLE_TIMEOUT_MS);
			expect(worker.terminated).toBe(1);
		} finally {
			await harness.client.terminate();
			vi.useRealTimers();
		}
	});

	it("fences an old idle callback and delayed close from a replacement worker", async () => {
		vi.useFakeTimers();
		const timers = spyOn(globalThis, "setTimeout");
		const oldClose = Promise.withResolvers<void>();
		const harness = createHarness(oldClose.promise);
		try {
			const { worker, model } = await initialize(harness);
			const idleCallback = timers.mock.calls.findLast(([, delay]) => delay === IDLE_TIMEOUT_MS)?.[0];
			if (typeof idleCallback !== "function") throw new Error("idle callback was not scheduled");

			const closing = harness.client.terminate();
			expect(worker.terminated).toBe(1);
			const embedding = model.embed(["replacement recall"])[Symbol.asyncIterator]().next();
			const replacement = harness.workers[1];
			replacement.complete(await replacement.nextRequest(), [[0.75, 0.25]]);
			expect(await embedding).toEqual({ done: false, value: [[0.75, 0.25]] });

			oldClose.resolve();
			await closing;
			// Model a cancelled timer callback that had already been queued before teardown.
			idleCallback();
			expect(replacement.terminated).toBe(0);
			vi.advanceTimersByTime(IDLE_TIMEOUT_MS);
			expect(replacement.terminated).toBe(1);
		} finally {
			oldClose.resolve();
			await harness.client.terminate();
			timers.mockRestore();
			vi.useRealTimers();
		}
	});
});
