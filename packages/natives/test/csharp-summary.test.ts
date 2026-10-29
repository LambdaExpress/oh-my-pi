import { describe, expect, it } from "bun:test";
import { summarizeCode, summarizeCodeAsync, wasmGrammarFor } from "../native";

const csharpGrammarUnavailable = wasmGrammarFor({ lang: "csharp" })?.installed === false;

describe.skipIf(csharpGrammarUnavailable)("C# declaration summaries (installed grammar)", () => {
	it("preserves inline declarations and exposes only non-editable signature projections", async () => {
		const code = [
			"namespace Example;",
			"public record Snapshot(int Value);",
			"public class Counter",
			"{",
			"    private int count = 0;",
			"    public Counter(int initial) { count = initial; }",
			"    public int Count { get => count; private set { count = value; } }",
			"    public int Next(int amount)",
			"    {",
			"        count += amount;",
			"        return count;",
			"    }",
			"    public int Peek() => count;",
			"}",
			"",
		].join("\n");
		const options = { code, path: "Counter.cs", unfoldUntilLines: 10_000, unfoldLimitLines: 20_000 };
		const result = summarizeCode(options);
		expect(await summarizeCodeAsync(options)).toEqual(result);
		expect(result.parsed).toBe(true);
		expect(result.elided).toBe(true);
		expect(result.language).toBe("csharp");
		const projected = result.segments.map(segment => segment.text ?? "").join("\n");
		expect(projected).toContain("public record Snapshot(int Value);");
		expect(projected).toContain("private int count = 0;");
		expect(projected).toContain("public Counter(int initial) { … }");
		expect(projected).toContain("public int Count { get => …; private set { … } }");
		expect(projected).toContain("public int Next(int amount)");
		expect(projected).toContain("public int Peek() => …;");
		expect(projected).not.toContain("count = initial");
		expect(projected).not.toContain("count = value");
		expect(projected).not.toContain("count += amount");
		expect(projected).not.toContain("return count");
		expect(result.segments.find(segment => segment.startLine === 9)).toEqual({
			kind: "signature",
			startLine: 9,
			endLine: 12,
			text: "    { … }",
		});
	});

	it("retains syntax failure as an explicitly unparsed result", () => {
		const code = "class Broken { public int Next( { return 37; }\n";
		const result = summarizeCode({ code, path: "Broken.cs" });

		expect(result.parsed).toBe(false);
		expect(result.elided).toBe(false);
		expect(result.segments).toEqual([{ kind: "kept", startLine: 1, endLine: 1, text: code }]);
	});
});
