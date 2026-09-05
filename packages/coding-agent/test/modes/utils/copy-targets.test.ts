import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CopySelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/copy-selector";
import {
	extractCodeBlocks,
	extractLastCommand,
	extractLastLink,
	extractLinks,
	extractQuoteBlocks,
} from "@oh-my-pi/pi-coding-agent/modes/utils/copy-targets";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { setKeybindings, type TUI } from "@oh-my-pi/pi-tui";

const UP = "\x1b[A";
const ENTER = "\r";

function assistantText(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	} as unknown as AgentMessage;
}

function userText(text: string, attribution: "user" | "agent" = "user"): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], attribution } as unknown as AgentMessage;
}

function assistantCalls(toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>): AgentMessage {
	return {
		role: "assistant",
		content: toolCalls.map((tc, i) => ({ type: "toolCall", id: `tc-${i}`, name: tc.name, arguments: tc.arguments })),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		stopReason: "toolUse",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	} as unknown as AgentMessage;
}

function sessionEntries(messages: readonly AgentMessage[]): SessionMessageEntry[] {
	return messages.map((message, index) => ({
		type: "message",
		id: `entry-${index}`,
		parentId: index === 0 ? null : `entry-${index - 1}`,
		timestamp: new Date(index).toISOString(),
		message,
	}));
}

function copySelections(messages: readonly AgentMessage[]): Array<[content: string, label: string]> {
	const selections: Array<[content: string, label: string]> = [];
	const selector = new CopySelectorComponent(sessionEntries(messages), {
		ui: { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI,
		cwd: "/tmp",
		requestRender: () => {},
		onPick: (content, label) => selections.push([content, label]),
		onCancel: () => {},
	});
	expect(selector.targetCount).toBe(messages.length);
	for (let index = 0; index < messages.length; index++) {
		selector.handleInput(ENTER);
		selector.handleInput(UP);
	}
	selector.dispose();
	return selections;
}

beforeEach(async () => {
	await Settings.init({ inMemory: true });
	setKeybindings(KeybindingsManager.inMemory());
});

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
	resetSettingsForTest();
});

describe("extractCodeBlocks", () => {
	it("captures the language id and strips the trailing newline", () => {
		expect(extractCodeBlocks("intro\n```ts\nconst x = 1;\n```\ntail")).toEqual([
			{ lang: "ts", code: "const x = 1;" },
		]);
	});

	it("returns blocks in document order with empty lang for bare fences", () => {
		const blocks = extractCodeBlocks("```\nplain\n```\n\n```py\nprint(1)\n```");
		expect(blocks.map(b => b.lang)).toEqual(["", "py"]);
		expect(blocks.map(b => b.code)).toEqual(["plain", "print(1)"]);
	});
});

describe("extractQuoteBlocks", () => {
	it("collects a `>`-prefixed run and strips the marker plus one space", () => {
		const text = "intro\n> line one\n> line two\ntail";
		expect(extractQuoteBlocks(text)).toEqual([{ text: "line one\nline two" }]);
	});

	it("keeps bare `>` separator lines as blank lines and splits on plain text", () => {
		const text = "> first\n>\n> second\n\nbreak\n> later";
		expect(extractQuoteBlocks(text).map(b => b.text)).toEqual(["first\n\nsecond", "later"]);
	});

	it("does not treat `>` lines inside a fenced code block as a quote", () => {
		const text = "> real quote\n```\n> not a quote\n```";
		expect(extractQuoteBlocks(text)).toEqual([{ text: "real quote" }]);
	});
});

describe("extractLastCommand", () => {
	it("returns the most recent bash command, walking backwards", () => {
		const messages = [
			assistantCalls([{ name: "bash", arguments: { command: "echo old" } }]),
			assistantCalls([{ name: "read", arguments: { path: "x" } }]),
			assistantCalls([
				{ name: "bash", arguments: { command: "echo a" } },
				{ name: "bash", arguments: { command: "echo b" } },
			]),
		] as unknown as AgentMessage[];
		expect(extractLastCommand(messages)).toEqual({ kind: "bash", code: "echo b", language: "bash" });
	});

	it("returns PowerShell scripts as copied command candidates", () => {
		const messages = [
			assistantCalls([{ name: "pwsh", arguments: { script: "Get-ChildItem Env:" } }]),
		] as unknown as AgentMessage[];
		expect(extractLastCommand(messages)).toEqual({
			kind: "pwsh",
			code: "Get-ChildItem Env:",
			language: "powershell",
		});
	});

	it("extracts eval code from flat args and reports the language", () => {
		const py = [
			assistantCalls([{ name: "eval", arguments: { language: "py", code: "print(1)" } }]),
		] as unknown as AgentMessage[];
		expect(extractLastCommand(py)).toEqual({ kind: "eval", code: "print(1)", language: "python" });

		const js = [
			assistantCalls([{ name: "eval", arguments: { language: "js", code: "log(1)" } }]),
		] as unknown as AgentMessage[];
		expect(extractLastCommand(js)?.language).toBe("javascript");
	});

	it("still joins legacy multi-cell eval args from older transcripts", () => {
		const py = [
			assistantCalls([
				{ name: "eval", arguments: { cells: [{ language: "py", code: "print(1)" }, { code: "print(2)" }] } },
			]),
		] as unknown as AgentMessage[];
		expect(extractLastCommand(py)).toEqual({ kind: "eval", code: "print(1)\n\nprint(2)", language: "python" });
	});
});

