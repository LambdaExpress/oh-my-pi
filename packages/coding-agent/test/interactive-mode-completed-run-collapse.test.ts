import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
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

	it("keeps repeated Alt+O toggles non-destructive while a later run is streaming", () => {
		const initial = { role: "user", content: "build it", timestamp: 1 } as const;
		const final = assistant([{ type: "text", text: "done" }], "stop", 2);
		mode.recordCompletedRunCollapse({
			firstMessage: initial,
			initialUserMessage: initial,
			finalAssistantMessage: final,
			durationMs: 1_000,
		});
		const agentState = session.agent.state as { isStreaming: boolean };
		agentState.isStreaming = true;
		const rebuild = vi.spyOn(mode, "rebuildChatFromMessages").mockImplementation(() => {});
		const refreshDisplay = vi.spyOn(mode.ui, "refreshDisplay").mockImplementation(() => {});
		const resetDisplay = vi.spyOn(mode.ui, "resetDisplay").mockImplementation(() => {});

		mode.toggleCompletedRunCollapse();
		mode.toggleCompletedRunCollapse();

		expect(rebuild).toHaveBeenCalledTimes(2);
		expect(refreshDisplay).toHaveBeenCalledTimes(2);
		expect(refreshDisplay).toHaveBeenNthCalledWith(1, "completed-run-toggle-during-stream");
		expect(resetDisplay).not.toHaveBeenCalled();

		agentState.isStreaming = false;
		mode.toggleCompletedRunCollapse();

		expect(rebuild).toHaveBeenCalledTimes(3);
		expect(refreshDisplay).toHaveBeenCalledTimes(2);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("collapses a just-finished run when Alt+O is pressed before the next submission", () => {
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
		const context = {
			messages: [initial, loop, result, final] as AgentMessage[],
			models: {},
			injectedTtsrRules: [],
			mode: "none",
		};
		const commit = vi.spyOn(mode.eventController, "commitCompletedRunCollapses").mockImplementation(() => {
			mode.recordCompletedRunCollapse({
				firstMessage: initial,
				initialUserMessage: initial,
				finalAssistantMessage: final,
				durationMs: 65_000,
			});
			return true;
		});
		const rebuild = vi.spyOn(mode, "rebuildChatFromMessages").mockImplementation(() => {});
		const resetDisplay = vi.spyOn(mode.ui, "resetDisplay").mockImplementation(() => {});

		mode.toggleCompletedRunCollapse();
		mode.chatContainer.clear();
		mode.renderSessionContext(context);
		const rendered = Bun.stripANSI(mode.chatContainer.render(120).join("\n"));

		expect(commit).toHaveBeenCalledTimes(1);
		expect(rendered).toContain("※ collapsed: 1 agent text segment · 1 tool call · 1m5s elapsed");
		expect(rendered).not.toContain("working through the request");
		expect(rendered).toContain("done");
		expect(rebuild).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("automatically collapses the latest completed run when a session is resumed", () => {
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
		} as ToolResultMessage;
		const final = assistant([{ type: "text", text: "done" }], "stop", 4);
		session.sessionManager.appendMessage(initial);
		session.sessionManager.appendMessage(loop);
		session.sessionManager.appendMessage(result);
		session.sessionManager.appendMessage(final);

		// There is no in-memory collapse record, matching a freshly resumed TUI.
		const resetDisplay = vi.spyOn(mode.ui, "resetDisplay").mockImplementation(() => {});
		mode.renderInitialMessages({ recoverCompletedRuns: true });

		let rendered = Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
		expect(rendered).toContain("※ collapsed: 1 agent text segment · 1 tool call");
		expect(rendered).not.toContain("working through the request");
		expect(rendered).toContain("done");

		// The recovered record must also power Alt+O; before the fix the resumed
		// view had no record, so the key was a no-op in both directions.
		mode.toggleCompletedRunCollapse();
		mode.chatContainer.clear();
		mode.renderSessionContext(session.buildTranscriptSessionContext({ collapseCompactedHistory: false }));
		rendered = Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
		expect(rendered).toContain("working through the request");
		expect(rendered).not.toContain("※ collapsed:");

		mode.toggleCompletedRunCollapse();
		mode.chatContainer.clear();
		mode.renderSessionContext(session.buildTranscriptSessionContext({ collapseCompactedHistory: false }));
		rendered = Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
		expect(rendered).toContain("※ collapsed: 1 agent text segment · 1 tool call");
		expect(resetDisplay).toHaveBeenCalledTimes(2);
	});

	it("recovers and toggles a completed run after a persisted upstream stream interruption", () => {
		const initial = { role: "user", content: "original request", timestamp: 1 } as const;
		const loop = assistant(
			[
				{ type: "text", text: "work before upstream disconnect" },
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
		} as ToolResultMessage;
		const interrupted = assistant([], "error", 4);
		interrupted.errorMessage = "stream_interrupted: Upstream stream interrupted after output began.";
		interrupted.errorId = 0;
		interrupted.stopDetails = {
			type: "stream_interrupted_after_content",
			category: null,
			explanation: interrupted.errorMessage,
		};
		const continuation = { role: "user", content: "continue", timestamp: 5 } as const;
		const final = assistant([{ type: "text", text: "done after continuation" }], "stop", 6);
		session.sessionManager.appendMessage(initial);
		session.sessionManager.appendMessage(loop);
		session.sessionManager.appendMessage(result);
		session.sessionManager.appendMessage(interrupted);
		session.sessionManager.appendMessage(continuation);
		session.sessionManager.appendMessage(final);

		mode.renderInitialMessages({ recoverCompletedRuns: true });

		let rendered = Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
		expect(rendered).toContain("original request");
		expect(rendered).toContain("done after continuation");
		expect(rendered).toContain("※ collapsed: 1 agent text segment · 1 tool call");
		expect(rendered).not.toContain("work before upstream disconnect");
		expect(rendered).not.toContain("continue");

		mode.toggleCompletedRunCollapse();
		rendered = Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
		expect(rendered).toContain("work before upstream disconnect");
		expect(rendered).toContain("continue");
		expect(rendered).toContain("Upstream stream interrupted after output began");
		expect(rendered).not.toContain("※ collapsed:");

		mode.toggleCompletedRunCollapse();
		rendered = Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
		expect(rendered).toContain("※ collapsed: 1 agent text segment · 1 tool call");
		expect(rendered).not.toContain("work before upstream disconnect");
	});

	it("recovers a manually interrupted tool run with its later completed correction", () => {
		const initialA = { role: "user", content: "open the pull request", timestamp: 1 } as const;
		const progressA = assistant(
			[
				{ type: "text", text: "merging the pull request" },
				{ type: "toolCall", id: "tc", name: "pwsh", arguments: {} },
			],
			"toolUse",
			2,
		);
		const resultA = {
			role: "toolResult",
			toolCallId: "tc",
			toolName: "pwsh",
			content: [{ type: "text", text: "merged" }],
			timestamp: 3,
		} as ToolResultMessage;
		const interruptedA = assistant([], "aborted", 4);
		interruptedA.errorMessage = USER_INTERRUPT_LABEL;
		const initialB = { role: "user", content: "I said open it, not merge it", timestamp: 5 } as const;
		const finalB = assistant([{ type: "text", text: "I will repair it" }], "stop", 6);
		for (const message of [initialA, progressA, resultA, interruptedA, initialB, finalB]) {
			session.sessionManager.appendMessage(message);
		}

		mode.renderInitialMessages({ recoverCompletedRuns: true });

		let rendered = Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
		expect(rendered.match(/※ collapsed:/g)).toHaveLength(1);
		expect(rendered).toContain("open the pull request");
		expect(rendered).toContain("I will repair it");
		expect(rendered).not.toContain("merging the pull request");
		expect(rendered).not.toContain("I said open it, not merge it");

		mode.toggleCompletedRunCollapse();
		rendered = Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
		expect(rendered).toContain("merging the pull request");
		expect(rendered).toContain("I said open it, not merge it");
		expect(rendered).not.toContain("※ collapsed:");
	});

	it("rebuilds from full persisted history after compaction while completed-run collapse is enabled", () => {
		Settings.instance.set("display.collapseCompacted", true);
		const buildTranscriptSessionContext = vi.spyOn(session, "buildTranscriptSessionContext");

		mode.rebuildChatFromMessages();

		expect(buildTranscriptSessionContext.mock.calls[0]?.[0]).toEqual({ collapseCompactedHistory: false });
	});

	it("keeps a pre-compaction completed run visible and expandable", () => {
		Settings.instance.set("display.collapseCompacted", true);
		const initial = { role: "user", content: "old request before compaction", timestamp: 1 } as const;
		const loop = assistant([{ type: "text", text: "old intermediate work" }], "toolUse", 2);
		const final = assistant([{ type: "text", text: "old final answer" }], "stop", 3);
		const next = { role: "user", content: "new request after compaction", timestamp: 4 } as const;
		session.sessionManager.appendMessage(initial);
		session.sessionManager.appendMessage(loop);
		session.sessionManager.appendMessage(final);
		const firstKeptEntryId = session.sessionManager.appendMessage(next);
		session.sessionManager.appendCompaction("provider summary", undefined, firstKeptEntryId, 100);

		const compactedTail = session.buildTranscriptSessionContext({ collapseCompactedHistory: true });
		expect(compactedTail.messages).not.toContain(initial);
		mode.renderInitialMessages({ recoverCompletedRuns: true });

		let rendered = Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
		expect(rendered).toContain("old request before compaction");
		expect(rendered).toContain("old final answer");
		expect(rendered).toContain("※ collapsed: 1 agent text segment");
		expect(rendered).not.toContain("old intermediate work");

		mode.toggleCompletedRunCollapse();
		rendered = Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
		expect(rendered).toContain("old intermediate work");
		expect(rendered).not.toContain("※ collapsed:");
	});

	it("shows a completed-run summary when compaction rebuilds during a queued follow-up", () => {
		Settings.instance.set("display.collapseCompacted", true);
		const initial = { role: "user", content: "original request", timestamp: 1 } as const;
		const loop = assistant(
			[
				{ type: "text", text: "old intermediate work" },
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
		} as ToolResultMessage;
		const final = assistant([{ type: "text", text: "first answer" }], "stop", 4);
		const followUp = { role: "user", content: "queued follow-up", timestamp: 5 } as const;
		for (const message of [initial, loop, result, final, followUp]) {
			session.sessionManager.appendMessage(message);
		}

		// Ctrl+Up follow-ups run inside the existing agent lifecycle. Until that
		// lifecycle settles, the live zero-row gate still belongs to the original
		// request even though persisted history already contains a completed answer.
		mode.eventController.restoreCompletedRunAnchor([initial, loop, result]);

		// Auto-compaction rebuilds from persisted history. That recovery projects
		// the first answer as collapsed while the live gate still shares its anchor.
		mode.rebuildChatFromMessages();
		const lines = mode.chatContainer.render(120).map(line => Bun.stripANSI(line));
		const summaryIndex = lines.findIndex(line => line.includes("※ collapsed: 1 agent text segment · 1 tool call"));

		expect(summaryIndex).toBeGreaterThanOrEqual(0);
		expect(lines.join("\n")).not.toContain("old intermediate work");
		expect(lines.join("\n")).toContain("first answer");
		expect(lines.join("\n")).toContain("queued follow-up");
		// The summary is stable, but the gate must still keep the running follow-up
		// and everything below it in the repaintable transcript suffix.
		expect(mode.chatContainer.getNativeScrollbackLiveRegionStart()).toBe(summaryIndex + 1);
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
		const messages = [initialA, loopA, resultA, abortedA, initialB, loopB, resultB, finalB] as AgentMessage[];
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

	it("end-to-end: an Enter force-flush parks run A and commits A and B separately when the user sends the next content", async () => {
		const mock = createMockModel({
			responses: [
				// Run A: long-running, interrupted by the force-flush abort.
				{ content: [{ type: "text", text: "working through the request" }], delayMs: 500 },
				// Run B: the force-flushed continuation, settles normally.
				{ content: [{ type: "text", text: "adjusted" }] },
				// Run C: the next user turn, whose start commits A and B.
				{ content: [{ type: "text", text: "third answer" }] },
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
		const recordCompletedRunCollapse = e2eMode.recordCompletedRunCollapse.bind(e2eMode);
		const collapsesCommitted = Promise.withResolvers<void>();
		let recordedCollapseCount = 0;
		const record = vi.spyOn(e2eMode, "recordCompletedRunCollapse").mockImplementation(collapse => {
			const changed = recordCompletedRunCollapse(collapse);
			recordedCollapseCount++;
			if (recordedCollapseCount === 2) collapsesCommitted.resolve();
			return changed;
		});
		vi.spyOn(e2eMode, "rebuildChatFromMessages").mockImplementation(() => {});
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

		// Wait for the continuation to settle and park A and B's collapse
		// records. Integration test against the real agent loop: deterministic
		// fake timers cannot drive the abort/drain/continue chain, so a bounded
		// real-time guard stands in for the parked-chain signal if the fix
		// regresses.
		const settled = Promise.withResolvers<void>();
		const agentEnds: number[] = [];
		e2eSession.subscribe(event => {
			if (event.type === "agent_end") {
				agentEnds.push(agentEnds.length);
				if (agentEnds.length === 2) settled.resolve();
			}
		});
		await Promise.race([settled.promise, Bun.sleep(10_000)]);
		await firstPrompt.catch(() => {});

		// B's settle parks both runs but leaves them fully expanded: nothing has
		// been recorded or rebuilt yet.
		expect(record).not.toHaveBeenCalled();

		// Sending the next content commits both parked runs: A parked, B natural.
		const thirdPrompt = e2eSession.prompt("third request", { expandPromptTemplates: false });
		// AgentSession emits listeners fire-and-forget; wait for EventController's
		// serialized dispatch chain to observe the new turn and commit both parked
		// records instead of treating an unrelated transcript rebuild as completion.
		await collapsesCommitted.promise;
		expect(record).toHaveBeenCalledTimes(2);
		const [aCollapse, bCollapse] = record.mock.calls.map(call => call[0] as CompletedRunCollapse);
		expect(aCollapse.finalAssistantMessage).toBeUndefined();
		expect(aCollapse.spanEndMessage).toBeDefined();
		expect(bCollapse.finalAssistantMessage?.stopReason).toBe("stop");
		await thirdPrompt;
		expect(mock.calls.length).toBe(3);

		await e2eMode.stop();
		await e2eSession.dispose();
	});

	it("end-to-end: a later successful continuation collapses from the request that was manually interrupted", async () => {
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "text", text: "partial work that must disappear" }], delayMs: 500 },
				{ content: [{ type: "text", text: "done after resume" }] },
				{ content: [{ type: "text", text: "unrelated answer" }] },
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
		e2eMode.eventController.subscribeToAgent();
		const firstStart = Promise.withResolvers<void>();
		e2eSession.subscribe(event => {
			if (event.type === "agent_start") firstStart.resolve();
		});

		const firstPrompt = e2eSession.prompt("original request", { expandPromptTemplates: false });
		await firstStart.promise;
		await e2eSession.abort({ reason: USER_INTERRUPT_LABEL });
		await firstPrompt.catch(() => {});
		await e2eSession.prompt("continue and finish", { expandPromptTemplates: false });
		await e2eSession.prompt("next request", { expandPromptTemplates: false });

		e2eMode.chatContainer.clear();
		e2eMode.renderSessionContext(e2eSession.buildTranscriptSessionContext({ collapseCompactedHistory: false }));
		const rendered = Bun.stripANSI(e2eMode.chatContainer.render(120).join("\n"));
		expect(rendered).toContain("original request");
		expect(rendered).toContain("done after resume");
		expect(rendered).not.toContain("continue and finish");
		expect(rendered).not.toContain("partial work that must disappear");
		expect(rendered).toContain("next request");
		expect(rendered).toContain("unrelated answer");

		await e2eMode.stop();
		await e2eSession.dispose();
	});
});
