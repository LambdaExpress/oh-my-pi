import { describe, expect, it } from "bun:test";
import {
	CONTEXT_INJECTION_MESSAGE_TYPE,
	type ContextInjectionItem,
	contextInjectionSignature,
	mcpInjectionItems,
	normalizeContextInjectionItems,
	type ContextInjectionDetails,
} from "../../src/session/context-injection";
import type { CustomMessage } from "../../src/session/messages";
import { buildSessionContext } from "../../src/session/session-context";
import type { SessionEntry } from "../../src/session/session-entries";

const timestamp = "2026-09-16T00:00:00.000Z";

const userEntry = {
	type: "message",
	id: "m1",
	parentId: null,
	timestamp,
	message: { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 },
} satisfies SessionEntry;

function injectionEntry(items: ContextInjectionItem[]): SessionEntry {
	return {
		type: "custom",
		id: "c1",
		parentId: "m1",
		timestamp,
		customType: "context-injection",
		data: { items } satisfies ContextInjectionDetails,
	};
}

function injectionMessages(entries: SessionEntry[], transcript: boolean): CustomMessage<ContextInjectionDetails>[] {
	const context = buildSessionContext(entries, undefined, undefined, transcript ? { transcript: true } : undefined);
	return context.messages.filter(
		(message): message is CustomMessage<ContextInjectionDetails> =>
			message.role === "custom" && message.customType === CONTEXT_INJECTION_MESSAGE_TYPE,
	);
}

describe("context injection records", () => {
	it("replays a journaled record as a visible transcript notice", () => {
		const items: ContextInjectionItem[] = [
			{
				kind: "context-file",
				label: "AGENTS.md",
				detail: "1.2 KB · ~/project/AGENTS.md",
				preview: "# Rules\nRun bun check.",
			},
		];
		const messages = injectionMessages([userEntry, injectionEntry(items)], true);

		expect(messages).toHaveLength(1);
		expect(messages[0]!.display).toBe(true);
		expect(messages[0]!.details?.items).toEqual(items);
	});

	it("keeps injection records out of the model context", () => {
		const entries = [
			userEntry,
			injectionEntry([{ kind: "rulebook", label: "Rulebook", count: 3 }]),
		] satisfies SessionEntry[];

		expect(injectionMessages(entries, false)).toHaveLength(0);
	});

	it("drops empty records instead of rendering an empty notice", () => {
		const entries = [userEntry, injectionEntry([])] satisfies SessionEntry[];

		expect(injectionMessages(entries, true)).toHaveLength(0);
	});

	it("keeps same-named files apart and caps oversized previews", () => {
		const long = `${"x".repeat(2_000)}\nsecond line`;
		const normalized = normalizeContextInjectionItems([
			{ kind: "context-file", label: "AGENTS.md", detail: "root", preview: long },
			{ kind: "context-file", label: "AGENTS.md", detail: "packages/app" },
			{ kind: "context-file", label: "AGENTS.md", detail: "root", preview: "duplicate" },
			{ kind: "context-file", label: "  " },
		]);

		expect(normalized).toHaveLength(2);
		expect(normalized.map(item => item.detail)).toEqual(["root", "packages/app"]);
		expect(normalized[0]!.preview!.length).toBeLessThan(long.length);
		expect(normalized[0]!.preview!.endsWith("second line")).toBe(false);
	});

	it("treats a changed source set as a different injection", () => {
		const base: ContextInjectionItem[] = [{ kind: "skill", label: "Skills", count: 4 }];

		expect(contextInjectionSignature(base)).toBe(contextInjectionSignature([...base]));
		expect(contextInjectionSignature(base)).not.toBe(
			contextInjectionSignature([{ kind: "skill", label: "Skills", count: 5 }]),
		);
	});

	it("lists every connected MCP server, instructions or not", () => {
		const items = mcpInjectionItems(
			new Map([
				["atlassian", ["search", "get_page"]],
				["echo", ["ping"]],
			]),
			new Map([["atlassian", "Prefer JQL over free text."]]),
		);

		expect(items.map(item => item.label)).toEqual(["MCP atlassian", "MCP echo"]);
		// The instructions ride along with the tool count; a server without them
		// still reports the tools it put in context, which is what keeps a
		// mid-session `/mcp disable` visible in the notice.
		expect(items[0]!.detail).toContain("2 tools");
		expect(items[0]!.detail).toContain("server instructions");
		expect(items[0]!.preview).toBe("Prefer JQL over free text.");
		expect(items[1]!.detail).toBe("1 tool");
		expect(items[1]!.preview).toBe("ping");
	});

	it("drops a connected server from the set when it disconnects", () => {
		const connected = mcpInjectionItems(new Map([["atlassian", ["search"]]]));
		const disconnected = mcpInjectionItems(new Map());

		expect(connected.map(item => item.label)).toEqual(["MCP atlassian"]);
		expect(disconnected).toHaveLength(0);
		expect(contextInjectionSignature(disconnected)).not.toBe(contextInjectionSignature(connected));
	});
});
