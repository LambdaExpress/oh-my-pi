import { describe, expect, it } from "bun:test";
import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import "./transcript-dom-shim";
import { Transcript } from "../src/components/transcript/Transcript";
import type { ActiveTool } from "../src/lib/client";

const TOOL_CALL_ID = "call-running-tool";
const TOOL_NAME = "probe_tool";

const RAW_ASSISTANT_TARGET = "stale-raw-assistant-target";
const ACTIVE_TOOL_TARGET = "effective-active-tool-target";

function assistantUsage(): AssistantMessage["usage"] {
	return { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } };
}

function committedAssistantToolCall(): SessionEntry {
	return {
		type: "message",
		id: "assistant-entry-1",
		parentId: null,
		timestamp: "2026-07-09T00:00:00Z",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "I will run the tool." },
				{
					type: "toolCall",
					id: TOOL_CALL_ID,
					name: TOOL_NAME,
					arguments: { target: RAW_ASSISTANT_TARGET },
					intent: "Inspect fixture input",
				},
			],
			model: "test/model",
			usage: assistantUsage(),
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

function activeTool(): ActiveTool {
	return {
		toolCallId: TOOL_CALL_ID,
		toolName: TOOL_NAME,
		args: { target: ACTIVE_TOOL_TARGET },
		intent: "Inspect fixture input",
		startedAt: 1,
	};
}

function renderTranscript(props: {
	entries?: readonly SessionEntry[];
	activeTools?: ReadonlyMap<string, ActiveTool>;
	working: boolean;
}): string {
	return renderToStaticMarkup(
		<Transcript
			entries={props.entries ?? []}
			stream={null}
			streamDone={true}
			activeTools={props.activeTools ?? new Map()}
			working={props.working}
		/>,
	);
}

function countElements(html: string, selector: string): number {
	let count = 0;
	new HTMLRewriter()
		.on(selector, {
			element() {
				count++;
			},
		})
		.transform(html);
	return count;
}

function countOccurrences(text: string, needle: string): number {
	let count = 0;
	let start = 0;
	while (true) {
		const index = text.indexOf(needle, start);
		if (index === -1) return count;
		count++;
		start = index + needle.length;
	}
}

describe("Transcript live tool rendering", () => {
	it("renders one running card for a committed tool call using active args without the working shimmer", () => {
		const html = renderTranscript({
			entries: [committedAssistantToolCall()],
			activeTools: new Map([[TOOL_CALL_ID, activeTool()]]),
			working: true,
		});

		expect(countElements(html, ".tv-card")).toBe(1);
		expect(countElements(html, ".tv-status-dots--run")).toBe(1);
		expect(countOccurrences(html, TOOL_NAME)).toBe(1);
		expect(html).not.toContain("thinking…");
		expect(html).toContain(ACTIVE_TOOL_TARGET);
		expect(html).not.toContain(RAW_ASSISTANT_TARGET);
	});

	it("keeps the working shimmer when no tool is active", () => {
		const html = renderTranscript({ working: true, activeTools: new Map() });

		expect(html).toContain("thinking…");
	});
});

describe("Transcript message Markdown", () => {
	it("renders host strings and guest text blocks as Markdown", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "host-markdown",
				parentId: null,
				timestamp: "2026-07-15T00:00:00Z",
				message: {
					role: "user",
					content: "Use `381866285601915778`",
					timestamp: 1,
				},
			},
			{
				type: "custom_message",
				id: "guest-markdown",
				parentId: "host-markdown",
				timestamp: "2026-07-15T00:00:01Z",
				customType: "collab-prompt",
				content: [{ type: "text", text: "Guest uses **Markdown**" }],
				details: { from: "guest" },
				display: true,
			},
		];

		const html = renderTranscript({ entries, working: false });

		expect(countElements(html, ".tr-row--user .tr-md code")).toBe(1);
		expect(countElements(html, ".tr-row--user .tr-md strong")).toBe(1);
	});
});

describe("Transcript completed runs", () => {
	it("collapses a normally completed run to its final answer and one expandable process control", () => {
		const entries: SessionEntry[] = [
			{
				type: "custom_message",
				id: "prompt",
				parentId: null,
				timestamp: "2026-08-22T00:00:00Z",
				customType: "collab-prompt",
				content: "Inspect the repository",
				details: { from: "tester" },
				display: true,
			},
			{
				type: "message",
				id: "process",
				parentId: "prompt",
				timestamp: "2026-08-22T00:00:01Z",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "private investigation details" },
						{ type: "text", text: "I will inspect the files." },
						{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src" } },
					],
					model: "test/model",
					usage: assistantUsage(),
					stopReason: "toolUse",
					timestamp: 2,
				},
			},
			{
				type: "message",
				id: "result",
				parentId: "process",
				timestamp: "2026-08-22T00:00:02Z",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "file contents" }],
					isError: false,
					timestamp: 3,
				},
			},
			{
				type: "message",
				id: "answer",
				parentId: "result",
				timestamp: "2026-08-22T00:00:03Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "The repository is healthy." }],
					model: "test/model",
					usage: assistantUsage(),
					stopReason: "stop",
					timestamp: 4,
				},
			},
		];

		const html = renderTranscript({ entries, working: false });

		expect(countElements(html, '.tr-run-toggle[aria-expanded="false"]')).toBe(1);
		expect(countElements(html, '.tr-run-process[aria-hidden="true"]')).toBe(1);
		expect(html).toContain("The repository is healthy.");
		expect(html).toContain("I will inspect the files.");
		expect(html).toContain("1 update");
		expect(html).toContain("1 tool");
	});

	it("keeps failed runs expanded instead of hiding their diagnostics", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "prompt",
				parentId: null,
				timestamp: "2026-08-22T00:00:00Z",
				message: { role: "user", content: "Fail visibly", timestamp: 1 },
			},
			{
				type: "message",
				id: "failure",
				parentId: "prompt",
				timestamp: "2026-08-22T00:00:01Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Visible failure details" }],
					model: "test/model",
					usage: assistantUsage(),
					stopReason: "error",
					errorMessage: "provider failed",
					timestamp: 2,
				},
			},
		];

		const html = renderTranscript({ entries, working: false });

		expect(html).toContain("Visible failure details");
		expect(html).toContain("provider failed");
		expect(countElements(html, ".tr-run-toggle")).toBe(0);
	});
});
