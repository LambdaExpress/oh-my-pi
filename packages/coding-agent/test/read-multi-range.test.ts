import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

import { cfgReadSummarizeEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

function createSession(cwd: string, bridge?: ClientBridge): ToolSession {
	const settings = Settings.isolated();
	// Disable structural summarization so multi-range tests assert raw line content
	// regardless of language heuristics.
	cfgReadSummarizeEnabled.set(settings, false);
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings,
		getClientBridge: bridge ? () => bridge : undefined,
	};
}

function makeNumberedContent(lines: number): string {
	return Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n");
}

describe("read tool multi-range selector", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-multi-range-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("returns both ranges separated by an elision marker", async () => {
		const filePath = path.join(tmpDir, "src", "numbered.txt");
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, makeNumberedContent(50));

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("call-multi", { path: `${filePath}:3-5,20-22` });
		const text = textOutput(result);
		const firstLine = text.split("\n")[0];
		expect(firstLine).toMatch(/^\[src\/numbered\.txt#[0-9A-F]{4}\]$/);

		expect(text).toContain("line 3");
		expect(text).toContain("line 4");
		expect(text).toContain("line 5");
		expect(text).toContain("line 20");
		expect(text).toContain("line 21");
		expect(text).toContain("line 22");
		// Lines between the ranges must be elided
		expect(text).not.toContain("line 10");
		expect(text).not.toContain("line 19");
		// Separator marker is present between blocks
		expect(text).toContain("…");
	});

	it("does not add the enclosing block to an explicit forward range", async () => {
		const filePath = path.join(tmpDir, "brackets.ts");
		await fs.writeFile(
			filePath,
			[
				"function outer() {",
				"  const one = 1;",
				"  const two = 2;",
				"  const three = 3;",
				"  const four = 4;",
				"  return one + two + three + four;",
				"}",
				"after();",
			].join("\n"),
		);

		const tool = new ReadTool(createSession(tmpDir));
		const text = textOutput(await tool.execute("call-bracket-close", { path: `${filePath}:1-1` }));

		expect(text).toContain("function outer() {");
		// The matching `}` and the elided body must stay out of the window.
		expect(text).not.toContain("}");
		expect(text).not.toContain("…");
		expect(text).not.toContain("const one");
	});

	it("does not add the enclosing block to an explicit reverse range", async () => {
		const filePath = path.join(tmpDir, "brackets.ts");
		await fs.writeFile(
			filePath,
			[
				"function outer() {",
				"  const one = 1;",
				"  const two = 2;",
				"  const three = 3;",
				"  const four = 4;",
				"  return one + two + three + four;",
				"}",
				"after();",
			].join("\n"),
		);

		const tool = new ReadTool(createSession(tmpDir));
		const text = textOutput(await tool.execute("call-bracket-open", { path: `${filePath}:7-7` }));

		expect(text).toContain("}");
		// The opener and the elided body must stay out of the window.
		expect(text).not.toContain("function outer() {");
		expect(text).not.toContain("…");
		expect(text).not.toContain("const one = 1");
	});

	it("does not extend an explicit range to a tree-sitter syntactic span", async () => {
		const filePath = path.join(tmpDir, "module.py");
		await fs.writeFile(
			filePath,
			[
				"def greet(name):",
				"    a = 1",
				"    b = 2",
				"    c = 3",
				"    d = 4",
				"    e = 5",
				"    f = 6",
				"    g = 7",
				"    return a + b + c + d + e + f + g + len(name)",
				"trailing = 1",
			].join("\n"),
		);

		const tool = new ReadTool(createSession(tmpDir));
		// Reading only the `def` header must not surface the body's last line
		// as a block boundary behind an ellipsis.
		const text = textOutput(await tool.execute("call-py-def", { path: `${filePath}:1-1` }));

		expect(text).toContain("def greet(name):");
		expect(text).not.toContain("…");
		expect(text).not.toContain("return a + b + c + d + e + f + g + len(name)");
		expect(text).not.toContain("trailing = 1");
	});

	it("merges overlapping ranges into a single contiguous block", async () => {
		const filePath = path.join(tmpDir, "numbered.txt");
		await fs.writeFile(filePath, makeNumberedContent(20));

		const tool = new ReadTool(createSession(tmpDir));
		// 3-7 and 6-9 overlap → merged into 3-9 (collapses to a single-range read).
		const result = await tool.execute("call-merge", { path: `${filePath}:3-7,6-9` });
		const text = textOutput(result);

		// All lines from the merged range present
		for (const i of [3, 4, 5, 6, 7, 8, 9]) {
			// Each line renders with its hashline prefix; assert on the
			// prefixed form so the check does not depend on a trailing newline.
			expect(text).toContain(`${i}:line ${i}`);
		}
		// No separator because ranges merged into one contiguous block
		expect(text).not.toContain("…");
	});

	it("sorts ranges in ascending order regardless of user order", async () => {
		const filePath = path.join(tmpDir, "numbered.txt");
		await fs.writeFile(filePath, makeNumberedContent(50));

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("call-sort", { path: `${filePath}:30-32,5-7` });
		const text = textOutput(result);

		const indexEarly = text.indexOf("line 5");
		const indexLate = text.indexOf("line 30");
		expect(indexEarly).toBeGreaterThanOrEqual(0);
		expect(indexLate).toBeGreaterThan(indexEarly);
	});

	it("surfaces an inline notice when a range is past EOF", async () => {
		const filePath = path.join(tmpDir, "small.txt");
		await fs.writeFile(filePath, makeNumberedContent(10));

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("call-oob", { path: `${filePath}:3-5,999-1000` });
		const text = textOutput(result);

		expect(text).toContain("line 3");
		expect(text).toContain("line 5");
		expect(text).toContain("Range 999-1000 is beyond end of file (10 lines total); skipped");
	});

	it("supports the +count syntax in multi-range", async () => {
		const filePath = path.join(tmpDir, "numbered.txt");
		await fs.writeFile(filePath, makeNumberedContent(30));

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("call-plus", { path: `${filePath}:2+2,20+2` });
		const text = textOutput(result);

		expect(text).toContain("line 2");
		expect(text).toContain("line 3");
		expect(text).toContain("line 20");
		expect(text).toContain("line 21");
		expect(text).not.toContain("line 4");
		expect(text).not.toContain("line 19");
	});

	it("将正向范围和最后若干行保留在同一资源", async () => {
		const filePath = path.join(tmpDir, "PackageProvenance.json");
		const lines = makeNumberedContent(180).split("\n");
		await fs.writeFile(filePath, lines.join("\n"));

		const result = await new ReadTool(createSession(tmpDir)).execute("call-mixed-tail", {
			path: `${filePath}:1-105,-38`,
		});

		expect(result.details?.displayContent).toEqual({
			text: [...lines.slice(0, 105), "…", ...lines.slice(142)].join("\n"),
			startLine: 1,
			lineNumbers: [
				...Array.from({ length: 105 }, (_, i) => i + 1),
				null,
				...Array.from({ length: 38 }, (_, i) => i + 143),
			],
		});
	});

	it.each([
		{
			selector: "-3,2+2,20-,21",
			spans: [
				[2, 3],
				[20, 30],
			],
		},
		{ selector: "-8,25-27,-3", spans: [[23, 30]] },
		{ selector: "15-,-3", spans: [[15, 30]] },
		{
			selector: "-3,2",
			spans: [
				[2, 2],
				[28, 30],
			],
		},
	])("排序并合并混合选择器 $selector", async ({ selector, spans }) => {
		const filePath = path.join(tmpDir, "numbered.txt");
		const lines = makeNumberedContent(30).split("\n");
		await fs.writeFile(filePath, lines.join("\n"));
		const textParts: string[] = [];
		const lineNumbers: Array<number | null> = [];
		for (const [start, end] of spans) {
			if (textParts.length > 0) {
				textParts.push("…");
				lineNumbers.push(null);
			}
			textParts.push(...lines.slice(start! - 1, end));
			lineNumbers.push(...Array.from({ length: end! - start! + 1 }, (_, i) => start! + i));
		}

		const result = await new ReadTool(createSession(tmpDir)).execute("call-tail-union", {
			path: `${filePath}:${selector}`,
		});

		expect(result.details?.displayContent).toEqual({
			text: textParts.join("\n"),
			startLine: spans[0]![0],
			lineNumbers,
		});
	});

	it("在两种 raw 顺序下按原始换行片段解析混合尾范围", async () => {
		const filePath = path.join(tmpDir, "raw.txt");
		await fs.writeFile(filePath, "one\r\ntwo\r\nthree\r\nfour\r\n");
		const tool = new ReadTool(createSession(tmpDir));
		const expected = "two\r\n\n…\n\nfour\r\n";

		for (const selector of ["raw:2-2,-2", "2-2,-2:raw"]) {
			expect(textOutput(await tool.execute(`call-${selector}`, { path: `${filePath}:${selector}` }))).toBe(expected);
		}
		expect(textOutput(await tool.execute("call-raw-tail", { path: `${filePath}:raw:-2` }))).toBe("four\r\n");
		const tail = await tool.execute("call-tail", { path: `${filePath}:-2` });
		expect(tail.details?.displayContent?.lineNumbers).toEqual([3, 4]);
	});

	it("对超过快照大小的文件按实际总行数解析尾范围", async () => {
		const filePath = path.join(tmpDir, "large.txt");
		const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1} ${"x".repeat(1000)}`);
		await fs.writeFile(filePath, lines.join("\n"));

		const result = await new ReadTool(createSession(tmpDir)).execute("call-streamed-tail", {
			path: `${filePath}:raw:1-2,-2`,
		});

		expect(textOutput(result)).toBe(`${lines.slice(0, 2).join("\n")}\n\n…\n\n${lines.slice(-2).join("\n")}`);
	});

	it("保留普通逗号路径列表和带标点的字面文件名", async () => {
		await fs.writeFile(path.join(tmpDir, "first.txt"), "第一个文件");
		await fs.writeFile(path.join(tmpDir, "second.txt"), "第二个文件");
		await fs.writeFile(path.join(tmpDir, "first,second;-38.txt"), "字面文件首行\n字面文件中间行\n字面文件尾行");
		const tool = new ReadTool(createSession(tmpDir));

		const list = textOutput(await tool.execute("call-path-list", { path: "first.txt,second.txt" }));
		expect(list).toContain("第一个文件");
		expect(list).toContain("第二个文件");
		await fs.writeFile(path.join(tmpDir, "first.txt"), "第一个文件首行\n第一个文件中间行\n第一个文件尾行");
		const rangedList = textOutput(
			await tool.execute("call-ranged-path-list", { path: "first.txt:raw:1-1,-1,second.txt:1-1" }),
		);
		expect(rangedList).toContain("第一个文件首行");
		expect(rangedList).toContain("第一个文件尾行");
		expect(rangedList).toContain("第二个文件");
		expect(rangedList).not.toContain("第一个文件中间行");
		const literal = await tool.execute("call-literal-punctuation", { path: "first,second;-38.txt:1-1,-1" });
		expect(literal.details?.displayContent?.text).toBe("字面文件首行\n…\n字面文件尾行");
		expect(literal.details?.displayContent?.lineNumbers).toEqual([1, null, 3]);
	});

	it("accepts `..` as a forgiving alias for `-`, producing identical output", async () => {
		const filePath = path.join(tmpDir, "numbered.txt");
		await fs.writeFile(filePath, makeNumberedContent(30));

		const tool = new ReadTool(createSession(tmpDir));
		const dotdot = textOutput(await tool.execute("call-dotdot", { path: `${filePath}:3..5` }));
		const dash = textOutput(await tool.execute("call-dash", { path: `${filePath}:3-5` }));

		expect(dotdot).toContain("line 3");
		expect(dotdot).toContain("line 5");
		// `..` must be a pure alias: byte-for-byte identical to the `-` form.
		expect(dotdot).toBe(dash);
	});

	it("accepts `..` in multi-range selectors", async () => {
		const filePath = path.join(tmpDir, "numbered.txt");
		await fs.writeFile(filePath, makeNumberedContent(50));

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("call-dotdot-multi", { path: `${filePath}:3..5,20..22` });
		const text = textOutput(result);

		expect(text).toContain("line 3");
		expect(text).toContain("line 5");
		expect(text).toContain("line 20");
		expect(text).toContain("line 22");
		expect(text).not.toContain("line 10");
		expect(text).toContain("…");
	});

	it("rejects multi-range selectors on directories", async () => {
		const tool = new ReadTool(createSession(tmpDir));
		await expect(tool.execute("call-dir", { path: `${tmpDir}:1-2,5-6` })).rejects.toThrow(
			/Multi-range line selectors are not supported for directory listings/,
		);
	});

	it("routes multi-range reads through the ACP bridge when available", async () => {
		const filePath = path.join(tmpDir, "disk.txt");
		await fs.writeFile(filePath, "disk one\ndisk two\ndisk three\ndisk four\ndisk five\n");
		const bridgeText = "bridge one\nbridge two\nbridge three\nbridge four\nbridge five\n";
		const bridge: ClientBridge = {
			capabilities: { readTextFile: true },
			readTextFile: async () => bridgeText,
		};

		const tool = new ReadTool(createSession(tmpDir, bridge));
		const result = await tool.execute("call-bridge", { path: `${filePath}:1-2,4-5` });
		const text = textOutput(result);

		expect(text).toContain("bridge one");
		expect(text).toContain("bridge two");
		expect(text).toContain("bridge four");
		expect(text).toContain("bridge five");
		expect(text).not.toContain("bridge three");
		expect(text).not.toContain("disk one");
	});

	it("按 ACP 编辑器文本的总行数解析混合尾范围", async () => {
		const filePath = path.join(tmpDir, "bridge-tail.txt");
		await fs.writeFile(filePath, makeNumberedContent(5));
		const bridgeLines = Array.from({ length: 30 }, (_, i) => `bridge ${i + 1}`);
		const bridge: ClientBridge = {
			capabilities: { readTextFile: true },
			readTextFile: async () => bridgeLines.join("\n"),
		};

		const result = await new ReadTool(createSession(tmpDir, bridge)).execute("call-bridge-tail", {
			path: `${filePath}:2-3,-2`,
		});

		expect(result.details?.totalLines).toBe(30);
		expect(result.details?.displayContent).toEqual({
			text: [...bridgeLines.slice(1, 3), "…", ...bridgeLines.slice(-2)].join("\n"),
			startLine: 2,
			lineNumbers: [2, 3, null, 29, 30],
		});
	});

	it("keeps ACP multi-range blanks editable without exposing the EOF sentinel", async () => {
		const filePath = path.join(tmpDir, "bridge.txt");
		const bridgeText = "first\n\nlast\n";
		await fs.writeFile(filePath, bridgeText);
		const bridge: ClientBridge = {
			capabilities: { readTextFile: true },
			readTextFile: async () => bridgeText,
		};
		const session = createSession(tmpDir, bridge);
		const text = textOutput(await new ReadTool(session).execute("call-bridge-eof", { path: `${filePath}:1-2,3-3` }));
		const header = text.split("\n")[0] ?? "";
		expect(header).toMatch(/^\[bridge\.txt#[0-9A-F]{4}\]$/);
		expect(text).toContain("1:first\n2:");
		expect(text).not.toContain("\n4:");

		await new EditTool(session, "hashline").execute("call-bridge-edit", {
			input: `${header}\nCUT 2`,
		});

		expect(await fs.readFile(filePath, "utf8")).toBe("first\nlast\n");
	});
});
