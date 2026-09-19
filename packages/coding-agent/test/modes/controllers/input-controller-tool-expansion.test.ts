import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { setLocale } from "../../../src/i18n";

beforeAll(() => {
	setLocale("en");
});

afterAll(() => {
	setLocale(null);
});

describe("InputController tool output expansion", () => {
	it("expands children and replays native history so retired blocks also re-render", () => {
		const expandable = { setExpanded: vi.fn() };
		const inert = { render: vi.fn(() => []) };
		const resetDisplay = vi.fn();
		const showStatus = vi.fn();
		const ctx = {
			toolOutputExpanded: false,
			chatContainer: { children: [expandable, inert] },
			ui: { resetDisplay },
			showStatus,
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(true);
		expect(expandable.setExpanded).toHaveBeenCalledWith(true);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
		expect(expandable.setExpanded.mock.invocationCallOrder[0]).toBeLessThan(resetDisplay.mock.invocationCallOrder[0]);
		expect(showStatus).toHaveBeenCalledWith("Tool output expansion: enabled");
	});

	it("does not expand hidden tool activity and explains why", () => {
		const expandable = { setExpanded: vi.fn() };
		const resetDisplay = vi.fn();
		const showStatus = vi.fn();
		const ctx = {
			hideToolActivity: true,
			toolOutputExpanded: false,
			chatContainer: { children: [expandable] },
			keybindings: { getDisplayString: vi.fn(() => "Alt+H") },
			showStatus,
			ui: { resetDisplay },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(false);
		expect(expandable.setExpanded).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Alt+H"));
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("/settings"));
	});
});

describe("InputController tool row folding", () => {
	it("folds the transcript, persists the choice, and replays native history", () => {
		const setToolRowsFolded = vi.fn();
		const set = vi.fn();
		const resetDisplay = vi.fn();
		const showStatus = vi.fn();
		const ctx = {
			foldToolRows: false,
			hideToolActivity: false,
			settings: { set },
			chatContainer: { setToolRowsFolded },
			showStatus,
			ui: { resetDisplay },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolRowsFolded();

		expect(ctx.foldToolRows).toBe(true);
		expect(set).toHaveBeenLastCalledWith("display.foldToolRows", true);
		expect(setToolRowsFolded).toHaveBeenCalledWith(true);
		// Rows already retired to native scrollback must replay under the fold.
		expect(setToolRowsFolded.mock.invocationCallOrder[0]).toBeLessThan(resetDisplay.mock.invocationCallOrder[0]);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenLastCalledWith("Tool rows: folded");

		new InputController(ctx).toggleToolRowsFolded();

		expect(ctx.foldToolRows).toBe(false);
		expect(set).toHaveBeenLastCalledWith("display.foldToolRows", false);
		expect(setToolRowsFolded).toHaveBeenLastCalledWith(false);
		expect(showStatus).toHaveBeenLastCalledWith("Tool rows: expanded");
	});

	it("does not fold hidden tool activity and explains why", () => {
		const setToolRowsFolded = vi.fn();
		const resetDisplay = vi.fn();
		const showStatus = vi.fn();
		const ctx = {
			foldToolRows: false,
			hideToolActivity: true,
			settings: { set: vi.fn() },
			chatContainer: { setToolRowsFolded },
			keybindings: { getDisplayString: vi.fn(() => "Ctrl+Shift+O") },
			showStatus,
			ui: { resetDisplay },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolRowsFolded();

		expect(ctx.foldToolRows).toBe(false);
		expect(setToolRowsFolded).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Ctrl+Shift+O"));
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("/settings"));
	});
});

describe("InputController tool activity visibility", () => {
	it("persists the toggle, preserves transient children, and reveals tools collapsed", () => {
		const pendingUserMessage = { kind: "pending-user" };
		const loadingIndicator = { kind: "loading" };
		const assistant = new AssistantMessageComponent();
		const setToolResultImagesVisible = vi.spyOn(assistant, "setToolResultImagesVisible");
		const children = [pendingUserMessage, assistant, loadingIndicator];
		const clear = vi.fn();
		const addChild = vi.fn();
		const rebuildChatFromMessages = vi.fn();
		const set = vi.fn();
		const clearInlineImages = vi.fn();
		const resetDisplay = vi.fn();
		const showStatus = vi.fn();
		const setToolActivityVisible = vi.fn();
		const ctx = {
			hideToolActivity: false,
			toolOutputExpanded: true,
			settings: { set },
			chatContainer: { children, clear, addChild, setToolActivityVisible },
			rebuildChatFromMessages,
			showStatus,
			ui: { clearInlineImages, resetDisplay },
		};
		const controller = new InputController(ctx as unknown as InteractiveModeContext) as unknown as InputController & {
			toggleToolActivityVisibility(): void;
		};

		controller.toggleToolActivityVisibility();

		expect(ctx.hideToolActivity).toBe(true);
		expect(set).toHaveBeenLastCalledWith("display.hideToolActivity", true);
		expect(ctx.chatContainer.children).toEqual(children);
		expect(clear).not.toHaveBeenCalled();
		expect(addChild).not.toHaveBeenCalled();
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(clearInlineImages).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
		expect(clearInlineImages.mock.invocationCallOrder[0]).toBeLessThan(resetDisplay.mock.invocationCallOrder[0]);
		expect(showStatus).toHaveBeenLastCalledWith("Tool activity: hidden");
		expect(setToolResultImagesVisible).toHaveBeenLastCalledWith(false);
		expect(setToolActivityVisible).toHaveBeenLastCalledWith(false);

		controller.toggleToolActivityVisibility();

		expect(ctx.hideToolActivity).toBe(false);
		expect(ctx.toolOutputExpanded).toBe(false);
		expect(set).toHaveBeenLastCalledWith("display.hideToolActivity", false);
		expect(ctx.chatContainer.children).toEqual(children);
		expect(clear).not.toHaveBeenCalled();
		expect(addChild).not.toHaveBeenCalled();
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(clearInlineImages).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(2);
		expect(showStatus).toHaveBeenLastCalledWith("Tool activity: visible");
		expect(setToolResultImagesVisible).toHaveBeenLastCalledWith(true);
		expect(setToolActivityVisible).toHaveBeenLastCalledWith(true);
	});
});
