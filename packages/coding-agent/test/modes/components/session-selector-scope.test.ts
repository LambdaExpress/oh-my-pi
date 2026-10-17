import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { SessionSelectorComponent } from "@oh-my-pi/pi-tui/overlays/session-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";

const selectors: SessionSelectorComponent<SessionInfo>[] = [];
const cx: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: kind => kind !== "picker",
	feature: () => true,
};

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	for (const selector of selectors) selector.dispose();
	selectors.length = 0;
});

function scope(selector: SessionSelectorComponent<SessionInfo>): string | undefined {
	const nodes: NativeNode[] = [selector.describe(cx)];
	for (const node of nodes) {
		if (node.k === "tabs" && node.key === "scope") return node.p?.active;
		for (const child of node.c ?? []) if ("k" in child) nodes.push(child);
	}
	throw new Error("no scope tabs");
}

function createSession(id: string, title: string, cwd: string, parentSessionPath?: string): SessionInfo {
	return {
		path: `${cwd}/${id}.jsonl`,
		id,
		cwd,
		title,
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date("2024-01-02T00:00:00Z"),
		messageCount: 1,
		size: 0,
		firstMessage: `${title} first message`,
		allMessagesText: `${title} first message`,
		...(parentSessionPath ? { parentSessionPath } : {}),
	};
}

const TAB = "\t";

describe("SessionSelectorComponent scope toggle", () => {
	it("cycles folder → flat → grouped → folder on Tab and surfaces each session's directory", async () => {
		const folder = [createSession("local", "Local", "/work/current")];
		const global = [
			createSession("local", "Local", "/work/current"),
			createSession("remote", "Remote", "/work/other-project"),
		];
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
			},
		);
		selectors.push(selector);

		expect(scope(selector)).toBe("folder");
		expect(selector.render(120).join("\n")).not.toContain("other-project");

		selector.handleInput(TAB);
		await Bun.sleep(0);

		let rendered = selector.render(120).join("\n");
		expect(scope(selector)).toBe("flat");
		expect(rendered).toContain("other-project");
		expect(loads).toBe(1);

		// Second Tab: grouped (by parent) scope, group headers with each session.
		selector.handleInput(TAB);
		await Bun.sleep(0);
		rendered = selector.render(120).join("\n");
		expect(scope(selector)).toBe("grouped");
		expect(rendered).toContain("(1)");
		expect(rendered).toContain("Local");
		expect(rendered).toContain("Remote");
		expect(loads).toBe(1);

		// Third Tab: back to folder scope without reloading.
		selector.handleInput(TAB);
		await Bun.sleep(0);
		expect(scope(selector)).toBe("folder");
		expect(selector.render(120).join("\n")).not.toContain("other-project");
		expect(loads).toBe(1);
	});

	it("shows directories in folder scope only when the list spans worktrees, across a Tab round-trip", () => {
		const single = new SessionSelectorComponent(
			[createSession("a", "Alpha", "/work/repo"), createSession("b", "Beta", "/work/repo")],
			() => {},
			() => {},
			() => {},
		);
		selectors.push(single);
		expect(single.render(120).join("\n")).not.toContain("/work/repo");

		const folder = [createSession("main", "Main", "/work/repo"), createSession("wt", "Moved", "/work/repo-wt")];
		const remote = createSession("other", "Foreign", "/work/other-project");
		const selector = new SessionSelectorComponent(
			folder,
			() => {},
			() => {},
			() => {},
			// Preloaded, so each scope change applies synchronously.
			{ allSessions: [...folder, remote] },
		);
		selectors.push(selector);
		expect(selector.render(120).join("\n")).toContain("/work/repo-wt");

		selector.handleInput(TAB);
		expect(scope(selector)).toBe("flat");
		expect(selector.render(120).join("\n")).toContain(remote.cwd);
		selector.handleInput(TAB);
		expect(scope(selector)).toBe("grouped");
		expect(selector.render(120).join("\n")).toContain(remote.cwd);
		selector.handleInput(TAB);
		const rendered = selector.render(120).join("\n");
		expect(scope(selector)).toBe("folder");
		expect(rendered).toContain("/work/repo-wt");
		expect(rendered).not.toContain(remote.cwd);
	});

	it("returns the full selected session, including its cwd", async () => {
		const folder = [createSession("local", "Local", "/work/current")];
		const remote = createSession("remote", "Remote", "/work/other-project");
		const selected: SessionInfo[] = [];
		const selector = new SessionSelectorComponent(
			folder,
			session => selected.push(session),
			() => {},
			() => {},
			{ loadAllSessions: async () => [remote] },
		);
		selectors.push(selector);

		selector.handleInput(TAB);
		await Bun.sleep(0);
		selector.handleInput("\n");

		expect(selected).toHaveLength(1);
		expect(selected[0]?.path).toBe(remote.path);
		expect(selected[0]?.cwd).toBe("/work/other-project");
	});

	it("starts in current-folder scope even when the cwd is empty and a global list is preloaded (#3099)", () => {
		const remote = createSession("remote", "Remote", "/work/other-project");
		const selected: SessionInfo[] = [];
		const selector = new SessionSelectorComponent(
			[],
			session => selected.push(session),
			() => {},
			() => {},
			{ allSessions: [remote] },
		);
		selectors.push(selector);

		const rendered = selector.render(120).join("\n");
		expect(scope(selector)).toBe("folder");
		expect(rendered).not.toContain("other-project");
		selector.handleInput("\n");
		expect(selected).toEqual([]);
		selector.handleInput(TAB);
		expect(scope(selector)).toBe("flat");
		expect(selector.render(120).join("\n")).toContain(remote.cwd);
	});

	it("marks only forked child sessions in the native catalogue", () => {
		const parent = createSession("root", "Incident", "/work/current");
		const child = createSession("child", "Incident", "/work/current", parent.path);
		const selector = new SessionSelectorComponent(
			[parent, child],
			() => {},
			() => {},
			() => {},
		);
		selectors.push(selector);

		const picker = selector.describe({ ...cx, supports: () => true });
		if (picker.k !== "picker") throw new Error("no session picker");
		const items = picker.p?.items;
		if (!items) throw new Error("no session catalogue");
		const parentItem = items.find(item => item.id === parent.path);
		const childItem = items.find(item => item.id === child.path);
		if (!parentItem || !childItem) throw new Error("the catalogue is missing a session");
		expect(parentItem.badges).toBeUndefined();
		expect(childItem.badges).toHaveLength(1);
	});
});
