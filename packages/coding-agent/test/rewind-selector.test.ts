/**
 * Contract tests for the esc-esc rewind selector's target construction and
 * navigation: Up steps through rendered items in transcript order, Left jumps
 * to the previous user turn, entries that render nothing (hidden notices) are
 * never selectable, and componentless tool results fold into the turn that
 * rendered their call so rewinding a turn keeps its tool output.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type BranchVariantPath,
	RewindSelectorComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components/rewind-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { setKeybindings, type TUI } from "@oh-my-pi/pi-tui";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ENTER = "\r";

function entry(id: string, parentId: string | null, message: AgentMessage): SessionMessageEntry {
	return { type: "message", id, parentId, timestamp: "2024-01-01T00:00:00Z", message };
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 } as AgentMessage;
}

function assistantWithBashCall(callId: string): AgentMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "Running a command." },
			{ type: "toolCall", id: callId, name: "bash", arguments: { command: "ls" } },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 2,
	} as unknown as AgentMessage;
}

function bashResult(callId: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName: "bash",
		content: [{ type: "text", text: "file.txt" }],
		isError: false,
		timestamp: 3,
	} as unknown as AgentMessage;
}

/** u1 → a1(bash call) → tr1 → hidden notice → u2. */
function makeEntries(): SessionMessageEntry[] {
	return [
		entry("u1", null, userMessage("first prompt")),
		entry("a1", "u1", assistantWithBashCall("call-1")),
		entry("tr1", "a1", bashResult("call-1")),
		entry("notice", "tr1", {
			role: "custom",
			customType: "test-notice",
			content: "invisible",
			display: false,
			timestamp: 4,
		} as unknown as AgentMessage),
		entry("u2", "notice", userMessage("second prompt")),
	];
}

