import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { setLocale } from "../../../src/i18n";
import { cfgDisplayHideToolActivity } from "@oh-my-pi/pi-coding-agent/modes/settings";

beforeAll(() => {
	setLocale("en");
});

afterAll(() => {
	setLocale(null);
});

afterEach(() => {
	vi.restoreAllMocks();
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
	});

	it("does not expand or replay hidden tool activity", () => {
		const expandable = { setExpanded: vi.fn() };
		const resetDisplay = vi.fn();
		const showStatus = vi.fn();
		const ctx = {
			hideToolActivity: true,
			toolOutputExpanded: false,
			chatContainer: { children: [expandable] },
			keybindings: { getKeys: vi.fn(() => ["alt+h"]) },
			showStatus,
			ui: { resetDisplay },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(false);
		expect(expandable.setExpanded).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
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

		new InputController(ctx).toggleToolRowsFolded();

		expect(ctx.foldToolRows).toBe(false);
		expect(set).toHaveBeenLastCalledWith("display.foldToolRows", false);
		expect(setToolRowsFolded).toHaveBeenLastCalledWith(false);
		expect(resetDisplay).toHaveBeenCalledTimes(2);
	});

	it("does not fold, persist, or replay hidden tool activity", () => {
		const setToolRowsFolded = vi.fn();
		const resetDisplay = vi.fn();
		const showStatus = vi.fn();
		const ctx = {
			foldToolRows: false,
			hideToolActivity: true,
			settings: { set: vi.fn() },
			chatContainer: { setToolRowsFolded },
			keybindings: { getKeys: vi.fn(() => ["alt+h"]) },
			showStatus,
			ui: { resetDisplay },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolRowsFolded();

		expect(ctx.foldToolRows).toBe(false);
		expect(ctx.settings.set).not.toHaveBeenCalled();
		expect(setToolRowsFolded).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
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
		const settings = Settings.isolated();
		const clearInlineImages = vi.fn();
		const resetDisplay = vi.fn();
		const showStatus = vi.fn();
		const setToolActivityVisible = vi.fn();
		const ctx = {
			hideToolActivity: false,
			toolOutputExpanded: true,
			settings,
			chatContainer: { children, clear, addChild, setToolActivityVisible },
			rebuildChatFromMessages,
			showStatus,
			ui: { clearInlineImages, resetDisplay },
		};
		const controller = new InputController(ctx as unknown as InteractiveModeContext);

		controller.toggleToolActivityVisibility();

		expect(ctx.hideToolActivity).toBe(true);
		expect(cfgDisplayHideToolActivity.get(settings)).toBe(true);
		expect(ctx.chatContainer.children).toEqual(children);
		expect(clear).not.toHaveBeenCalled();
		expect(addChild).not.toHaveBeenCalled();
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(clearInlineImages).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
		expect(clearInlineImages.mock.invocationCallOrder[0]).toBeLessThan(resetDisplay.mock.invocationCallOrder[0]);
		expect(setToolResultImagesVisible).toHaveBeenLastCalledWith(false);
		expect(setToolActivityVisible).toHaveBeenLastCalledWith(false);

		controller.toggleToolActivityVisibility();

		expect(ctx.hideToolActivity).toBe(false);
		expect(ctx.toolOutputExpanded).toBe(false);
		expect(cfgDisplayHideToolActivity.get(settings)).toBe(false);
		expect(ctx.chatContainer.children).toEqual(children);
		expect(clear).not.toHaveBeenCalled();
		expect(addChild).not.toHaveBeenCalled();
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(clearInlineImages).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(2);
		expect(setToolResultImagesVisible).toHaveBeenLastCalledWith(true);
		expect(setToolActivityVisible).toHaveBeenLastCalledWith(true);
	});
});
