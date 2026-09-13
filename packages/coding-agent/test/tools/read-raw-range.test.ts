import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { formatTruncationMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text" && typeof c.text === "string")
		.map(c => c.text as string)
		.join("\n");
}

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "session"),
		settings: Settings.isolated(),
	};
}

describe("read tool raw range exactness", () => {
	let testDir: string;
	let filePath: string;
	let tool: ReadTool;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-raw-range-"));
		filePath = path.join(testDir, "data.txt");
		const lines = Array.from({ length: 60 }, (_, index) => `L${String(index + 1).padStart(2, "0")}`);
		await Bun.write(filePath, lines.join("\n"));
		tool = new ReadTool(makeSession(testDir));
	});

	afterEach(async () => {
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("returns exactly the requested single line for raw:N-N", async () => {
		// Regression: raw ranges used to get 1 leading + 3 trailing context
		// lines. Without line numbers the padding is indistinguishable from
		// requested content, so verbatim-extraction callers pasted 5 lines
		// where they asked for 1.
		const result = await tool.execute("call-raw-single", { path: `${filePath}:raw:31-31` });
		const output = getTextOutput(result);

		expect(output.trimEnd()).toBe("L31");
	});

	it("returns exactly the requested raw range at the start of the file", async () => {
		const result = await tool.execute("call-raw-head", { path: `${filePath}:raw:1-2` });
		const output = getTextOutput(result);

		expect(output.trimEnd()).toBe("L01\nL02");
	});

	it("records the source line count for an open-ended range that reaches EOF", async () => {
		const result = await tool.execute("call-raw-tail", { path: `${filePath}:raw:31-` });

		expect(result.details?.totalLines).toBe(60);
	});

	it("returns exactly the requested numbered range", async () => {
		// Explicit numeric selectors are exact: `:31-31` must not pad with
		// leading/trailing context the caller never asked for.
		const result = await tool.execute("call-numbered", { path: `${filePath}:31-31` });
		const output = getTextOutput(result);

		expect(output).toContain("L31");
		expect(output).not.toContain("L30");
		expect(output).not.toContain("L32");
	});

	it("returns exactly the requested range inside a bracket block", async () => {
		// Regression: an explicit `:N-M` used to grow to the enclosing
		// bracket/tree-sitter block, leaking the `function` header and closing
		// brace (plus an elision) that the caller never requested.
		const blockFile = path.join(testDir, "block.txt");
		await Bun.write(
			blockFile,
			[
				"function outer() {",
				"  const one = 1;",
				"  const two = 2;",
				"  const three = 3;",
				"  return one + two + three;",
				"}",
				"after();",
			].join("\n"),
		);

		const result = await tool.execute("call-block-range", { path: `${blockFile}:2-3` });
		const output = getTextOutput(result);

		expect(output).toContain("const one = 1;");
		expect(output).toContain("const two = 2;");
		expect(output).not.toContain("function outer() {");
		expect(output).not.toContain("const three");
		expect(output).not.toContain("after();");
		expect(output).not.toContain("…");
	});

	it("keeps the continuation when the byte budget stops inside requested buffered content", async () => {
		const bufferedFile = path.join(testDir, "buffered-range.txt");
		await Bun.write(
			bufferedFile,
			Array.from({ length: 100 }, (_, index) => `line-${index + 1} ${"x".repeat(1_016)}`).join("\n"),
		);

		const result = await tool.execute("call-buffered-byte-limited-range", { path: `${bufferedFile}:1-100` });
		const output = getTextOutput(result);
		const truncation = result.details?.meta?.truncation;

		expect(output).not.toContain("could not fit after preceding context");
		expect(output).not.toContain(":raw:");
		expect(truncation).toBeDefined();
		if (!truncation) throw new Error("expected truncation metadata");
		const shownRange = truncation.shownRange;
		expect(shownRange).toBeDefined();
		if (!shownRange) throw new Error("expected shown range");
		expect(truncation.nextOffset).toBe(shownRange.end + 1);
		expect(formatTruncationMetaNotice(truncation)).toContain(`Use :${truncation.nextOffset} to continue`);
	});

	it("byte-caps a requested oversized line without padding in context", async () => {
		const bufferedFile = path.join(testDir, "buffered-oversized.txt");
		await Bun.write(
			bufferedFile,
			["leading-context", `oversized-${"x".repeat(70_000)}-end`, "trailing-one", "trailing-two"].join("\n"),
		);

		const result = await tool.execute("call-buffered-oversized-selected", { path: `${bufferedFile}:2-2` });
		const output = getTextOutput(result);

		// `:2-2` selects line 2 alone; line 1 is not pulled in as context, so the
		// oversized requested line itself is what exceeds the byte budget.
		expect(output).not.toContain("leading-context");
		const truncation = result.details?.meta?.truncation;
		expect(truncation?.partialLine).toBe(true);
		expect(truncation?.totalBytes).toBeGreaterThan(70_000);
		expect(truncation?.nextOffset).toBeUndefined();
		if (!truncation) throw new Error("expected truncation metadata");
		expect(formatTruncationMetaNotice(truncation)).not.toContain("Use :2 to continue");

		const recovered = await tool.execute("call-buffered-oversized-raw", { path: `${bufferedFile}:raw:2-2` });
		const recoveredOutput = getTextOutput(recovered);
		expect(recoveredOutput).toStartWith("oversized-");
		expect(recoveredOutput).not.toContain("leading-context");
		expect(recoveredOutput).not.toContain("trailing-one");
		expect(recovered.details?.meta?.truncation?.partialLine).toBe(true);
	});

	it("accounts for the displayed preview when a single raw line exceeds the byte budget", async () => {
		// Regression #10768: an oversized first line collects no complete line but
		// still renders a ~50 KB byte-capped preview. The truncation meta used to
		// report outputLines=0/outputBytes=0/totalBytes=0, so the notice claimed
		// "Showing 0 of N lines (0B limit)" over visible content.
		const bigFile = path.join(testDir, "big.txt");
		const bigLine = "x".repeat(70000);
		await Bun.write(bigFile, `first\n${bigLine}\nlast\n`);

		const result = await tool.execute("call-oversized-line", { path: `${bigFile}:raw:2-2` });
		const body = getTextOutput(result);
		expect(Buffer.byteLength(body, "utf-8")).toBeGreaterThan(50000);

		const truncation = result.details?.meta?.truncation;
		expect(truncation).toBeDefined();
		if (!truncation) throw new Error("expected truncation meta");
		expect(truncation.partialLine).toBe(true);
		expect(truncation.outputLines).toBe(1);
		expect(truncation.outputBytes).toBe(Buffer.byteLength(body, "utf-8"));
		expect(truncation.totalBytes).toBe(70000);

		const notice = formatTruncationMetaNotice(truncation);
		expect(notice).toContain("(partial,");
		expect(notice).not.toMatch(/Showing 0 of/);
		expect(notice).not.toContain("0B limit");
	});
});
