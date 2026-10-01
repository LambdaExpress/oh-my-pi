/**
 * Skill/custom queued-message display contracts.
 *
 * Custom queued chips now ride on the queued AgentMessage itself via
 * details.__queueChipText. The session derives pending display directly from
 * the agent-core queue; there is no separate display mirror to splice.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getThemeByName, initTheme, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme/tui-adapters";
import type {
	CompactionQueuedMessage,
	InteractiveModeContext,
	SubmittedUserInput,
} from "@oh-my-pi/pi-coding-agent/modes/types";
import { customSubmissionSignature } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE, type SkillPromptDetails } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { setLocale } from "../src/i18n";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(() => {
	// Keep skill rendering and interactive notices deterministic across locales.
	setLocale("en");
});

afterEach(() => {
	setLocale(null);
});

type PromptCustomMessage = Mock<AgentSession["promptCustomMessage"]>;

async function writeSkillFile(dir: string, skillName: string, body: string): Promise<Skill> {
	const skillPath = path.join(dir, `${skillName}.md`);
	await Bun.write(skillPath, `---\nname: ${skillName}\n---\n${body}\n`);
	return { name: skillName, description: "", filePath: skillPath, baseDir: dir, source: "test" };
}

function createStubInputControllerContext(opts: {
	skillCommands: Map<string, Skill>;
	isStreaming: boolean;
	isCompacting?: boolean;
	loopModeEnabled?: boolean;
	session?: AgentSession;
}) {
	const editor = new CustomEditor(getEditorTheme());
	editor.skillFilePath = name => opts.skillCommands.get(`skill:${name}`)?.filePath;
	const promptCustomMessage: PromptCustomMessage = vi.fn(async (_message, options) => {
		options?.onPromptAdmitted?.();
		return true;
	});
	const prompt = vi.fn(async (_text: string, _options?: unknown) => true);
	const pendingSubmissions: SubmittedUserInput[] = [];
	const startPendingSubmission: Mock<InteractiveModeContext["startPendingSubmission"]> = vi.fn((input, options) => {
		if (options?.clearEditor !== false) {
			editor.setText("");
			editor.imageLinks = undefined;
			editor.pendingImages = [];
			editor.pendingImageLinks = [];
		}
		const pending: SubmittedUserInput = {
			text: input.text,
			displayText: input.displayText,
			images: input.images,
			imageLinks: input.imageLinks,
			customType: input.customType,
			customMessage: input.customMessage,
			display: input.display,
			streamingBehavior: input.streamingBehavior,
			cancelled: false,
			started: false,
		};
		pendingSubmissions.push(pending);
		return pending;
	});
	const markPendingSubmissionStarted: Mock<InteractiveModeContext["markPendingSubmissionStarted"]> = vi.fn(input => {
		if (input.cancelled) return false;
		input.started = true;
		return true;
	});
	const finishPendingSubmission: Mock<InteractiveModeContext["finishPendingSubmission"]> = vi.fn(input => {
		const index = pendingSubmissions.indexOf(input);
		if (index !== -1) pendingSubmissions.splice(index, 1);
	});
	const updatePendingMessagesDisplay = vi.fn();
	const requestRender = vi.fn();
	const showError = vi.fn();
	const rebuildChatFromMessages = vi.fn();
	const setLoopPrompt = (prompt: string) => {
		ctx.loopPrompt = prompt;
	};
	const armLoopAutoSubmit = vi.fn();
	const ctx: InteractiveModeContext = createInteractiveModeContext({
		editor,
		ui: { requestRender },
		settings: opts.session?.settings ?? Settings.isolated(),
		sessionManager: opts.session?.sessionManager,
		skillCommands: opts.skillCommands,
		session: opts.session ?? {
			isStreaming: opts.isStreaming,
			isCompacting: opts.isCompacting ?? false,
			isBashRunning: false,
			isEvalRunning: false,
			extensionRunner: undefined,
			prompt,
			promptCustomMessage,
		},
		showError,
		updatePendingMessagesDisplay,
		isBashMode: false,
		isPythonMode: false,
		loopModeEnabled: opts.loopModeEnabled ?? false,
		setLoopPrompt,
		armLoopAutoSubmit,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		withLocalSubmission: async <T>(_text: string, fn: () => Promise<T>) => fn(),
		startPendingSubmission,
		markPendingSubmissionStarted,
		finishPendingSubmission,
		rebuildChatFromMessages,
	});
	const helpers = new UiHelpers(ctx);
	ctx.queueCompactionMessage = (text, mode, images, options) =>
		helpers.queueCompactionMessage(text, mode, images, options);

	return {
		ctx,
		editor,
		async pressEnter(): Promise<void> {
			const onSubmit = editor.onSubmit;
			if (!onSubmit) throw new Error("The editor submit handler is not installed");
			let completion: Promise<void> | undefined;
			editor.onSubmit = text => {
				completion = Promise.resolve(onSubmit(text));
				return completion;
			};
			try {
				editor.handleInput("\r");
				if (!completion) throw new Error("Enter did not submit the editor draft");
				await completion;
			} finally {
				editor.onSubmit = onSubmit;
			}
		},
		promptCustomMessage,
		pendingSubmissions,
		showError,
		armLoopAutoSubmit,
	};
}

describe("InputController skill queue chip metadata", () => {
	let tempDir: TempDir;
	let skillCommands: Map<string, Skill>;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-skill-queue-stub-");
		const skill = await writeSkillFile(tempDir.path(), "test-skill", "Do the thing.");
		skillCommands = new Map<string, Skill>([["skill:test-skill", skill]]);
	});

	afterEach(() => {
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	it("queues a streaming skill as an editable slash invocation until delivery", async () => {
		const fixture = await createRealSession();
		const providerEntered = Promise.withResolvers<void>();
		const releaseProvider = Promise.withResolvers<MockResponse>();
		const mock = createMockModel({
			handler: () => {
				providerEntered.resolve();
				return releaseProvider.promise;
			},
		});
		fixture.session.agent.streamFn = mock.stream;
		const runningTurn = fixture.session.prompt("current request");
		try {
			await providerEntered.promise;
			const { ctx, editor, pressEnter } = createStubInputControllerContext({
				skillCommands,
				isStreaming: true,
				session: fixture.session,
			});
			const controller = new InputController(ctx);
			controller.setupEditorSubmitHandler();
			editor.setText("/skill:test-skill arg1 arg2");

			await pressEnter();

			expect(fixture.session.getQueuedMessages()).toEqual({
				steering: ["/skill:test-skill arg1 arg2"],
				followUp: [],
			});
			expect(editor.getText()).toBe("");
			expect(controller.restoreQueuedMessagesToEditor()).toBe(1);
			expect(editor.getExpandedText()).toBe("/skill:test-skill arg1 arg2");
			expect(fixture.session.agent.hasQueuedMessages()).toBe(false);
		} finally {
			releaseProvider.resolve({ content: ["completed current request"] });
			await runningTurn;
			await fixture.session.dispose();
			fixture.authStorage.close();
			fixture.tempDir.removeSync();
		}
	});

	it("queues known skill steers during compaction instead of dispatching immediately", async () => {
		const { ctx, editor, pressEnter, promptCustomMessage } = createStubInputControllerContext({
			skillCommands,
			isStreaming: false,
			isCompacting: true,
		});
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		editor.setText("/skill:test-skill arg1 arg2");
		await pressEnter();

		expect(ctx.compactionQueuedMessages).toEqual([
			{ text: "/skill:test-skill arg1 arg2", mode: "steer", images: undefined },
		]);
		expect(editor.getText()).toBe("");
		expect(promptCustomMessage).not.toHaveBeenCalled();
	});

	it("captures the loop prompt for a /skill: submission (regression: /loop never resubmitted a skill prompt)", async () => {
		const { ctx, editor, pressEnter, armLoopAutoSubmit } = createStubInputControllerContext({
			skillCommands,
			isStreaming: false,
			loopModeEnabled: true,
		});
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		editor.setText("/skill:test-skill arg1 arg2");
		await pressEnter();

		expect(ctx.loopPrompt).toBe("/skill:test-skill arg1 arg2");
		expect(editor.getText()).toBe("");
		expect(armLoopAutoSubmit).toHaveBeenCalledTimes(1);
	});

	it("captures the loop prompt for a /skill: submission queued during compaction", async () => {
		const { ctx, editor, pressEnter, armLoopAutoSubmit } = createStubInputControllerContext({
			skillCommands,
			isStreaming: false,
			isCompacting: true,
			loopModeEnabled: true,
		});
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		editor.setText("/skill:test-skill arg1 arg2");
		await pressEnter();

		expect(ctx.loopPrompt).toBe("/skill:test-skill arg1 arg2");
		expect(ctx.compactionQueuedMessages).toEqual([
			{ text: "/skill:test-skill arg1 arg2", mode: "steer", images: undefined },
		]);
		expect(armLoopAutoSubmit).not.toHaveBeenCalled();
	});

	it("keeps a draft typed while a Ctrl+Enter skill submission was failing", async () => {
		const { ctx, editor, promptCustomMessage, showError } = createStubInputControllerContext({
			skillCommands,
			isStreaming: true,
		});
		promptCustomMessage.mockImplementation(async () => {
			// The user keeps typing while dispatch is in flight.
			editor.setText("typed while dispatching");
			throw new Error("dispatch failed");
		});
		const controller = new InputController(ctx);

		editor.setText("/skill:test-skill go");
		await controller.handleFollowUp();

		expect(showError).toHaveBeenCalledTimes(1);
		expect(editor.getExpandedText()).toBe("/skill:test-skill go\n\ntyped while dispatching");
	});

	it("keeps the next draft while an idle skill awaits admission", async () => {
		const { ctx, editor, pressEnter, promptCustomMessage, pendingSubmissions } = createStubInputControllerContext({
			skillCommands,
			isStreaming: false,
		});
		const dispatched = Promise.withResolvers<Parameters<AgentSession["promptCustomMessage"]>[1]>();
		const completed = Promise.withResolvers<boolean>();
		promptCustomMessage.mockImplementation(async (_message, options) => {
			dispatched.resolve(options);
			return completed.promise;
		});
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		editor.setText("/skill:test-skill arg1 arg2");
		const submission = pressEnter();
		const options = await dispatched.promise;

		const pending = pendingSubmissions[0];
		if (!pending) throw new Error("expected pending skill submission");
		expect(pending.started).toBe(false);
		expect(editor.getText()).toBe("");
		editor.setText("new draft while the skill is awaiting admission");
		if (!options?.onPromptAdmitted) throw new Error("expected session admission callback");
		options.onPromptAdmitted();
		expect(pending.started).toBe(true);
		completed.resolve(true);
		await submission;
		expect(editor.getText()).toBe("new draft while the skill is awaiting admission");
		expect(pendingSubmissions).toEqual([]);
	});
});

describe("InputController optimistic skill row (#8895)", () => {
	let tempDir: TempDir;
	let skillCommands: Map<string, Skill>;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-skill-optimistic-stub-");
		const skill = await writeSkillFile(tempDir.path(), "test-skill", "Do the thing.");
		skillCommands = new Map<string, Skill>([["skill:test-skill", skill]]);
	});

	afterEach(() => {
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	it("drops the pending row and restores the draft when dispatch throws", async () => {
		const { ctx, editor, pressEnter, promptCustomMessage, pendingSubmissions, showError } =
			createStubInputControllerContext({ skillCommands, isStreaming: false });
		let pendingAtDispatch: SubmittedUserInput | undefined;
		promptCustomMessage.mockImplementation(async () => {
			pendingAtDispatch = pendingSubmissions[0];
			throw new Error("preflight failed");
		});

		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		editor.setText("/skill:test-skill go");
		await pressEnter();

		expect(pendingAtDispatch?.started).toBe(false);
		expect(pendingSubmissions).toEqual([]);
		expect(showError).toHaveBeenCalledTimes(1);
		expect(editor.getExpandedText()).toBe("/skill:test-skill go");
	});
});

describe("compaction skill re-invocation", () => {
	let tempDir: TempDir;
	let skillCommands: Map<string, Skill>;

	function createCompactionDrainContext(queuedMessages: CompactionQueuedMessage[], loopModeEnabled = false) {
		const promptCustomMessageCalled = Promise.withResolvers<void>();
		const promptCustomMessage: PromptCustomMessage = vi.fn(async () => {
			promptCustomMessageCalled.resolve();
			return true;
		});
		const prompt = vi.fn(async (_text: string, _options?: { streamingBehavior?: "steer" | "followUp" }) => true);
		const steer = vi.fn(async (_text: string, _images?: ImageContent[]) => {});
		const followUp = vi.fn(async (_text: string, _images?: ImageContent[]) => {});
		const armLoopAutoSubmit = vi.fn();
		const ctx = createInteractiveModeContext({
			settings: Settings.isolated(),
			skillCommands,
			compactionQueuedMessages: queuedMessages,
			loopModeEnabled,
			armLoopAutoSubmit,
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
			isKnownSlashCommand: vi.fn(() => false),
			recordLocalSubmission: vi.fn((_text: string, _imageCount = 0) => vi.fn()),
			withLocalSubmission: async <T>(_text: string, fn: () => Promise<T>) => fn(),
			session: {
				promptCustomMessage,
				prompt,
				steer,
				followUp,
				clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
			},
		});
		return { ctx, promptCustomMessageCalled, armLoopAutoSubmit };
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-skill-compaction-stub-");
		const skill = await writeSkillFile(tempDir.path(), "test-skill", "Do the thing.");
		skillCommands = new Map<string, Skill>([["skill:test-skill", skill]]);
	});

	afterEach(() => {
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	it("arms the loop after re-invoking a queued skill (regression: /loop never resubmitted after compaction)", async () => {
		const { ctx, promptCustomMessageCalled, armLoopAutoSubmit } = createCompactionDrainContext(
			[{ text: "/skill:test-skill arg1 arg2", mode: "steer" }],
			true,
		);
		const uiHelpers = new UiHelpers(ctx);

		await uiHelpers.flushCompactionQueue({ willRetry: false });
		await promptCustomMessageCalled.promise;

		expect(ctx.compactionQueuedMessages).toEqual([]);
		expect(armLoopAutoSubmit).toHaveBeenCalledTimes(1);
	});

	it("queues retry-drained skills without appending them to session history", async () => {
		const fixture = await createRealSession();
		try {
			const image: ImageContent = { type: "image", data: "cmV0cnk=", mimeType: "image/png" };
			const { ctx } = createCompactionDrainContext([
				{ text: "/skill:test-skill retry args", mode: "followUp", images: [image] },
			]);
			ctx.session = fixture.session;
			const uiHelpers = new UiHelpers(ctx);

			await uiHelpers.flushCompactionQueue({ willRetry: true });

			expect(fixture.session.getQueuedMessages().followUp).toEqual(["/skill:test-skill retry args"]);
			const queued = fixture.session.agent.peekFollowUpQueue()[0];
			if (queued?.role !== "custom" || !Array.isArray(queued.content)) {
				throw new Error("expected retry-drained skill to be queued as image-bearing custom content");
			}
			expect(queued.customType).toBe(SKILL_PROMPT_MESSAGE_TYPE);
			expect(queued.content[1]).toEqual(image);
			expect(fixture.session.messages).toEqual([]);
		} finally {
			await fixture.session.dispose();
			fixture.authStorage.close();
			fixture.tempDir.removeSync();
		}
	});
});

interface SessionFixture {
	tempDir: TempDir;
	authStorage: AuthStorage;
	session: AgentSession;
}

async function createRealSession(): Promise<SessionFixture> {
	const tempDir = TempDir.createSync("@pi-skill-queue-real-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	authStorage.keys.setRuntime("anthropic", "test-key");
	const settings = Settings.isolated();
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings });
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");

	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
	});

	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings,
		modelRegistry,
	});

	return { tempDir, authStorage, session };
}

function queueCustomSteer(session: AgentSession, chip: string, content = "skill body"): void {
	session.agent.steer({
		role: "custom",
		customType: SKILL_PROMPT_MESSAGE_TYPE,
		content,
		display: true,
		attribution: "user",
		details: {
			name: "foo",
			path: "/s.md",
			args: "bar",
			lineCount: 1,
			__queueChipText: chip,
		} satisfies SkillPromptDetails,
		timestamp: Date.now(),
	});
}

function queueAdvisorSteer(session: AgentSession, note = "consider X"): void {
	session.agent.steer({
		role: "custom",
		customType: "advisor",
		content: `Advisor:\n- [blocker] ${note}`,
		display: true,
		attribution: "agent",
		details: { notes: [{ note, severity: "blocker" }] },
		timestamp: Date.now(),
	});
}

/** Mirror a hidden magic-keyword companion notice (`display:false`, `attribution:"user"`). */
function queueMagicCompanion(session: AgentSession, customType = "ultrathink-notice"): void {
	session.agent.steer({
		role: "custom",
		customType,
		content: "hidden notice",
		display: false,
		attribution: "user",
		details: {},
		timestamp: Date.now(),
	});
}

