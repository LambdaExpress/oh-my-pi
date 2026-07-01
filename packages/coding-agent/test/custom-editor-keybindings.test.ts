import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui";

describe("CustomEditor keybindings", () => {
	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	afterEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	it("routes the configured retry chord through handleInput", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();

		editor.setActionKeys("app.retry", ["alt+shift+r"]);
		editor.onRetry = onRetry;
		editor.handleInput("\x1bR");

		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("lets custom handlers keep precedence over the default retry chord", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();
		const customHandler = vi.fn();

		editor.onRetry = onRetry;
		editor.setCustomKeyHandler("alt+r", customHandler);
		editor.handleInput("\x1br");

		expect(customHandler).toHaveBeenCalledTimes(1);
		expect(onRetry).not.toHaveBeenCalled();
	});

	it("lets copy-prompt remaps keep precedence over the default retry chord", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();
		const onCopyPrompt = vi.fn();

		editor.onRetry = onRetry;
		editor.onCopyPrompt = onCopyPrompt;
		editor.setActionKeys("app.clipboard.copyPrompt", ["alt+r"]);
		editor.handleInput("\x1br");

		expect(onCopyPrompt).toHaveBeenCalledTimes(1);
		expect(onRetry).not.toHaveBeenCalled();
	});

	it("lets the default Ctrl+Z reach editor undo instead of suspend", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onSuspend = vi.fn();

		editor.onSuspend = onSuspend;
		editor.handleInput("a");
		editor.handleInput("b");
		editor.handleInput("\x1a");

		expect(editor.getText()).toBe("");
		expect(onSuspend).not.toHaveBeenCalled();
	});

	it("routes Ctrl+Z to suspend after an explicit app.suspend remap", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onSuspend = vi.fn();

		editor.onSuspend = onSuspend;
		editor.setActionKeys("app.suspend", ["ctrl+z"]);
		editor.handleInput("a");
		editor.handleInput("\x1a");

		expect(onSuspend).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("a");
	});
});
