import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { COLLAB_PROTO, formatCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { RegisteredTool } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { wrapRegisteredTool } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { stopSharedSpinnerTicker, ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { SPINNER_ADVANCE_MS } from "@oh-my-pi/pi-tui/components/loader";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { customToolToDefinition } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { webSearchCustomTool } from "@oh-my-pi/pi-coding-agent/web/search";
import type { TUI } from "@oh-my-pi/pi-tui";
import { installInMemoryRelay, uninstallInMemoryRelay } from "../../collab/helpers/in-memory-relay";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

function createBridgedWebSearchTool() {
	const definition = customToolToDefinition(webSearchCustomTool);
	return wrapRegisteredTool(
		{ definition, extensionPath: "<sdk>" } as RegisteredTool,
		{ createContext: () => ({}) } as unknown as ExtensionRunner,
	);
}

// Contract under test: live tool previews that render a pending/running status
// must keep the spinner glyph tied to the shared tool-frame ticker. This covers
// both the shared ToolExecutionComponent interval and renderer-local caches that
// would otherwise keep serving the first pending frame.
describe("ToolExecutionComponent live preview spinners", () => {
	beforeAll(async () => {
		await initTheme();
	});

	// Earlier test files may leak live blocks (components never stopAnimation'd),
	// which keeps the shared ticker armed on a REAL interval and makes these
	// fake-timer assertions observe a pre-existing timer instead of a fresh one.
	beforeEach(() => {
		stopSharedSpinnerTicker();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("animates the eval pending cell while the call is live", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const component = new ToolExecutionComponent(
			"eval",
			{ language: "py", code: "import time\ntime.sleep(10)" },
			{},
			undefined,
			{ requestRender, requestComponentRender } as unknown as TUI,
			process.cwd(),
		);

		try {
			const firstFrame = stripVTControlCharacters(component.render(80).join("\n"));
			vi.advanceTimersByTime(120);
			const secondFrame = stripVTControlCharacters(component.render(80).join("\n"));

			expect(requestComponentRender).toHaveBeenCalledWith(component);
			expect(requestRender).not.toHaveBeenCalled();
			expect(firstFrame).toContain("time.sleep(10)");
			expect(secondFrame).toContain("time.sleep(10)");
			expect(secondFrame).not.toBe(firstFrame);
		} finally {
			component.stopAnimation();
		}
	});

	it("does not tick headerless bash pending previews", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const component = new ToolExecutionComponent(
			"bash",
			{ command: "sleep 600" },
			{},
			undefined,
			{ requestRender, requestComponentRender } as unknown as TUI,
			process.cwd(),
		);

		try {
			requestRender.mockClear();
			requestComponentRender.mockClear();
			vi.advanceTimersByTime(500);
			expect(requestRender).not.toHaveBeenCalled();
			expect(requestComponentRender).not.toHaveBeenCalled();
		} finally {
			component.stopAnimation();
		}
	});

	it("does not tick detached async bash result snapshots", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const component = new ToolExecutionComponent(
			"bash",
			{ command: "sleep 600", async: true },
			{},
			undefined,
			{ requestRender, requestComponentRender } as unknown as TUI,
			process.cwd(),
		);

		try {
			component.updateResult(
				{
					content: [{ type: "text", text: "started background job" }],
					details: {
						command: "sleep 600",
						async: { state: "running", jobId: "job-1", type: "bash" },
					},
				},
				true,
			);
			requestRender.mockClear();
			requestComponentRender.mockClear();
			vi.advanceTimersByTime(500);
			expect(requestRender).not.toHaveBeenCalled();
			expect(requestComponentRender).not.toHaveBeenCalled();
		} finally {
			component.stopAnimation();
		}
	});

	it("does not tick github pending previews whose Text is materialized per rebuild", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const component = new ToolExecutionComponent(
			"github",
			{ op: "run_watch", run: "12345" },
			{},
			undefined,
			{ requestRender, requestComponentRender } as unknown as TUI,
			process.cwd(),
		);

		try {
			requestRender.mockClear();
			requestComponentRender.mockClear();
			vi.advanceTimersByTime(500);
			expect(requestRender).not.toHaveBeenCalled();
			expect(requestComponentRender).not.toHaveBeenCalled();
		} finally {
			component.stopAnimation();
		}
	});

	it("does not tick custom tools whose pending label is a static tool-name Text", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		// A renderResult-only custom tool renders the static tool-name label
		// while pending, so the spinner interval must not start.
		const tool = { name: "ext_tool", renderResult: () => undefined };
		const component = new ToolExecutionComponent(
			"ext_tool",
			{ input: 1 },
			{},
			tool as never,
			{ requestRender, requestComponentRender } as unknown as TUI,
			process.cwd(),
		);

		try {
			requestRender.mockClear();
			requestComponentRender.mockClear();
			vi.advanceTimersByTime(500);
			expect(requestRender).not.toHaveBeenCalled();
			expect(requestComponentRender).not.toHaveBeenCalled();
		} finally {
			component.stopAnimation();
		}
	});

	it("replaces an adapted Web Search pending preview with one completed query-and-answer card", () => {
		const query = "ORIGINAL WEB SEARCH QUERY";
		const answer = "FINAL WEB SEARCH ANSWER";
		const component = new ToolExecutionComponent(
			"web_search",
			{ query },
			{ useBuiltInRenderer: false },
			createBridgedWebSearchTool(),
			{ requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
			process.cwd(),
		);

		try {
			const pending = stripVTControlCharacters(component.render(100).join("\n"));
			expect(pending).toContain(theme.status.pending);
			expect(pending).toContain("Web Search");
			expect(pending).toContain(query);

			component.updateResult({
				content: [{ type: "text", text: answer }],
				details: {
					response: {
						provider: "tavily",
						answer,
						sources: [{ title: "Search source", url: "https://example.com/source" }],
					},
				},
			});

			const completed = stripVTControlCharacters(component.render(100).join("\n"));
			expect(completed.match(/Web Search/g) ?? []).toHaveLength(1);
			expect(completed).not.toContain(theme.status.pending);
			expect(completed).toContain(`Query: ${query}`);
			expect(completed).toContain("Answer");
			expect(completed).toContain(answer);
		} finally {
			component.stopAnimation();
		}
	});

	it("replaces an adapted Web Search pending preview with one terminal error card", () => {
		const component = new ToolExecutionComponent(
			"web_search",
			{ query: "FAILING WEB SEARCH QUERY" },
			{ useBuiltInRenderer: false },
			createBridgedWebSearchTool(),
			{ requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
			process.cwd(),
		);

		try {
			expect(stripVTControlCharacters(component.render(100).join("\n"))).toContain(theme.status.pending);

			component.updateResult({
				content: [{ type: "text", text: "Provider unavailable" }],
				details: {
					response: { provider: "tavily", sources: [] },
					error: "Provider unavailable",
				},
				isError: true,
			});

			const failed = stripVTControlCharacters(component.render(100).join("\n"));
			expect(failed.match(/Web Search/g) ?? []).toHaveLength(1);
			expect(failed).not.toContain(theme.status.pending);
			expect(failed).toContain("Error: Provider unavailable");
		} finally {
			component.stopAnimation();
		}
	});

	// Regression (issue #8731): concurrent live tool blocks — e.g. parallel task
	// subagents — must share ONE spinner timer, not one per block, or active-work
	// CPU scales with block count.
	it("drives every concurrent live block from a single shared spinner timer", () => {
		vi.useFakeTimers();
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const renders = [vi.fn(), vi.fn(), vi.fn()];
		const components = renders.map(
			requestComponentRender =>
				new ToolExecutionComponent(
					"eval",
					{ language: "py", code: "import time\ntime.sleep(10)" },
					{},
					undefined,
					{ requestRender: vi.fn(), requestComponentRender } as unknown as TUI,
					process.cwd(),
				),
		);

		try {
			const spinnerTimers = setIntervalSpy.mock.calls.filter(([, ms]) => ms === SPINNER_ADVANCE_MS).length;
			// One shared ticker for all three live blocks, not three.
			expect(spinnerTimers).toBe(1);

			// A single tick repaints every registered block in lockstep.
			vi.advanceTimersByTime(SPINNER_ADVANCE_MS);
			for (const requestComponentRender of renders) {
				expect(requestComponentRender).toHaveBeenCalledTimes(1);
			}
		} finally {
			for (const component of components) component.stopAnimation();
		}
	});

	it("keeps normal multi-line tool frames throughout a pressured live transcript", () => {
		const ui = { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI;
		const transcript = new TranscriptContainer();
		const components = ["alpha", "bravo", "charlie", "delta"].map(name => {
			const component = new ToolExecutionComponent(
				"bash",
				{ command: `printf '${name}\\n'` },
				{},
				undefined,
				ui,
				process.cwd(),
			);
			transcript.addChild(component);
			return component;
		});
		try {
			// The first call remains active, so the finalized successors cannot retire
			// past it. This is the exact long-running-task shape that previously made
			// every tool card degrade to a one-line `bash · command` summary.
			for (let index = 1; index < components.length; index++) {
				components[index]!.updateResult(
					{ content: [{ type: "text", text: `${index}: output line one\n${index}: output line two` }] },
					false,
				);
			}

			const plain = transcript
				.renderViewport(80, 10)
				.map(row => stripVTControlCharacters(row))
				.join("\n");
			expect(plain).toContain("delta");
			expect(plain).toContain("3: output line one");
			expect(plain).toContain("3: output line two");
			expect(plain).not.toMatch(/[•╭─]\s+bash\s+·/i);
		} finally {
			for (const component of components) component.stopAnimation();
		}
	});

	// Regression (PR #9377 follow-up, codex review): a live block torn down
	// through `TranscriptContainer.disposeChildren()` — the real teardown the
	// collab guest's welcome/resync path (`guest.ts#finalizeSnapshot`) uses to
	// replace the chat transcript — must unregister from the shared ticker.
	// Calling `component.dispose()` directly does not exercise that path: the
	// bug was `chatContainer.clear()` detaching children without disposing
	// them, so a live block survived the resync with its ticker registration
	// intact even though its instance was orphaned.
	it("unregisters a live tool block from the shared ticker via the guest resync teardown", async () => {
		installInMemoryRelay();
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		try {
			vi.useFakeTimers();

			const chatContainer = new TranscriptContainer();
			const liveBlock = new ToolExecutionComponent(
				"eval",
				{ language: "py", code: "import time\ntime.sleep(10)" },
				{},
				undefined,
				{ requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
				process.cwd(),
			);
			chatContainer.addChild(liveBlock);
			expect(vi.getTimerCount()).toBeGreaterThan(0);

			await Settings.init({ inMemory: true });
			const ctx = {
				settings: { get: () => "" },
				sessionManager: { getSessionFile: () => null, getSessionName: () => "local", getCwd: () => "/local" },
				session: {
					messages: [],
					switchSession: () => Promise.resolve(),
					newSession: () => Promise.resolve(),
					agent: {
						state: { model: undefined },
						setModel: () => {},
						setThinkingLevel: () => {},
						setDisableReasoning: () => {},
					},
				},
				statusContainer: { clear: () => {}, disposeChildren: () => {} },
				pendingMessagesContainer: { clear: () => {}, disposeChildren: () => {} },
				compactionQueuedMessages: [],
				streamingComponent: undefined,
				streamingMessage: undefined,
				transcriptMessageComponents: new WeakMap(),
				pendingTools: new Map(),
				pendingBashComponents: [],
				pendingPythonComponents: [],
				lastAssistantUsage: undefined,
				initialChatRendered: true,
				hideToolActivity: false,
				loadingAnimation: undefined,
				statusLine: {
					setCollabStatus: () => {},
					invalidate: () => {},
					resetActiveTime: () => {},
					markActivityStart: () => {},
					markActivityEnd: () => {},
				},
				ui: { requestRender: () => {} },
				chatContainer,
				resetObserverRegistry: () => {},
				eventController: { takeDisplaceableComponents: () => [] },
				// The real transcript-commit path is the contract under test: the
				// guest resync performs no eager teardown, so the orphaned live
				// block's ticker registration must drop exactly when
				// UiHelpers.renderInitialMessages() swaps the staged transcript in
				// and disposes the previously visible children.
				renderInitialMessages: (options?: { clearTerminalHistory?: boolean }) =>
					uiHelpers.renderInitialMessages(options),
				renderSessionContext: (context: unknown, options: unknown) =>
					(uiHelpers.renderSessionContext as (c: unknown, o: unknown) => void)(context, options),
				renderSessionContextIncrementally: (context: unknown, options: unknown, renderChunk?: () => void) =>
					(
						uiHelpers.renderSessionContextIncrementally as (
							c: unknown,
							o: unknown,
							r?: () => void,
						) => Promise<void>
					)(context, options, renderChunk),
				viewSession: {
					isStreaming: false,
					buildTranscriptSessionContext: () => ({
						messages: [],
						thinkingLevel: "off",
						serviceTier: undefined,
						models: {},
						injectedTtsrRules: [],
						mode: "none",
					}),
					getToolByName: () => undefined,
					hasBuiltInTool: () => true,
					extensionRunner: undefined,
					sessionManager: { getEntries: () => [], getCwd: () => "/local" },
				},
				reloadTodos: () => Promise.resolve(),
				showStatus: () => {},
				showError: () => {},
				updateEditorTopBorder: () => {},
				updateEditorBorderColor: () => {},
				syncRunningSubagentBadge: () => {},
			} as unknown as InteractiveModeContext;
			const uiHelpers = new UiHelpers(ctx);

			const roomId = "spinner-resync-room";
			const roomKey = generateRoomKey();
			const cryptoKey = await importRoomKey(roomKey);
			const link = formatCollabLink("ws://localhost:8788", roomId, roomKey);
			const hostSocket = new CollabSocket({
				wsUrl: `ws://localhost:8788/r/${roomId}`,
				role: "host",
				key: cryptoKey,
			});
			const hostOpen = Promise.withResolvers<void>();
			hostSocket.onOpen = () => hostOpen.resolve();
			hostSocket.onFrame = frame => {
				if (frame.t !== "hello") return;
				hostSocket.send({
					t: "welcome",
					proto: COLLAB_PROTO,
					header: { type: "session", id: "resync-session", timestamp: "2026-06-26T00:00:00Z", cwd: "/tmp" },
					state: {
						isStreaming: false,
						queuedMessageCount: 0,
						sessionName: "host session",
						cwd: "/tmp",
						participants: [{ name: "Host", role: "host" }],
					},
					agents: [],
					entryCount: 0,
				});
			};
			hostSocket.connect();
			await hostOpen.promise;

			const guest = new CollabGuestLink(ctx);
			try {
				// Drives the real welcome handshake into `#finalizeSnapshot`, which
				// tears down `chatContainer` while `liveBlock` is still registered.
				await guest.join(link);

				expect(chatContainer.children).not.toContain(liveBlock);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				hostSocket.close();
				await guest.leave("test cleanup").catch(() => {});
			}
		} finally {
			writeSpy.mockRestore();
			uninstallInMemoryRelay();
			stopSharedSpinnerTicker();
		}
	});

	// Regression (PR #9377 follow-up, codex review): when the staged replay
	// inside `UiHelpers.renderInitialMessages()` throws, its own rollback only
	// restores the untouched visible container -- it never disposes that
	// container's children, since they were never touched. A tool block that
	// was tracked in `pendingTools` before `#clearTransientUi()` cleared the
	// map is now orphaned with no remaining reference, so nothing would ever
	// call `dispose()` on it again: its shared-ticker registration must be
	// stopped by `#finalizeSnapshot` itself on the failure path.
	it("stops an orphaned pending tool block's ticker when guest resync staging fails", async () => {
		installInMemoryRelay();
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		try {
			vi.useFakeTimers();

			const chatContainer = new TranscriptContainer();
			const liveBlock = new ToolExecutionComponent(
				"eval",
				{ language: "py", code: "import time\ntime.sleep(10)" },
				{},
				undefined,
				{ requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
				process.cwd(),
			);
			chatContainer.addChild(liveBlock);
			expect(vi.getTimerCount()).toBeGreaterThan(0);

			await Settings.init({ inMemory: true });
			const ctx = {
				settings: { get: () => "" },
				sessionManager: { getSessionFile: () => null, getSessionName: () => "local", getCwd: () => "/local" },
				session: {
					messages: [],
					switchSession: () => Promise.resolve(),
					newSession: () => Promise.resolve(),
					agent: {
						state: { model: undefined },
						setModel: () => {},
						setThinkingLevel: () => {},
						setDisableReasoning: () => {},
					},
				},
				statusContainer: { clear: () => {}, disposeChildren: () => {} },
				pendingMessagesContainer: { clear: () => {}, disposeChildren: () => {} },
				compactionQueuedMessages: [],
				streamingComponent: undefined,
				streamingMessage: undefined,
				transcriptMessageComponents: new WeakMap(),
				// The block under test is tracked as a pending tool, mirroring the
				// real state right before a resync: #clearTransientUi() clears this
				// map without disposing the block it names.
				pendingTools: new Map([["call-1", liveBlock]]),
				pendingBashComponents: [],
				pendingPythonComponents: [],
				lastAssistantUsage: undefined,
				initialChatRendered: true,
				hideToolActivity: false,
				loadingAnimation: undefined,
				statusLine: {
					setCollabStatus: () => {},
					invalidate: () => {},
					resetActiveTime: () => {},
					markActivityStart: () => {},
					markActivityEnd: () => {},
				},
				ui: { requestRender: () => {} },
				chatContainer,
				resetObserverRegistry: () => {},
				eventController: { takeDisplaceableComponents: () => [] },
				renderInitialMessages: (options?: { clearTerminalHistory?: boolean }) =>
					uiHelpers.renderInitialMessages(options),
				renderSessionContext: (context: unknown, options: unknown) =>
					(uiHelpers.renderSessionContext as (c: unknown, o: unknown) => void)(context, options),
				// Fails the staged replay itself, so renderInitialMessages()'s own
				// rollback runs (restoring the untouched visible container) without
				// ever reaching the success-path disposeChildren() that would
				// otherwise unregister the orphaned block.
				renderSessionContextIncrementally: () => Promise.reject(new Error("staged rebuild boom")),
				viewSession: {
					isStreaming: false,
					buildTranscriptSessionContext: () => ({
						messages: [],
						thinkingLevel: "off",
						serviceTier: undefined,
						models: {},
						injectedTtsrRules: [],
						mode: "none",
					}),
					getToolByName: () => undefined,
					hasBuiltInTool: () => true,
					extensionRunner: undefined,
					sessionManager: { getEntries: () => [], getCwd: () => "/local" },
				},
				reloadTodos: () => Promise.resolve(),
				showStatus: () => {},
				showError: () => {},
				updateEditorTopBorder: () => {},
				updateEditorBorderColor: () => {},
				syncRunningSubagentBadge: () => {},
			} as unknown as InteractiveModeContext;
			const uiHelpers = new UiHelpers(ctx);

			const roomId = "spinner-resync-failure-room";
			const roomKey = generateRoomKey();
			const cryptoKey = await importRoomKey(roomKey);
			const link = formatCollabLink("ws://localhost:8788", roomId, roomKey);
			const hostSocket = new CollabSocket({
				wsUrl: `ws://localhost:8788/r/${roomId}`,
				role: "host",
				key: cryptoKey,
			});
			const hostOpen = Promise.withResolvers<void>();
			hostSocket.onOpen = () => hostOpen.resolve();
			hostSocket.onFrame = frame => {
				if (frame.t !== "hello") return;
				hostSocket.send({
					t: "welcome",
					proto: COLLAB_PROTO,
					header: {
						type: "session",
						id: "resync-failure-session",
						timestamp: "2026-06-26T00:00:00Z",
						cwd: "/tmp",
					},
					state: {
						isStreaming: false,
						queuedMessageCount: 0,
						sessionName: "host session",
						cwd: "/tmp",
						participants: [{ name: "Host", role: "host" }],
					},
					agents: [],
					entryCount: 0,
				});
			};
			hostSocket.connect();
			await hostOpen.promise;

			const guest = new CollabGuestLink(ctx);
			try {
				let joinError: unknown;
				try {
					await guest.join(link);
				} catch (err) {
					joinError = err;
				}
				expect(joinError).toBeInstanceOf(Error);
				expect((joinError as Error).message).toContain("staged rebuild boom");

				// The block was stopped in place, not disposed from the tree: its
				// rendered row survives the failed resync untouched.
				expect(chatContainer.children).toContain(liveBlock);
				// ...but it no longer holds the shared ticker open.
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				hostSocket.close();
				await guest.leave("test cleanup").catch(() => {});
			}
		} finally {
			writeSpy.mockRestore();
			uninstallInMemoryRelay();
			stopSharedSpinnerTicker();
		}
	});

	// Regression (PR #9377 follow-up, codex review): `#handleToolExecutionEnd`
	// settles a displaceable `hub`/`todo` result out of `pendingTools` into
	// EventController's own trackers (`#displaceablePollComponent` /
	// `#displaceableTodoComponent`) instead of leaving it there, so enumerating
	// only `pendingTools` before a resync misses that still-animated "waiting"
	// card entirely: `#finalizeSnapshot` must fold in
	// `eventController.takeDisplaceableComponents()` too, or its ticker
	// registration survives the failed resync with no remaining reference to
	// stop it.
	// A later codex pass on this test flagged that stubbing
	// `takeDisplaceableComponents()` to hand back a manually built block only
	// proves `#finalizeSnapshot` calls whatever function sits at that name --
	// not that the real tracker holds and clears the right component -- so
	// this drives an actual `hub` wait (still running, so it stays
	// displaceable) through a real `EventController`, the same tracker
	// `job-poll-displacement.test.ts` exercises in isolation.
	it("folds a displaceable poll/todo block into orphan cleanup when guest resync staging fails", async () => {
		installInMemoryRelay();
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		try {
			vi.useFakeTimers();

			const chatContainer = new TranscriptContainer();
			await Settings.init({ inMemory: true });

			// A real controller, not a stand-in: `#handleToolExecutionEnd` moves
			// the resulting component out of `pendingTools` into its own
			// displaceable tracker exactly as production code does, so a
			// regression in that tracker's bookkeeping fails this test too.
			const controllerCtx = createInteractiveModeContext({ chatContainer });
			const controller = new EventController(controllerCtx);
			const takeDisplaceableComponents = vi.spyOn(controller, "takeDisplaceableComponents");
			await controller.handleEvent({
				type: "tool_execution_start",
				toolCallId: "hub-wait-1",
				toolName: "hub",
				args: { op: "wait", ids: ["j0"] },
			} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
			await controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: "hub-wait-1",
				toolName: "hub",
				isError: false,
				result: {
					content: [{ type: "text", text: "" }],
					details: {
						op: "wait",
						jobs: [{ id: "j0", type: "task", status: "running", label: "job 0", durationMs: 1_000 }],
					},
				},
			} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

			// The wait is still running, so the block left `pendingTools` for the
			// controller's own displaceable tracker rather than a settled slot.
			expect(controllerCtx.pendingTools.size).toBe(0);
			const displaceableBlock = chatContainer.children.find(
				(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
			);
			if (!displaceableBlock) throw new Error("expected the hub wait to render a live block");
			expect(vi.getTimerCount()).toBeGreaterThan(0);

			const ctx = {
				settings: { get: () => "" },
				sessionManager: { getSessionFile: () => null, getSessionName: () => "local", getCwd: () => "/local" },
				session: {
					messages: [],
					switchSession: () => Promise.resolve(),
					newSession: () => Promise.resolve(),
					agent: {
						state: { model: undefined },
						setModel: () => {},
						setThinkingLevel: () => {},
						setDisableReasoning: () => {},
					},
				},
				statusContainer: { clear: () => {}, disposeChildren: () => {} },
				pendingMessagesContainer: { clear: () => {}, disposeChildren: () => {} },
				compactionQueuedMessages: [],
				streamingComponent: undefined,
				streamingMessage: undefined,
				transcriptMessageComponents: new WeakMap(),
				// pendingTools is empty: the displaceable block already left it when
				// its result settled, which is exactly the gap this test defends.
				pendingTools: new Map(),
				pendingBashComponents: [],
				pendingPythonComponents: [],
				lastAssistantUsage: undefined,
				initialChatRendered: true,
				hideToolActivity: false,
				loadingAnimation: undefined,
				statusLine: {
					setCollabStatus: () => {},
					invalidate: () => {},
					resetActiveTime: () => {},
					markActivityStart: () => {},
					markActivityEnd: () => {},
				},
				ui: { requestRender: () => {} },
				chatContainer,
				resetObserverRegistry: () => {},
				eventController: controller,
				renderInitialMessages: (options?: { clearTerminalHistory?: boolean }) =>
					uiHelpers.renderInitialMessages(options),
				renderSessionContext: (context: unknown, options: unknown) =>
					(uiHelpers.renderSessionContext as (c: unknown, o: unknown) => void)(context, options),
				// Fails the staged replay itself, so renderInitialMessages()'s own
				// rollback runs (restoring the untouched visible container) without
				// ever reaching the success-path disposeChildren() that would
				// otherwise unregister the orphaned block.
				renderSessionContextIncrementally: () => Promise.reject(new Error("staged rebuild boom")),
				viewSession: {
					isStreaming: false,
					buildTranscriptSessionContext: () => ({
						messages: [],
						thinkingLevel: "off",
						serviceTier: undefined,
						models: {},
						injectedTtsrRules: [],
						mode: "none",
					}),
					getToolByName: () => undefined,
					hasBuiltInTool: () => true,
					extensionRunner: undefined,
					sessionManager: { getEntries: () => [], getCwd: () => "/local" },
				},
				reloadTodos: () => Promise.resolve(),
				showStatus: () => {},
				showError: () => {},
				updateEditorTopBorder: () => {},
				updateEditorBorderColor: () => {},
				syncRunningSubagentBadge: () => {},
			} as unknown as InteractiveModeContext;
			const uiHelpers = new UiHelpers(ctx);

			const roomId = "spinner-resync-displaceable-room";
			const roomKey = generateRoomKey();
			const cryptoKey = await importRoomKey(roomKey);
			const link = formatCollabLink("ws://localhost:8788", roomId, roomKey);
			const hostSocket = new CollabSocket({
				wsUrl: `ws://localhost:8788/r/${roomId}`,
				role: "host",
				key: cryptoKey,
			});
			const hostOpen = Promise.withResolvers<void>();
			hostSocket.onOpen = () => hostOpen.resolve();
			hostSocket.onFrame = frame => {
				if (frame.t !== "hello") return;
				hostSocket.send({
					t: "welcome",
					proto: COLLAB_PROTO,
					header: {
						type: "session",
						id: "resync-displaceable-session",
						timestamp: "2026-06-26T00:00:00Z",
						cwd: "/tmp",
					},
					state: {
						isStreaming: false,
						queuedMessageCount: 0,
						sessionName: "host session",
						cwd: "/tmp",
						participants: [{ name: "Host", role: "host" }],
					},
					agents: [],
					entryCount: 0,
				});
			};
			hostSocket.connect();
			await hostOpen.promise;

			const guest = new CollabGuestLink(ctx);
			try {
				let joinError: unknown;
				try {
					await guest.join(link);
				} catch (err) {
					joinError = err;
				}
				expect(joinError).toBeInstanceOf(Error);
				expect((joinError as Error).message).toContain("staged rebuild boom");

				// #finalizeSnapshot folded the real displaceable tracker into its
				// orphan accounting.
				expect(takeDisplaceableComponents).toHaveBeenCalledTimes(1);
				// The tracker actually cleared its private fields, not merely handed
				// back the card once: a regression that returns the card without
				// clearing #displaceablePollComponent/#displaceableTodoComponent would
				// still pass every assertion above (the card is sealed and its timer
				// stopped once) while leaving EventController holding a stale
				// reference across the failed resync.
				expect(controller.takeDisplaceableComponents()).toEqual([]);
				// The block was stopped in place, not disposed from the tree: its
				// rendered row survives the failed resync untouched.
				expect(chatContainer.children).toContain(displaceableBlock);
				// ...but it no longer holds the shared ticker open.
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				hostSocket.close();
				await guest.leave("test cleanup").catch(() => {});
			}
		} finally {
			writeSpy.mockRestore();
			uninstallInMemoryRelay();
			stopSharedSpinnerTicker();
		}
	});

	// Regression (PR #9377 follow-up, codex review): every orphaned block in
	// this rollback path -- from `pendingTools` or from
	// `eventController.takeDisplaceableComponents()` -- is still a live,
	// rendered row in the untouched visible container. Calling `dispose()` on
	// it propagates teardown to its own renderer children
	// (`Container.dispose()`), releasing resources a still-visible row's
	// children may use. Only `seal()`, which stops the shared-ticker
	// registration without touching children, is safe here.
	it("seals rather than disposes orphaned blocks when guest resync staging fails", async () => {
		installInMemoryRelay();
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		try {
			vi.useFakeTimers();

			const chatContainer = new TranscriptContainer();
			const pendingBlock = new ToolExecutionComponent(
				"eval",
				{ language: "py", code: "import time\ntime.sleep(10)" },
				{},
				undefined,
				{ requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
				process.cwd(),
			);
			chatContainer.addChild(pendingBlock);
			const displaceableBlock = new ToolExecutionComponent(
				"eval",
				{ language: "py", code: "import time\ntime.sleep(10)" },
				{},
				undefined,
				{ requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
				process.cwd(),
			);
			chatContainer.addChild(displaceableBlock);
			expect(vi.getTimerCount()).toBeGreaterThan(0);

			const pendingDisposeSpy = spyOn(pendingBlock, "dispose");
			const displaceableDisposeSpy = spyOn(displaceableBlock, "dispose");

			await Settings.init({ inMemory: true });
			const ctx = {
				settings: { get: () => "" },
				sessionManager: { getSessionFile: () => null, getSessionName: () => "local", getCwd: () => "/local" },
				session: {
					messages: [],
					switchSession: () => Promise.resolve(),
					newSession: () => Promise.resolve(),
					agent: {
						state: { model: undefined },
						setModel: () => {},
						setThinkingLevel: () => {},
						setDisableReasoning: () => {},
					},
				},
				statusContainer: { clear: () => {}, disposeChildren: () => {} },
				pendingMessagesContainer: { clear: () => {}, disposeChildren: () => {} },
				compactionQueuedMessages: [],
				streamingComponent: undefined,
				streamingMessage: undefined,
				transcriptMessageComponents: new WeakMap(),
				pendingTools: new Map([["call-1", pendingBlock]]),
				pendingBashComponents: [],
				pendingPythonComponents: [],
				lastAssistantUsage: undefined,
				initialChatRendered: true,
				hideToolActivity: false,
				loadingAnimation: undefined,
				statusLine: {
					setCollabStatus: () => {},
					invalidate: () => {},
					resetActiveTime: () => {},
					markActivityStart: () => {},
					markActivityEnd: () => {},
				},
				ui: { requestRender: () => {} },
				chatContainer,
				resetObserverRegistry: () => {},
				eventController: { takeDisplaceableComponents: () => [displaceableBlock] },
				renderInitialMessages: (options?: { clearTerminalHistory?: boolean }) =>
					uiHelpers.renderInitialMessages(options),
				renderSessionContext: (context: unknown, options: unknown) =>
					(uiHelpers.renderSessionContext as (c: unknown, o: unknown) => void)(context, options),
				// Fails the staged replay itself, so renderInitialMessages()'s own
				// rollback runs (restoring the untouched visible container) without
				// ever reaching the success-path disposeChildren() that would
				// otherwise unregister the orphaned blocks.
				renderSessionContextIncrementally: () => Promise.reject(new Error("staged rebuild boom")),
				viewSession: {
					isStreaming: false,
					buildTranscriptSessionContext: () => ({
						messages: [],
						thinkingLevel: "off",
						serviceTier: undefined,
						models: {},
						injectedTtsrRules: [],
						mode: "none",
					}),
					getToolByName: () => undefined,
					hasBuiltInTool: () => true,
					extensionRunner: undefined,
					sessionManager: { getEntries: () => [], getCwd: () => "/local" },
				},
				reloadTodos: () => Promise.resolve(),
				showStatus: () => {},
				showError: () => {},
				updateEditorTopBorder: () => {},
				updateEditorBorderColor: () => {},
				syncRunningSubagentBadge: () => {},
			} as unknown as InteractiveModeContext;
			const uiHelpers = new UiHelpers(ctx);

			const roomId = "spinner-resync-seal-room";
			const roomKey = generateRoomKey();
			const cryptoKey = await importRoomKey(roomKey);
			const link = formatCollabLink("ws://localhost:8788", roomId, roomKey);
			const hostSocket = new CollabSocket({
				wsUrl: `ws://localhost:8788/r/${roomId}`,
				role: "host",
				key: cryptoKey,
			});
			const hostOpen = Promise.withResolvers<void>();
			hostSocket.onOpen = () => hostOpen.resolve();
			hostSocket.onFrame = frame => {
				if (frame.t !== "hello") return;
				hostSocket.send({
					t: "welcome",
					proto: COLLAB_PROTO,
					header: { type: "session", id: "resync-seal-session", timestamp: "2026-06-26T00:00:00Z", cwd: "/tmp" },
					state: {
						isStreaming: false,
						queuedMessageCount: 0,
						sessionName: "host session",
						cwd: "/tmp",
						participants: [{ name: "Host", role: "host" }],
					},
					agents: [],
					entryCount: 0,
				});
			};
			hostSocket.connect();
			await hostOpen.promise;

			const guest = new CollabGuestLink(ctx);
			try {
				let joinError: unknown;
				try {
					await guest.join(link);
				} catch (err) {
					joinError = err;
				}
				expect(joinError).toBeInstanceOf(Error);
				expect((joinError as Error).message).toContain("staged rebuild boom");

				// Both blocks were stopped in place, not disposed from the tree:
				// their rendered rows survive the failed resync untouched.
				expect(chatContainer.children).toContain(pendingBlock);
				expect(chatContainer.children).toContain(displaceableBlock);
				// ...but neither holds the shared ticker open any longer.
				expect(vi.getTimerCount()).toBe(0);
				// seal(), not dispose(): a rollback-preserved row's own renderer
				// children must not be torn down.
				expect(pendingDisposeSpy).not.toHaveBeenCalled();
				expect(displaceableDisposeSpy).not.toHaveBeenCalled();
			} finally {
				hostSocket.close();
				await guest.leave("test cleanup").catch(() => {});
			}
		} finally {
			writeSpy.mockRestore();
			uninstallInMemoryRelay();
			stopSharedSpinnerTicker();
		}
	});
});