function makeSelector(
	onSelect: (id: string) => void,
	siblingPaths?: (entryId: string) => BranchVariantPath[],
	entries = makeEntries(),
): RewindSelectorComponent {
	return new RewindSelectorComponent(entries, {
		ui: { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI,
		cwd: "/tmp",
		requestRender: () => {},
		siblingPaths,
		onSelect,
		onCancel: () => {},
	});
}

function frame(selector: RewindSelectorComponent, width = 80): string[] {
	return selector.render(width).map(line => Bun.stripANSI(line));
}

/** Locate visible fixture text using terminal cells, including wide characters. */
function pointAt(lines: string[], text: string): { col: number; row: number } {
	// Branch captions repeat the prompt; hit the transcript occurrence below.
	const row = lines.findLastIndex(line => line.includes(text));
	if (row < 0) throw new Error(`Fixture text is not visible: ${text}`);
	const line = lines[row]!;
	return { row, col: Bun.stringWidth(line.slice(0, line.indexOf(text))) };
}

function mouse(
	selector: RewindSelectorComponent,
	point: { col: number; row: number },
	button = 35,
	release = false,
): void {
	selector.handleInput(`\x1b[<${button};${point.col + 1};${point.row + 1}${release ? "m" : "M"}`);
}

describe("RewindSelectorComponent", () => {
	beforeAll(async () => {
		await initTheme();
	});
	beforeEach(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		setKeybindings(KeybindingsManager.inMemory());
	});
	afterEach(() => {
		vi.restoreAllMocks();
		setKeybindings(KeybindingsManager.inMemory());
		resetSettingsForTest();
	});

	it("starts on the newest rendered item and Up steps in transcript order past hidden notices", () => {
		const selected: string[] = [];
		const selector = makeSelector(id => selected.push(id));
		selector.render(80);

		selector.handleInput(ENTER);
		selector.handleInput(UP);
		selector.handleInput(UP);
		selector.handleInput(ENTER);

		// u2 first; two Up presses land on u1 — the assistant turn is one step,
		// and the display:false notice is never a stop.
		expect(selected).toEqual(["u2", "u1"]);
	});

	it("folds componentless tool results into the turn that rendered their call", () => {
		const selected: string[] = [];
		const selector = makeSelector(id => selected.push(id));
		selector.render(80);

		selector.handleInput(UP);
		selector.handleInput(ENTER);

		// The assistant turn's rewind point is its trailing tool result, so the
		// bash output survives the rewind.
		expect(selected).toEqual(["tr1"]);
	});

	it("jumps between user turns with Left while Down returns in transcript order", () => {
		const selected: string[] = [];
		const selector = makeSelector(id => selected.push(id));
		selector.render(80);

		selector.handleInput(LEFT);
		selector.handleInput(ENTER);
		selector.handleInput(DOWN);
		selector.handleInput(ENTER);

		// Left from u2 skips the assistant turn straight to u1; Down steps back
		// one rendered item onto the assistant turn (folded to tr1).
		expect(selected).toEqual(["u1", "tr1"]);
	});

	it("slides into a sibling branch with Right and rewinds onto its entries", () => {
		const selected: string[] = [];
		const siblings = (entryId: string): BranchVariantPath[] =>
			entryId === "u2" ? [{ rootId: "u2b", entries: [entry("u2b", "a2", userMessage("alternate prompt"))] }] : [];
		const selector = makeSelector(id => selected.push(id), siblings);
		selector.render(120);

		// u2 is the newest target and has a sibling: Right enters the alternate
		// column, Enter rewinds onto the sibling's entry; Left returns to the
		// current path and Enter lands back on u2.
		selector.handleInput(RIGHT);
		selector.handleInput(ENTER);
		selector.handleInput(LEFT);
		selector.handleInput(ENTER);
		selector.dispose();

		expect(selected).toEqual(["u2b", "u2"]);
	});

	it("renders sibling branches as a half-width column strip at the fork", () => {
		const siblings = (entryId: string): BranchVariantPath[] =>
			entryId === "u2" ? [{ rootId: "u2b", entries: [entry("u2b", "a2", userMessage("alternate prompt"))] }] : [];
		const selector = makeSelector(() => {}, siblings);
		const lines = selector.render(120).map(line => Bun.stripANSI(line));
		selector.dispose();

		const joined = lines.join("\n");
		// Both branch columns are visible side by side with their captions.
		expect(joined).toContain("1/2");
		expect(joined).toContain("current");
		expect(joined).toContain("2/2");
		expect(joined).toContain("alternate prompt");
		// The shared history above the fork stays full width and un-columned.
		expect(joined).toContain("first prompt");
	});

	it("shows a dot rail with edge ellipses when branches overflow the window", () => {
		const siblings = (entryId: string): BranchVariantPath[] =>
			entryId === "u2"
				? ["b1", "b2", "b3"].map(id => ({
						rootId: id,
						entries: [entry(id, "a2", userMessage(`${id} prompt`))],
					}))
				: [];
		const selector = makeSelector(() => {}, siblings);

		const first = selector.render(120).map(line => Bun.stripANSI(line));
		const initialRail = first.find(line => line.includes("◉"));
		expect(initialRail).toBeDefined();
		// Four columns, current active: one filled dot, three hollow, more to the
		// right but nothing to the left.
		expect(initialRail!.match(/○/g)).toHaveLength(3);
		expect(initialRail!.trimEnd().endsWith("…")).toBe(true);
		expect(initialRail!.trimStart().startsWith("…")).toBe(false);

		selector.handleInput(RIGHT);
		selector.handleInput(RIGHT);
		selector.handleInput(RIGHT);
		const slid = selector.render(120).map(line => Bun.stripANSI(line));
		selector.dispose();
		const slidRail = slid.find(line => line.includes("◉"));
		// Last column active: content now overflows on the left instead.
		expect(slidRail!.trimStart().startsWith("…")).toBe(true);
	});

	it("outlines exactly the selected block with dotted verticals", () => {
		const selector = makeSelector(() => {});
		const lines = selector.render(80).map(line => Bun.stripANSI(line));

		const boxed = lines.filter(line => line.startsWith("┆"));
		// The initial selection is the newest user prompt; the older prompt
		// stays outside the outline.
		expect(boxed.join("\n")).toContain("second prompt");
		expect(boxed.join("\n")).not.toContain("first prompt");
		expect(lines.join("\n")).toContain("first prompt");
	});

	it("moves the existing outline on hover without committing and clicks the folded tool-result target", () => {
		const selected: string[] = [];
		const selector = makeSelector(id => selected.push(id));
		mouse(selector, pointAt(frame(selector), "first prompt"));
		const hovered = frame(selector);
		expect(hovered.filter(line => line.startsWith("┆")).join("\n")).toContain("first prompt");
		expect(hovered.filter(line => line.startsWith("┆")).join("\n")).not.toContain("second prompt");
		expect(selected).toEqual([]);

		mouse(selector, pointAt(hovered, "Running a command."));
		const toolFrame = frame(selector);
		expect(toolFrame.filter(line => line.startsWith("┆")).join("\n")).toContain("Running a command.");
		const point = pointAt(toolFrame, "Running a command.");
		mouse(selector, point, 0);
		mouse(selector, point, 0, true);
		expect(selected).toEqual(["tr1"]);
		selector.dispose();
	});

	it("ignores frame chrome, blank space, the scrollbar, and non-left clicks", () => {
		const selected: string[] = [];
		const selector = makeSelector(id => selected.push(id));
		const lines = frame(selector);
		const prompt = pointAt(lines, "first prompt");
		mouse(selector, { col: 5, row: 1 }, 0);
		mouse(selector, { col: 5, row: lines.length - 2 }, 0);
		mouse(selector, { col: 5, row: lines.length - 3 }, 0);
		mouse(selector, { col: 79, row: prompt.row }, 0);
		mouse(selector, prompt, 2);
		mouse(selector, prompt, 32);
		mouse(selector, prompt, 0, true);
		expect(selected).toEqual([]);

		// Keyboard navigation resumes normally after a mouse preview.
		selector.handleInput(UP);
		selector.handleInput(ENTER);
		expect(selected).toEqual(["tr1"]);
		selector.dispose();
	});

	it("hit-tests the scrolled and resized viewport, including a wrapped wide-character message", () => {
		const selected: string[] = [];
		const entries = Array.from({ length: 30 }, (_, index) =>
			entry(
				`u${index}`,
				index === 0 ? null : `u${index - 1}`,
				userMessage(`消息 ${index} ${"宽字".repeat(30)} 终点${index}`),
			),
		);
		const selector = makeSelector(id => selected.push(id), undefined, entries);
		frame(selector);
		selector.handleInput("\x1b[H");
		frame(selector);
		mouse(selector, { col: 10, row: 10 }, 65);
		const resized = frame(selector, 48);
		const marker = resized.join("\n").match(/终点(\d+)/)?.[0];
		if (!marker) throw new Error("Expected a visible wrapped message after scrolling");
		const point = pointAt(resized, marker);
		mouse(selector, point);
		const hovered = frame(selector, 48);
		expect(hovered.filter(line => line.startsWith("┆")).join("\n")).toContain(marker);
		mouse(selector, pointAt(hovered, marker), 0);
		expect(selected).toEqual([`u${marker.slice(2)}`]);
		selector.dispose();
	});

	it("previews and clicks either branch column without moving the fork or camera", () => {
		const selected: string[] = [];
		const siblings = (entryId: string): BranchVariantPath[] =>
			entryId === "u2"
				? [{ rootId: "u2b", entries: [entry("u2b", "notice", userMessage("alternate prompt"))] }]
				: [];
		const selector = makeSelector(id => selected.push(id), siblings);
		const before = frame(selector, 120);
		const alternate = pointAt(before, "alternate prompt");
		mouse(selector, alternate);
		const hovered = frame(selector, 120);
		const alternateLine = hovered[pointAt(hovered, "alternate prompt").row]!;
		expect(alternateLine.slice(0, alternateLine.indexOf("alternate prompt"))).toContain("┆");
		expect(pointAt(hovered, "2/2")).toEqual(pointAt(before, "2/2"));
		expect(selected).toEqual([]);
		// The original pointer still lies on the same branch after its outline appears.
		mouse(selector, alternate, 0);
		mouse(selector, pointAt(frame(selector, 120), "second prompt"), 0);
		expect(selected).toEqual(["u2b", "u2"]);

		mouse(selector, pointAt(frame(selector, 120), "first prompt"));
		const prefix = frame(selector, 120);
		expect(prefix.filter(line => line.startsWith("┆")).join("\n")).toContain("first prompt");
		expect(prefix.join("\n")).toContain("alternate prompt");
		mouse(selector, pointAt(prefix, "first prompt"), 0);
		expect(selected).toEqual(["u2b", "u2", "u1"]);
		selector.dispose();
	});

	it("keeps a shorter sibling under the pointer when moving the outline at the bottom of a long transcript", () => {
		const selected: string[] = [];
		const entries = Array.from({ length: 30 }, (_, index) =>
			entry(
				`u${index}`,
				index === 0 ? null : `u${index - 1}`,
				userMessage(`Message ${index}: ${"A long wrapped prompt. ".repeat(8)}`),
			),
		);
		const selector = makeSelector(
			id => selected.push(id),
			id =>
				id === "u29" ? [{ rootId: "alt", entries: [entry("alt", "u28", userMessage("short alternate"))] }] : [],
			entries,
		);
		const before = frame(selector, 120);
		const point = pointAt(before, "short alternate");
		const caption = pointAt(before, "2/2");
		mouse(selector, point);
		const hovered = frame(selector, 120);
		expect(pointAt(hovered, "2/2")).toEqual(caption);
		mouse(selector, point);
		frame(selector, 120);
		mouse(selector, point, 0);
		expect(selected).toEqual(["alt"]);
		selector.dispose();
	});

	it("clicks the visible branch after a horizontal camera slide and rejects the column gap", () => {
		const selected: string[] = [];
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const siblings = (entryId: string): BranchVariantPath[] =>
			entryId === "u2"
				? ["b1", "b2", "b3"].map(id => ({
						rootId: id,
						entries: [entry(id, "notice", userMessage(`${id} prompt`))],
					}))
				: [];
		const selector = makeSelector(id => selected.push(id), siblings);
		frame(selector, 120);
		selector.handleInput(RIGHT);
		selector.handleInput(RIGHT);
		selector.handleInput(RIGHT);
		now.mockReturnValue(1_200);
		const slid = frame(selector, 120);
		mouse(selector, pointAt(slid, "b3 prompt"), 0);
		mouse(selector, { col: 60, row: pointAt(slid, "b3 prompt").row }, 0);
		expect(selected).toEqual(["b3"]);
		selector.dispose();
	});
});
