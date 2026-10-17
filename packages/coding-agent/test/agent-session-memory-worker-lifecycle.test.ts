import { expect, it, spyOn } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	MnemopiEmbedClient,
	mnemopiEmbedClient,
	mnemopiEmbedServerName,
	shutdownMnemopiEmbedClient,
} from "@oh-my-pi/pi-coding-agent/mnemopi/embed-client";
import type { MnemopiEmbedServerRequest } from "@oh-my-pi/pi-coding-agent/mnemopi/embed-protocol";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as sharedWorkers from "@oh-my-pi/pi-coding-agent/subprocess/shared-worker";
import { type IpcConnection, IpcServer, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { TempDir, VERSION } from "@oh-my-pi/pi-utils";

const MODEL = "fast-bge-base-en-v1.5";

type PendingEmbed = {
	connection: IpcConnection;
	request: Extract<MnemopiEmbedServerRequest, { type: "embed" }>;
};

it("session disposal preserves shared embeddings, while process shutdown drops only its own connection", async () => {
	const directory = TempDir.createSync("@omp-memory-worker-ownership-");
	const cacheDir = directory.path();
	const endpoint = ipcEndpoint(directory.path(), mnemopiEmbedServerName(MODEL, cacheDir));
	const connections = new Set<IpcConnection>();
	const pending: PendingEmbed[] = [];
	const waiters: Array<(request: PendingEmbed) => void> = [];
	const sessions: AgentSession[] = [];
	const authStorage = await AuthStorage.create(":memory:");
	const otherProcess = new MnemopiEmbedClient();
	let server: IpcServer | undefined;
	let restoreConnect: (() => void) | undefined;

	function nextEmbed(): Promise<PendingEmbed> {
		const request = pending.shift();
		if (request) return Promise.resolve(request);
		const ready = Promise.withResolvers<PendingEmbed>();
		waiters.push(ready.resolve);
		return ready.promise;
	}

	function embed(client: MnemopiEmbedClient, text: string): Promise<number[][] | Error> {
		// Observe rejection immediately: an ownership regression must fail the
		// vector assertion, not leak an unhandled rejection during disposal.
		return client
			.embed(MODEL, cacheDir, [text], undefined)
			.catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
	}

	function complete({ connection, request }: PendingEmbed, vectors: number[][]): void {
		connection.send(JSON.stringify({ type: "vectors", id: request.id, vectors }));
	}

	try {
		// A tagged native IPC endpoint exercises the real shared-worker probe,
		// LazyWorkerHandle and connection lifetime without loading any model.
		server = await IpcServer.listen(endpoint, { framing: "lines" }, connection => {
			connections.add(connection);
			connection.start(
				line => {
					const request = JSON.parse(line) as MnemopiEmbedServerRequest;
					if (request.type === "ping") {
						connection.send(JSON.stringify({ type: "pong", id: request.id, tag: VERSION }));
					} else if (request.type === "init") {
						connection.send(JSON.stringify({ type: "ready", id: request.id }));
					} else if (request.type === "embed") {
						const call = { connection, request };
						const waiter = waiters.shift();
						if (waiter) waiter(call);
						else pending.push(call);
					} else {
						for (const peer of connections) peer.destroy();
						void server?.close();
					}
				},
				() => connections.delete(connection),
			);
		});
		const realConnect = sharedWorkers.connectSharedWorker;
		const connect = spyOn(sharedWorkers, "connectSharedWorker").mockImplementation(
			<Req, Res>(launch: sharedWorkers.SharedWorkerLaunch, _runtimeDir: string, name: string) =>
				realConnect<Req, Res>(
					{
						...launch,
						async spawn() {
							throw new Error("The isolated embedding endpoint must be adopted; spawning is forbidden");
						},
					},
					directory.path(),
					name,
				),
		);
		restoreConnect = () => connect.mockRestore();

		const modelRegistry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
		for (const [agentId, memoryTaskDepth] of [
			["Main", 0],
			["Worker", 1],
		] as const) {
			sessions.push(
				new AgentSession({
					agent: new Agent({ initialState: { systemPrompt: [], messages: [], tools: [] } }),
					sessionManager: SessionManager.inMemory(directory.path()),
					settings: Settings.isolated({ "memory.backend": "off", "compaction.enabled": false }),
					modelRegistry,
					agentId,
					memoryTaskDepth,
				}),
			);
		}
		const [main, child] = sessions;
		// load() exercises the transport directly, avoiding initialize()'s
		// first-use model-cache/download tracking in this no-model fixture.
		expect(await mnemopiEmbedClient.load(MODEL, cacheDir)).toBeUndefined();
		expect(await otherProcess.load(MODEL, cacheDir)).toBeUndefined();

		const parentEmbedding = embed(mnemopiEmbedClient, "parent recall");
		const parentRequest = await nextEmbed();
		const peerEmbedding = embed(otherProcess, "another process's recall");
		const peerRequest = await nextEmbed();

		await child!.dispose();
		complete(parentRequest, [[1, 0]]);
		expect(await parentEmbedding).toEqual([[1, 0]]);

		const continuedEmbedding = embed(mnemopiEmbedClient, "recall while the main session is disposed");
		const continuedRequest = await nextEmbed();
		await main!.dispose();
		complete(continuedRequest, [[0.5, 0.5]]);
		expect(await continuedEmbedding).toEqual([[0.5, 0.5]]);

		const cancelledEmbedding = embed(mnemopiEmbedClient, "process shutdown cancels this request");
		await nextEmbed();
		await shutdownMnemopiEmbedClient();
		expect(await cancelledEmbedding).toBeInstanceOf(Error);
		// Process-wide cleanup disconnects its client, not the shared server or
		// another process's already pending work.
		complete(peerRequest, [[0, 1]]);
		expect(await peerEmbedding).toEqual([[0, 1]]);

		expect(await mnemopiEmbedClient.load(MODEL, cacheDir)).toBeUndefined();
		const reconnectedEmbedding = embed(mnemopiEmbedClient, "reattach to the surviving server");
		complete(await nextEmbed(), [[0.25, 0.75]]);
		expect(await reconnectedEmbedding).toEqual([[0.25, 0.75]]);
	} finally {
		try {
			await Promise.all(sessions.map(session => session.dispose()));
		} finally {
			await shutdownMnemopiEmbedClient();
			await otherProcess.terminate();
			restoreConnect?.();
			for (const connection of connections) connection.destroy();
			await server?.close();
			authStorage.close();
			directory.removeSync();
		}
	}
}, 30_000);
