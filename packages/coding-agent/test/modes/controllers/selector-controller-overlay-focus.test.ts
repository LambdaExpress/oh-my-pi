import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SessionSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/session-selector";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { Component, OverlayOptions } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	resetSettingsForTest();
});

interface EditorSlot {
	children: unknown[];
	clear: () => void;
	addChild: (child: unknown) => void;
}

function createEditorSlot(...initial: unknown[]): EditorSlot {
	return {
		children: [...initial],
		clear() {
			this.children = [];
		},
		addChild(child: unknown) {
			this.children.push(child);
		},
	};
}

function createCtx(slot: EditorSlot, editor: unknown) {
	const setFocus = vi.fn();
	const ctx = {
		editor,
		editorContainer: slot,
		ui: {
			setFocus,
			requestRender: vi.fn(),
		},
	} as unknown as InteractiveModeContext;
	return { ctx, setFocus };
}

function createMessageNode(id: string, parentId: string | null, content: string): SessionTreeNode {
	const message: AgentMessage = { role: "user", content, timestamp: 1 };
	const entry: SessionEntry = {
		type: "message",
		id,
		parentId,
		timestamp: "2024-01-01T00:00:00Z",
		message,
	};
	return { entry, children: [] };
}

describe("SelectorController.focusActiveEditorArea", () => {
	// Regression for issue #3349: closing a fullscreen overlay (settings,
	// extensions dashboard, agents dashboard) while a hook selector / approval
	// prompt occupies the editor slot must restore focus to that prompt — not
	// to the editor that the prompt replaced. Pre-fix, the close handlers
	// hardcoded `setFocus(this.ctx.editor)`, leaving keystrokes routed to a
	// no-longer-mounted editor while the visible prompt sat unreachable.

	it("focuses the editor when the slot has only the editor in it", () => {
		const editor = { id: "editor" };
		const slot = createEditorSlot(editor);
		const { ctx, setFocus } = createCtx(slot, editor);

		new SelectorController(ctx).focusActiveEditorArea();

		expect(setFocus).toHaveBeenCalledTimes(1);
		expect(setFocus).toHaveBeenCalledWith(editor);
	});

	it("focuses the active hook-selector-style prompt when the slot holds it instead of the editor", () => {
		const editor = { id: "editor" };
		const approvalPrompt = { id: "approval-prompt" };
		// Mirrors `ExtensionUiController.showHookSelector`: the hook surface
		// clears the slot and replaces the editor with its prompt component.
		const slot = createEditorSlot(approvalPrompt);
		const { ctx, setFocus } = createCtx(slot, editor);

		new SelectorController(ctx).focusActiveEditorArea();

		expect(setFocus).toHaveBeenCalledTimes(1);
		expect(setFocus).toHaveBeenCalledWith(approvalPrompt);
		expect(setFocus).not.toHaveBeenCalledWith(editor);
	});

	it("falls back to the editor when the slot is empty (defensive)", () => {
		const editor = { id: "editor" };
		const slot = createEditorSlot();
		const { ctx, setFocus } = createCtx(slot, editor);

		new SelectorController(ctx).focusActiveEditorArea();

		expect(setFocus).toHaveBeenCalledTimes(1);
		expect(setFocus).toHaveBeenCalledWith(editor);
	});
});

describe("SelectorController.showTreeSelector", () => {
	it("opens the tree picker as a fullscreen top-left overlay and focuses it", () => {
		const editor = { id: "editor" };
		const slot = createEditorSlot(editor);
		const root = createMessageNode("root", null, "Root prompt");
		root.children.push(createMessageNode("child", "root", "Child prompt"));
		const overlayHandle = { hide: vi.fn() };
		const showOverlay = vi.fn((_component: Component, _options: OverlayOptions) => overlayHandle);
		const setFocus = vi.fn();
		const requestRender = vi.fn();
		const ctx = {
			editor,
			editorContainer: slot,
			ui: {
				terminal: { rows: 40 },
				showOverlay,
				setFocus,
				requestRender,
			},
			sessionManager: {
				getTree: () => [root],
				getLeafId: () => "root",
				appendLabelChange: vi.fn(),
			},
			showStatus: vi.fn(),
		} as unknown as InteractiveModeContext;

		new SelectorController(ctx).showTreeSelector();

		expect(showOverlay).toHaveBeenCalledTimes(1);
		const overlayCall = showOverlay.mock.calls[0];
		expect(overlayCall).toBeDefined();
		const [selector, options] = overlayCall!;
		expect(options).toEqual({
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		expect(setFocus).toHaveBeenCalledWith(selector);
		expect(requestRender).toHaveBeenCalled();
		expect(slot.children).toEqual([editor]);
	});
});

describe("SelectorController session replacement overlay", () => {
	it("keeps the fullscreen selector visible until the resumed transcript is ready", async () => {
		const session: SessionInfo = {
			path: "/tmp/resume.jsonl",
			id: "resume",
			cwd: "/tmp",
			title: "Resume target",
			created: new Date("2026-01-01T00:00:00Z"),
			modified: new Date("2026-01-02T00:00:00Z"),
			messageCount: 2,
			size: 1,
			firstMessage: "first",
			allMessagesText: "first second",
		};
		vi.spyOn(SessionManager, "list").mockResolvedValue([session]);

		const overlayHidden = Promise.withResolvers<void>();
		const hide = vi.fn(() => overlayHidden.resolve());
		let selector: SessionSelectorComponent | undefined;
		const editor = { id: "editor" };
		const editorContainer = createEditorSlot(editor);
		const ctx = {
			editor,
			editorContainer,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionDir: () => "/tmp",
			},
			ui: {
				showOverlay: vi.fn(component => {
					selector = component as SessionSelectorComponent;
					return { hide, setHidden: vi.fn(), isHidden: () => false };
				}),
				setFocus: vi.fn(),
				requestRender: vi.fn(),
				terminal: { rows: 24 },
			},
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);
		const resumeStarted = Promise.withResolvers<void>();
		const resumed = Promise.withResolvers<boolean>();
		const handleResume = vi.spyOn(controller, "handleResumeSession").mockImplementation(() => {
			resumeStarted.resolve();
			return resumed.promise;
		});
		await controller.showSessionSelector();
		expect(selector).toBeDefined();
		selector!.handleInput("\n");
		await resumeStarted.promise;

		expect(handleResume).toHaveBeenCalledWith(session.path);
		expect(hide).not.toHaveBeenCalled();

		// The selector remains mounted until resume finishes, but it must not accept
		// a second selection or cancel the overlay during that interval.
		selector!.handleInput("\n");
		selector!.handleInput("\x1b");
		expect(handleResume).toHaveBeenCalledTimes(1);
		expect(hide).not.toHaveBeenCalled();

		resumed.resolve(true);
		await overlayHidden.promise;
		expect(hide).toHaveBeenCalledTimes(1);
	});
});