/** Mirror a steered user prompt (`AgentSession.#queueUserMessage(..., "steer")`). */
function queueUserSteer(session: AgentSession, text: string): void {
	session.agent.steer({
		role: "user",
		content: [{ type: "text", text }],
		steering: true,
		attribution: "user",
		timestamp: Date.now(),
	});
}

describe("AgentSession derived queued custom display", () => {
	let fixture: SessionFixture | undefined;

	afterEach(async () => {
		if (fixture) {
			await fixture.session.dispose();
			fixture.authStorage.close();
			fixture.tempDir.removeSync();
			fixture = undefined;
		}
		vi.restoreAllMocks();
	});

	it("derives queued custom chip text directly from the agent steering queue", async () => {
		fixture = await createRealSession();
		const { session } = fixture;

		queueCustomSteer(session, "/skill:foo bar");

		expect(session.getQueuedMessages().steering).toEqual(["/skill:foo bar"]);
		expect(session.queuedMessageCount).toBe(1);
	});

	it("excludes display-suppressed custom messages from chips/count and never restores them", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		session.agent.steer({
			role: "custom",
			customType: "internal",
			content: "hidden",
			display: false,
			details: { __queueChipText: "hidden" },
			timestamp: Date.now(),
		});

		expect(session.getQueuedMessages().steering).toEqual([]);
		expect(session.queuedMessageCount).toBe(0);
		// Plain Alt+Up dequeue restores nothing AND preserves the hidden steer for the
		// continuing stream — it isn't the user's draft.
		expect(session.clearQueue().steering).toEqual([]);
		expect(session.agent.hasQueuedMessages()).toBe(true);
		// Esc+abort drops it so abort()'s stranded-message drain can't auto-resume the
		// run the user just interrupted (the drain gate is agent.hasQueuedMessages()).
		expect(session.clearQueue({ forInterrupt: true }).steering).toEqual([]);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("never restores a visible agent-authored custom steer; preserves on dequeue, drops on interrupt", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		// An IRC aside / extension/hook notice: visible, but agent-authored — editing it
		// makes no sense, so it must not ride the Esc/Alt+Up editor-restore path.
		const steer = () =>
			session.agent.steer({
				role: "custom",
				customType: "irc",
				content: "peer pinged you",
				display: true,
				attribution: "agent",
				details: {},
				timestamp: Date.now(),
			});
		steer();

		expect(session.getQueuedMessages().steering).toEqual([]);
		// popLast leaves the agent steer untouched (not user-restorable)...
		expect(session.popLastQueuedMessage()).toBeUndefined();
		expect(session.agent.peekSteeringQueue()).toHaveLength(1);
		// ...plain dequeue restores nothing but PRESERVES the extension steer (not lost)...
		expect(session.clearQueue().steering).toEqual([]);
		expect(session.agent.peekSteeringQueue()).toHaveLength(1);
		// ...and only Esc+abort drops it (no auto-resume leftover).
		expect(session.clearQueue({ forInterrupt: true }).steering).toEqual([]);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("counts a queued advisor card as pending work but keeps it out of chips and restore", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		queueAdvisorSteer(session, "guard the null path");

		// Advisor cards are real pending work (feeds hasPendingMessages/empty-Enter abort)...
		expect(session.queuedMessageCount).toBe(1);
		// ...but are never editable user input.
		expect(session.getQueuedMessages().steering).toEqual([]);

		// clearQueue must not surface the advisor note for editor restore, and must
		// leave the card queued so the abort/resume path still delivers it.
		const cleared = session.clearQueue();
		expect(cleared.steering).toEqual([]);
		expect(cleared.followUp).toEqual([]);
		expect(session.agent.peekSteeringQueue()).toHaveLength(1);
		expect(session.popLastQueuedMessage()).toBeUndefined();
	});

	it("clearQueue restores user messages but preserves a queued advisor card", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		queueCustomSteer(session, "/skill:foo bar");
		queueAdvisorSteer(session, "rename the symbol");

		const cleared = session.clearQueue();
		expect(cleared.steering).toEqual([{ text: "/skill:foo bar", images: undefined }]);
		// The advisor card survives in the agent-core queue; the user's message left.
		const remaining = session.agent.peekSteeringQueue();
		expect(remaining).toHaveLength(1);
		expect(remaining[0]).toMatchObject({ customType: "advisor" });
	});

	it("popLastQueuedMessage steps over an advisor card to the user message", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		queueCustomSteer(session, "/skill:foo bar");
		queueAdvisorSteer(session, "watch the race");

		expect(session.popLastQueuedMessage()?.text).toBe("/skill:foo bar");
		// Advisor card remains queued, not restored.
		const remaining = session.agent.peekSteeringQueue();
		expect(remaining).toHaveLength(1);
		expect(remaining[0]).toMatchObject({ customType: "advisor" });
	});

	it("clearQueue drops a queued magic-keyword companion with its dequeued user prompt", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		// Queue order mirrors prompt("ultrathink do X", { streamingBehavior: "steer" }):
		// the hidden companion notice queues right before the user message.
		queueMagicCompanion(session, "ultrathink-notice");
		queueUserSteer(session, "ultrathink do X");

		// The companion is display:false, so only the user prompt is displayable work.
		expect(session.queuedMessageCount).toBe(1);

		// Alt+Up bulk restore returns the user's text and leaves no orphaned companion.
		const cleared = session.clearQueue();
		expect(cleared.steering).toEqual([{ text: "ultrathink do X", images: undefined }]);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("popLastQueuedMessage drops only the popped prompt's preceding companion", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		// [ultrathink-notice, "first", orchestrate-notice, "second"].
		queueMagicCompanion(session, "ultrathink-notice");
		queueUserSteer(session, "first");
		queueMagicCompanion(session, "orchestrate-notice");
		queueUserSteer(session, "second");

		expect(session.popLastQueuedMessage()?.text).toBe("second");
		// Only the popped prompt's companion (orchestrate-notice) leaves; the earlier
		// prompt and its own companion stay intact.
		const remaining = session.agent.peekSteeringQueue();
		expect(remaining.map(m => (m.role === "custom" ? m.customType : m.role))).toEqual(["ultrathink-notice", "user"]);
	});
});

