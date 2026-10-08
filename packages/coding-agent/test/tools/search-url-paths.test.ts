import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GlobTool } from "@oh-my-pi/pi-coding-agent/tools/glob";
import * as scrapers from "@oh-my-pi/pi-coding-agent/web/scrapers/types";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function createSession(testDir: string): ToolSession {
	const sessionFile = path.join(testDir, "session.jsonl");
	const artifactsDir = sessionFile.slice(0, -6);
	let nextArtifactId = 0;
	return {
		cwd: testDir,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => "*",
		allocateOutputArtifact: async toolType => {
			const id = String(nextArtifactId++);
			return { id, path: path.join(artifactsDir, `${id}.${toolType}.log`) };
		},
		settings: Settings.isolated({
			"fetch.enabled": true,
			"grep.contextBefore": 0,
			"grep.contextAfter": 0,
			"astGrep.enabled": true,
			"astEdit.enabled": true,
			"tools.xdev": false,
		}),
	};
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

function stubLoadPage(body: string, contentType: string) {
	return vi.spyOn(scrapers, "loadPage").mockImplementation(async requestedUrl => ({
		ok: true,
		status: 200,
		finalUrl: requestedUrl,
		contentType,
		content: body,
	}));
}

describe("search tools with external URL paths", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "search-url-paths-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(testDir);
	});

	it("search fetches a URL and greps the rendered text", async () => {
		stubLoadPage("alpha\nremote needle\nomega\n", "text/plain");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("search-url", {
			pattern: "remote needle",
			path: "https://example.com/notes.txt",
		});

		const text = resultText(result);
		expect(text).toContain("remote needle");
		expect(text).not.toContain("Cannot search external URL");
	});

	it("refetches the same URL before each search", async () => {
		let body = "first needle\n";
		const loadPage = vi.spyOn(scrapers, "loadPage").mockImplementation(async requestedUrl => ({
			ok: true,
			status: 200,
			finalUrl: requestedUrl,
			contentType: "text/plain",
			content: body,
		}));
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const first = await tool!.execute("search-url-first", {
			pattern: "first|second",
			path: "https://example.com/live.txt",
		});
		body = "second needle\n";
		const second = await tool!.execute("search-url-second", {
			pattern: "first|second",
			path: "https://example.com/live.txt",
		});

		expect(resultText(first)).toContain("first needle");
		expect(resultText(second)).toContain("second needle");
		expect(resultText(second)).not.toContain("first needle");
		expect(loadPage).toHaveBeenCalledTimes(2);
	});

	it("search applies URL line-range selectors after materialization", async () => {
		stubLoadPage("outside before\nremote needle\noutside after\n", "text/plain");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("search-url-range", {
			pattern: "outside|remote needle",
			path: "https://example.com/notes.txt:2-2",
		});

		const text = resultText(result);
		expect(text).toContain("remote needle");
		expect(text).not.toContain("outside before");
		expect(text).not.toContain("outside after");
	});

	it("ast_edit rejects external URLs instead of staging read-cache files", async () => {
		stubLoadPage("legacyWrap(x, value)\n", "text/plain");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "ast_edit");
		expect(tool).toBeDefined();

		await expect(
			tool!.execute("ast-edit-url", {
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: ["https://example.com/snippet.ts"],
			}),
		).rejects.toThrow("Cannot rewrite external URL");
	});

	it("ast_grep materializes URL content with the source extension", async () => {
		stubLoadPage("export function remoteNeedle() {\n\treturn 1;\n}\n", "text/plain");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "ast_grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("ast-grep-url", {
			pat: "remoteNeedle",
			path: "https://example.com/snippet.ts",
		});

		const text = resultText(result);
		expect(text).toContain("remoteNeedle");
		expect(text).not.toContain("Parse issues");
	});

	it("search materializes a scheme-less www. scope like its canonical spelling", async () => {
		const loadPage = stubLoadPage("alpha\nremote needle\nomega\n", "text/plain");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("search-url-www", {
			pattern: "remote needle",
			path: "www.example.com/notes.txt",
		});

		expect(resultText(result)).toContain("remote needle");
		expect(loadPage).toHaveBeenCalledWith("https://www.example.com/notes.txt", expect.anything());
	});

	it("search repairs a collapsed https:/ scheme before materializing", async () => {
		const loadPage = stubLoadPage("alpha\nremote needle\nomega\n", "text/plain");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("search-url-collapsed", {
			pattern: "remote needle",
			path: "https:/example.com/notes.txt",
		});

		expect(resultText(result)).toContain("remote needle");
		expect(loadPage).toHaveBeenCalledWith("https://example.com/notes.txt", expect.anything());
	});

	it("search prefers an existing local directory named like a www. host", async () => {
		const loadPage = stubLoadPage("remote body\n", "text/plain");
		await fs.mkdir(path.join(testDir, "www.example.com"), { recursive: true });
		await fs.writeFile(path.join(testDir, "www.example.com", "notes.txt"), "local needle\n");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("search-local-dir", {
			pattern: "local needle",
			path: "www.example.com",
		});

		expect(resultText(result)).toContain("local needle");
		expect(loadPage).not.toHaveBeenCalled();
	});

	it("search leaves plain relative paths untouched by URL materialization", async () => {
		const loadPage = stubLoadPage("remote body\n", "text/plain");
		await fs.mkdir(path.join(testDir, "src"), { recursive: true });
		await fs.writeFile(path.join(testDir, "src", "notes.txt"), "local needle\n");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("search-local-rel", {
			pattern: "local needle",
			path: "src/notes.txt",
		});

		expect(resultText(result)).toContain("local needle");
		expect(loadPage).not.toHaveBeenCalled();
	});

	it("search rejects unsupported URL schemes explicitly", async () => {
		stubLoadPage("remote body\n", "text/plain");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		await expect(
			tool!.execute("search-url-ftp", {
				pattern: "needle",
				path: "ftp://example.com/notes.txt",
			}),
		).rejects.toThrow("Cannot search external URL");
	});
});

