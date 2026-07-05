import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { TreeSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tree-selector";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	type SessionEntry,
	type SessionTreeNode,
	TITLE_CHANGE_ENTRY_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";

const TIMESTAMP = "2026-01-02T03:04:05.000Z";
const TITLE_TEXT = "Release readiness review";

type FilterMode = "default" | "all";

function messageNode(id: string, parentId: string | null, message: AgentMessage): SessionTreeNode {
	const entry: SessionEntry = {
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message,
	};
	return { entry, children: [] };
}

function titleChangeNode(id: string, parentId: string | null, title: string): SessionTreeNode {
	const entry: SessionEntry = {
		type: TITLE_CHANGE_ENTRY_TYPE,
		id,
		parentId,
		timestamp: TIMESTAMP,
		title,
		source: "auto",
		trigger: "initial",
	};
	return { entry, children: [] };
}

function titleChangeConversation(): { tree: SessionTreeNode[]; leafId: string } {
	const user = messageNode("user-1", null, { role: "user", content: "Name this session", timestamp: 1 });
	const titleChange = titleChangeNode("title-1", user.entry.id, TITLE_TEXT);
	const assistant = messageNode("assistant-1", titleChange.entry.id, {
		role: "assistant",
		content: [{ type: "text", text: "Done." }],
		stopReason: "stop",
		timestamp: 2,
	} as AgentMessage);

	user.children.push(titleChange);
	titleChange.children.push(assistant);

	return { tree: [user], leafId: assistant.entry.id };
}

function renderRows(filterMode?: FilterMode): string[] {
	const { tree, leafId } = titleChangeConversation();
	const selector = new TreeSelectorComponent(
		tree,
		leafId,
		60,
		() => {},
		() => {},
		undefined,
		filterMode,
	);
	return selector.render(120).map(line => Bun.stripANSI(line));
}

function rowIndex(rows: readonly string[], text: string): number {
	const index = rows.findIndex(line => line.includes(text));
	if (index < 0) throw new Error(`row containing ${JSON.stringify(text)} not rendered`);
	return index;
}

describe("TreeSelectorComponent title change rendering", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	it("hides title changes in the default view without leaving a blank visible row", () => {
		const rows = renderRows();
		const userIndex = rowIndex(rows, "user: Name this session");
		const assistantIndex = rowIndex(rows, "assistant: Done.");

		expect(assistantIndex).toBe(userIndex + 1);
		expect(rows.slice(userIndex + 1, assistantIndex)).toEqual([]);
		expect(rows.join("\n")).not.toContain(TITLE_TEXT);
	});

	it("renders the title text for title changes in the all filter", () => {
		const rows = renderRows("all");
		const userIndex = rowIndex(rows, "user: Name this session");
		const titleIndex = rowIndex(rows, TITLE_TEXT);
		const assistantIndex = rowIndex(rows, "assistant: Done.");

		expect(titleIndex).toBeGreaterThan(userIndex);
		expect(titleIndex).toBeLessThan(assistantIndex);
		expect(rows[titleIndex]).toContain(TITLE_TEXT);
	});
});
