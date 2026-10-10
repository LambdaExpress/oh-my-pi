/**
 * The subagent usage gauge divides context tokens by the window of the model
 * the run is attributed to. A retry fallback moves attribution to a model with
 * a different window, and the executor's progress record has to move with it —
 * the Agent Hub renders `progress.contextWindow` (`agent-hub-projection.ts`
 * `progressMetrics`), so a stale value shows the wrong percentage for the rest
 * of the run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";

function modelRegistration(
	provider: string,
	id: string,
	contextWindow: number,
): { provider: string; id: string; config: ProviderConfigInput } {
	return {
		provider,
		id,
		config: {
			api: "openai-completions",
			baseUrl: `https://${provider}.example.test`,
			apiKey: "test-key",
			models: [
				{
					id,
					name: id,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow,
					maxTokens: 8192,
				},
			],
		},
	};
}

describe("subagent context window after a model swap", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-fallback-window-");
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose();
		authStorage.close();
		tempDir[Symbol.dispose]();
	});

	it("follows the serving model's window", async () => {
		const primary = modelRegistration("context-primary", "primary", 256_000);
		const fallback = modelRegistration("context-fallback", "fallback", 500_000);
		const primarySelector = `${primary.provider}/${primary.id}`;
		const fallbackSelector = `${fallback.provider}/${fallback.id}`;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": true,
			"retry.modelFallback": true,
			"retry.maxRetries": 1,
			"retry.fallbackRevertPolicy": "never",
			"retry.usageAwareFallback": false,
		});
		settings.setModelRole("default", primarySelector);
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings });
		for (const candidate of [primary, fallback]) {
			modelRegistry.registerProvider(candidate.provider, candidate.config);
		}
		const mock = createMockModel({
			responses: [
				{ content: ["primary completed earlier work"] },
				{ throw: "overloaded_error: provider returned error 503" },
				{
					content: [
						{ type: "toolCall", name: "yield", arguments: { data: { answer: "answered after the swap" } } },
					],
				},
			],
		});
		const snapshots: AgentProgress[] = [];
		const requestedModels: string[] = [];
		const createAgentSession = sdkModule.createAgentSession;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			const result = await createAgentSession({
				...options,
				agentDir: tempDir.path(),
				disableExtensionDiscovery: true,
				preloadedExtensionPaths: [],
				preloadedCustomToolPaths: [],
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				skipPythonPreflight: true,
			});
			sessions.push(result.session);
			result.session.agent.streamFn = (candidate, context, streamOptions) => {
				requestedModels.push(`${candidate.provider}/${candidate.id}`);
				return mock.stream(candidate, context, streamOptions);
			};
			// A served primary must keep owning the gauge while the fallback is
			// merely routed; the real recovery state moves it when output settles.
			await result.session.prompt("establish primary attribution");
			await result.session.waitForIdle();
			return result;
		});

		const result = await runSubprocess({
			cwd: tempDir.path(),
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled", tools: ["yield"] },
			task: "work",
			index: 0,
			id: "context-window-swap",
			modelOverride: [primarySelector, fallbackSelector],
			settings,
			modelRegistry,
			restrictToolNames: true,
			enableLsp: false,
			enableIrc: false,
			enableMCP: false,
			onProgress: progress => {
				snapshots.push({ ...progress });
			},
		});

		expect(result.exitCode, result.stderr).toBe(0);
		expect(requestedModels).toEqual([primarySelector, primarySelector, fallbackSelector]);
		expect(result.resolvedModelIdentity).toBe(fallbackSelector);
		expect(result.contextWindow).toBe(500_000);
		expect(snapshots.find(snapshot => snapshot.resolvedModelIdentity === primarySelector)?.contextWindow).toBe(
			256_000,
		);
		// The hub polls streamed progress, not just the settled result.
		expect(snapshots.findLast(snapshot => snapshot.resolvedModelIdentity === fallbackSelector)?.contextWindow).toBe(
			500_000,
		);
	});
});
