import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentTool, type AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	ASYNC_INLINE_RESULT_MAX_CHARS,
	type AsyncResultDetails,
} from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, type CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import { TempDir } from "@oh-my-pi/pi-utils";

function text(message: AgentToolResult<unknown>): string {
	return message.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
}

describe("task completion delivery across wait boundaries", () => {
	let manager: AsyncJobManager;
	let session: AgentSession | undefined;
	let auth: AuthStorage | undefined;
	let temp: TempDir;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		session = undefined;
		auth = undefined;
		manager = new AsyncJobManager({});
		temp = TempDir.createSync("@task-delivery-race-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		await manager.dispose({ timeoutMs: 100 });
		auth?.close();
		temp.removeSync();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	function toolSession(): ToolSession {
		return {
			cwd: temp.path(),
			settings: Settings.isolated({ "launch.enabled": false }),
			asyncJobManager: manager,
			agentRegistry: AgentRegistry.global(),
			getAgentId: () => "Main",
		} as unknown as ToolSession;
	}

	async function createParent(handler: MockHandler = { content: ["acknowledged"] }) {
		auth = await AuthStorage.create(":memory:");
		auth.keys.setRuntime("openai", "test-key");
		const mock = createMockModel({ provider: "openai", id: "gpt-test", handler });
		const wait = new WaitTool(toolSession());
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [wait], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(temp.path()),
			settings,
			modelRegistry: new ModelRegistry(auth),
			toolRegistry: new Map([[wait.name, wait as unknown as AgentTool]]),
			agentId: "Main",
			asyncJobManager: manager,
		});
		return { active: session, mock, wait };
	}

	function deliveredIds(): string[] {
		return (session?.agent.state.messages ?? [])
			.filter(
				(message): message is CustomMessage<AsyncResultDetails> =>
					message.role === "custom" && message.customType === "async-result",
			)
			.flatMap(message => message.details?.jobs.map(job => job.jobId) ?? []);
	}

	it("parks an accepted completion while watched and resumes the same delivery once", async () => {
		const delivered: string[] = [];
		manager.registerDeliverySink("Main", (_id, result) => {
			delivered.push(result);
		});
		const gate = Promise.withResolvers<string>();
		const id = manager.register("task", "worker", () => gate.promise, { ownerId: "Main" });
		manager.watchJobs([id]);
		gate.resolve("worker report");
		await manager.getJob(id)!.promise;

		expect(manager.hasJobDelivery(id)).toBe(true);
		expect(manager.isJobResultConsumed(id)).toBe(false);
		expect(delivered).toEqual([]);
		manager.unwatchJobs([id]);
		expect(await manager.drainDeliveries({ timeoutMs: 1_000 })).toBe(true);
		expect(delivered).toEqual(["worker report"]);
		expect(manager.isJobResultConsumed(id)).toBe(true);
		expect(manager.hasJobDelivery(id)).toBe(false);
	});

	it("preserves another watched completion when a foreground consumer takes one result", async () => {
		const delivered: string[] = [];
		manager.registerDeliverySink("Main", id => {
			delivered.push(id);
		});
		const first = manager.register("task", "first", async () => "first report", { ownerId: "Main" });
		const second = manager.register("task", "second", async () => "second report", { ownerId: "Main" });
		manager.watchJobs([first, second]);
		await manager.waitForAll();

		expect(manager.consumeJobResults([first])).toBe(1);
		expect(manager.hasJobDelivery(second)).toBe(true);
		expect(manager.isJobResultConsumed(second)).toBe(false);
		manager.unwatchJobs([first, second]);
		await manager.drainDeliveries({ timeoutMs: 1_000 });
		expect(delivered).toEqual([second]);
	});

	it("requeues a deferred in-flight sink after the watcher releases before its receipt settles", async () => {
		const entered = Promise.withResolvers<void>();
		const deferred = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const readyToCommit = Promise.withResolvers<void>();
		const commit = Promise.withResolvers<void>();
		const delivered: string[] = [];
		let attempts = 0;
		manager.registerDeliverySink("Main", async (_id, result) => {
			if (++attempts === 1) {
				entered.resolve();
				await release.promise;
				deferred.resolve();
				return "deferred";
			}
			readyToCommit.resolve();
			await commit.promise;
			delivered.push(result);
		});
		const id = manager.register("task", "worker", async () => "worker report", { ownerId: "Main" });
		try {
			await entered.promise;
			manager.watchJobs([id]);
			release.resolve();
			await deferred.promise;
			// The sink has decided not to inject, but its manager receipt is still in flight.
			manager.unwatchJobs([id]);
			await readyToCommit.promise;
			expect(manager.isJobResultConsumed(id)).toBe(false);
			commit.resolve();
			await manager.drainDeliveries({ timeoutMs: 1_000 });
			expect(attempts).toBe(2);
			expect(delivered).toEqual(["worker report"]);
			expect(manager.isJobResultConsumed(id)).toBe(true);
		} finally {
			release.resolve();
			commit.resolve();
		}
	});

	it.each([false, true])("auto-delivers concurrent completions to a busy parent (queued watch: %s)", async watched => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const queued = Promise.withResolvers<void>();
		let calls = 0;
		const { active } = await createParent(async () => {
			if (++calls === 1) {
				entered.resolve();
				await release.promise;
			}
			return { content: ["acknowledged"] };
		});
		const enqueue = active.yieldQueue.enqueueWithReceipt.bind(active.yieldQueue);
		let queuedCount = 0;
		vi.spyOn(active.yieldQueue, "enqueueWithReceipt").mockImplementation((kind, entry) => {
			const receipt = enqueue(kind, entry);
			if (kind === "async-result" && ++queuedCount === 2) queued.resolve();
			return receipt;
		});
		const turn = active.prompt("continue independent work");
		try {
			await entered.promise;
			const first = manager.register("task", "first", async () => "first report", { ownerId: "Main" });
			const second = manager.register("task", "second", async () => "second report", { ownerId: "Main" });
			await queued.promise;
			if (watched) manager.watchJobs([first]);
			expect(manager.isJobResultConsumed(first)).toBe(false);
			expect(manager.isJobResultConsumed(second)).toBe(false);
			release.resolve();
			await turn;
			await active.waitForIdle();
			expect(await manager.drainDeliveries({ timeoutMs: 1_000 })).toBe(true);
			expect(deliveredIds().sort()).toEqual([first, second].sort());
			expect(manager.isJobResultConsumed(first)).toBe(true);
			expect(manager.isJobResultConsumed(second)).toBe(true);
			manager.unwatchJobs([first, second]);
			await manager.drainDeliveries({ timeoutMs: 1_000 });
			expect(deliveredIds().sort()).toEqual([first, second].sort());
		} finally {
			release.resolve();
			await turn;
		}
	});

	it("keeps an actual formatting-time deferral unconsumed and auto-delivers after unwatch", async () => {
		const deferred = Promise.withResolvers<void>();
		const register = manager.registerDeliverySink.bind(manager);
		vi.spyOn(manager, "registerDeliverySink").mockImplementation((owner, sink) =>
			register(owner, async (id, result, job) => {
				const outcome = await sink(id, result, job);
				if (outcome === "deferred") deferred.resolve();
				return outcome;
			}),
		);
		const { active } = await createParent();
		const formatting = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const allocate = active.sessionManager.allocateArtifactPath.bind(active.sessionManager);
		vi.spyOn(active.sessionManager, "allocateArtifactPath").mockImplementation(async kind => {
			formatting.resolve();
			await release.promise;
			return allocate(kind);
		});
		const id = manager.register("task", "large report", async () => "x".repeat(ASYNC_INLINE_RESULT_MAX_CHARS + 1), {
			ownerId: "Main",
		});
		try {
			await formatting.promise;
			manager.watchJobs([id]);
			release.resolve();
			await deferred.promise;
			expect(manager.isJobResultConsumed(id)).toBe(false);
			manager.unwatchJobs([id]);
			expect(await manager.drainDeliveries({ timeoutMs: 1_000 })).toBe(true);
			await active.waitForIdle();
			expect(deliveredIds()).toEqual([id]);
			expect(manager.isJobResultConsumed(id)).toBe(true);
		} finally {
			release.resolve();
			manager.unwatchJobs([id]);
		}
	});

	it("hands an accepted completion to a long wait after a short wait without replaying it", async () => {
		const { active, wait } = await createParent();
		const gate = Promise.withResolvers<string>();
		const id = manager.register("task", "worker", () => gate.promise, { ownerId: "Main" });
		try {
			const short = await wait.execute("short", { timeoutMs: 1 });
			expect(short.details?.jobs?.[0]).toMatchObject({ id, status: "running" });
			const long = wait.execute("long", { timeoutMs: 0 });
			gate.resolve("worker report");
			const result = await long;
			expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "worker report" });
			expect(text(result)).toContain("Delivery: received by this wait.");
			expect(manager.isJobResultConsumed(id)).toBe(true);
			await manager.drainDeliveries({ timeoutMs: 1_000 });
			await active.waitForIdle();
			expect(deliveredIds()).toEqual([]);
			await expect(wait.execute("again", { timeoutMs: 0 })).rejects.toThrow("Nothing to wait for");
		} finally {
			gate.resolve("worker report");
		}
	});

	it("auto-delivers once when IRC wins a photo-finish with the watched completion", async () => {
		const delivered: string[] = [];
		const committed = Promise.withResolvers<void>();
		manager.registerDeliverySink("Main", async (_id, result) => {
			await committed.promise;
			delivered.push(result);
		});
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
		registry.register({ id: "Peer", displayName: "Peer", kind: "sub", parentId: "Main", session: null });
		const gate = Promise.withResolvers<string>();
		const id = manager.register("task", "worker", () => gate.promise, { ownerId: "Main" });
		try {
			const waiting = new WaitTool(toolSession()).execute("irc-race", { timeoutMs: 0 });
			const message = IrcBus.global().send({ from: "Peer", to: "Main", body: "handoff message" });
			gate.resolve("worker report");
			expect((await message).outcome).toBe("injected");
			const result = await waiting;
			expect(result.details?.waited).toMatchObject({ from: "Peer", body: "handoff message" });
			expect(manager.isJobResultConsumed(id)).toBe(false);
			committed.resolve();
			await manager.drainDeliveries({ timeoutMs: 1_000 });
			expect(delivered).toEqual(["worker report"]);
			expect(manager.isJobResultConsumed(id)).toBe(true);
		} finally {
			gate.resolve("worker report");
			committed.resolve();
		}
	});

	it("recovers a genuinely dead-lettered result once without claiming automatic delivery", async () => {
		const id = manager.register("task", "orphan", async () => "recoverable report", { ownerId: "Main" });
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 1_000 });
		expect(manager.hasJobDelivery(id)).toBe(false);
		expect(manager.isJobResultConsumed(id)).toBe(false);
		const wait = new WaitTool(toolSession());
		const recovered = await wait.execute("recover", { timeoutMs: 0 });
		expect(text(recovered)).toContain("not auto-delivered; recovered by this snapshot");
		expect(recovered.details?.jobs?.[0]?.resultText).toBe("recoverable report");
		expect(manager.isJobResultConsumed(id)).toBe(true);
		await expect(wait.execute("again", { timeoutMs: 0 })).rejects.toThrow("Nothing to wait for");
	});

	it("does not consume a discarded sink attempt that never reached the parent", async () => {
		manager.registerDeliverySink("Main", () => "discarded");
		const id = manager.register("task", "discarded", async () => "recoverable report", { ownerId: "Main" });
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 1_000 });
		expect(manager.isJobResultConsumed(id)).toBe(false);
		expect(manager.hasJobDelivery(id)).toBe(false);
		const recovered = await new WaitTool(toolSession()).execute("recover-discarded", { timeoutMs: 0 });
		expect(recovered.details?.jobs?.[0]?.resultText).toBe("recoverable report");
		expect(manager.isJobResultConsumed(id)).toBe(true);
	});
});
