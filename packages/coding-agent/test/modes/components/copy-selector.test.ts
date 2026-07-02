import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { CopySelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/copy-selector";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { CopyTarget } from "@oh-my-pi/pi-coding-agent/modes/utils/copy-targets";
import { setKeybindings } from "@oh-my-pi/pi-tui";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\n";
const CANCEL = "\x07"; // ctrl+g, remapped to tui.select.cancel below

function leftClick(row1Based: number, col1Based = 4): string {
	return `\x1b[<0;${col1Based};${row1Based}M`;
}

function hover(row1Based: number, col1Based = 6): string {
	return `\x1b[<35;${col1Based};${row1Based}M`;
}

function wheel(direction: "up" | "down", row1Based = 2): string {
	return `\x1b[<${direction === "down" ? 65 : 64};1;${row1Based}M`;
}

let darkTheme = await getThemeByName("dark");

// Flatten order (always expanded): msg:1, Block 1, Block 2, msg:2.
function makeRoots(): CopyTarget[] {
	return [
		{
			id: "msg:1",
			label: "Newest message",
			hint: "5 lines · 2 code",
			preview: "newest-preview-text",
			content: "FULL_MESSAGE",
			copyMessage: "Copied last message to clipboard",
			children: [
				{
					id: "msg:1:code:0",
					label: "Block 1",
					hint: "ts",
					language: "ts",
					preview: "alpha()",
					content: "BLOCK0",
					copyMessage: "Copied block 1",
				},
				{
					id: "msg:1:code:1",
					label: "Block 2",
					hint: "py",
					language: "python",
					preview: "beta()",
					content: "BLOCK1",
					copyMessage: "Copied block 2",
				},
			],
		},
		{
			id: "msg:2",
			label: "Older message",
			hint: "3 lines",
			preview: "older-text",
			content: "OLDER",
			copyMessage: "Copied message",
		},
	];
}

function render(component: CopySelectorComponent): string {
	return stripVTControlCharacters(component.render(80).join("\n"));
}

describe("CopySelectorComponent", () => {
	beforeAll(async () => {
		darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Failed to load dark theme");
	});

	beforeEach(() => {
		setThemeInstance(darkTheme!);
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "ctrl+g" }));
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
		vi.restoreAllMocks();
	});

	it("renders an outlined tree with code blocks nested under their message", () => {
		const out = render(new CopySelectorComponent(makeRoots(), { onPick: vi.fn(), onCancel: vi.fn() }));
		expect(out).toContain(theme.boxRound.topLeft);
		expect(out).toContain("│");
		expect(out).toContain("Copy to clipboard");
		// Messages and their nested blocks are all visible (always expanded),
		// connected with /tree-style branch glyphs.
		expect(out).toContain("Newest message");
		expect(out).toContain("Block 1");
		expect(out).toContain("Block 2");
		expect(out).toContain("Older message");
		expect(out).toMatch(/[├└]/);
	});

	it("copies the message node itself on Enter", () => {
		const onPick = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });

		component.handleInput(ENTER); // cursor starts on the message node

		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick.mock.calls[0]![0].content).toBe("FULL_MESSAGE");
	});

	it("navigates into a nested code block and copies it", () => {
		const onPick = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });

		component.handleInput(DOWN); // onto "Block 1"
		component.handleInput(ENTER);

		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick.mock.calls[0]![0].content).toBe("BLOCK0");
	});

	it("traverses past nested blocks to the older message, with the preview tracking the cursor", () => {
		const component = new CopySelectorComponent(makeRoots(), { onPick: vi.fn(), onCancel: vi.fn() });

		component.handleInput(DOWN); // Block 1
		expect(render(component)).toContain("alpha()");

		component.handleInput(DOWN); // Block 2
		component.handleInput(DOWN); // Older message
		expect(render(component)).toContain("older-text");

		component.handleInput(UP); // back onto Block 2
		expect(render(component)).toContain("beta()");
	});

	it("moves the copy cursor with the wheel and copies the new target on Enter", () => {
		const onPick = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });

		component.render(80);
		component.handleInput(wheel("down"));
		expect(render(component)).toContain("alpha()");

		component.handleInput(ENTER);

		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick.mock.calls[0]![0].content).toBe("BLOCK0");
	});

	it("copies the target under a left click", () => {
		const onPick = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });

		const lines = component.render(80);
		const block2Row = lines.findIndex(line => stripVTControlCharacters(line).includes("Block 2"));
		expect(block2Row).toBeGreaterThanOrEqual(0);

		component.handleInput(leftClick(block2Row + 1));

		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick.mock.calls[0]![0].content).toBe("BLOCK1");
	});

	it("highlights a hovered target without changing Enter selection", () => {
		const onPick = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });
		const selectedBg = theme.getBgAnsi("selectedBg");

		const initialOutput = render(component);
		expect(initialOutput).toContain("newest-preview-text");
		expect(initialOutput).not.toContain("alpha()");

		const initialLines = component.render(80);
		const block1Row = initialLines.findIndex(line => stripVTControlCharacters(line).includes("Block 1"));
		expect(block1Row).toBeGreaterThanOrEqual(0);
		expect(initialLines[block1Row]!).not.toContain(selectedBg);

		component.handleInput(hover(block1Row + 1));

		const hoveredLines = component.render(80);
		expect(hoveredLines[block1Row]!).toContain(selectedBg);
		expect(stripVTControlCharacters(hoveredLines.join("\n"))).toContain("alpha()");
		expect(onPick).not.toHaveBeenCalled();

		component.handleInput(ENTER);

		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick.mock.calls[0]![0].content).toBe("FULL_MESSAGE");
	});

	it("clears hover preview when the pointer leaves the tree", () => {
		const component = new CopySelectorComponent(makeRoots(), { onPick: vi.fn(), onCancel: vi.fn() });

		const lines = component.render(80);
		const block1Row = lines.findIndex(line => stripVTControlCharacters(line).includes("Block 1"));
		const previewRow = lines.findIndex(line => stripVTControlCharacters(line).includes("Preview"));
		expect(block1Row).toBeGreaterThanOrEqual(0);
		expect(previewRow).toBeGreaterThanOrEqual(0);

		component.handleInput(hover(block1Row + 1));
		expect(render(component)).toContain("alpha()");

		component.handleInput(hover(previewRow + 1));

		const afterPointerLeave = render(component);
		expect(afterPointerLeave).toContain("newest-preview-text");
		expect(afterPointerLeave).not.toContain("alpha()");
	});

	it("ignores clicks outside the copy tree", () => {
		const onPick = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });

		const lines = component.render(80);
		const previewRow = lines.findIndex(line => stripVTControlCharacters(line).includes("Preview"));
		expect(previewRow).toBeGreaterThanOrEqual(0);

		component.handleInput(leftClick(previewRow + 1));

		expect(onPick).not.toHaveBeenCalled();
	});

	it("quits on the cancel key", () => {
		const onCancel = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick: vi.fn(), onCancel });

		component.handleInput(CANCEL);

		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});
