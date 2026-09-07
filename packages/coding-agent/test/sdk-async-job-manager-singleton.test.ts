import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import * as advisorModule from "../src/advisor";

describe("AsyncJobManager singleton across concurrent top-level sessions", () => {
	const tempDirs: string[] = [];
	// Building a ModelRegistry per session is the dominant cost here: createAgentSession
	// otherwise runs discoverAuthStorage (a fresh AuthStorage DB create+reload) and a
	// background online model refresh for every spawn (~450ms each). The singleton
	// ownership behavior under test is independent of model resolution, so we hand every
	// session one shared, network-free registry built once (~10ms/session instead).
	let sharedTempDir: string;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-async-singleton-shared-"));
		sharedAuthStorage = await AuthStorage.create(path.join(sharedTempDir, "auth.db"));
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedTempDir, "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		removeSyncWithRetries(sharedTempDir);
	});

	afterEach(async () => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
		AsyncJobManager.resetForTests();
	});

	async function spawnTopLevelSession(extraSettings?: Record<string, unknown>, extensions: ExtensionFactory[] = []) {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-async-singleton-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settings: Settings.isolated({ "bash.autoBackground.enabled": true, ...extraSettings }),
			disableExtensionDiscovery: true,
			extensions,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			modelRegistry: sharedModelRegistry,
		});
		return session;
	}

	it("keeps the primary session's manager installed after a secondary session disposes", async () => {
		const primary = await spawnTopLevelSession();
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();

			const secondary = await spawnTopLevelSession();
			try {
				// While the secondary is alive the global instance MUST still point at
				// the primary's manager so background tools keep delivering completions
				// to the primary session that owns them.
				expect(AsyncJobManager.instance()).toBe(primaryManager);
			} finally {
				await secondary.dispose();
			}

			// After the secondary disposes, the primary's manager MUST still be the
			// reachable singleton — otherwise the `task` async path errors with
			// "Async execution is enabled but no async job manager is available".
			expect(AsyncJobManager.instance()).toBe(primaryManager);
		} finally {
			await primary.dispose();
		}

		// Once the owning primary session disposes the singleton clears, matching
		// the documented single-owner invariant.
		expect(AsyncJobManager.instance()).toBeUndefined();
	}, 60000);

	it("does not cancel the primary session's running jobs when a secondary session disposes", async () => {
		const primary = await spawnTopLevelSession();
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();

			// Register a long-running job under the primary top-level session's
			// owner and scope. The secondary inherits the same MAIN_AGENT_ID owner,
			// so the scope boundary is what prevents its dispose path from
			// cancelling the primary's job (issue #1923).
			const release = Promise.withResolvers<string>();
			const jobId = primaryManager!.register(
				"bash",
				"sleep",
				async ({ signal }) => {
					const aborted = Promise.withResolvers<void>();
					signal.addEventListener("abort", () => aborted.resolve(), { once: true });
					await Promise.race([release.promise, aborted.promise]);
					return signal.aborted ? "aborted" : "completed";
				},
				{ ownerId: "Main", scopeId: primary.getAgentScopeId() },
			);
			expect(primary.getAsyncJobSnapshot()?.running.some(job => job.id === jobId)).toBe(true);

			const secondary = await spawnTopLevelSession();
			try {
				expect(secondary.getAsyncJobSnapshot()).toBeNull();
			} finally {
				await secondary.dispose();
			}

			const job = primaryManager!.getJob(jobId);
			expect(job?.status).toBe("running");

			release.resolve("done");
			await primaryManager!.waitForAll();
		} finally {
			await primary.dispose();
		}
	}, 60000);

	it("exposes the owning session's jobs through a production extension context", async () => {
		let observedSnapshot: AsyncJobSnapshot | null | undefined;
		const snapshotExtension: ExtensionFactory = pi => {
			pi.registerTool({
				name: "capture_async_job_snapshot",
				label: "Capture async job snapshot",
				description: "Capture the session-owned async job snapshot for this test.",
				parameters: type({}),
				approval: "read",
				async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
					observedSnapshot = ctx.getAsyncJobSnapshot();
					return { content: [{ type: "text", text: "captured" }] };
				},
			});
		};
		const session = await spawnTopLevelSession(undefined, [snapshotExtension]);
		const manager = AsyncJobManager.instance();
		expect(manager).toBeDefined();
		const release = Promise.withResolvers<string>();
		const jobId = manager!.register("bash", "extension snapshot test", async () => release.promise, {
			ownerId: "Main",
		});

		try {
			const snapshotTool = session.getToolByName("capture_async_job_snapshot");
			expect(snapshotTool).toBeDefined();
			await snapshotTool!.execute("call-snapshot", {});

			expect(observedSnapshot?.running.some(job => job.id === jobId)).toBe(true);
		} finally {
			release.resolve("done");
			await manager!.waitForAll();
			await session.dispose();
		}
	}, 60000);

	it("refuses async bash from a secondary session instead of routing it to the primary's manager", async () => {
		const primary = await spawnTopLevelSession({ "async.enabled": true });
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();
			const primaryJobCountBefore = primaryManager!.getAllJobs().length;

			const secondary = await spawnTopLevelSession({ "async.enabled": true });
			try {
				const bashTool = secondary.getToolByName("bash");
				expect(bashTool).toBeDefined();
				await expect(bashTool!.execute("call-1", { command: "echo hi", async: true })).rejects.toThrow(
					/Async job manager unavailable/,
				);
			} finally {
				await secondary.dispose();
			}

			// The secondary's failed async attempt must not have leaked a job into
			// the primary's manager.
			expect(primaryManager!.getAllJobs().length).toBe(primaryJobCountBefore);
		} finally {
			await primary.dispose();
		}
	}, 60000);

	it("retires the previous session's agents and async state before starting a new session", async () => {
		const primary = await spawnTopLevelSession();
		const manager = AsyncJobManager.instance();
		if (!manager) throw new Error("Expected primary session to own the async job manager");

		const registry = AgentRegistry.global();
		const lifecycle = AgentLifecycleManager.global();
		const previousScopeId = primary.getAgentScopeId();
		let idleDisposeCalls = 0;
		let parkedReviveCalls = 0;
		const idleSession = {
			dispose: async () => {
				idleDisposeCalls++;
			},
		} as AgentSession;

		registry.register({
			id: "PreviousIdle",
			displayName: "Previous idle agent",
			kind: "sub",
			parentId: "Main",
			scopeId: previousScopeId,
			session: idleSession,
			sessionFile: path.join(primary.sessionFile!.slice(0, -6), "PreviousIdle.jsonl"),
			status: "idle",
		});
		lifecycle.adopt("PreviousIdle", { idleTtlMs: 0 }, previousScopeId);
		registry.register({
			id: "PreviousParked",
			displayName: "Previous parked agent",
			kind: "sub",
			parentId: "Main",
			scopeId: previousScopeId,
			session: null,
			sessionFile: path.join(primary.sessionFile!.slice(0, -6), "PreviousParked.jsonl"),
			status: "parked",
		});
		lifecycle.adopt(
			"PreviousParked",
			{
				idleTtlMs: 0,
				revive: async () => {
					parkedReviveCalls++;
					return idleSession;
				},
			},
			previousScopeId,
		);

		const descendantAborted = Promise.withResolvers<void>();
		const descendantJobId = manager.register(
			"task",
			"previous descendant work",
			async ({ signal }) => {
				if (!signal.aborted) {
					await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
				}
				descendantAborted.resolve();
				return "old result";
			},
			{ id: "PreviousIdle-job", ownerId: "PreviousIdle", scopeId: previousScopeId },
		);
		primary.yieldQueue.enqueue("async-result", {
			jobId: "previous-completed-job",
			result: "must not reach the new session",
			job: undefined,
			durationMs: 0,
		});

		try {
			const previousSessionId = primary.sessionId;
			expect(await primary.newSession()).toBe(true);

			expect(primary.sessionId).not.toBe(previousSessionId);
			expect(registry.get("PreviousIdle")).toBeUndefined();
			expect(registry.get("PreviousParked")).toBeUndefined();
			expect(lifecycle.has("PreviousIdle")).toBe(false);
			expect(lifecycle.has("PreviousParked")).toBe(false);
			expect(idleDisposeCalls).toBe(1);
			expect(parkedReviveCalls).toBe(0);
			expect(manager.getJob(descendantJobId)).toBeUndefined();
			expect(primary.yieldQueue.has()).toBe(false);
			await descendantAborted.promise;
		} finally {
			await primary.dispose();
		}
	}, 60000);

	it("resumes a retired conversation without reopening its old agent and job scope", async () => {
		const primary = await spawnTopLevelSession();
		const manager = AsyncJobManager.instance();
		if (!manager) throw new Error("Expected primary session to own the async job manager");
		const registry = AgentRegistry.global();
		const bus = IrcBus.global();
		const oldScopeId = primary.getAgentScopeId();
		const oldSessionId = primary.sessionManager.getSessionId();
		const oldFile = primary.sessionFile!;
		const message = { role: "user" as const, content: "Remember this conversation", timestamp: Date.now() };
		primary.sessionManager.appendMessage(message);

		try {
			await primary.sessionManager.ensureOnDisk();
			expect(await primary.newSession()).toBe(true);
			const newFile = primary.sessionFile!;
			expect(await primary.switchSession(oldFile)).toBe(true);
			expect(primary.sessionManager.getSessionId()).toBe(oldSessionId);
			expect(primary.messages).toContainEqual(message);

			const resumedScopeId = primary.getAgentScopeId();
			expect(resumedScopeId).not.toBe(oldScopeId);
			expect(() =>
				registry.register({
					id: "LateResumePeer",
					displayName: "Late resume peer",
					kind: "sub",
					scopeId: oldScopeId,
					session: null,
				}),
			).toThrow(/retired scope/);
			expect(() =>
				manager.register("task", "late old work", async () => "stale", {
					ownerId: "Main",
					scopeId: oldScopeId,
				}),
			).toThrow(/scope is retired/);
			expect(
				(await bus.send({ from: "LateResumePeer", to: "Main", body: "stale", scopeId: oldScopeId })).outcome,
			).toBe("failed");

			// Reloads and a round trip must preserve the resumed runtime, so its
			// still-live peers remain able to reach Main.
			await primary.reload();
			expect(await primary.switchSession(newFile)).toBe(true);
			expect(await primary.switchSession(oldFile)).toBe(true);
			const reply = bus.wait("Main", { from: "ResumePeer" }, 1_000, undefined, { scopeId: resumedScopeId });
			expect(
				(await bus.send({ from: "ResumePeer", to: "Main", body: "resumed reply", scopeId: resumedScopeId }))
					.outcome,
			).toBe("injected");
			expect((await reply)?.body).toBe("resumed reply");

			const jobId = manager.register("task", "resumed work", async () => "resumed result", {
				ownerId: "Main",
				scopeId: primary.getAgentScopeId(),
			});
			await manager.waitForAll();
			expect(manager.getJob(jobId)?.resultText).toBe("resumed result");

			// Retiring a resumed generation must not prevent another resume, or
			// allow delayed callbacks from that generation to mutate Main.
			expect(await primary.newSession()).toBe(true);
			expect(await primary.switchSession(oldFile)).toBe(true);
			registry.updateScope("Main", oldScopeId, resumedScopeId);
			expect(primary.messages).toContainEqual(message);
			const nextScopeId = primary.getAgentScopeId();
			const nextReply = bus.wait("Main", { from: "ResumePeer" }, 1_000, undefined, { scopeId: nextScopeId });
			expect(
				(await bus.send({ from: "ResumePeer", to: "Main", body: "second resume", scopeId: nextScopeId })).outcome,
			).toBe("injected");
			expect((await nextReply)?.body).toBe("second resume");
			expect(() =>
				manager.register("task", "late resumed work", async () => "stale", {
					ownerId: "Main",
					scopeId: resumedScopeId,
				}),
			).toThrow(/scope is retired/);
		} finally {
			await primary.dispose();
		}
	}, 60000);

	it("keeps both the source and fork resumable after retiring the fork's runtime", async () => {
		const primary = await spawnTopLevelSession();
		try {
			const sourceMessage = { role: "user" as const, content: "Source conversation", timestamp: Date.now() };
			primary.sessionManager.appendMessage(sourceMessage);
			await primary.sessionManager.ensureOnDisk();
			const sourceFile = primary.sessionFile!;
			expect(await primary.fork()).toBe(true);
			const forkFile = primary.sessionFile!;
			const forkMessage = { role: "user" as const, content: "Fork-only conversation", timestamp: Date.now() };
			primary.sessionManager.appendMessage(forkMessage);

			expect(await primary.newSession()).toBe(true);
			expect(await primary.switchSession(sourceFile)).toBe(true);
			expect(primary.messages).toContainEqual(sourceMessage);
			expect(primary.messages).not.toContainEqual(forkMessage);
			expect(await primary.switchSession(forkFile)).toBe(true);
			expect(primary.messages).toContainEqual(sourceMessage);
			expect(primary.messages).toContainEqual(forkMessage);
		} finally {
			await primary.dispose();
		}
	}, 60000);

	it("restores the active runtime scope when resume fails after rebinding Main", async () => {
		const primary = await spawnTopLevelSession();
		try {
			await primary.sessionManager.ensureOnDisk();
			const oldFile = primary.sessionFile!;
			expect(await primary.newSession()).toBe(true);
			const activeFile = primary.sessionFile;
			const activeScopeId = primary.getAgentScopeId();
			const message = { role: "user" as const, content: "Keep the current conversation", timestamp: Date.now() };
			primary.sessionManager.appendMessage(message);
			primary.agent.appendMessage(message);
			using costRestore = spyOn(advisorModule, "loadAdvisorTranscriptCosts");
			costRestore.mockRejectedValueOnce(new Error("advisor transcript unavailable"));

			await expect(primary.switchSession(oldFile)).rejects.toThrow("advisor transcript unavailable");
			expect(primary.sessionFile).toBe(activeFile);
			expect(primary.messages).toContainEqual(message);
			const bus = IrcBus.global();
			const reply = bus.wait("Main", { from: "ActivePeer" }, 1_000, undefined, { scopeId: activeScopeId });
			expect(
				(await bus.send({ from: "ActivePeer", to: "Main", body: "still active", scopeId: activeScopeId })).outcome,
			).toBe("injected");
			expect((await reply)?.body).toBe("still active");
			expect(primary.getAgentScopeId()).toBe(activeScopeId);
			expect(await primary.switchSession(oldFile)).toBe(true);
		} finally {
			await primary.dispose();
		}
	}, 60000);

	it("clears a manager installed before a top-level session startup failure takes ownership", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-async-startup-failure-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });

		await expect(
			createAgentSession({
				cwd,
				agentDir,
				settings: Settings.isolated({ "bash.autoBackground.enabled": true }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				modelRegistry: sharedModelRegistry,
				systemPrompt: () => {
					throw new Error("forced startup failure");
				},
			}),
		).rejects.toThrow("forced startup failure");

		expect(AsyncJobManager.instance()).toBeUndefined();

		const replacement = await spawnTopLevelSession();
		try {
			expect(AsyncJobManager.instance()).toBeDefined();
			expect(replacement.getAsyncJobSnapshot()).not.toBeNull();
		} finally {
			await replacement.dispose();
		}
	}, 60000);
});
