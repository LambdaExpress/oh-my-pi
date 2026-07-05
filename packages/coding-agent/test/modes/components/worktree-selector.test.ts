import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import {
	WorktreeSelectorComponent,
	type WorktreeSelectorItem,
} from "@oh-my-pi/pi-coding-agent/modes/components/worktree-selector";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { setKeybindings } from "@oh-my-pi/pi-tui";

const DOWN = "\x1b[B";
const ENTER = "\n";
const ESC = "\x1b";

function leftClick(row1Based: number, col1Based = 4): string {
	return `\x1b[<0;${col1Based};${row1Based}M`;
}

function wheel(direction: "up" | "down", row1Based = 2): string {
	return `\x1b[<${direction === "down" ? 65 : 64};1;${row1Based}M`;
}

function makeItems(): WorktreeSelectorItem[] {
	return [
		{
			id: "ready-alpha",
			name: "Alpha workspace",
			state: "ready",
			worktreeRoot: "/repo/.omp/wt/alpha",
			targetCwd: "/repo/.omp/wt/alpha/pkg",
			baseRef: "main",
			branch: null,
			detached: true,
			title: "Fix parser regression",
			sessionFile: "/repo/.omp/sessions/alpha.jsonl",
			snapshotPath: null,
			appliedAt: null,
		},
		{
			id: "snap-beta",
			name: "Beta snapshot",
			state: "snapshotted",
			worktreeRoot: "/repo/.omp/wt/beta",
			targetCwd: "/repo/.omp/wt/beta",
			baseRef: "main",
			branch: "feature/beta",
			detached: false,
			title: null,
			sessionFile: null,
			snapshotPath: "/repo/.omp/wt/snapshots/beta",
			appliedAt: null,
		},
	];
}

describe("WorktreeSelectorComponent", () => {
	beforeAll(async () => {
		const darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Expected dark theme");
		setThemeInstance(darkTheme);
	});

	beforeEach(() => {
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "escape" }));
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
		vi.restoreAllMocks();
	});

	it("renders managed worktree state and every visible action", () => {
		const component = new WorktreeSelectorComponent(makeItems(), { onPick: vi.fn(), onCancel: vi.fn() });

		const output = stripVTControlCharacters(component.render(100).join("\n"));

		expect(output).toContain("Managed worktrees");
		expect(output).toContain("Alpha workspace");
		expect(output).toContain("Switch to");
		expect(output).toContain("Move current session to");
		expect(output).toContain("Apply Alpha workspace locally");
		expect(output).toContain("Create branch for");
		expect(output).toContain("Remove");
		expect(output).toContain("Beta snapshot");
		expect(output).toContain("Restore Beta snapshot from snapshot");
		expect(output).toContain("/repo/.omp/wt/snapshots/beta");
	});

	it("runs the default action for the selected worktree on Enter", () => {
		const onPick = vi.fn();
		const component = new WorktreeSelectorComponent(makeItems(), { onPick, onCancel: vi.fn() });

		component.handleInput(ENTER);

		expect(onPick).toHaveBeenCalledWith({ action: "switch", id: "ready-alpha" });
	});

	it("moves selection with the keyboard and chooses move-current before merge", () => {
		const onPick = vi.fn();
		const component = new WorktreeSelectorComponent(makeItems(), { onPick, onCancel: vi.fn() });

		component.handleInput(DOWN);
		component.handleInput(ENTER);

		expect(onPick).toHaveBeenCalledWith({ action: "move-current", id: "ready-alpha" });
	});

	it("moves selection with the mouse wheel before Enter", () => {
		const onPick = vi.fn();
		const component = new WorktreeSelectorComponent(makeItems(), { onPick, onCancel: vi.fn() });
		component.render(100);

		for (let i = 0; i < 5; i++) component.handleInput(wheel("down"));
		component.handleInput(ENTER);

		expect(onPick).toHaveBeenCalledWith({ action: "restore", id: "snap-beta" });
	});

	it("runs the visible action under a mouse click", () => {
		const onPick = vi.fn();
		const component = new WorktreeSelectorComponent(makeItems(), { onPick, onCancel: vi.fn() });

		const lines = component.render(100);
		const removeRow = lines.findIndex(line => stripVTControlCharacters(line).includes("Remove Alpha workspace"));
		expect(removeRow).toBeGreaterThanOrEqual(0);
		component.handleInput(leftClick(removeRow + 1));

		expect(onPick).toHaveBeenCalledWith({ action: "remove", id: "ready-alpha" });
	});

	it("cancels on Esc without triggering an action", () => {
		const onPick = vi.fn();
		const onCancel = vi.fn();
		const component = new WorktreeSelectorComponent(makeItems(), { onPick, onCancel });

		component.handleInput(ESC);

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onPick).not.toHaveBeenCalled();
	});

	it("highlights the hovered worktree action while keeping Enter on the keyboard selection", () => {
		const onPick = vi.fn();
		const component = new WorktreeSelectorComponent(makeItems(), { onPick, onCancel: vi.fn() });
		const initialLines = component.render(100);
		const betaRow = initialLines.findIndex(line => stripVTControlCharacters(line).includes("Beta snapshot"));
		expect(betaRow).toBeGreaterThanOrEqual(0);
		expect(initialLines[betaRow]).not.toContain(theme.getBgAnsi("selectedBg"));

		component.handleInput(`\x1b[<35;4;${betaRow + 1}M`);

		const hoveredLines = component.render(100);
		expect(hoveredLines[betaRow]).toContain(theme.getBgAnsi("selectedBg"));
		component.handleInput(ENTER);
		expect(onPick).toHaveBeenCalledWith({ action: "switch", id: "ready-alpha" });
	});
});
