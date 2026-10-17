/**
 * The local text read path materializes a file once and derives every view from
 * those bytes: the binary sniff, the rendered window and its byte accounting,
 * bracket context, and the whole-file snapshot hash. These tests pin the parts
 * of that contract a plausible rewrite would silently break — the decode the
 * snapshot tag is hashed from, exact on-disk byte counts, raw EOF terminators
 * without a phantom line, and the absence of a second whole-file read.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { formatBytes } from "@oh-my-pi/pi-tui/render/render-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

import { cfgReadSummarizeEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

function createSession(cwd: string): ToolSession {
	const settings = Settings.isolated();
	// Structural summarization would answer whole-file reads from the summarizer
	// instead of the range path under test.
	cfgReadSummarizeEnabled.set(settings, false);
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings,
	} as ToolSession;
}

describe("read tool single-pass file access", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-single-pass-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("hashes the snapshot from BOM-stripped text so a whole-file tag validates without recovery", async () => {
		// `Bun.file().text()` strips a leading BOM and the patcher's live read goes
		// through it, so a tag hashed from BOM-bearing text only ever applies via
		// stale-hash recovery — which tells the model the file changed externally
		// when nothing changed.
		const filePath = path.join(tmpDir, "bom.ts");
		await fs.writeFile(filePath, Buffer.from("\uFEFFexport const a = 1;\nexport const b = 2;\n", "utf-8"));

		const session = createSession(tmpDir);
		const header = textOutput(await new ReadTool(session).execute("bom-read", { path: filePath })).split("\n")[0];
		expect(header).toMatch(/^\[bom\.ts#[0-9A-F]{4}\]$/);

		await new EditTool(session, "hashline").execute("bom-edit", {
			input: `${header}\nPUT 2.=2:\n+export const b = 22;`,
		});
		// The BOM survives the write; only the addressed line changed.
		expect(await fs.readFile(filePath, "utf8")).toBe("\uFEFFexport const a = 1;\nexport const b = 22;\n");
	});

	it("reports on-disk byte lengths for a line that is not valid UTF-8", async () => {
		// Decoding replaces each stray byte with U+FFFD, which re-encodes to three
		// bytes. Measuring the decoded string instead of the buffer would inflate
		// every reported length by two bytes per stray byte.
		const strayBytes = 512;
		const lineBytes = 60 * 1024;
		const filePath = path.join(tmpDir, "invalid-utf8.txt");
		await fs.writeFile(
			filePath,
			Buffer.concat([
				// Stray bytes sit past the 8KiB binary sniff window, so the file still
				// reads as text and reaches the oversized-line notice.
				Buffer.from("z".repeat(lineBytes - strayBytes), "utf-8"),
				Buffer.from(Array.from({ length: strayBytes }, () => 0xff)),
				Buffer.from("\ntail\n", "utf-8"),
			]),
		);

		// `:1-1` keeps the byte budget at its 50KB floor, which the 60KB line exceeds.
		const text = textOutput(await new ReadTool(createSession(tmpDir)).execute("bytes", { path: `${filePath}:1-1` }));

		expect(text).toContain(`[Line 1 is ${formatBytes(lineBytes)}, exceeds ${formatBytes(50 * 1024)} limit`);
		expect(text).not.toContain(formatBytes(lineBytes + strayBytes * 2));
	});

	it.each(["alpha\nbeta\n", "\uFEFFalpha\r\nbeta\r\n"])(
		"keeps raw and numbered line addresses within physical EOF for %j",
		async content => {
			const filePath = path.join(tmpDir, "trailing.txt");
			await fs.writeFile(filePath, content);
			const session: ToolSession = {
				...createSession(tmpDir),
				skills: [{ name: "physical-eof", description: "", filePath, baseDir: tmpDir, source: "test" }],
			};
			const finalLine = content.slice(content.indexOf("\n") + 1);

			for (const target of [filePath, "skill://physical-eof"]) {
				const tool = new ReadTool(session);
				const numbered = await tool.execute("numbered-tail", { path: `${target}:2-2` });
				expect(numbered.details?.totalLines).toBe(2);
				expect(numbered.details?.displayContent).toEqual({
					text: finalLine.slice(0, -1),
					startLine: 2,
					lineNumbers: [2],
				});
				const numberedBeyond = await tool.execute("beyond", { path: `${target}:3` });
				const rawBeyond = await tool.execute("raw-beyond", { path: `${target}:raw:3` });
				expect(numberedBeyond.details?.displayContent).toBeUndefined();
				expect(rawBeyond.details?.displayContent).toBeUndefined();

				const rawFinalLine = await tool.execute("raw-final-line", { path: `${target}:raw:2-2` });
				expect(textOutput(rawFinalLine)).toBe(finalLine);
				expect(rawFinalLine.details?.totalLines).toBe(2);
				expect(rawFinalLine.details?.displayContent?.lineNumbers).toEqual([2]);
				expect(textOutput(await tool.execute("raw-final-open", { path: `${target}:raw:2-` }))).toBe(finalLine);
				for (const selector of ["raw", "raw:1-25", "raw:-2"]) {
					const result = await tool.execute(`raw-whole-${selector}`, { path: `${target}:${selector}` });
					expect(textOutput(result)).toBe(content);
					expect(result.details?.totalLines).toBe(2);
					expect(result.details?.displayContent?.lineNumbers).toEqual([1, 2]);
				}
			}
		},
	);

	it("does not re-read a file it already materialized", async () => {
		// Bracket context and the snapshot hash each used to pull the whole file
		// through `Bun.file(path).text()`, so a ranged read of one file opened it
		// four times. Any reintroduced whole-file re-read trips this counter.
		const filePath = path.join(tmpDir, "counted.ts");
		await fs.writeFile(
			filePath,
			`${Array.from({ length: 400 }, (_, i) => `export const value${i} = ${i};`).join("\n")}\n`,
		);

		type FileFactory = typeof Bun.file;
		const originalFile: FileFactory = Bun.file;
		const bunNamespace = Bun as unknown as { file: FileFactory };
		let wholeFileReads = 0;
		bunNamespace.file = ((target: Parameters<FileFactory>[0], ...rest: unknown[]) => {
			const factory = originalFile as unknown as (t: unknown, ...r: unknown[]) => Bun.BunFile;
			const handle = factory(target, ...rest);
			if (typeof target !== "string" || target !== filePath) return handle;
			return new Proxy(handle, {
				// Receiver must be the real BunFile: native accessors such as `size`
				// throw when `this` is the proxy.
				get(obj, prop) {
					const value = Reflect.get(obj, prop);
					if (prop === "text" || prop === "bytes" || prop === "arrayBuffer") {
						const reader = value as (...a: unknown[]) => Promise<unknown>;
						return (...args: unknown[]) => {
							wholeFileReads++;
							return reader.apply(obj, args);
						};
					}
					return typeof value === "function" ? value.bind(obj) : value;
				},
			});
		}) as FileFactory;

		try {
			const tool = new ReadTool(createSession(tmpDir));
			const text = textOutput(await tool.execute("counted", { path: `${filePath}:100-120` }));
			expect(text).toContain("export const value100 = 100;");
			expect(text).toMatch(/^\[counted\.ts#[0-9A-F]{4}\]$/m);
		} finally {
			bunNamespace.file = originalFile;
		}

		expect(wholeFileReads).toBe(0);
	});
});
