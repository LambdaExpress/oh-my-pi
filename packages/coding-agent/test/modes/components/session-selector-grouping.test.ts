import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SessionSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/session-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { setLocale } from "../../../src/i18n";

beforeAll(async () => {
	await initTheme();
	// Assertions target the English copy (scope labels, group headers, ellipsis
	// rows); pin the locale so zh-CN machines don't render translated text.
	setLocale("en");
});

afterAll(() => {
	setLocale(null);
});

const TAB = "\t";
const DOWN = "\x1b[B";

function createSession(
	id: string,
	title: string,
	cwd: string,
	modified = new Date("2024-01-02T00:00:00Z"),
): SessionInfo {
	return {
		path: `${cwd}/${id}.jsonl`,
		id,
		cwd,
		title,
		created: new Date("2024-01-01T00:00:00Z"),
		modified,
		messageCount: 1,
		size: 1024,
		firstMessage: `${title} first message`,
		allMessagesText: `${title} first message`,
	};
}

/** Five alpha sessions with distinct recency; "Alpha 1" is the newest. */
function alphaGroup(): SessionInfo[] {
	return ["Alpha 1", "Alpha 2", "Alpha 3", "Alpha 4", "Alpha 5"].map((title, i) =>
		createSession(`a${i + 1}`, title, "/work/alpha", new Date(Date.UTC(2024, 0, 6 - i))),
	);
}

/** Plain (ANSI-stripped) picker text so assertions target glyphs, not colors. */
function renderText(selector: SessionSelectorComponent): string {
	return Bun.stripANSI(selector.render(120).join("\n"));
}

function renderLines(selector: SessionSelectorComponent): string[] {
	return renderText(selector).split("\n");
}