describe("glob unions of internal URLs and workspace paths", () => {
	let testDir: string;
	let localDir: string;
	let tool: GlobTool;
	const mixedPattern =
		"local://*backend*;AvatarLibrary/SettingsReadback/*;**/SettingsPage*;**/StreamingAssetsMode*;**/*Configuration*.cs";
	const expectedFiles = [
		"local://avatar-library-backend-notes.md",
		"AvatarLibrary/SettingsReadback/settings.html",
		"AvatarLibrary/Pages/SettingsPage.cs",
		"AvatarLibrary/Features/StreamingAssetsMode.cs",
		"Config/AppConfiguration.cs",
	];

	async function writeFixture(filePath: string, mtime: number): Promise<void> {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, "fixture\n");
		await fs.utimes(filePath, mtime, mtime);
	}

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "glob-url-union-"));
		const session = createSession(testDir);
		localDir = resolveLocalRoot({ getArtifactsDir: () => session.getArtifactsDir!() });
		tool = new GlobTool(session);
		for (const [index, entry] of expectedFiles.entries()) {
			const filePath = entry.startsWith("local://")
				? path.join(localDir, entry.slice("local://".length))
				: path.join(testDir, entry);
			await writeFixture(filePath, 1_600_000_000 - index * 10);
		}
		await writeFixture(path.join(testDir, "unrelated.txt"), 1_600_000_100);
	});

	afterEach(async () => {
		await removeWithRetries(testDir);
	});

	it("returns the real native-walk union for the reported mixed glob", async () => {
		const result = await tool.execute("mixed-glob", {
			path: mixedPattern,
			hidden: true,
			gitignore: false,
			limit: 120,
		});

		expect(result.details?.files).toEqual(expectedFiles);
		expect(resultText(result)).toContain("avatar-library-backend-notes.md");
		expect(resultText(result)).toContain("settings.html");
	});

	it("unions exact URL and workspace entries and reports a missing trailing filename", async () => {
		const result = await tool.execute("exact-mixed-glob", {
			path: "local://avatar-library-backend-notes.md;AvatarLibrary/SettingsReadback/settings.html;missing.txt",
			gitignore: false,
		});

		expect(result.details?.files).toEqual(expectedFiles.slice(0, 2));
		expect(result.details?.missingPaths).toEqual(["missing.txt"]);
	});

	it("deduplicates overlapping targets before applying the globally ranked limit", async () => {
		const result = await tool.execute("mixed-glob-limit", {
			path: `${mixedPattern};AvatarLibrary/SettingsReadback/settings.html`,
			hidden: true,
			gitignore: false,
			limit: 2,
		});

		expect(result.details?.files).toEqual(expectedFiles.slice(0, 2));
		expect(result.details?.truncated).toBe(true);
	});

	it("preserves literal URL and workspace semicolons alongside brace-glob commas", async () => {
		await writeFixture(path.join(localDir, "avatar;backend.md"), 1_600_000_200);
		await writeFixture(path.join(localDir, "scratch,copy.md"), 1_600_000_195);
		await writeFixture(path.join(testDir, "backend.md"), 1_600_000_210);
		await writeFixture(path.join(testDir, "a;b.txt"), 1_600_000_190);
		await writeFixture(path.join(testDir, "src", "a.txt"), 1_600_000_180);
		await writeFixture(path.join(testDir, "src", "b.txt"), 1_600_000_170);
		await writeFixture(path.join(testDir, "src", "c.txt"), 1_600_000_220);

		const literal = await tool.execute("literal-url", {
			path: "local://avatar;backend.md",
			gitignore: false,
		});
		expect(literal.details?.files).toEqual(["local://avatar;backend.md"]);

		const mixed = await tool.execute("literal-mixed-glob", {
			path: "local://avatar;backend.md;a;b.txt;local://scratch,copy.md;src/{a,b}.txt",
			gitignore: false,
		});
		expect(mixed.details?.files).toEqual([
			"local://avatar;backend.md",
			"local://scratch,copy.md",
			"a;b.txt",
			"src/a.txt",
			"src/b.txt",
		]);
	});

	it("reports missing mixed targets while retaining surviving URL and workspace matches", async () => {
		const result = await tool.execute("mixed-glob-missing", {
			path: `${mixedPattern};missing/**/*.txt`,
			gitignore: false,
		});
		expect(result.details?.files).toEqual(expectedFiles);
		expect(result.details?.missingPaths).toEqual(["missing/**/*.txt"]);

		const missingFile = await tool.execute("url-glob-missing-file", {
			path: "local://*backend*;missing.txt",
			gitignore: false,
		});
		expect(missingFile.details?.files).toEqual([expectedFiles[0]]);
		expect(missingFile.details?.missingPaths).toEqual(["missing.txt"]);

		await expect(
			tool.execute("mixed-glob-all-missing", {
				path: "local://missing/*.md;missing/**/*.txt",
				gitignore: false,
			}),
		).rejects.toThrow(ToolError);
	});

	it("keeps URL access-tier refusals fatal instead of treating them as missing targets", async () => {
		await expect(
			tool.execute("restricted-mixed-glob", {
				path: "ssh://unconfigured/root/*.md;AvatarLibrary/SettingsReadback/*",
				gitignore: false,
			}),
		).rejects.toMatchObject({ code: "EACCES" });
	});
});
