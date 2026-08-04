import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { GlobTool } from "../../src/tools/glob";
import { applyListLimit } from "../../src/tools/list-limit";
import { formatOutputNotice } from "../../src/tools/output-meta";

const manyItems = Array.from({ length: 6000 }, (_, i) => `item-${i}`);

describe("applyListLimit", () => {
	it("caps the follow-up suggestion at maxSuggestion when truncation triggers", () => {
		const result = applyListLimit(manyItems, { limit: 5000, maxSuggestion: 5000 });
		expect(result.items).toHaveLength(5000);
		expect(result.limitReached).toBe(5000);
		expect(result.meta.resultLimit).toEqual({ reached: 5000, suggestion: 5000 });
	});

	it("keeps the original doubled suggestion when maxSuggestion is omitted", () => {
		const result = applyListLimit(manyItems, { limit: 5000 });
		expect(result.items).toHaveLength(5000);
		expect(result.meta.resultLimit).toEqual({ reached: 5000, suggestion: 10000 });
	});

	it("applies maxSuggestion to match-type limits", () => {
		const result = applyListLimit(manyItems, { limit: 5000, limitType: "match", maxSuggestion: 5000 });
		expect(result.meta.matchLimit).toEqual({ reached: 5000, suggestion: 5000 });
		expect(result.meta.resultLimit).toBeUndefined();
	});

	it("applies maxSuggestion to the head limit suggestion", () => {
		const result = applyListLimit(manyItems, { limit: 500, headLimit: 300, maxSuggestion: 500 });
		expect(result.meta.headLimit).toEqual({ reached: 300, suggestion: 500 });
	});

	it("leaves the head suggestion doubled without maxSuggestion", () => {
		const result = applyListLimit(manyItems, { limit: 500, headLimit: 300 });
		expect(result.meta.headLimit).toEqual({ reached: 300, suggestion: 600 });
	});

	it("never inflates the suggestion above the natural doubling", () => {
		const result = applyListLimit(manyItems, { limit: 5000, maxSuggestion: 20000 });
		expect(result.meta.resultLimit).toEqual({ reached: 5000, suggestion: 10000 });
	});

	it("emits no limit metadata when the list fits", () => {
		const result = applyListLimit(["a", "b"], { limit: 5, maxSuggestion: 5000 });
		expect(result.items).toEqual(["a", "b"]);
		expect(result.limitReached).toBeUndefined();
		expect(result.meta).toEqual({});
	});
});

describe("glob limit plumbing", () => {
	function createSession(cwd: string): ToolSession {
		return {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
	}

	function createTool(
		session: ToolSession,
		glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]>,
	): GlobTool {
		return new GlobTool(session, {
			operations: {
				exists: async () => true,
				stat: async () => ({ isFile: () => false, isDirectory: () => true }),
				glob,
			},
		});
	}

	function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
		return result.content
			.filter(c => c.type === "text")
			.map(c => c.text ?? "")
			.join("\n");
	}

	it("accepts limit=5000 without clamping it to 200", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "glob-limit-"));
		try {
			let requestedLimit: number | undefined;
			const files = Array.from({ length: 300 }, (_, i) => `file-${i}.txt`);
			const tool = createTool(createSession(tmpDir), async (_pattern, _cwd, options) => {
				requestedLimit = options.limit;
				return files;
			});

			const result = await tool.execute("glob-large-limit", { path: tmpDir, limit: 5000 });

			expect(requestedLimit).toBe(5000);
			expect(result.details?.fileCount).toBe(300);
			expect(result.details?.resultLimitReached).toBeUndefined();
			expect(resultText(result)).toContain("file-299.txt");
		} finally {
			await removeWithRetries(tmpDir);
		}
	});

	it("hints at the capped suggestion instead of a limit the tool cannot honor", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "glob-hint-"));
		try {
			const files = Array.from({ length: 6000 }, (_, i) => `file-${i}.txt`);
			const tool = createTool(createSession(tmpDir), async () => files);

			const result = await tool.execute("glob-capped-hint", { path: tmpDir, limit: 5000 });

			expect(result.details?.fileCount).toBe(5000);
			expect(result.details?.resultLimitReached).toBe(5000);
			const notice = formatOutputNotice(result.details?.meta);
			expect(notice).toContain("5000 results limit reached. Use limit=5000 for more");
			expect(notice).not.toContain("Use limit=10000");
		} finally {
			await removeWithRetries(tmpDir);
		}
	});
});