/** Drain the async scope-switch chain (lazy load → setSessions → header). */
async function flushAsync(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** Tab twice: folder → flat → grouped (by parent). */
async function tabToGrouped(selector: SessionSelectorComponent): Promise<void> {
	selector.handleInput(TAB);
	await flushAsync();
	selector.handleInput(TAB);
	await flushAsync();
}

function makeSelector(
	folder: SessionInfo[],
	global: SessionInfo[],
	options: { onDelete?: (session: SessionInfo) => Promise<boolean>; rows?: number } = {},
): { selector: SessionSelectorComponent; loads: () => number } {
	let loads = 0;
	const selector = new SessionSelectorComponent(
		folder,
		() => {},
		() => {},
		() => {},
		{
			loadAllSessions: async () => {
				loads++;
				return global;
			},
			onDelete: options.onDelete,
			getTerminalRows: () => options.rows ?? 100,
			fillHeight: options.rows !== undefined,
		},
	);
	return { selector, loads: () => loads };
}

describe("SessionSelectorComponent grouping", () => {
	it("cycles folder → flat → grouped → folder on Tab, loading the global list once", async () => {
		const folder = [createSession("local", "Local", "/work/current")];
		const global = [
			createSession("local", "Local", "/work/current"),
			createSession("remote", "Remote", "/work/other-project"),
		];
		const { selector, loads } = makeSelector(folder, global);

		expect(renderText(selector)).toContain("(current folder)");

		selector.handleInput(TAB);
		await flushAsync();
		expect(renderText(selector)).toContain("(all projects)");
		expect(loads()).toBe(1);

		selector.handleInput(TAB);
		await flushAsync();
		expect(renderText(selector)).toContain("(by parent)");
		expect(loads()).toBe(1);

		selector.handleInput(TAB);
		await flushAsync();
		expect(renderText(selector)).toContain("(current folder)");
		expect(loads()).toBe(1);
	});

	it("renders group headers with counts, a 3-session preview, and an ellipsis row for larger groups", async () => {
		const global = [
			...alphaGroup(),
			createSession("b1", "Beta 1", "/work/beta"),
			createSession("g1", "Gamma 1", "/work/gamma"),
		];
		const { selector } = makeSelector([createSession("local", "Local", "/work/current")], global);
		await tabToGrouped(selector);

		const rendered = renderText(selector);
		// One header per parent folder, carrying the group's full session count.
		expect(rendered).toContain("/work/alpha (5)");
		expect(rendered).toContain("/work/beta (1)");
		expect(rendered).toContain("/work/gamma (1)");
		// Only the newest 3 sessions of the 5-session group are shown by default.
		expect(rendered).toContain("Alpha 1");
		expect(rendered).toContain("Alpha 2");
		expect(rendered).toContain("Alpha 3");
		expect(rendered).not.toContain("Alpha 4");
		expect(rendered).not.toContain("Alpha 5");
		// The ellipsis row names the hidden remainder.
		expect(rendered).toContain("… 2 more sessions");
	});

	it("toggles a group with Enter on its header and expands the ellipsis row to all members", async () => {
		const global = [...alphaGroup(), createSession("b1", "Beta 1", "/work/beta")];
		const { selector } = makeSelector([createSession("local", "Local", "/work/current")], global);
		await tabToGrouped(selector);

		// Enter on the first header (alpha) collapses the group.
		selector.handleInput("\n");
		expect(renderText(selector)).not.toContain("Alpha 1");
		expect(renderText(selector)).toContain("/work/alpha");

		// Enter again re-expands to the 3-session preview.
		selector.handleInput("\n");
		expect(renderText(selector)).toContain("Alpha 1");
		expect(renderText(selector)).not.toContain("Alpha 4");

		// Navigate down to the ellipsis row and Enter to show every member.
		const list = selector.getSessionList();
		for (let i = 0; i < 4; i++) list.handleInput(DOWN);
		selector.handleInput("\n");
		const rendered = renderText(selector);
		expect(rendered).toContain("Alpha 4");
		expect(rendered).toContain("Alpha 5");
		expect(rendered).not.toContain("more sessions");
	});

	it("toggles a group when its header row is clicked", async () => {
		const global = [...alphaGroup(), createSession("b1", "Beta 1", "/work/beta")];
		const { selector } = makeSelector([createSession("local", "Local", "/work/current")], global, { rows: 100 });
		await tabToGrouped(selector);

		const lines = renderLines(selector);
		const headerRow = lines.findIndex(line => line.includes("/work/alpha (5)"));
		expect(headerRow).toBeGreaterThanOrEqual(0);

		// SGR left click on the header row collapses the group.
		selector.handleInput(`\x1b[<0;4;${headerRow + 1}M`);
		expect(renderText(selector)).not.toContain("Alpha 1");
		expect(renderText(selector)).toContain("/work/alpha");

		// Clicking the (still-present) header again re-expands it.
		selector.handleInput(`\x1b[<0;4;${headerRow + 1}M`);
		expect(renderText(selector)).toContain("Alpha 1");
	});

	it("auto-expands collapsed groups while searching and restores the collapse after clearing", async () => {
		const global = [...alphaGroup(), createSession("b1", "Beta 1", "/work/beta")];
		const { selector } = makeSelector([createSession("local", "Local", "/work/current")], global);
		await tabToGrouped(selector);

		// Collapse the alpha group.
		selector.handleInput("\n");
		expect(renderText(selector)).not.toContain("Alpha 1");

		// A query hitting a member of the collapsed group surfaces it, header intact.
		const list = selector.getSessionList();
		for (const ch of "Alpha 4") list.handleInput(ch);
		const searching = renderText(selector);
		expect(searching).toContain("Alpha 4");
		expect(searching).toContain("/work/alpha");

		// Clearing the query restores the collapsed group.
		for (let i = 0; i < 7; i++) list.handleInput("\x7f");
		const cleared = renderText(selector);
		expect(cleared).not.toContain("Alpha 4");
		expect(cleared).not.toContain("Alpha 1");
		expect(cleared).toContain("/work/alpha");
	});

	it("removes a group header when its last session is deleted", async () => {
		const global = [createSession("only", "Only", "/work/alpha"), createSession("solo", "Solo", "/work/beta")];
		const { selector } = makeSelector([createSession("local", "Local", "/work/current")], global, {
			onDelete: async () => true,
		});
		await tabToGrouped(selector);

		// Select the alpha session (below its header) and delete it.
		selector.getSessionList().handleInput(DOWN);
		selector.handleInput("\x1b[3~");
		selector.handleInput("\n");
		await flushAsync();

		const rendered = renderText(selector);
		expect(rendered).not.toContain("/work/alpha");
		expect(rendered).toContain("/work/beta (1)");
		expect(rendered).toContain("Solo");
	});

	it("remembers expand state across flat ↔ grouped scope switches", async () => {
		const global = [...alphaGroup(), createSession("b1", "Beta 1", "/work/beta")];
		const { selector } = makeSelector([createSession("local", "Local", "/work/current")], global);
		await tabToGrouped(selector);

		// Collapse alpha.
		selector.handleInput("\n");
		expect(renderText(selector)).not.toContain("Alpha 1");

		// Cycle flat → folder → flat → grouped.
		selector.handleInput(TAB);
		await flushAsync();
		selector.handleInput(TAB);
		await flushAsync();
		selector.handleInput(TAB);
		await flushAsync();

		expect(renderText(selector)).toContain("(by parent)");
		expect(renderText(selector)).not.toContain("Alpha 1");
		expect(renderText(selector)).toContain("/work/alpha");
	});

	it("groups sessions with an empty cwd under the unknown-folder label", async () => {
		const global = [createSession("nowhere", "Nowhere", ""), createSession("home", "Home", "/work/home")];
		const { selector } = makeSelector([createSession("local", "Local", "/work/current")], global);

		// English: the unknown-folder key doubles as its own label.
		await tabToGrouped(selector);
		expect(renderText(selector)).toContain("unknown folder (1)");

		// zh-CN: the translated label is rendered instead.
		setLocale("zh-CN");
		expect(renderText(selector)).toContain("未知文件夹 (1)");
		setLocale("en");
	});

	it("renders group members in recency order, newest first", async () => {
		const global = [
			createSession("old", "Oldest", "/work/alpha", new Date("2024-01-01T00:00:00Z")),
			createSession("mid", "Middle", "/work/alpha", new Date("2024-01-03T00:00:00Z")),
			createSession("new", "Newest", "/work/alpha", new Date("2024-01-05T00:00:00Z")),
		];
		const { selector } = makeSelector([createSession("local", "Local", "/work/current")], global);
		await tabToGrouped(selector);

		const lines = renderLines(selector);
		const rowOf = (title: string): number => lines.findIndex(line => line.includes(title));
		expect(rowOf("Newest")).toBeGreaterThanOrEqual(0);
		expect(rowOf("Newest")).toBeLessThan(rowOf("Middle"));
		expect(rowOf("Middle")).toBeLessThan(rowOf("Oldest"));
	});
});