function createStubInteractiveModeContextForUiHelpers(session: AgentSession) {
	const editor = new CustomEditor(getEditorTheme());
	const ctx = createInteractiveModeContext({
		editor,
		session,
		settings: session.settings,
		sessionManager: session.sessionManager,
		compactionQueuedMessages: [],
	});

	return { ctx, editor, pendingMessagesContainer: ctx.pendingMessagesContainer };
}

describe("UiHelpers / InputController against derived queued custom display", () => {
	let fixture: SessionFixture | undefined;

	beforeEach(async () => {
		const themeInstance = await getThemeByName("dark");
		if (!themeInstance) throw new Error("Expected the bundled dark theme");
		setThemeInstance(themeInstance);
	});

	afterEach(async () => {
		if (fixture) {
			await fixture.session.dispose();
			fixture.authStorage.close();
			fixture.tempDir.removeSync();
			fixture = undefined;
		}
		vi.restoreAllMocks();
	});

	it("renders the compact slash form for queued skills", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		queueCustomSteer(session, "/skill:test-skill arg1 arg2");

		const { ctx, pendingMessagesContainer } = createStubInteractiveModeContextForUiHelpers(session);
		const uiHelpers = new UiHelpers(ctx);
		uiHelpers.updatePendingMessagesDisplay();

		const rendered = Bun.stripANSI(pendingMessagesContainer.render(120).join("\n"));
		expect(rendered).toContain("/skill:test-skill arg1 arg2");
		expect(rendered).not.toContain("skill body");

		session.clearQueue();
		uiHelpers.updatePendingMessagesDisplay();

		expect(Bun.stripANSI(pendingMessagesContainer.render(120).join("\n"))).not.toContain("/skill:test-skill");
	});

	it("renders queued follow-up drafts in submission order", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		for (const text of ["inspect types", "run tests", "summarize"]) {
			session.agent.followUp({
				role: "user",
				content: text,
				attribution: "user",
				timestamp: Date.now(),
			});
		}

		const { ctx, pendingMessagesContainer } = createStubInteractiveModeContextForUiHelpers(session);
		new UiHelpers(ctx).updatePendingMessagesDisplay();

		const rendered = Bun.stripANSI(pendingMessagesContainer.render(120).join("\n"));
		expect(rendered).toContain("1. inspect types");
		expect(rendered).toContain("2. run tests");
		expect(rendered).toContain("3. summarize");
	});

	it("restores the compact slash form into the editor and clears the queue", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		queueCustomSteer(session, "/skill:test-skill arg1 arg2");

		const { ctx, editor } = createStubInteractiveModeContextForUiHelpers(session);
		const controller = new InputController(ctx);
		const count = controller.restoreQueuedMessagesToEditor();

		expect(count).toBe(1);
		expect(editor.getText()).toBe("/skill:test-skill arg1 arg2");
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
	});
});

