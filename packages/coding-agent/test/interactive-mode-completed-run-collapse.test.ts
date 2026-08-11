import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { CompletedRunCollapse } from "@oh-my-pi/pi-coding-agent/modes/utils/transcript-render-helpers";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { setLocale } from "../src/i18n";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	timestamp: number,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage,
		stopReason,
		timestamp,
	};
}

describe("InteractiveMode completed-run collapse", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		setLocale("en");
		tempDir = TempDir.createSync("@pi-completed-run-collapse-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "display.collapseCompletedRuns": true }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setLocale(null);
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("toggles every recorded run from summary to full history and back", () => {
		const initial = { role: "user", content: "build it", timestamp: 1 } as const;
		const loop = assistant(
			[
				{ type: "text", text: "working through the request" },
				{ type: "toolCall", id: "tc", name: "read", arguments: {} },
			],
			"toolUse",
			2,
		);
		const result = {
			role: "toolResult",
			toolCallId: "tc",
			toolName: "read",
			content: [{ type: "text", text: "tool data" }],
			timestamp: 3,
		} as AgentMessage;
		const final = assistant([{ type: "text", text: "done" }], "stop", 4);
		const messages = [initial, loop, result, final] as AgentMessage[];
		const context = {
			messages,
			models: {},
			injectedTtsrRules: [],
			mode: "none",
		};
		mode.recordCompletedRunCollapse({
			firstMessage: initial,
			initialUserMessage: initial,
			finalAssistantMessage: final,
			durationMs: 65_000,
		});
		const rebuild = vi.spyOn(mode, "rebuildChatFromMessages").mockImplementation(() => {});
		const resetDisplay = vi.spyOn(mode.ui, "resetDisplay").mockImplementation(() => {});

		mode.chatContainer.clear();
		mode.renderSessionContext(context);
		let rendered = Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
		expect(rendered).toContain("※ collapsed: 1 agent text segment · 1 tool call · 1m5s elapsed · Alt+O to expand");
		expect(rendered).not.toContain("working through the request");
		expect(rendered).toContain("done");

		mode.toggleCompletedRunCollapse();
		mode.chatContainer.clear();
		mode.renderSessionContext(context);
		rendered = Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
		expect(rendered).toContain("working through the request");
		expect(rendered).not.toContain("※ collapsed:");

		mode.toggleCompletedRunCollapse();
		mode.chatContainer.clear();
		mode.renderSessionContext(context);
		rendered = Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
		expect(rendered).toContain("※ collapsed: 1 agent text segment · 1 tool call · 1m5s elapsed · Alt+O to expand");
		expect(rendered).not.toContain("working through the request");
		expect(rebuild).toHaveBeenCalledTimes(2);
		expect(resetDisplay).toHaveBeenCalledTimes(2);
		expect(messages).toHaveLength(4);
	});

	it("toggles a force-flushed interrupted run and its continuation together", () => {
		const initialA = { role: "user", content: "build it", timestamp: 1 } as const;
		const loopA = assistant(
			[
				{ type: "text", text: "working through the request" },
				{ type: "toolCall", id: "tc-a", name: "read", arguments: {} },
			],
			"toolUse",
			2,
		);
		const resultA = {
			role: "toolResult",
			toolCallId: "tc-a",
			toolName: "read",
			content: [{ type: "text", text: "tool data" }],
			timestamp: 3,
		} as AgentMessage;
		const abortedA = assistant([], "aborted", 4);
		abortedA.errorMessage = "Interrupted by user";
		const initialB = { role: "user", content: "force-flushed follow-up", steering: true, timestamp: 5 } as const;
		const loopB = assistant(
			[
				{ type: "text", text: "editing the tests" },
				{ type: "toolCall", id: "tc-b", name: "edit", arguments: {} },
			],
			"toolUse",
			6,
		);
		const resultB = {
			role: "toolResult",
			toolCallId: "tc-b",
			toolName: "edit",
			content: [{ type: "text", text: "edited" }],
			timestamp: 7,
		} as AgentMessage;
		const finalB = assistant([{ type: "text", text: "done" }], "stop", 8);
		const messages = [
			initialA,
			loopA,
			resultA,
			abortedA,
			initialB,
			loopB,
			resultB,
			finalB,
		] as AgentMessage[];
		const context = {
			messages,
			models: {},
			injectedTtsrRules: [],
			mode: "none",
		};
		mode.recordCompletedRunCollapse({
			firstMessage: initialA,
			initialUserMessage: initialA,
			spanEndMessage: abortedA,
			durationMs: 60_000,
		});
		mode.recordCompletedRunCollapse({
			firstMessage: initialB,
			initialUserMessage: initialB,
			finalAssistantMessage: finalB,
			durationMs: 120_000,
		});
		const rebuild = vi.spyOn(mode, "rebuildChatFromMessages").mockImplementation(() => {});
		const resetDisplay = vi.spyOn(mode.ui, "resetDisplay").mockImplementation(() => {});

		mode.chatContainer.clear();
		mode.renderSessionContext(context);
		let rendered = Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
		// Both runs collapsed: two independent summaries, intermediate content hidden.
		expect(rendered).toContain("※ collapsed: 1 agent text segment · 1 tool call · 1m elapsed · Alt+O to expand");
		expect(rendered).toContain("※ collapsed: 1 agent text segment · 1 tool call · 2m elapsed · Alt+O to expand");
		expect(rendered).not.toContain("working through the request");
		expect(rendered).not.toContain("editing the tests");
		expect(rendered).toContain("done");

		// Alt+O expands both records at once.
		mode.toggleCompletedRunCollapse();
		mode.chatContainer.clear();
		mode.renderSessionContext(context);
		rendered = Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
		expect(rendered).toContain("working through the request");
		expect(rendered).toContain("editing the tests");
		expect(rendered).not.toContain("※ collapsed:");

		// Alt+O again restores both summaries.
		mode.toggleCompletedRunCollapse();
		mode.chatContainer.clear();
		mode.renderSessionContext(context);
		rendered = Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
		expect(rendered).toContain("※ collapsed: 1 agent text segment · 1 tool call · 1m elapsed · Alt+O to expand");
		expect(rendered).toContain("※ collapsed: 1 agent text segment · 1 tool call · 2m elapsed · Alt+O to expand");
		expect(rendered).not.toContain("working through the request");
		expect(rebuild).toHaveBeenCalledTimes(2);
		expect(resetDisplay).toHaveBeenCalledTimes(2);
		expect(messages).toHaveLength(8);
	});

	it("end-to-end: an Enter force-flush parks run A and commits A and B separately after B settles", async () => {
		const mock = createMockModel({
			responses: [
				// Run A: long-running, interrupted by the force-flush abort.
				{ content: [{ type: "text", text: "working through the request" }], delayMs: 500 },
				// Run B: the force-flushed continuation, settles normally.
				{ content: [{ type: "text", text: "adjusted" }] },
			],
		});
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const e2eSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "display.collapseCompletedRuns": true }),
			modelRegistry,
		});
		const e2eMode = new InteractiveMode(e2eSession, "test");
		// InteractiveMode only subscribes the event controller in `init()` (the
		// interactive startup path); the test harness drives the session directly,
		// so wire the controller up manually.
		e2eMode.eventController.subscribeToAgent();
		const record = vi.spyOn(e2eMode, "recordCompletedRunCollapse");
		const rebuilt = Promise.withResolvers<void>();
		vi.spyOn(e2eMode, "rebuildChatFromMessages").mockImplementation(() => {
			rebuilt.resolve();
		});
		const secondAgentStart = Promise.withResolvers<void>();
		const agentStarts: number[] = [];
		e2eSession.subscribe(event => {
			if (event.type === "agent_start") {
				agentStarts.push(agentStarts.length);
				secondAgentStart.resolve();
			}
		});

		// Send the first message: run A starts streaming (the mock delays).
		const firstPrompt = e2eSession.prompt("first request", { expandPromptTemplates: false });
		// While A streams, the second message is queued, then force-flushed with
		// an empty Enter: this is the exact input-controller flush path.
		await secondAgentStart.promise;
		await e2eSession.prompt("second request", {
			streamingBehavior: "steer",
			expandPromptTemplates: false,
		});
		await e2eSession.abort({ reason: USER_INTERRUPT_LABEL, forceFlush: true });

		// Wait for the continuation to settle and the atomic commit to land.
		// Integration test against the real agent loop: deterministic fake timers
		// cannot drive the abort/drain/continue chain, so a bounded real-time
		// guard stands in for the rebuilt signal if the fix regresses.
		await Promise.race([rebuilt.promise, Bun.sleep(10_000)]);
		await firstPrompt.catch(() => {});

		// Both runs collapse with their own summaries, A parked and B natural.
		expect(record).toHaveBeenCalledTimes(2);
		const [aCollapse, bCollapse] = record.mock.calls.map(call => call[0] as CompletedRunCollapse);
		expect(aCollapse.finalAssistantMessage).toBeUndefined();
		expect(aCollapse.spanEndMessage).toBeDefined();
		expect(bCollapse.finalAssistantMessage?.stopReason).toBe("stop");
		expect(mock.calls.length).toBe(2);

		await e2eMode.stop();
		await e2eSession.dispose();
	});
});
