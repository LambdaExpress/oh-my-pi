import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { PythonResult } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { BashResult } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Text } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

type Harness = {
	mode: InteractiveMode;
	tempDir: TempDir;
	setStreaming: (value: boolean) => void;
};

let harness: Harness | undefined;

async function createHarness(): Promise<Harness> {
	if (harness) {
		harness.setStreaming(false);
		harness.mode.clearTransientSessionUi();
		harness.mode.chatContainer.disposeChildren();
		return harness;
	}

	const tempDir = TempDir.createSync("@pi-deferred-notice-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	await initTheme(false);
	const sessionManager = SessionManager.inMemory(tempDir.path());
	await sessionManager.setSessionName("Deferred notice", "user");
	let streaming = false;
	const session = {
		sessionManager,
		settings,
		agent: { state: { tools: [] }, metadataForProvider: () => undefined },
		customCommands: [],
		skills: [],
		autoCompactionEnabled: true,
		messages: [],
		systemPrompt: [],
		state: { model: undefined },
		model: undefined,
		thinkingLevel: undefined,
		getAsyncJobSnapshot: () => ({
			running: [],
			recent: [],
			delivery: { queued: 0, delivering: false, pendingJobIds: [] },
		}),
		get isStreaming() {
			return streaming;
		},
		executeBash: vi.fn(),
		executePython: vi.fn(),
	} as unknown as AgentSession;
	const mode = new InteractiveMode(session, "test");
	harness = {
		mode,
		tempDir,
		setStreaming: (value: boolean) => {
			streaming = value;
		},
	};
	return harness;
}

function noticeText(mode: InteractiveMode): string {
	return mode.deferredCommandContainer.render(120).join("\n");
}

function transcriptRowCount(mode: InteractiveMode): number {
	return mode.chatContainer.render(120).length;
}

function transcriptText(mode: InteractiveMode): string {
	return mode.chatContainer.render(120).join("\n");
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	harness?.mode.stop();
	harness?.tempDir.removeSync();
	harness = undefined;
	resetSettingsForTest();
});