function createEventControllerFixture() {
	const clearOptimisticCustomMessage = vi.fn();
	const ctx = createInteractiveModeContext({
		optimisticCustomMessageSignature: undefined,
		clearOptimisticCustomMessage,
	});
	clearOptimisticCustomMessage.mockImplementation(() => {
		ctx.optimisticCustomMessageSignature = undefined;
	});
	const addMessageToChat = vi.spyOn(ctx, "addMessageToChat");
	const controller = new EventController(ctx);
	return {
		controller,
		ctx,
		addMessageToChat,
	};
}

describe("EventController custom queued-message refresh", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("drops a real skill custom message that matches the optimistic pending card", async () => {
		const { controller, ctx, addMessageToChat } = createEventControllerFixture();
		const event: Extract<AgentSessionEvent, { type: "message_start" }> = {
			type: "message_start",
			message: {
				role: "custom",
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: "rendered skill body",
				display: true,
				attribution: "user",
				details: {
					name: "foo",
					path: "/s.md",
					args: "bar",
					lineCount: 1,
				} satisfies SkillPromptDetails,
				timestamp: 1_717_171_717_000,
			},
		};
		if (event.message.role !== "custom") {
			throw new Error("expected custom message event");
		}
		ctx.optimisticCustomMessageSignature = customSubmissionSignature(event.message);

		await controller.handleEvent(event);

		expect(addMessageToChat).not.toHaveBeenCalled();
		expect(ctx.optimisticCustomMessageSignature).toBeUndefined();
	});
});