describe("extractLinks", () => {
	it("finds inline links, autolinks, and bare URLs in document order, deduplicated by href", () => {
		const text = [
			'See [the docs](https://example.com/docs "Docs") and <https://example.com/auto>.',
			"Bare: https://example.com/bare/path?x=1&y=2 then again https://example.com/docs.",
		].join("\n");
		expect(extractLinks(text)).toEqual([
			{ text: "the docs", href: "https://example.com/docs" },
			{ text: "https://example.com/auto", href: "https://example.com/auto" },
			{ text: "https://example.com/bare/path?x=1&y=2", href: "https://example.com/bare/path?x=1&y=2" },
		]);
	});

	it("trims sentence punctuation but keeps a paren that belongs to the URL", () => {
		expect(extractLinks("(https://en.wikipedia.org/wiki/Foo_(bar)).")).toEqual([
			{ text: "https://en.wikipedia.org/wiki/Foo_(bar)", href: "https://en.wikipedia.org/wiki/Foo_(bar)" },
		]);
		expect(extractLinks("Try https://example.com/a, https://example.com/b; or https://example.com/c?")).toEqual([
			{ text: "https://example.com/a", href: "https://example.com/a" },
			{ text: "https://example.com/b", href: "https://example.com/b" },
			{ text: "https://example.com/c", href: "https://example.com/c" },
		]);
	});

	it("ignores URLs inside fenced code and inline code, because it uses the renderer's lexer", () => {
		const text =
			"Run `curl https://example.com/in-code` then:\n```bash\ncurl https://example.com/fenced\n```\nDocs: https://example.com/prose";
		expect(extractLinks(text)).toEqual([{ text: "https://example.com/prose", href: "https://example.com/prose" }]);
	});

	it("keeps a URL that the terminal would wrap as one target", () => {
		const long = `https://github.com/dalilshorja/dalilshorja/actions/runs/33654874668/job/100330811133?check_suite_focus=true&pr=4`;
		expect(extractLinks(`Run: ${long}`)).toEqual([{ text: long, href: long }]);
	});

	it("only http(s) targets qualify", () => {
		expect(extractLinks("[file](file:///tmp/x) [mail](mailto:a@b.c) ftp://x.y/z a@b.c")).toEqual([]);
	});

	it("resolves reference links and GFM www autolinks through the renderer's lexer", () => {
		expect(extractLinks("[ref link][r] and www.example.com/www\n\n[r]: https://example.com/ref")).toEqual([
			{ text: "ref link", href: "https://example.com/ref" },
			{ text: "www.example.com/www", href: "http://www.example.com/www" },
		]);
	});
});

describe("extractLastLink", () => {
	it("returns the last link of the most recent assistant message that has one", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "old https://example.com/old" }] },
			{
				role: "assistant",
				content: [{ type: "text", text: "a https://example.com/a and b https://example.com/b" }],
			},
			{ role: "user", content: "thanks https://example.com/user-link" },
			{ role: "assistant", content: [{ type: "text", text: "no links here" }] },
		] as unknown as AgentMessage[];
		expect(extractLastLink(messages)).toEqual({ text: "https://example.com/b", href: "https://example.com/b" });
		expect(extractLastLink(messages.slice(3))).toBeUndefined();
	});

	it("keeps every model output between user messages as an ordered copy target", () => {
		const selections = copySelections([
			userText("first prompt"),
			assistantText("first opening"),
			assistantText("first final"),
			userText("second prompt"),
			assistantText("second opening"),
			assistantCalls([{ name: "bash", arguments: { command: "bun check" } }]),
			assistantText("second final"),
		]);

		expect(selections).toEqual([
			["second final", "assistant message"],
			["bun check", "turn content"],
			["second opening", "assistant message"],
			["second prompt", "user message"],
			["first final", "assistant message"],
			["first opening", "assistant message"],
			["first prompt", "user message"],
		]);
	});

	it("preserves adjacent model outputs around agent-attributed synthetic input", () => {
		const selections = copySelections([
			userText("prompt"),
			assistantText("opening"),
			userText("hidden continuation", "agent"),
			assistantText("final"),
		]);

		expect(selections).toEqual([
			["final", "assistant message"],
			["hidden continuation", "user message"],
			["opening", "assistant message"],
			["prompt", "user message"],
		]);
	});
});