describe("InteractiveMode deferred command preview", () => {
	it("shows the panel immediately mid-turn without touching the transcript", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		const transcriptBefore = transcriptRowCount(mode);

		mode.presentCommandOutput(new Text("Claude 5 Hour: 62% used", 1, 0));

		// The answer is visible right away, which is the whole point: before this,
		// a command run mid-turn was indistinguishable from a dead one.
		expect(noticeText(mode)).toContain("Claude 5 Hour: 62% used");
		// But never via the transcript: a mid-turn transcript mount re-renders rows
		// below the growing live block and duplicates them in native scrollback
		// (issues #4806/#6767), which is what deferral was introduced to stop.
		expect(transcriptRowCount(mode)).toBe(transcriptBefore);
		expect(transcriptText(mode)).not.toContain("Claude 5 Hour");
	});

	it("counts commands rather than the components each one queues", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);

		// One command commonly queues a spacer plus its panel; that is still one
		// command from the user's point of view.
		mode.presentCommandOutput([new Text("spacer", 1, 0), new Text("usage panel", 1, 0)]);
		expect(noticeText(mode)).toContain("1 command output");

		mode.presentCommandOutput(new Text("advisor panel", 1, 0));
		expect(noticeText(mode)).toContain("2 command outputs");
	});

	it("caps a tall panel so the prompt stays on screen", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		const tall = Array.from({ length: 200 }, (_, i) => `row ${i}`).join("\n");

		mode.presentCommandOutput(new Text(tall, 1, 0));

		const rows = mode.deferredCommandContainer.render(120);
		expect(rows.length).toBeLessThan(60);
		expect(rows.join("\n")).toContain("row 0");
		expect(rows.join("\n")).toContain("more rows");
		// The tail is not silently dropped: it arrives in full at the settle.
		expect(rows.join("\n")).not.toContain("row 199");
	});

	it("clears the preview and mounts the panels once the turn settles", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		mode.presentCommandOutput(new Text("usage panel", 1, 0));
		expect(noticeText(mode)).not.toBe("");

		setStreaming(false);
		mode.flushPendingCommandOutput();

		expect(noticeText(mode)).toBe("");
		expect(transcriptText(mode)).toContain("usage panel");
	});

	it("unpins a completed bash result before later streamed text", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		mode.isInitialized = true;
		settings.override("display.smoothStreaming", false);
		const started = assistantMessage("");
		await mode.eventController.handleEvent({ type: "message_start", message: started });
		const before = assistantMessage("BEFORE_LOCAL_EXECUTION\nPARTIAL_");
		await mode.eventController.handleEvent({
			type: "message_update",
			message: before,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "BEFORE_LOCAL_EXECUTION\nPARTIAL_",
				partial: before,
			},
		});
		const execution = Promise.withResolvers<BashResult>();
		vi.spyOn(mode.session, "executeBash").mockReturnValueOnce(execution.promise);
		const command = mode.handleBashCommand("printf bash-result");
		await Promise.resolve();
		const bash = mode.pendingBashComponents[0]!;
		expect(mode.pendingMessagesContainer.children).toContain(bash);

		execution.resolve({
			output: "bash-result",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 11,
			outputLines: 1,
			outputBytes: 11,
		});
		await command;
		const after = assistantMessage("BEFORE_LOCAL_EXECUTION\nPARTIAL_AFTER_LOCAL_EXECUTION");
		await mode.eventController.handleEvent({
			type: "message_update",
			message: after,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "AFTER_LOCAL_EXECUTION",
				partial: after,
			},
		});

		const transcript = Bun.stripANSI(transcriptText(mode));
		expect(mode.pendingMessagesContainer.children).not.toContain(bash);
		expect(mode.pendingBashComponents).toHaveLength(0);
		expect(transcript.indexOf("BEFORE_LOCAL_EXECUTION")).toBeLessThan(transcript.indexOf("bash-result"));
		expect(transcript.indexOf("bash-result")).toBeLessThan(transcript.indexOf("PARTIAL_AFTER_LOCAL_EXECUTION"));
		expect(transcript.split("\n").map(line => line.trim())).not.toContain("PARTIAL_");

		setStreaming(false);
		await mode.eventController.handleEvent({ type: "message_end", message: after });
	});

	it("unpins a completed Python result before later streamed text", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		mode.isInitialized = true;
		settings.override("display.smoothStreaming", false);
		const started = assistantMessage("");
		await mode.eventController.handleEvent({ type: "message_start", message: started });
		const before = assistantMessage("BEFORE_PYTHON_EXECUTION\n");
		await mode.eventController.handleEvent({
			type: "message_update",
			message: before,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "BEFORE_PYTHON_EXECUTION\n",
				partial: before,
			},
		});
		const execution = Promise.withResolvers<PythonResult>();
		vi.spyOn(mode.session, "executePython").mockReturnValueOnce(execution.promise);
		const command = mode.handlePythonCommand("print('python-result')");
		await Promise.resolve();
		const python = mode.pendingPythonComponents[0]!;
		expect(mode.pendingMessagesContainer.children).toContain(python);

		execution.resolve({
			output: "python-result",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 13,
			outputLines: 1,
			outputBytes: 13,
			displayOutputs: [],
			stdinRequested: false,
		});
		await command;
		const after = assistantMessage("BEFORE_PYTHON_EXECUTION\nAFTER_PYTHON_EXECUTION");
		await mode.eventController.handleEvent({
			type: "message_update",
			message: after,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "AFTER_PYTHON_EXECUTION",
				partial: after,
			},
		});

		const transcript = transcriptText(mode);
		expect(mode.pendingMessagesContainer.children).not.toContain(python);
		expect(mode.pendingPythonComponents).toHaveLength(0);
		expect(transcript.indexOf("BEFORE_PYTHON_EXECUTION")).toBeLessThan(transcript.indexOf("python-result"));
		expect(transcript.indexOf("python-result")).toBeLessThan(transcript.indexOf("AFTER_PYTHON_EXECUTION"));

		setStreaming(false);
		await mode.eventController.handleEvent({ type: "message_end", message: after });
	});

	it("keeps a still-running local command pinned when the agent turn settles", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		mode.isInitialized = true;
		settings.override("display.smoothStreaming", false);
		const message = assistantMessage("TURN_FINISHED\n");
		await mode.eventController.handleEvent({ type: "message_start", message: assistantMessage("") });
		await mode.eventController.handleEvent({
			type: "message_update",
			message,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "TURN_FINISHED\n",
				partial: message,
			},
		});
		const execution = Promise.withResolvers<BashResult>();
		vi.spyOn(mode.session, "executeBash").mockReturnValueOnce(execution.promise);
		const command = mode.handleBashCommand("printf late-result");
		await Promise.resolve();
		const bash = mode.pendingBashComponents[0]!;

		setStreaming(false);
		await mode.eventController.handleEvent({ type: "message_end", message });
		mode.flushPendingCommandOutput();
		expect(mode.pendingMessagesContainer.children).toContain(bash);
		expect(mode.pendingBashComponents).toContain(bash);

		execution.resolve({
			output: "late-result",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 11,
			outputLines: 1,
			outputBytes: 11,
		});
		await command;
		expect(mode.pendingMessagesContainer.children).not.toContain(bash);
		expect(mode.pendingBashComponents).not.toContain(bash);
		expect(transcriptText(mode)).toContain("late-result");
	});

	it("shows no preview when the agent is idle, since output mounts immediately", async () => {
		const { mode } = await createHarness();

		mode.presentCommandOutput(new Text("usage panel", 1, 0));

		expect(noticeText(mode)).toBe("");
		expect(transcriptText(mode)).toContain("usage panel");
	});

	it("drops a stale preview when the session is reset while output is queued", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		mode.presentCommandOutput(new Text("usage panel", 1, 0));
		expect(noticeText(mode)).not.toBe("");

		mode.clearTransientSessionUi();

		expect(noticeText(mode)).toBe("");
	});

	it("starts the queue over after a reset, so a later command previews alone", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		mode.presentCommandOutput(new Text("stale panel", 1, 0));

		// The reset keeps the same session id here, so nothing downstream can
		// recognise the leftover queue as stale; it has to be dropped at the reset.
		mode.clearTransientSessionUi();
		mode.presentCommandOutput(new Text("fresh panel", 1, 0));

		const notice = noticeText(mode);
		expect(notice).toContain("fresh panel");
		expect(notice).not.toContain("stale panel");
		expect(notice).toContain("1 command output");
		expect(notice).not.toContain("2 command outputs");
	});
});
