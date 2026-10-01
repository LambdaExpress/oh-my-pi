import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	formatDoubleTap,
	formatKeyHint,
	getDefaultPasteImageKeys,
	KeybindingsManager,
	setKeyHintPlatform,
} from "@oh-my-pi/pi-tui/app-keybindings";
import { ensureThemeSync, setThemeInstance, theme, type Theme } from "@oh-my-pi/pi-tui/theme/theme";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";

let previousTheme: Theme;

beforeEach(() => {
	ensureThemeSync();
	previousTheme = theme;
	setThemeInstance(loadThemeSync("dark", { symbolPresetOverride: "unicode" }));
	setKeyHintPlatform("linux");
});

afterEach(() => {
	setKeyHintPlatform(undefined);
	setThemeInstance(previousTheme);
});

describe("KeybindingsManager.getDisplayString", () => {
	it("formats multiple bindings with the existing separator", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.clipboard.copyPrompt": ["alt+shift+c", "ctrl+shift+c"],
		});

		expect(keybindings.getDisplayString("app.clipboard.copyPrompt")).toBe("Alt+⇧C/Ctrl+⇧C");
	});

	it("returns an empty string when the action has no binding", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.clipboard.copyPrompt": [],
		});

		expect(keybindings.getDisplayString("app.clipboard.copyPrompt")).toBe("");
	});

	it("keeps Alt and Super labels off macOS", () => {
		setKeyHintPlatform("linux");
		const keybindings = KeybindingsManager.inMemory({
			"app.display.reset": "alt+l",
			"app.clipboard.pasteImage": ["ctrl+v", "super+v"],
		});

		expect(keybindings.getDisplayString("app.display.reset")).toBe("Alt+L");
		expect(keybindings.getDisplayString("app.clipboard.pasteImage")).toBe("Ctrl+V/Super+V");
	});
});

describe("formatKeyHint with keycap glyphs", () => {
	it("abuts macOS glyph modifiers and keeps Ctrl/Alt/Super as words elsewhere", () => {
		setKeyHintPlatform("darwin");
		expect(formatKeyHint("ctrl+shift+c")).toBe("⌃⇧C");
		expect(formatKeyHint("alt+up")).toBe("⌥↑");
		expect(formatKeyHint("super+v")).toBe("⌘V");

		setKeyHintPlatform("linux");
		expect(formatKeyHint("ctrl+shift+c")).toBe("Ctrl+⇧C");
		expect(formatKeyHint("alt+up")).toBe("Alt+↑");
		expect(formatKeyHint("super+v")).toBe("Super+V");
	});

	it("orders modifiers canonically regardless of binding order", () => {
		setKeyHintPlatform("darwin");
		expect(formatKeyHint("shift+ctrl+p")).toBe("⌃⇧P");
		expect(formatKeyHint("super+shift+alt+k")).toBe("⌥⇧⌘K");
	});

	it("keeps a bare letter lowercase but capitalizes it inside a chord", () => {
		expect(formatKeyHint("q")).toBe("q");
		expect(formatKeyHint("shift+g")).toBe("⇧G");
	});

	it("renders a bare modifier and the plus key itself", () => {
		setKeyHintPlatform("linux");
		expect(formatKeyHint("shift")).toBe("⇧");
		expect(formatKeyHint("ctrl++")).toBe("Ctrl++");
		expect(formatKeyHint("+")).toBe("+");
	});

	it("spaces a double tap only when the key renders as a word", () => {
		expect(formatDoubleTap("left")).toBe("←←");
		setThemeInstance(loadThemeSync("dark", { symbolPresetOverride: "ascii" }));
		expect(formatDoubleTap("left")).toBe("Left Left");
	});

	it("separates nerd icons so adjacent keycaps stay legible", () => {
		setKeyHintPlatform("darwin");
		setThemeInstance(loadThemeSync("dark", { symbolPresetOverride: "nerd" }));
		expect(formatKeyHint("shift+tab")).toBe("\u{f0636} \u{f0312}");
		expect(formatKeyHint("ctrl+shift+c")).toBe("\u{f0634} \u{f0636} C");
	});
});

describe("getDefaultPasteImageKeys", () => {
	it("keeps Ctrl+V registered for image paste on Windows alongside the terminal-safe fallback", () => {
		expect(getDefaultPasteImageKeys("win32")).toEqual(["ctrl+v", "alt+v"]);
	});

	it("adds the macOS Command key event to Ctrl+V for image paste", () => {
		expect(getDefaultPasteImageKeys("linux")).toEqual(["ctrl+v"]);
		expect(getDefaultPasteImageKeys("darwin")).toEqual(["ctrl+v", "super+v"]);
	});
});
