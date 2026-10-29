import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { writeArchive } from "@oh-my-pi/pi-utils/ar";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

function createSession(root: string): ToolSession {
	const artifactsDir = path.join(root, "artifacts");
	let artifactId = 100;
	return {
		cwd: root,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => artifactsDir,
		localProtocolOptions: { getArtifactsDir: () => artifactsDir, getSessionId: () => "read-selectors" },
		allocateOutputArtifact: async () => {
			const id = String(artifactId++);
			await fs.mkdir(artifactsDir, { recursive: true });
			return { id, path: path.join(artifactsDir, `${id}.read.log`) };
		},
		settings: Settings.isolated({ "read.summarize.enabled": false }),
	};
}

describe("read selector resource boundaries", () => {
	let root: string;
	let session: ToolSession;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "read-selector-regressions-"));
		session = createSession(root);
	});

	afterEach(async () => {
		await removeWithRetries(root);
	});

	it("peels conflict ranges before validation and counts only conflict source lines", async () => {
		const block = ["<<<<<<< ours", "ours-one", "ours-two", "=======", "theirs-one", ">>>>>>> theirs"];
		await Bun.write(path.join(root, "conflicted.txt"), ["before-one", "before-two", ...block, "after"].join("\n"));
		const tool = wrapToolWithMetaNotice(new ReadTool(session));
		await tool.execute("register-conflict", { path: "conflicted.txt:conflicts" });

		const selected = await tool.execute("conflict-mixed-range", { path: "conflict://1:1-2,-2" });
		expect(selected.details?.displayContent).toEqual({
			text: [...block.slice(0, 2), "…", ...block.slice(-2)].join("\n"),
			startLine: 3,
			lineNumbers: [3, 4, null, 7, 8],
		});
		expect(textOf(selected)).not.toContain("ours-two");
		expect(textOf(selected)).not.toContain("before-one");
		expect(textOf(selected)).not.toContain("after");
		expect(textOf(selected)).not.toMatch(/\d+:\d+:/);
		expect(selected.details?.totalLines).toBe(block.length);
		const expected = `${block[1]}\n\n…\n\n${block.at(-1)}`;
		for (const selector of ["raw:2-2,-1", "2-2,-1:raw"]) {
			expect(textOf(await tool.execute(selector, { path: `conflict://1:${selector}` }))).toBe(expected);
		}
		const scoped = await tool.execute("conflict-scoped-tail", { path: "conflict://1/ours:raw:-1" });
		expect(textOf(scoped)).toBe("ours-two");
		expect(scoped.details?.displayContent?.lineNumbers).toEqual([5]);
		expect(textOf(await tool.execute("conflict-bare-raw", { path: "conflict://1:raw" }))).toBe(block.join("\n"));
		await expect(tool.execute("conflict-invalid-range", { path: "conflict://1:raw:-3-1" })).rejects.toThrow(
			"Invalid selector",
		);
	});

	it.each(["zip", "tar.gz"] as const)(
		"resolves local:// %s archives before file and directory member selectors",
		async format => {
			const url = `local://sources.${format}`;
			const archivePath = resolveLocalUrlToPath(url, session.localProtocolOptions!);
			await fs.mkdir(path.dirname(archivePath), { recursive: true });
			await writeArchive(archivePath, format, [
				["project/tasks.py", "import sys\r\nfirst()\r\nsecond()\r\nlast()\r\n"],
				["project/package/setup.py", "setup()\n"],
			]);
			const tool = wrapToolWithMetaNotice(new ReadTool(session));
			for (const member of ["project/tasks.py:1-2,-1", "project/package/", "project/package/:-1"]) {
				const located = await tool.execute(`local-${member}`, { path: `${url}:${member}` });
				const absolute = await tool.execute(`absolute-${member}`, { path: `${archivePath}:${member}` });
				expect(located.content).toEqual(absolute.content);
				expect(located.details?.isDirectory).toBe(absolute.details?.isDirectory);
				expect(located.details?.resolvedPath).toBe(archivePath);
			}
			const directory = await tool.execute("local-archive-directory", { path: `${url}:project/package/` });
			expect(textOf(directory)).toContain("setup.py");
			for (const selector of ["raw:2-2,-1", "2-2,-1:raw"]) {
				const result = await tool.execute(`local-${selector}`, { path: `${url}:project/tasks.py:${selector}` });
				expect(textOf(result)).toBe("first()\r\n\n…\n\nlast()\r\n");
				expect(result.details?.meta?.source).toEqual({ type: "internal", value: `${url}:project/tasks.py` });
			}
		},
	);

	it("keeps wrapped raw file reads byte-exact without continuation, conflict, or repetition footers", async () => {
		const lines = [
			"\uFEFFfirst\r",
			"second\r",
			"<<<<<<< ours\r",
			"left\r",
			"=======\r",
			"right\r",
			">>>>>>> theirs\r",
			"last\r",
		];
		await Bun.write(path.join(root, "notes.md"), `${lines.join("\n")}\n`);
		const tool = wrapToolWithMetaNotice(new ReadTool(session));
		for (let index = 0; index < 4; index++) {
			const result = await tool.execute(`raw-exact-${index}`, { path: "notes.md:2-2:raw" });
			expect(textOf(result)).toBe("second\r");
			expect(result.details?.meta?.truncation).toBeUndefined();
			expect(result.details?.totalLines).toBe(lines.length);
		}
		for (const selector of ["raw:1-8", "1-8:raw", "raw:1-50"]) {
			expect(textOf(await tool.execute(selector, { path: `notes.md:${selector}` }))).toBe(`${lines.join("\n")}\n`);
		}
		expect(textOf(await tool.execute("raw-tail", { path: "notes.md:raw:-1" }))).toBe("last\r\n");
	});

	it.each(["bytes", "lines"] as const)(
		"retains the warning when a raw range actually exceeds the %s cap",
		async cap => {
			const filename = `${cap}-cap.txt`;
			const source = cap === "bytes" ? "x".repeat(DEFAULT_MAX_BYTES + 1) : "x\n".repeat(DEFAULT_MAX_LINES + 1);
			await Bun.write(path.join(root, filename), source);
			const selector = cap === "bytes" ? "raw:1-1" : `raw:1-${DEFAULT_MAX_LINES + 1}`;
			const result = await wrapToolWithMetaNotice(new ReadTool(session)).execute(`raw-${cap}-cap`, {
				path: `${filename}:${selector}`,
			});
			expect(result.details?.meta?.truncation?.truncatedBy).toBe(cap);
			expect(textOf(result)).toContain("[Showing ");
			if (cap === "bytes") expect(result.details?.meta?.truncation?.partialLine).toBe(true);
			else expect(result.details?.meta?.truncation?.nextOffset).toBe(DEFAULT_MAX_LINES + 1);
		},
	);

	it("ranges actual mounted xd:// docs without treating selectors as tool names", async () => {
		const read = new ReadTool(session);
		const mounted = new EvalTool(session);
		session.xdev = {
			tools: new Map<string, Tool>([[mounted.name, mounted]]),
			mountedNames: new Set([mounted.name]),
			builtInNames: new Set([mounted.name]),
			isActive: () => false,
		};
		const tool = wrapToolWithMetaNotice(read);
		const whole = await tool.execute("read-device-docs", { path: "xd://eval:raw" });
		const docs = textOf(whole);
		const lines = docs.split("\n");
		expect(docs).toContain("# eval");
		expect(docs).toContain("type Args");
		const expected = `${lines.slice(0, 3).join("\n")}\n\n…\n\n${lines.slice(-2).join("\n")}`;
		for (const selector of ["raw:1-3,-2", "1-3,-2:raw"]) {
			expect(textOf(await tool.execute(selector, { path: `xd://eval:${selector}` }))).toBe(expected);
		}
		const range = await tool.execute("device-doc-range", { path: "xd://eval:2-4" });
		expect(range.details?.displayContent?.text).toBe(lines.slice(1, 4).join("\n"));
		expect(range.details?.totalLines).toBe(lines.length);
		expect(session.editStore).toBeUndefined();
	});

	it("preserves a compact oversized JSON query in an artifact and returns a nonempty byte-capped preview", async () => {
		const document = { nodes: [{ id: 1, widgets_values: ["起点", "x".repeat(78_000), "终点"] }] };
		await Bun.write(path.join(root, "workflow.json"), JSON.stringify(document));
		const expected = JSON.stringify(document.nodes);
		const tool = wrapToolWithMetaNotice(new ReadTool(session));
		const result = await tool.execute("compact-long-query", { path: "workflow.json?q=.nodes&compact=true" });
		const preview = result.details?.displayContent?.text ?? textOf(result).split("\n\n[")[0];
		expect(preview).toStartWith('[{"id":1,"widgets_values":["起点",');
		expect(Buffer.byteLength(preview, "utf-8")).toBeGreaterThan(0);
		expect(Buffer.byteLength(preview, "utf-8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(preview).not.toContain("\uFFFD");
		const artifactId = result.details?.meta?.truncation?.artifactId;
		expect(artifactId).toBeDefined();
		expect(textOf(result)).toContain(`artifact://${artifactId}`);
		expect(await Bun.file(path.join(root, "artifacts", `${artifactId}.read.log`)).text()).toBe(expected);
		const recovered = await tool.execute("recover-compact-query", { path: `artifact://${artifactId}:raw:1-3000` });
		expect(textOf(recovered)).toBe(expected);
		expect(result.details?.meta?.truncation?.outputBytes).toBe(Buffer.byteLength(preview, "utf-8"));
	});

	it("returns bounded JSON data even in a session without artifact storage", async () => {
		await Bun.write(path.join(root, "wide.json"), JSON.stringify({ value: "x".repeat(78_000) }));
		session.allocateOutputArtifact = undefined;
		const tool = wrapToolWithMetaNotice(new ReadTool(session));
		const result = await tool.execute("compact-query-without-artifacts", { path: "wide.json?q=.value&compact=true" });
		expect(textOf(result)).toStartWith('"xxx');
		expect(result.details?.meta?.truncation?.outputBytes).toBeGreaterThan(0);
		expect(result.details?.meta?.truncation?.artifactId).toBeUndefined();
	});
});
