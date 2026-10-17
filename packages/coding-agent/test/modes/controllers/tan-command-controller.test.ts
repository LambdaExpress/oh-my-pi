import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { AsyncJobRegisterOptions } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { PreparedExtension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { TanCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/tan-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { setLocale } from "../../../src/i18n";

interface CapturedJobRunContext {
	jobId: string;
	signal: AbortSignal;
	reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
}

type CapturedJobRun = (ctx: CapturedJobRunContext) => Promise<string>;

const model = { provider: "anthropic", id: "claude-sonnet-4-5" } as Model;
const createAgentSession = sdkModule.createAgentSession;

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

interface TanSessionEvent {
	type: string;
	result?: unknown;
	aborted?: boolean;
}

/** Minimal tan clone session stub covering the surface `TanCommandController` drives. */
function createCloneStub(overrides?: {
	prompt?: () => Promise<void>;
	abort?: () => void;
	sessionManager?: { appendSessionInit: (init: unknown) => void };
	lastAssistantText?: string;
	activeToolNames?: string[];
	enabledToolNames?: string[];
	mountedXdevToolNames?: string[];
}) {
	const messages: AgentMessage[] = [];
	const appendMessage = vi.fn((message: AgentMessage) => {
		messages.push(message);
	});
	let listener: ((event: TanSessionEvent) => void) | undefined;
	const clone = {
		agent: { appendMessage, state: { messages } },
		sessionManager: overrides?.sessionManager,
		setActiveToolPresentation: vi.fn(async () => {}),
		getMountedXdevToolNames: vi.fn(() => [...(overrides?.mountedXdevToolNames ?? [])]),
		setTodoPhases: vi.fn(),
		getActiveToolNames: vi.fn(() => overrides?.activeToolNames ?? ["read", "bash"]),
		getEnabledToolNames: vi.fn(() => overrides?.enabledToolNames ?? overrides?.activeToolNames ?? ["read", "bash"]),
		subscribe: vi.fn((l: (event: TanSessionEvent) => void) => {
			listener = l;
			return () => {
				listener = undefined;
			};
		}),
		prompt: vi.fn(overrides?.prompt ?? (async () => {})),
		waitForIdle: vi.fn(async () => {}),
		hasPendingAsyncWork: vi.fn(() => false),
		settleAsyncWork: vi.fn(async () => {}),
		getLastAssistantMessage: vi.fn(() => assistantText(overrides?.lastAssistantText ?? "done")),
		abort: vi.fn(overrides?.abort ?? (() => {})),
		dispose: vi.fn(async () => {}),
	};
	return {
		clone,
		appendMessage,
		messages,
		get compactionListener() {
			return listener;
		},
	};
}

function createContext(overrides?: {
	isStreaming?: boolean;
	model?: Model;
	agentId?: string;
	parentPromptCacheKey?: string;
	mcpManager?: MCPManager;
	extensionPaths?: string[];
	customToolPaths?: NonNullable<InteractiveModeContext["session"]["customToolPaths"]>;
	register?: (run: CapturedJobRun, options?: AsyncJobRegisterOptions) => string;
	activeToolNames?: string[];
	enabledToolNames?: string[];
	mountedXdevToolNames?: string[];
	preparedExtensions?: unknown;
	effectiveExtensionRoots?: unknown;
}) {
	const tempDir = TempDir.createSync("@omp-tan-controller-");
	const parentFile = path.join(tempDir.path(), "parent.jsonl");
	// The clone nests inside the parent's artifact directory, like a subagent.
	const cloneFile = path.join(parentFile.slice(0, -6), "clone.jsonl");
	let capturedRun: CapturedJobRun | undefined;
	let capturedOptions: AsyncJobRegisterOptions | undefined;
	const sequence: string[] = [];
	const register = vi.fn(
		(_type: "bash" | "task", _label: string, run: CapturedJobRun, options?: AsyncJobRegisterOptions): string => {
			sequence.push("register");
			capturedRun = run;
			capturedOptions = options;
			return overrides?.register ? overrides.register(run, options) : "job-123";
		},
	);
	const session = {
		isStreaming: overrides?.isStreaming ?? false,
		agent: { promptCacheKey: overrides?.parentPromptCacheKey },
		model: overrides?.model ?? model,
		asyncJobManager: { register },
		sessionId: "parent-session",
		getAgentScopeId: vi.fn(() => "parent-scope"),
		configuredThinkingLevel: vi.fn(() => undefined),
		systemPrompt: ["system prompt"],
		extensionPaths: overrides?.extensionPaths ?? [],
		customToolPaths: overrides?.customToolPaths ?? [],
		getActiveToolNames: vi.fn(() => overrides?.activeToolNames ?? ["read", "bash"]),
		getEnabledToolNames: vi.fn(() => overrides?.enabledToolNames ?? overrides?.activeToolNames ?? ["read", "bash"]),
		getMountedXdevToolNames: vi.fn(() => overrides?.mountedXdevToolNames ?? []),
		modelRegistry: { authStorage: { marker: "auth" } },
		preparedExtensions: overrides?.preparedExtensions,
		effectiveExtensionRoots: overrides?.effectiveExtensionRoots,
		getAgentId: vi.fn(() => overrides?.agentId),
		sendCustomMessage: vi.fn(async () => {
			sequence.push("sendCustomMessage");
		}),
	} as unknown as InteractiveModeContext["session"];
	const parentArtifactsDir = parentFile.slice(0, -6);
	const getArtifactsDir = vi.fn(() => parentArtifactsDir);
	const getSessionId = vi.fn(() => "parent-local-session");
	const materializeDeferredSession = vi.fn(async () => {});
	const sessionManager = {
		getHeader: vi.fn(() => undefined),
		getSessionFile: vi.fn(() => parentFile),
		getCwd: vi.fn(() => tempDir.path()),
		getSessionDir: vi.fn(() => tempDir.path()),
		getArtifactsDir,
		getSessionId,
		ensureOnDisk: vi.fn(async () => {}),
		flush: vi.fn(async () => {}),
	} as unknown as InteractiveModeContext["sessionManager"];
	const cloneManager = {
		getSessionFile: vi.fn(() => cloneFile),
		appendCustomEntry: vi.fn(),
		materializeDeferredSession,
	} as unknown as SessionManager;
	const ctx = {
		session,
		sessionManager,
		mcpManager: overrides?.mcpManager,
		settings: Settings.isolated({ "task.enableLsp": true }),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		rebuildChatFromMessages: vi.fn(),
	} as unknown as InteractiveModeContext;
	return {
		tempDir,
		parentFile,
		parentArtifactsDir,
		cloneFile,
		cloneManager,
		ctx,
		getArtifactsDir,
		getSessionId,
		materializeDeferredSession,
		register,
		sequence,
		get capturedRun() {
			return capturedRun;
		},
		get capturedOptions() {
			return capturedOptions;
		},
	};
}

async function createHeadlessClone(
	cwd: string,
	toolNames: string[],
	options: Pick<CreateAgentSessionOptions, "mcpTools" | "mountedToolNames" | "settings"> = {},
) {
	const fixtureModel = getBundledModel("openai", "gpt-4o-mini");
	if (!fixtureModel) throw new Error("Expected bundled fixture model");
	return createAgentSession({
		cwd,
		agentDir: cwd,
		model: fixtureModel,
		settings: Settings.isolated({ "tools.xdev": false, "marketplace.autoUpdate": "off" }),
		sessionManager: SessionManager.inMemory(cwd),
		agentRegistry: new AgentRegistry(),
		parentTaskPrefix: "Tan-headless-fixture",
		toolNames,
		hasUI: false,
		bindProcessState: false,
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		disableExtensionDiscovery: true,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		preloadedCustomToolPaths: [],
		workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		...options,
	});
}

describe("TanCommandController", () => {
	beforeEach(() => {
		setLocale("en");
	});

	afterEach(() => {
		setLocale(null);
		vi.restoreAllMocks();
	});

	it("rejects empty work before forking", async () => {
		const harness = createContext();
		const forkSpy = vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const controller = new TanCommandController(harness.ctx);

		await controller.start("   ");

		expect(forkSpy).not.toHaveBeenCalled();
		expect(harness.ctx.showStatus).toHaveBeenCalledWith("Usage: /tan <work>");
	});

	it("dispatches without disturbing an in-flight turn while streaming", async () => {
		const harness = createContext({ isStreaming: true });
		const forkSpy = vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const controller = new TanCommandController(harness.ctx);

		await controller.start("check something");

		expect(forkSpy).toHaveBeenCalled();
		expect(harness.ctx.showWarning).not.toHaveBeenCalled();
		// The breadcrumb is queued for the next turn, not steered into the live one,
		// and the live chat is left to the streaming renderer (no synchronous rebuild).
		expect(harness.ctx.session.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "background-tan-dispatch" }),
			{ triggerTurn: false, deliverAs: "nextTurn" },
		);
		expect(harness.ctx.rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(harness.ctx.showStatus).toHaveBeenCalledWith("Dispatched background tan job-123");
	});

	it("forks with breadcrumb suppression, registers under Main, and dispatches after receiving the job id", async () => {
		const harness = createContext();
		const forkSpy = vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const controller = new TanCommandController(harness.ctx);

		await controller.start("write the release note");

		expect(forkSpy).toHaveBeenCalledWith(
			harness.parentFile,
			harness.tempDir.path(),
			harness.parentFile.slice(0, -6),
			undefined,
			{
				copyArtifacts: false,
				suppressBreadcrumb: true,
				sessionFile: expect.stringMatching(/Tan-.+\.jsonl$/),
				resetInheritedCost: true,
				repairInterruptedTail: true,
			},
		);
		expect(harness.register).toHaveBeenCalledWith("task", "/tan write the release note", expect.any(Function), {
			ownerId: MAIN_AGENT_ID,
			scopeId: "parent-scope",
			agentId: expect.stringMatching(/^Tan-/) as unknown as string,
		});
		expect(harness.capturedOptions?.ownerId).toBe(MAIN_AGENT_ID);
		expect(harness.sequence).toEqual(["register", "sendCustomMessage"]);
		expect(harness.ctx.session.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "background-tan-dispatch",
				details: {
					jobId: "job-123",
					work: "write the release note",
					sessionFile: expect.stringMatching(/Tan-.+\.jsonl$/),
				},
			}),
			{ triggerTurn: false, deliverAs: "nextTurn" },
		);
		expect(harness.ctx.rebuildChatFromMessages).toHaveBeenCalled();
		expect(harness.ctx.showStatus).toHaveBeenCalledWith("Dispatched background tan job-123");
	});

	it("keeps the dispatching session's local:// root after the interactive session switches", async () => {
		const harness = createContext();
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const { clone } = createCloneStub({ lastAssistantText: "done" });
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: clone } as unknown as CreateAgentSessionResult;
		});
		const controller = new TanCommandController(harness.ctx);

		await controller.start("read local://paste-1.md");
		harness.getArtifactsDir.mockReturnValue(path.join(harness.tempDir.path(), "other-session"));
		harness.getSessionId.mockReturnValue("other-session");
		const capturedRun = harness.capturedRun;
		if (!capturedRun) throw new Error("run function was not captured");
		await capturedRun({ jobId: "job-123", signal: new AbortController().signal, reportProgress: async () => {} });

		const opts = capturedOptions?.localProtocolOptions;
		if (!opts) throw new Error("localProtocolOptions was not passed");
		expect(resolveLocalRoot(opts)).toBe(path.join(harness.parentArtifactsDir, "local"));
		// The local mapping keys off the session-manager id (not `session.sessionId`,
		// still "parent-session"), matching the parent's large-paste / local:// writes.
		expect(opts.getSessionId?.()).toBe("parent-local-session");
	});

	it("keeps the tangent alive until successive descendant results produce the final answer", async () => {
		const harness = createContext();
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const { clone } = createCloneStub();
		const firstEntered = Promise.withResolvers<void>();
		const secondEntered = Promise.withResolvers<void>();
		const firstResult = Promise.withResolvers<void>();
		const secondResult = Promise.withResolvers<void>();
		let generation = 0;
		let answer = "preliminary answer";
		clone.hasPendingAsyncWork.mockImplementation(() => generation < 2);
		clone.settleAsyncWork.mockImplementation(async () => {
			if (generation === 0) {
				firstEntered.resolve();
				await firstResult.promise;
				answer = "first descendant result; another descendant is pending";
			} else {
				secondEntered.resolve();
				await secondResult.promise;
				answer = "final answer incorporating both descendant results";
			}
			generation++;
		});
		clone.getLastAssistantMessage.mockImplementation(() => assistantText(answer));
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: clone,
		} as unknown as CreateAgentSessionResult);
		await new TanCommandController(harness.ctx).start("integrate descendant results");
		const run = harness.capturedRun;
		if (!run) throw new Error("run function was not captured");
		let returned = false;
		const result = run({
			jobId: "job-123",
			signal: new AbortController().signal,
			reportProgress: async () => {},
		}).then(value => {
			returned = true;
			return value;
		});
		try {
			// Racing the first wait against completion makes the old premature return
			// fail immediately rather than waiting for a test timeout.
			expect(await Promise.race([firstEntered.promise.then(() => "waiting"), result.then(() => "returned")])).toBe(
				"waiting",
			);
			expect(clone.dispose).not.toHaveBeenCalled();
			firstResult.resolve();
			await secondEntered.promise;
			expect(returned).toBe(false);
			expect(clone.dispose).not.toHaveBeenCalled();
			secondResult.resolve();
			expect(await result).toBe("final answer incorporating both descendant results");
			expect(clone.dispose).toHaveBeenCalledTimes(1);
		} finally {
			firstResult.resolve();
			secondResult.resolve();
			await result;
		}
	});

	it("cancels a tangent while descendant settlement is pending and disposes its clone", async () => {
		const harness = createContext();
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const { clone } = createCloneStub();
		const settling = Promise.withResolvers<void>();
		const settled = Promise.withResolvers<void>();
		clone.hasPendingAsyncWork.mockReturnValue(true);
		clone.settleAsyncWork.mockImplementation(async () => {
			settling.resolve();
			await settled.promise;
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: clone,
		} as unknown as CreateAgentSessionResult);
		await new TanCommandController(harness.ctx).start("wait for a descendant");
		const run = harness.capturedRun;
		if (!run) throw new Error("run function was not captured");
		const abort = new AbortController();
		const result = run({ jobId: "job-123", signal: abort.signal, reportProgress: async () => {} });
		try {
			await settling.promise;
			abort.abort();
			await expect(result).rejects.toThrow();
			expect(clone.abort).toHaveBeenCalledTimes(1);
			expect(clone.dispose).toHaveBeenCalledTimes(1);
			expect(clone.getLastAssistantMessage).not.toHaveBeenCalled();
		} finally {
			clone.hasPendingAsyncWork.mockReturnValue(false);
			settled.resolve();
			await result.catch(() => {});
		}
	});

	it("forwards the parent's prepared extensions and root policy so the tan child rebinds runtime providers", async () => {
		// Regression: the tan clone reuses the parent's shared ModelRegistry. If it
		// is built without the parent's extensions, the SDK's syncExtensionSources
		// prune unregisters extension-provided providers from that shared registry,
		// so the child fails its API-key check ("No API key found for <provider>")
		// and the parent loses the registration too. The child MUST rebind the
		// parent's prepared extensions before that prune runs.
		const preparedExtensions: PreparedExtension[] = [
			{ path: "/ext/provider.ts", resolvedPath: "/ext/provider.ts", factory: null, error: null },
		];
		const effectiveExtensionRoots: EffectiveExtensionRoots = {
			explicit: ["/ext/provider.ts"],
			mode: "explicit-only",
			configured: [],
			configuredLevel: "user",
		};
		const extensionPaths = ["/ext/provider.ts"];
		const harness = createContext({ preparedExtensions, effectiveExtensionRoots, extensionPaths });
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const { clone } = createCloneStub({ lastAssistantText: "done" });
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: clone } as unknown as CreateAgentSessionResult;
		});
		const controller = new TanCommandController(harness.ctx);

		await controller.start("chase the tangent");
		const capturedRun = harness.capturedRun;
		if (!capturedRun) throw new Error("run function was not captured");
		await capturedRun({ jobId: "job-123", signal: new AbortController().signal, reportProgress: async () => {} });

		expect(capturedOptions?.preloadedPreparedExtensions).toBe(preparedExtensions);
		// Path-list fallback is forwarded (fresh copy) for parent builds without prepared factories.
		expect(capturedOptions?.preloadedExtensionPaths).toEqual(extensionPaths);
		expect(capturedOptions?.extensionRoots?.()).toBe(effectiveExtensionRoots);
		expect(capturedOptions?.disableExtensionDiscovery).toBe(true);
	});

	it("collapses an empty prepared-extensions list to undefined so the child selects the path fallback", async () => {
		// `[]` is truthy: if forwarded verbatim the child would bind an empty
		// factory list and skip the populated path fallback, then prune the shared
		// registry from an empty source set — the exact failure the fix prevents.
		const effectiveExtensionRoots: EffectiveExtensionRoots = {
			explicit: ["/ext/provider.ts"],
			mode: "explicit-only",
			configured: [],
			configuredLevel: "user",
		};
		const extensionPaths = ["/ext/provider.ts"];
		const harness = createContext({ preparedExtensions: [], effectiveExtensionRoots, extensionPaths });
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const { clone } = createCloneStub({ lastAssistantText: "done" });
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: clone } as unknown as CreateAgentSessionResult;
		});
		const controller = new TanCommandController(harness.ctx);

		await controller.start("chase the tangent");
		const capturedRun = harness.capturedRun;
		if (!capturedRun) throw new Error("run function was not captured");
		await capturedRun({ jobId: "job-123", signal: new AbortController().signal, reportProgress: async () => {} });

		expect(capturedOptions?.preloadedPreparedExtensions).toBeUndefined();
		expect(capturedOptions?.preloadedExtensionPaths).toEqual(extensionPaths);
	});

	it("aborts the cloned agent when the background job signal aborts", async () => {
		const harness = createContext({ agentId: MAIN_AGENT_ID });
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const promptStarted = Promise.withResolvers<void>();
		const abortObserved = Promise.withResolvers<void>();
		const { clone } = createCloneStub({
			prompt: async () => {
				promptStarted.resolve();
				await abortObserved.promise;
			},
			abort: () => {
				abortObserved.resolve();
			},
			lastAssistantText: "finished",
		});
		const createAgentSessionSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue({ session: clone } as unknown as CreateAgentSessionResult);
		const controller = new TanCommandController(harness.ctx);
		await controller.start("follow the tangent");
		const capturedRun = harness.capturedRun;
		expect(capturedRun).toBeDefined();
		if (!capturedRun) throw new Error("run function was not captured");
		const abortController = new AbortController();

		const resultPromise = capturedRun({
			jobId: "job-123",
			signal: abortController.signal,
			reportProgress: async () => {},
		});
		await promptStarted.promise;
		abortController.abort();
		const result = await resultPromise;

		expect(result).toBe("finished");
		expect(clone.abort).toHaveBeenCalled();
		expect(clone.dispose).toHaveBeenCalled();
		expect(createAgentSessionSpy.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				providerPromptCacheKey: "parent-session",
				agentScopeId: "parent-scope",
				parentTaskPrefix: expect.stringMatching(/^Tan-/) as unknown as string,
				agentDisplayName: "tan",
			}),
		);
	});

	it("parents the tan clone to the spawning agent, not to the clone itself", async () => {
		const harness = createContext({ agentId: "FocusedParent" });
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const { clone } = createCloneStub();
		const createAgentSessionSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue({ session: clone } as unknown as CreateAgentSessionResult);
		const controller = new TanCommandController(harness.ctx);
		await controller.start("follow the tangent");
		const capturedRun = harness.capturedRun;
		if (!capturedRun) throw new Error("run function was not captured");
		await capturedRun({ jobId: "job-1", signal: new AbortController().signal, reportProgress: async () => {} });

		const opts = createAgentSessionSpy.mock.calls[0]?.[0];
		// The clone's registry parent is the spawning (focused) agent. Its own
		// `Tan-<id>` artifact prefix must never double as the parent link, or the
		// hub would render the tan parented to itself.
		expect(opts?.parentAgentId).toBe("FocusedParent");
		expect(opts?.parentTaskPrefix).toMatch(/^Tan-/);
		expect(opts?.parentTaskPrefix).not.toBe("FocusedParent");
	});

	it("pins the parent's effective cache key when the parent itself carries a pinned promptCacheKey", async () => {
		// A parent that is itself a fork/tan caches under `agent.promptCacheKey`,
		// not its own session id — the clone must read that exact shard.
		const harness = createContext({ parentPromptCacheKey: "grandparent-cache-key" });
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const { clone } = createCloneStub();
		const createAgentSessionSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue({ session: clone } as unknown as CreateAgentSessionResult);
		const controller = new TanCommandController(harness.ctx);

		await controller.start("follow the tangent");
		const run = harness.capturedRun;
		if (!run) throw new Error("run function was not captured");
		await run({ jobId: "job-1", signal: new AbortController().signal, reportProgress: async () => {} });

		const opts = createAgentSessionSpy.mock.calls[0]?.[0];
		expect(opts?.providerPromptCacheKey).toBe("grandparent-cache-key");
		expect(opts?.providerSessionId).toMatch(/^parent-session:tan:/);
	});

	it("parks the finished tan in the registry so it stays visible in the Agent Hub", async () => {
		const harness = createContext();
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const appendSessionInit = vi.fn();
		const { clone } = createCloneStub({ sessionManager: { appendSessionInit } });
		const createAgentSessionSpy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: clone,
		} as unknown as CreateAgentSessionResult);
		const registry = AgentRegistry.global();
		const setStatus = vi.spyOn(registry, "setStatus");
		const detachSession = vi.spyOn(registry, "detachSession");
		const unregister = vi.spyOn(registry, "unregister");
		const controller = new TanCommandController(harness.ctx);

		await controller.start("park me");
		expect(harness.materializeDeferredSession).not.toHaveBeenCalled();
		const run = harness.capturedRun;
		if (!run) throw new Error("run function was not captured");
		const result = await run({
			jobId: "job-123",
			signal: new AbortController().signal,
			reportProgress: async () => {},
		});

		expect(result).toBe("done");
		expect(appendSessionInit).toHaveBeenCalledWith({
			systemPrompt: ["system prompt"],
			task: "park me",
			tools: ["read", "bash"],
			mountedXdevTools: [],
		});
		expect(harness.materializeDeferredSession).toHaveBeenCalledTimes(1);
		expect(createAgentSessionSpy.mock.invocationCallOrder[0]).toBeLessThan(
			harness.materializeDeferredSession.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
		expect(appendSessionInit.mock.invocationCallOrder[0]).toBeLessThan(
			harness.materializeDeferredSession.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
		// Parked (not unregistered) before dispose, then the disposed session is nulled
		// out — the hub keeps the ref and reads its transcript from the session file.
		expect(setStatus).toHaveBeenCalledWith(expect.stringMatching(/^Tan-/), "parked", "parent-scope");
		expect(detachSession).toHaveBeenCalledWith(expect.stringMatching(/^Tan-/), "parent-scope");
		expect(clone.dispose).toHaveBeenCalled();
		expect(unregister).not.toHaveBeenCalled();
	});

	it("copies and persists the full enabled tool set", async () => {
		const enabledToolNames = ["eval", "read", "bash"];
		const harness = createContext({ activeToolNames: ["eval"], enabledToolNames });
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const appendSessionInit = vi.fn();
		const { clone } = createCloneStub({
			sessionManager: { appendSessionInit },
			activeToolNames: ["eval"],
			enabledToolNames,
		});
		const createAgentSessionSpy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: clone,
		} as unknown as CreateAgentSessionResult);
		const controller = new TanCommandController(harness.ctx);

		await controller.start("preserve bridge tools");
		const run = harness.capturedRun;
		if (!run) throw new Error("run function was not captured");
		await run({ jobId: "job-123", signal: new AbortController().signal, reportProgress: async () => {} });

		expect(createAgentSessionSpy.mock.calls[0]?.[0]?.toolNames).toEqual(enabledToolNames);
		expect(appendSessionInit).toHaveBeenCalledWith(expect.objectContaining({ tools: enabledToolNames }));
	});

	it("dispatches when the parent enables a tool the headless clone cannot host", async () => {
		// A mounted ask has no top-level descriptor to preserve. The real factory
		// omits it in a headless clone rather than installing a fake prompt tool.
		const harness = createContext({
			enabledToolNames: ["ask", "read", "bash"],
			mountedXdevToolNames: ["ask"],
		});
		using tempDir = harness.tempDir;
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const created = await createHeadlessClone(tempDir.path(), ["ask", "read", "bash"]);
		const clone = created.session;
		vi.spyOn(clone, "prompt").mockResolvedValue(true);
		vi.spyOn(clone, "getLastAssistantMessage").mockReturnValue(assistantText("done"));
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(created);
		try {
			await new TanCommandController(harness.ctx).start("check the deploy");
			const run = harness.capturedRun;
			if (!run) throw new Error("run function was not captured");
			const result = await run({
				jobId: "job-123",
				signal: new AbortController().signal,
				reportProgress: async () => {},
			});

			expect(result).toBe("done");
			expect(clone.getEnabledToolNames()).toEqual(["read", "bash"]);
			expect(clone.getMountedXdevToolNames()).toEqual([]);
			expect(clone.getToolByName("ask")).toBeUndefined();
		} finally {
			if (!clone.isDisposed) await clone.dispose();
		}
	});

	it("refuses a clone that loses custom or MCP capabilities instead of classifying them as headless tools", async () => {
		const toolNames = ["read", "bash", "deployment_status", "mcp__deploy_status"];
		const harness = createContext({
			enabledToolNames: toolNames,
			mountedXdevToolNames: ["mcp__deploy_status"],
		});
		using tempDir = harness.tempDir;
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const created = await createHeadlessClone(tempDir.path(), toolNames);
		const clone = created.session;
		const promptSpy = vi.spyOn(clone, "prompt");
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(created);

		try {
			await new TanCommandController(harness.ctx).start("check the deploy");
			const run = harness.capturedRun;
			if (!run) throw new Error("run function was not captured");
			await expect(
				run({ jobId: "job-123", signal: new AbortController().signal, reportProgress: async () => {} }),
			).rejects.toThrow(/deployment_status, mcp__deploy_status/);
			expect(promptSpy).not.toHaveBeenCalled();
			expect(harness.materializeDeferredSession).not.toHaveBeenCalled();
		} finally {
			if (!clone.isDisposed) await clone.dispose();
		}
	});

	it("keeps MCP reloads within the inherited capability and mounted presentation", async () => {
		using tempDir = TempDir.createSync("@omp-tan-mcp-");
		const manager = new MCPManager(tempDir.path());
		const mcpTool = (name: string): ReturnType<MCPManager["getTools"]>[number] => ({
			name: `mcp__fixture_${name}`,
			label: name,
			description: name,
			parameters: type({}),
			mcpServerName: "fixture",
			mcpToolName: name,
			execute: async () => ({
				content: [{ type: "text", text: name }],
				details: { serverName: "fixture", mcpToolName: name },
			}),
		});
		const inherited = mcpTool("status");
		const ungranted = mcpTool("reset");
		const discoveredLater = mcpTool("remove");
		let sourceTools = [inherited, ungranted];
		vi.spyOn(manager, "getTools").mockImplementation(() => sourceTools);
		let toolsChanged: (() => void) | undefined;
		const subscribe = manager.addToolsChangedListener.bind(manager);
		vi.spyOn(manager, "addToolsChangedListener").mockImplementation(listener => {
			toolsChanged = listener;
			return subscribe(listener);
		});
		const toolNames = ["read", "write", "bash", inherited.name];
		const harness = createContext({
			mcpManager: manager,
			enabledToolNames: toolNames,
			mountedXdevToolNames: [inherited.name],
		});
		using _parentDir = harness.tempDir;
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		let created: CreateAgentSessionResult | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			created = await createHeadlessClone(tempDir.path(), options?.toolNames ?? [], {
				mcpTools: options?.mcpTools,
				mountedToolNames: options?.mountedToolNames,
				settings: Settings.isolated({ "tools.xdev": true, "marketplace.autoUpdate": "off" }),
			});
			const clone = created.session;
			const refreshed = Promise.withResolvers<void>();
			const refresh = clone.refreshMCPTools.bind(clone);
			vi.spyOn(clone, "refreshMCPTools").mockImplementation(tools => {
				const pending = refresh(tools);
				pending.then(refreshed.resolve, refreshed.reject);
				return pending;
			});
			vi.spyOn(clone, "prompt").mockImplementation(async () => {
				expect(clone.getAllToolNames()).not.toContain(ungranted.name);
				sourceTools = [inherited, ungranted, discoveredLater];
				if (!toolsChanged) throw new Error("MCP tools-change listener was not registered");
				toolsChanged();
				await refreshed.promise;
				expect(clone.getEnabledToolNames()).toEqual(toolNames);
				expect(clone.getMountedXdevToolNames()).toEqual([inherited.name]);
				expect(clone.getAllToolNames()).not.toContain(ungranted.name);
				expect(clone.getAllToolNames()).not.toContain(discoveredLater.name);
				return true;
			});
			vi.spyOn(clone, "getLastAssistantMessage").mockReturnValue(assistantText("done"));
			return created;
		});

		try {
			await new TanCommandController(harness.ctx).start("check the deploy");
			const run = harness.capturedRun;
			if (!run) throw new Error("run function was not captured");
			expect(
				await run({ jobId: "job-123", signal: new AbortController().signal, reportProgress: async () => {} }),
			).toBe("done");
		} finally {
			if (created && !created.session.isDisposed) await created.session.dispose();
			await manager.disconnectAll();
		}
	});

	it("restores the request when compaction summarizes an already-dispatched turn", async () => {
		const harness = createContext();
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const compacted = Promise.withResolvers<void>();
		const stub = createCloneStub({
			prompt: async () => {
				// The request has been dispatched (agent_start), then the summarizer
				// erases both the fork notice and the request from history, so the
				// controller must append both again in order.
				stub.compactionListener?.({ type: "agent_start" });
				stub.compactionListener?.({ type: "auto_compaction_end", result: {}, aborted: false });
				compacted.resolve();
			},
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: stub.clone,
		} as unknown as CreateAgentSessionResult);
		const controller = new TanCommandController(harness.ctx);

		await controller.start("follow the tangent");
		const run = harness.capturedRun;
		if (!run) throw new Error("run function was not captured");
		await run({ jobId: "job-123", signal: new AbortController().signal, reportProgress: async () => {} });
		await compacted.promise;

		// Inherited parent todos are wiped both in-memory and in the persisted
		// session so reloads agree; otherwise todo reminders drag the tan back
		// onto the parent's task.
		expect(stub.clone.setTodoPhases).toHaveBeenCalledWith([]);
		expect(harness.cloneManager.appendCustomEntry).toHaveBeenCalledWith("user_todo_edit", { phases: [] });
		// Initial dispatch places the fork notice before prompt(); after a
		// post-dispatch compaction, the listener restores both messages in order
		// so the notice's "request below" contract holds.
		expect(stub.appendMessage.mock.calls.map(([message]) => message.role)).toEqual([
			"developer",
			"developer",
			"user",
		]);
		expect(stub.appendMessage.mock.calls[2]?.[0]).toEqual(
			expect.objectContaining({
				role: "user",
				content: [{ type: "text", text: "follow the tangent" }],
				attribution: "user",
			}),
		);
		// The compaction listener is released once the tan finishes.
		expect(stub.compactionListener).toBeUndefined();
	});

	it("does not duplicate the request when compaction runs before the initial dispatch", async () => {
		const harness = createContext();
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const compacted = Promise.withResolvers<void>();
		const stub = createCloneStub({
			prompt: async () => {
				// Pre-prompt compaction on the inherited context fires before the
				// pending request is dispatched (no agent_start yet). The dispatch
				// appends the request itself, so the listener must restore only the
				// notice here — appending the request would send it twice.
				stub.compactionListener?.({ type: "auto_compaction_end", result: {}, aborted: false });
				compacted.resolve();
			},
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: stub.clone,
		} as unknown as CreateAgentSessionResult);
		const controller = new TanCommandController(harness.ctx);

		await controller.start("follow the tangent");
		const run = harness.capturedRun;
		if (!run) throw new Error("run function was not captured");
		await run({ jobId: "job-123", signal: new AbortController().signal, reportProgress: async () => {} });
		await compacted.promise;

		// Only the two fork notices are re-appended (dispatch + pre-prompt
		// restore); the request is left for the real dispatch, never duplicated.
		expect(stub.appendMessage.mock.calls.map(([message]) => message.role)).toEqual(["developer", "developer"]);
	});

	it("does not re-append the request when compaction keeps it in context", async () => {
		const harness = createContext();
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const compacted = Promise.withResolvers<void>();
		const stub = createCloneStub({
			prompt: async () => {
				// Model the real dispatch appending the request, then a post-dispatch
				// compaction that keeps the recent turn: the request survives in the
				// rebuilt context, so the listener must not append it a second time.
				stub.compactionListener?.({ type: "agent_start" });
				stub.clone.agent.appendMessage({
					role: "user",
					content: [{ type: "text", text: "follow the tangent" }],
					attribution: "user",
					timestamp: Date.now(),
				});
				stub.compactionListener?.({ type: "auto_compaction_end", result: {}, aborted: false });
				compacted.resolve();
			},
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: stub.clone,
		} as unknown as CreateAgentSessionResult);
		const controller = new TanCommandController(harness.ctx);

		await controller.start("follow the tangent");
		const run = harness.capturedRun;
		if (!run) throw new Error("run function was not captured");
		await run({ jobId: "job-123", signal: new AbortController().signal, reportProgress: async () => {} });
		await compacted.promise;

		// Only the initial-dispatch fork notice and the dispatched request are
		// appended; the retained request is left in place, not duplicated.
		expect(stub.appendMessage.mock.calls.map(([message]) => message.role)).toEqual(["developer", "user"]);
		const requestCount = stub.messages.filter(
			message =>
				message.role === "user" &&
				Array.isArray(message.content) &&
				message.content.some(part => part.type === "text" && part.text === "follow the tangent"),
		).length;
		expect(requestCount).toBe(1);
	});
});
