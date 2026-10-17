import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	MnemopiEmbedClient,
	mnemopiEmbedLaunch,
	mnemopiEmbedServerName,
	type MnemopiEmbedWorkerHandle,
} from "@oh-my-pi/pi-coding-agent/mnemopi/embed-client";
import {
	MNEMOPI_EMBED_IDLE_MS_ENV,
	type MnemopiEmbedCall,
	type MnemopiEmbedServerRequest,
	type MnemopiEmbedServerResponse,
	type MnemopiEmbedWorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/mnemopi/embed-protocol";
import {
	connectSharedWorker,
	type SharedWorkerLaunch,
	type SpawnedWorker,
} from "@oh-my-pi/pi-coding-agent/subprocess/shared-worker";
import type { RefCountedWorkerHandle } from "@oh-my-pi/pi-coding-agent/subprocess/worker-client";

const REQUEST_TIMEOUT_MS = 100;
const MODEL = "fast-bge-base-en-v1.5";
const CACHE_DIR = "/tmp/cache";
type EmbedReply = MnemopiEmbedWorkerOutbound | MnemopiEmbedServerResponse;
type ServerConnection = RefCountedWorkerHandle<MnemopiEmbedServerRequest, MnemopiEmbedServerResponse>;

class ControlledEmbedTransport implements MnemopiEmbedWorkerHandle {
	terminated = 0;
	#requests: MnemopiEmbedCall[] = [];
	#requestWaiters: Array<(message: MnemopiEmbedCall) => void> = [];
	#messageHandler: ((message: EmbedReply) => void) | undefined;
	#errorHandler: ((error: Error) => void) | undefined;

	constructor(private readonly termination?: Promise<void>) {}

	send(message: MnemopiEmbedCall): void {
		if (this.terminated > 0) throw new Error("request sent to terminated embedding transport");
		const waiter = this.#requestWaiters.shift();
		if (waiter) waiter(message);
		else this.#requests.push(message);
	}

	nextRequest(): Promise<MnemopiEmbedCall> {
		const request = this.#requests.shift();
		if (request) return Promise.resolve(request);
		const { promise, resolve } = Promise.withResolvers<MnemopiEmbedCall>();
		this.#requestWaiters.push(resolve);
		return promise;
	}

	onMessage(handler: (message: EmbedReply) => void): () => void {
		this.#messageHandler = handler;
		return () => {
			if (this.#messageHandler === handler) this.#messageHandler = undefined;
		};
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errorHandler = handler;
		return () => {
			if (this.#errorHandler === handler) this.#errorHandler = undefined;
		};
	}

	captureError(): (error: Error) => void {
		if (!this.#errorHandler) throw new Error("embedding transport has no error listener");
		return this.#errorHandler;
	}

	ref(): void {}
	unref(): void {}

	complete(request: MnemopiEmbedCall, vectors: number[][]): void {
		if (!this.#messageHandler) throw new Error("embedding transport has no response listener");
		if (request.type === "init") this.#messageHandler({ type: "ready", id: request.id });
		else this.#messageHandler({ type: "vectors", id: request.id, vectors });
	}

	terminate(): Promise<void> {
		this.terminated += 1;
		this.#messageHandler = undefined;
		this.#errorHandler = undefined;
		return this.termination ?? Promise.resolve();
	}
}

async function ping(connection: ServerConnection, id: string): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const unsubscribeMessage = connection.onMessage(message => {
		if (message.type === "pong" && message.id === id) resolve(message.tag);
	});
	const unsubscribeError = connection.onError(reject);
	try {
		connection.send({ type: "ping", id });
		return await promise;
	} finally {
		unsubscribeMessage();
		unsubscribeError();
	}
}

describe("mnemopi shared embedding lifecycle", () => {
	it("isolates a timed-out model connection from another model's in-flight embedding", async () => {
		vi.useFakeTimers();
		const transports = new Map<string, ControlledEmbedTransport>();
		const client = new MnemopiEmbedClient(model => {
			const transport = new ControlledEmbedTransport();
			transports.set(model, transport);
			return transport;
		}, REQUEST_TIMEOUT_MS);
		try {
			const stalled = client.embed(MODEL, CACHE_DIR, ["stalled recall"], undefined);
			const stalledOutcome = stalled.then(
				vectors => ({ kind: "completed" as const, vectors }),
				error => ({ kind: "failed" as const, error }),
			);
			vi.advanceTimersByTime(REQUEST_TIMEOUT_MS / 2);
			const peerModel = "fast-bge-small-en-v1.5";
			const peerEmbedding = client.embed(peerModel, CACHE_DIR, ["peer recall"], undefined);
			const peerOutcome = peerEmbedding.then(
				vectors => ({ kind: "completed" as const, vectors }),
				error => ({ kind: "failed" as const, error }),
			);
			const peer = transports.get(peerModel)!;
			const peerRequest = await peer.nextRequest();
			vi.advanceTimersByTime(REQUEST_TIMEOUT_MS / 2);

			const outcome = await stalledOutcome;
			expect(outcome.kind).toBe("failed");
			if (outcome.kind === "failed") expect(String(outcome.error)).toMatch(/timed out/i);
			expect(transports.get(MODEL)!.terminated).toBe(1);
			expect(peer.terminated).toBe(0);
			peer.complete(peerRequest, [[0.25, 0.75]]);
			expect(await peerOutcome).toEqual({ kind: "completed", vectors: [[0.25, 0.75]] });
		} finally {
			await client.terminate();
			vi.useRealTimers();
		}
	});

	it("keeps a replacement usable while an old connection close drains and a queued error arrives", async () => {
		const oldClose = Promise.withResolvers<void>();
		const transports: ControlledEmbedTransport[] = [];
		const client = new MnemopiEmbedClient(() => {
			const transport = new ControlledEmbedTransport(transports.length === 0 ? oldClose.promise : undefined);
			transports.push(transport);
			return transport;
		});
		try {
			const firstEmbedding = client.embed(MODEL, CACHE_DIR, ["first recall"], undefined);
			const first = transports[0]!;
			first.complete(await first.nextRequest(), [[1, 0]]);
			expect(await firstEmbedding).toEqual([[1, 0]]);
			const lateError = first.captureError();

			const closing = client.terminate();
			const replacementEmbedding = client.embed(MODEL, CACHE_DIR, ["replacement recall"], undefined);
			const outcome = replacementEmbedding.then(
				vectors => ({ kind: "completed" as const, vectors }),
				error => ({ kind: "failed" as const, error }),
			);
			const replacement = transports[1]!;
			const request = await replacement.nextRequest();
			// Model an error callback queued before the old listener was unsubscribed.
			lateError(new Error("worker connection closed"));
			oldClose.resolve();
			await closing;
			expect(first.terminated).toBe(1);
			expect(replacement.terminated).toBe(0);
			replacement.complete(request, [[0.75, 0.25]]);
			expect(await outcome).toEqual({ kind: "completed", vectors: [[0.75, 0.25]] });
		} finally {
			oldClose.resolve();
			await client.terminate();
		}
	});

	it("disconnects clients independently, idles with connections open, and reconnects to a fresh shared server", async () => {
		const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-embed-lifetime-"));
		const spawned: SpawnedWorker[] = [];
		const connections: ServerConnection[] = [];
		const base = mnemopiEmbedLaunch(MODEL, { [MNEMOPI_EMBED_IDLE_MS_ENV]: "2000" });
		const launch: SharedWorkerLaunch = {
			...base,
			async spawn(endpoint, logPath) {
				const worker = await base.spawn(endpoint, logPath);
				spawned.push(worker);
				return worker;
			},
		};
		const name = mnemopiEmbedServerName(MODEL, path.join(runtimeDir, "cache"));
		const connect = async (): Promise<ServerConnection> => {
			const connection = await connectSharedWorker<MnemopiEmbedServerRequest, MnemopiEmbedServerResponse>(
				launch,
				runtimeDir,
				name,
			);
			connections.push(connection);
			return connection;
		};
		try {
			// Only ping: the real CLI server runs, but no embedding model is loaded.
			const sessionA = await connect();
			const sessionB = await connect();
			const originalServer = spawned[0]!;
			await sessionA.terminate();
			expect(await ping(sessionB, "peer-after-disconnect")).toBe(launch.tag);
			const sessionC = await connect();
			expect(await ping(sessionC, "reused-server")).toBe(launch.tag);
			expect(spawned).toHaveLength(1);
			expect(originalServer.proc.exitCode).toBeNull();

			// Idle ownership belongs to the server, not client connection count.
			originalServer.proc.ref();
			expect(await originalServer.proc.exited).toBe(0);
			const sessionD = await connect();
			expect(await ping(sessionD, "server-after-idle")).toBe(launch.tag);
			expect(spawned).toHaveLength(2);
		} finally {
			await Promise.all(connections.map(connection => connection.terminate()));
			await Promise.all(
				spawned.map(async worker => {
					worker.proc.ref();
					if (worker.proc.exitCode === null) worker.proc.kill();
					await worker.proc.exited;
				}),
			);
			await fs.rm(runtimeDir, { recursive: true, force: true });
		}
	}, 30_000);
});
