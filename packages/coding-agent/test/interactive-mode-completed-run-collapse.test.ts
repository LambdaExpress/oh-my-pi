import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

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
});
