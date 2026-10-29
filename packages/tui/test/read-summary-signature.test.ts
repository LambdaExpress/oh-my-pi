import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { EditStore } from "@oh-my-pi/pi-natives";
import type { SummaryResult } from "@oh-my-pi/pi-natives";
import { formatReadSummary } from "@oh-my-pi/pi-tui/tools/read";

const summary: SummaryResult = {
	language: "csharp",
	parsed: true,
	elided: true,
	totalLines: 8,
	segments: [
		{ kind: "kept", startLine: 1, endLine: 2, text: "class Counter\n{" },
		{ kind: "signature", startLine: 3, endLine: 3, text: "    public int Peek() => …;" },
		{ kind: "kept", startLine: 4, endLine: 4, text: "    public void Reset()" },
		{ kind: "signature", startLine: 5, endLine: 7, text: "    { … }" },
		{ kind: "kept", startLine: 8, endLine: 8, text: "}" },
	],
};

describe("read summary signature projections", () => {
	it("uses non-editable range prefixes and precise recovery ranges", () => {
		const rendered = formatReadSummary({ hashLines: true, lineNumbers: false }, summary);

		expect(rendered.text).toContain("~3-3:    public int Peek() => …;");
		expect(rendered.text).toContain("~5-7:    { … }");
		expect(rendered.text).not.toMatch(/^3:/m);
		expect(rendered.text).not.toMatch(/^5:/m);
		expect(rendered.elidedRanges).toEqual([
			{ start: 3, end: 3 },
			{ start: 5, end: 7 },
		]);
		expect(rendered.elidedLines).toBe(4);
		expect(rendered.displayText).toBe(
			"class Counter\n{\n    public int Peek() => …;\n    public void Reset()\n    { … }\n}",
		);
	});

	it("keeps projections separate from surrounding brace pairs in every display mode", () => {
		const numbered = formatReadSummary({ hashLines: false, lineNumbers: true }, summary);
		expect(numbered.text).toContain("~3-3|    public int Peek() => …;");
		expect(numbered.text).toContain("~5-7|    { … }");
		expect(numbered.text).toContain("8|}");

		const plain = formatReadSummary({ hashLines: false, lineNumbers: false }, summary);
		expect(plain.text).toBe(plain.displayText);
		expect(plain.elidedRanges).toEqual(numbered.elidedRanges);
	});

	it("never records projected boundary lines as fully seen editable source", () => {
		const store = new EditStore();
		const sourcePath = path.resolve("Counter.cs");
		const tag = store.recordSnapshot(
			sourcePath,
			"class Counter\n{\n    public int Peek() => 7;\n    public void Reset()\n    {\n        ResetCore();\n    }\n}\n",
			[0],
		);
		const rendered = formatReadSummary({ hashLines: true, lineNumbers: false }, summary);
		store.recordSeenLinesFromBody(sourcePath, tag, rendered.text);

		expect(store.seenLines(sourcePath, tag)).toEqual([0, 1, 2, 4, 8]);
	});
});
