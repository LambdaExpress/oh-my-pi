import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { mnemopiEmbedClient, MNEMOPI_EMBED_WORKER_ARG } from "@oh-my-pi/pi-coding-agent/mnemopi/embed-client";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as workers from "@oh-my-pi/pi-coding-agent/subprocess/worker-client";
import { TempDir } from "@oh-my-pi/pi-utils";

it("disposing a session cannot interrupt another session's process-owned embedding", async () => {
	const directory = TempDir.createSync("@omp-memory-worker-ownership-");
	const peerFile = directory.join("embedding-peer.js");
	const pendingFile = directory.join("embedding-pending");
	const releaseFile = directory.join("embedding-release");
	const waiting = Promise.withResolvers<void>();
	const watcher = fs.watch(directory.path(), { persistent: false }, (_event, filename) => {
		if (filename === path.basename(pendingFile)) waiting.resolve();
	});
	const resolveSpawn = workers.resolveWorkerSpawnCmd;
	const spawn = spyOn(workers, "resolveWorkerSpawnCmd").mockImplementation(selector =>
		selector === MNEMOPI_EMBED_WORKER_ARG ? { cmd: [process.execPath, peerFile] } : resolveSpawn(selector),
	);
	let session: AgentSession | undefined;
	try {
		session = new AgentSession({
			agent: new Agent({ initialState: { systemPrompt: [], messages: [], tools: [] } }),
			sessionManager: SessionManager.inMemory(directory.path()),
			settings: Settings.isolated({ "memory.backend": "off", "compaction.enabled": false }),
			modelRegistry: {
				getApiKey: async () => undefined,
				resolver: () => async () => undefined,
				authStorage: { usage: { ingestHeaders() {} }, oauth: { identity: () => undefined } },
				hasLazyRuntimeMetadata: () => false,
			} as unknown as ModelRegistry,
		});
		await Bun.write(
			peerFile,
			`import * as fs from "node:fs";
let pendingEmbed;
const watcher = fs.watch(${JSON.stringify(directory.path())}, (_event, filename) => {
	if (filename !== "embedding-release" || !pendingEmbed) return;
	process.send({ type: "vectors", id: pendingEmbed.id, vectors: [[1, 0]] });
	pendingEmbed = undefined;
});
process.on("message", async message => {
	if (message.type === "init") process.send({ type: "ready", id: message.id });
	if (message.type !== "embed") return;
	pendingEmbed = message;
	await Bun.write(${JSON.stringify(pendingFile)}, String(process.pid));
});
process.on("disconnect", () => { watcher.close(); process.exit(0); });
`,
		);
		const model = await mnemopiEmbedClient.initialize("fast-bge-base-en-v1.5", directory.path());
		if (!model) throw new Error("isolated embedding peer failed to initialize");
		const embedding = model.embed(["parent recall"])[Symbol.asyncIterator]().next();
		// Handle rejection even if session disposal regresses and kills the peer before the assertion.
		const outcome = embedding.then(
			result => ({ kind: "completed" as const, result }),
			error => ({ kind: "failed" as const, error }),
		);
		await waiting.promise;
		const pid = Number(await Bun.file(pendingFile).text());
		await session.dispose();
		let peerAlive = true;
		try {
			process.kill(pid, 0);
		} catch {
			peerAlive = false;
		}
		expect(peerAlive).toBe(true);
		await Bun.write(releaseFile, "release");
		expect((await outcome).kind).toBe("completed");
	} finally {
		watcher.close();
		await session?.dispose();
		await mnemopiEmbedClient.terminate();
		spawn.mockRestore();
		directory.removeSync();
	}
}, 30_000);
