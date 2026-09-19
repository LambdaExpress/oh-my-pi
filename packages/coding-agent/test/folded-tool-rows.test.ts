import { beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme";
import { Text, type TUI } from "@oh-my-pi/pi-tui";

const uiStub = {
	requestRender() {},
	requestComponentRender() {},
	resetDisplay() {},
} as unknown as TUI;

const darkTheme = await getThemeByName("dark");

/** One rendered tool row, control sequences stripped. */
function visibleRows(component: { render(width: number): readonly string[] }, width = 200): string[] {
	return component.render(width).map(line => stripVTControlCharacters(line));
}

function toolCard(toolName: string, args: unknown, label?: string): ToolExecutionComponent {
	const tool = label === undefined ? undefined : ({ label } as unknown as AgentTool);
	return new ToolExecutionComponent(toolName, args, {}, tool, uiStub);
}

/** Settle a card so its folded row is asserted without the live-call spinner. */
function settle(card: ToolExecutionComponent, details?: unknown): ToolExecutionComponent {
	card.updateResult({ content: [{ type: "text", text: "ok" }], details });
	return card;
}

describe("folded tool rows", () => {
	beforeEach(() => {
		if (!darkTheme) throw new Error("Failed to load dark theme");
		setThemeInstance(darkTheme);
	});

	it("folds an eval call to its title and restores the code cell", () => {
		const card = toolCard("eval", { language: "py", title: "stall vs fix production", code: "print(1)" }, "Eval");
		expect(visibleRows(card).join("\n")).toContain("print(1)");

		card.setToolRowsFolded(true);
		const folded = visibleRows(card);
		expect(folded).toHaveLength(1);
		expect(folded[0]!.trim()).toEndWith("Eval: stall vs fix production");

		card.setToolRowsFolded(false);
		expect(visibleRows(card).join("\n")).toContain("print(1)");
	});

	it("keeps a live call's spinner on the folded row", () => {
		const card = toolCard("eval", { language: "py", title: "still running", code: "sleep(1)" }, "Eval");
		card.setExecutionStarted();
		card.setToolRowsFolded(true);

		const row = visibleRows(card)[0] ?? "";
		expect(row.trim().endsWith("Eval: still running")).toBe(true);
		expect(row.trim()).not.toBe("Eval: still running");
	});

	it("folds an edit to its path and green/red change counts", () => {
		const target = path.join(os.homedir(), "project", "README.md");
		const card = toolCard("edit", { file_path: target }, "Edit");
		card.updateResult({
			content: [{ type: "text", text: "Updated README.md" }],
			details: { diff: "@@ -1,2 +1,4 @@\n-old\n+new\n+more\n+most" },
		});
		card.setToolRowsFolded(true);

		const row = card.render(200)[0] ?? "";
		expect(stripVTControlCharacters(row)).toBe(" Edit: ~/project/README.md +3 -1");
		// File targets keep the accent color every card header gives a path.
		expect(row).toContain(theme.fg("accent", "~/project/README.md"));
		// The counts keep their diff colors while folded, not just their digits.
		expect(row).toContain(theme.fg("toolDiffAdded", "+3"));
		expect(row).toContain(theme.fg("toolDiffRemoved", "-1"));
	});

	it("keeps file targets accented and other details muted", () => {
		const written = settle(toolCard("write", { file_path: "src/app.ts" }, "Write"));
		written.setToolRowsFolded(true);
		const writeRow = written.render(200)[0] ?? "";
		expect(writeRow).toContain(theme.fg("accent", "src/app.ts"));

		// A write reports how many lines it wrote, in the same color a folded
		// edit uses for its `+N`.
		const filled = settle(toolCard("write", { file_path: "src/app.ts", content: "a\nb\nc" }, "Write"));
		filled.setToolRowsFolded(true);
		const filledRow = filled.render(200)[0] ?? "";
		expect(stripVTControlCharacters(filledRow).trim()).toBe("Write: src/app.ts +3");
		expect(filledRow).toContain(theme.fg("toolDiffAdded", "+3"));

		// A renderer-less tool folds through the generic fallback: its path is a
		// target, its pattern is prose.
		const read = settle(toolCard("read", { path: "src/index.ts" }));
		read.setToolRowsFolded(true);
		expect(read.render(200)[0] ?? "").toContain(theme.fg("accent", "src/index.ts"));

		const grep = settle(toolCard("grep", { pattern: "useState" }));
		grep.setToolRowsFolded(true);
		expect(grep.render(200)[0] ?? "").toContain(theme.fg("muted", "useState"));
	});

	it("folds a device write to the operation it ran, not the device URL", () => {
		const mounted = new Map<string, AgentTool>([["adb", { label: "ADB" } as unknown as AgentTool]]);
		const writeTool = {
			label: "Write",
			session: { xdev: { mountedNames: new Set(["adb"]), tools: mounted } },
		} as unknown as AgentTool;
		const deviceCard = (content: string) =>
			new ToolExecutionComponent("write", { path: "xd://adb", content }, {}, writeTool, uiStub);

		const shell = settle(deviceCard('{"op":"shell","command":"logcat -d"}'));
		shell.setToolRowsFolded(true);
		expect(visibleRows(shell).map(row => row.trim())).toEqual(["ADB: shell logcat -d"]);

		// A file subject inside the device args keeps its accent color.
		const pull = settle(deviceCard('{"op":"pull","path":"/sdcard/shot.png"}'));
		pull.setToolRowsFolded(true);
		const pullRow = pull.render(200)[0] ?? "";
		expect(stripVTControlCharacters(pullRow).trim()).toBe("ADB: pull /sdcard/shot.png");
		expect(pullRow).toContain(theme.fg("accent", "/sdcard/shot.png"));

		// Payloads the known keys do not name still say what the call acts on.
		const tap = settle(deviceCard('{"op":"tap","x":540,"y":1200}'));
		tap.setToolRowsFolded(true);
		expect(visibleRows(tap).map(row => row.trim())).toEqual(["ADB: tap 540 1200"]);

		const mcpTool = {
			label: "Write",
			session: {
				xdev: {
					mountedNames: new Set(["mcp__atlassian__downloadjiraattachment"]),
					tools: new Map([
						[
							"mcp__atlassian__downloadjiraattachment",
							{ label: "atlassian/downloadJiraAttachment" } as unknown as AgentTool,
						],
					]),
				},
			},
		} as unknown as AgentTool;
		const attachment = settle(
			new ToolExecutionComponent(
				"write",
				{
					path: "xd://mcp__atlassian__downloadjiraattachment",
					content: '{"issue":"CEN21-7022","filename":"evidence.zip"}',
				},
				{},
				mcpTool,
				uiStub,
			),
		);
		attachment.setToolRowsFolded(true);
		expect(visibleRows(attachment).map(row => row.trim())).toEqual(["atlassian/downloadJiraAttachment: CEN21-7022"]);
	});

	it("folds a failed call with an error cue a successful one does not carry", () => {
		const failing = toolCard("bash", { command: "exit 1" }, "Bash");
		failing.updateResult({ content: [{ type: "text", text: "boom" }], isError: true });
		failing.setToolRowsFolded(true);
		const succeeded = toolCard("bash", { command: "true" }, "Bash");
		succeeded.updateResult({ content: [{ type: "text", text: "ok" }] });
		succeeded.setToolRowsFolded(true);

		const failedRow = failing.render(120)[0] ?? "";
		expect(failedRow).toContain(theme.styledSymbol("status.error", "error"));
		expect(failedRow).toContain(theme.fg("error", theme.bold("Bash")));
		expect(succeeded.render(120)[0] ?? "").not.toContain(theme.styledSymbol("status.error", "error"));
	});

	it("keeps an interrupted call neutral while folded", () => {
		// A steering interrupt sets isError on its placeholder; the full card
		// renders that as normal control flow, and the folded row must match.
		const card = toolCard("bash", { command: "sleep 10" }, "Bash");
		card.updateResult({
			content: [{ type: "text", text: "aborted" }],
			isError: true,
			details: { source: "interrupt_skipped", __synthetic: true },
		});
		card.setToolRowsFolded(true);

		const row = card.render(120)[0] ?? "";
		expect(row).not.toContain(theme.styledSymbol("status.error", "error"));
		expect(row).not.toContain(theme.fg("error", theme.bold("Bash")));
	});

	it("folds a tool with no renderer summary to its naming argument", () => {
		const card = settle(toolCard("custom_scan", { path: path.join(os.homedir(), "notes.txt") }));
		card.setToolRowsFolded(true);

		expect(visibleRows(card).map(row => row.trim())).toEqual(["custom_scan: ~/notes.txt"]);
	});

	it("keeps model-authored arguments to one sanitized row", () => {
		const card = settle(toolCard("custom_run", { command: "printf 'x'\u0007\u001b[2J\r\nsecond" }));
		card.setToolRowsFolded(true);

		const rows = card.render(80);
		expect(rows).toHaveLength(1);
		expect(rows[0]).not.toContain("\u0007");
		expect(rows[0]).not.toContain("\u001b[2J");
		expect(stripVTControlCharacters(rows[0]!)).toContain("custom_run: printf 'x' second");
	});

	it("truncates a long folded row instead of wrapping it", () => {
		const card = settle(toolCard("custom_scan", { path: "a".repeat(300) }));
		card.setToolRowsFolded(true);

		const rows = card.render(40);
		expect(rows).toHaveLength(1);
		expect(stripVTControlCharacters(rows[0]!).length).toBeLessThanOrEqual(40);
	});

	it("folds blocks that mount after the container was folded", () => {
		const transcript = new TranscriptContainer();
		const early = settle(toolCard("bash", { command: "bun test" }, "Bash"));
		transcript.addChild(early);
		transcript.setToolRowsFolded(true);
		expect(visibleRows(early)[0]?.trim()).toBe("Bash: bun test");

		const late = settle(toolCard("read", { path: "src/index.ts" }, "Read"));
		transcript.addChild(late);
		expect(visibleRows(late)[0]?.trim()).toBe("Read: src/index.ts");

		transcript.setToolRowsFolded(false);
		expect(visibleRows(late)[0]?.trim()).not.toBe("Read: src/index.ts");
	});

	it("folds a read group into a single row listing every target", () => {
		const group = new ReadToolGroupComponent();
		group.updateArgs({ path: "src/alpha.ts" }, "read-1");
		group.updateArgs({ path: "src/beta.ts" }, "read-2");
		expect(visibleRows(group).length).toBeGreaterThan(1);

		group.setToolRowsFolded(true);
		const rows = visibleRows(group);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("src/alpha.ts");
		expect(rows[0]).toContain("src/beta.ts");
	});

	it("drops the block gap between folded rows and keeps it around prose", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(settle(toolCard("bash", { command: "bun test" }, "Bash")));
		transcript.addChild(settle(toolCard("read", { path: "src/app.ts" }, "Read")));
		transcript.addChild(new Text("assistant reply", 0, 0));
		transcript.setToolRowsFolded(true);

		expect(visibleRows(transcript, 80).map(row => row.trim())).toEqual([
			"Bash: bun test",
			"Read: src/app.ts",
			"",
			"assistant reply",
		]);

		// Unfolded cards keep the transcript's standard one-row block gap.
		transcript.setToolRowsFolded(false);
		expect(visibleRows(transcript, 80).filter(row => row.trim() === "")).toHaveLength(2);
	});
});
