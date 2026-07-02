import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { TreeSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tree-selector";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { type RenderScheduler, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

beforeAll(async () => {
	await initTheme();
});

function makeMessageNode(id: string, parentId: string | null, content: string): SessionTreeNode {
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

function makeTree(): SessionTreeNode {
	const root = makeMessageNode("root", null, "Root prompt");
	const firstChild = makeMessageNode("child-one", "root", "First child prompt");
	const secondChild = makeMessageNode("child-two", "root", "Second child prompt");
	root.children.push(firstChild, secondChild);
	return root;
}

function makeSelector(onSelect: (entryId: string) => void): TreeSelectorComponent {
	return new TreeSelectorComponent([makeTree()], "root", 40, onSelect, () => {});
}

function renderStripped(selector: TreeSelectorComponent): string[] {
	return selector.render(120).map(line => Bun.stripANSI(line));
}

async function settle(term: VirtualTerminal): Promise<void> {
	for (let i = 0; i < 3; i++) await Promise.resolve();
	await term.flush();
}

/** SGR left-button press at a 1-based screen row. */
function leftClick(row1Based: number, col1Based = 1): string {
	return `\x1b[<0;${col1Based};${row1Based}M`;
}

/** SGR no-button motion at a 1-based screen row. */
function hover(row1Based: number, col1Based = 6): string {
	return `\x1b[<35;${col1Based};${row1Based}M`;
}

/** SGR wheel notch: button 64 = up, 65 = down. */
function wheel(direction: "up" | "down"): string {
	return direction === "down" ? "\x1b[<65;1;9M" : "\x1b[<64;1;9M";
}

describe("TreeSelectorComponent mouse", () => {
	it("fills the viewport and pins the bottom border to the last row", () => {
		const selector = makeSelector(() => {});

		const lines = renderStripped(selector);

		expect(lines.length).toBe(40);
		expect(lines[lines.length - 1]!.trim().length).toBeGreaterThan(0);
		expect(lines.findIndex(line => line.includes("First child prompt"))).toBeGreaterThanOrEqual(0);
	});

	it("paints the fullscreen overlay bottom border on the last viewport row", async () => {
		let now = 0;
		const renderScheduler: RenderScheduler = {
			now: () => now,
			scheduleImmediate(callback) {
				queueMicrotask(callback);
			},
			scheduleRender(callback, delayMs) {
				let cancelled = false;
				queueMicrotask(() => {
					if (cancelled) return;
					now += delayMs;
					callback();
				});
				return {
					cancel() {
						cancelled = true;
					},
				};
			},
		};
		const term = new VirtualTerminal(120, 40, 200);
		const tui = new TUI(term, undefined, { renderScheduler });
		const selector = makeSelector(() => {});

		try {
			tui.start();
			tui.showOverlay(selector, {
				anchor: "top-left",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
			});
			await settle(term);

			const viewport = term.getViewport().map(line => line.trimEnd());
			expect(viewport.length).toBe(40);
			expect(viewport.some(line => line.includes("Session Tree"))).toBeTrue();
			expect(viewport.findIndex(line => line.includes("First child prompt"))).toBeGreaterThanOrEqual(0);
			expect(viewport[viewport.length - 1]!.trim().length).toBeGreaterThan(0);
		} finally {
			tui.stop();
		}
	});
	it("moves down one tree node with the wheel, then selects it on Enter", () => {
		const selected: string[] = [];
		const selector = makeSelector(entryId => selected.push(entryId));

		selector.render(120);
		selector.handleInput(wheel("down"));
		selector.handleInput("\n");

		expect(selected).toEqual(["child-one"]);
	});

	it("clamps wheel-up navigation at the first tree node", () => {
		const selected: string[] = [];
		const selector = makeSelector(entryId => selected.push(entryId));

		selector.render(120);
		selector.handleInput(wheel("up"));
		selector.handleInput("\n");

		expect(selected).toEqual(["root"]);
	});

	it("selects the tree node under a left click", () => {
		const selected: string[] = [];
		const selector = makeSelector(entryId => selected.push(entryId));

		const lines = renderStripped(selector);
		const childRow = lines.findIndex(line => line.includes("First child prompt"));
		expect(childRow).toBeGreaterThanOrEqual(0);

		selector.handleInput(leftClick(childRow + 1));

		expect(selected).toEqual(["child-one"]);
	});

	it("highlights a hovered tree node without changing keyboard selection", () => {
		const selected: string[] = [];
		const selector = makeSelector(entryId => selected.push(entryId));
		let renderRequests = 0;
		selector.setOnRequestRender(() => renderRequests++);
		const selectedBg = theme.getBgAnsi("selectedBg");

		const initialLines = selector.render(120);
		const childRow = initialLines.findIndex(line => Bun.stripANSI(line).includes("First child prompt"));
		expect(childRow).toBeGreaterThanOrEqual(0);
		expect(initialLines[childRow]!).not.toContain(selectedBg);

		selector.handleInput(hover(childRow + 1));

		expect(renderRequests).toBeGreaterThan(0);
		const hoveredLines = selector.render(120);
		expect(hoveredLines[childRow]!).toContain(selectedBg);

		selector.handleInput(hover(1));
		const clearedLines = selector.render(120);
		expect(clearedLines[childRow]!).not.toContain(selectedBg);

		selector.handleInput("\n");

		expect(selected).toEqual(["root"]);
	});

	it("ignores a left click on selector chrome", () => {
		const selected: string[] = [];
		const selector = makeSelector(entryId => selected.push(entryId));

		selector.render(120);
		selector.handleInput(leftClick(1));

		expect(selected).toEqual([]);
	});

	it("ignores wheel and click reports while label input is open", () => {
		const selected: string[] = [];
		const selector = makeSelector(entryId => selected.push(entryId));
		const lines = renderStripped(selector);
		const childRow = lines.findIndex(line => line.includes("First child prompt"));
		expect(childRow).toBeGreaterThanOrEqual(0);

		selector.handleInput("L");
		selector.render(120);
		selector.handleInput(wheel("down"));
		selector.handleInput(leftClick(childRow + 1));

		expect(selected).toEqual([]);

		selector.handleInput("\x1b");
		selector.handleInput("\n");

		expect(selected).toEqual(["root"]);
	});
});
