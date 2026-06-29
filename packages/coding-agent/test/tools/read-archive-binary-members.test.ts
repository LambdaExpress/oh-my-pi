/**
 * Archive member binary reads: image and supported document members should route
 * through the same read paths as files, while unsupported binaries stay opaque.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import * as markit from "@oh-my-pi/pi-coding-agent/utils/markit";
import { type Unzipped, zip } from "@oh-my-pi/pi-coding-agent/utils/zip";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const enc = (value: string): Uint8Array => new TextEncoder().encode(value);

// 1x1 transparent PNG — small enough to pass through image loading untouched.
const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);

function makeSession(testDir: string): ToolSession {
	const sessionFile = path.join(testDir, "session.jsonl");
	const artifactsDir = sessionFile.slice(0, -6);
	return {
		cwd: testDir,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "images.autoResize": false, "inspect_image.enabled": false }),
	} as unknown as ToolSession;
}

function joinText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

function makeXlsx(): Uint8Array {
	return zip({
		"xl/workbook.xml": enc(
			`<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="People" sheetId="1" r:id="rId1"/></sheets></workbook>`,
		),
		"xl/_rels/workbook.xml.rels": enc(
			`<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
		),
		"xl/worksheets/sheet1.xml": enc(
			`<?xml version="1.0"?><worksheet><sheetData><row><c t="inlineStr"><is><t>Name</t></is></c><c t="inlineStr"><is><t>Age</t></is></c></row><row><c t="inlineStr"><is><t>Alice</t></is></c><c><v>30</v></c></row></sheetData></worksheet>`,
		),
	});
}

async function writeBundle(testDir: string, entries: Unzipped): Promise<string> {
	const bundlePath = path.join(testDir, "bundle.zip");
	await Bun.write(bundlePath, zip(entries));
	return bundlePath;
}

function mockPdfConversion(
	markdown = ["Heading", "", "<!-- image: p11-img0 (page 11, 10x10pt) -->", "", "Footer"].join("\n"),
	members: Record<string, Uint8Array> = { "p11-img0.png": TINY_PNG },
) {
	return vi
		.spyOn(markit, "convertBufferWithMarkit")
		.mockImplementation(async (_bytes, extension, _signal, options) => {
			if (extension === ".pdf" && options?.imageDir) {
				await fs.mkdir(options.imageDir, { recursive: true });
				for (const name in members) {
					await Bun.write(path.join(options.imageDir, name), members[name]!);
				}
				return { ok: true, content: "", cache: "skipped" };
			}
			if (extension === ".pdf") {
				return { ok: true, content: markdown, cache: "miss" };
			}
			return { ok: false, content: "", error: `Unexpected extension ${extension}`, cache: "miss" };
		});
}

describe("read archive binary members", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-archive-binary-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(testDir);
	});

	it("decodes a PNG member into an inline image block", async () => {
		const bundlePath = await writeBundle(testDir, { "clifford.png": TINY_PNG });
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: `${bundlePath}:clifford.png` });

		const image = result.content.find(c => c.type === "image");
		expect(image).toBeDefined();
		expect(image && "mimeType" in image ? image.mimeType : undefined).toBe("image/png");
		expect(joinText(result.content)).not.toContain("\uFFFDPNG");
	});

	it("converts an XLSX member to markdown", async () => {
		const bundlePath = await writeBundle(testDir, { "people.xlsx": makeXlsx() });
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: `${bundlePath}:people.xlsx` });
		const text = joinText(result.content);

		expect(text).toContain("## People");
		expect(text).toContain("| Name | Age |");
		expect(text).toContain("| Alice | 30 |");
	});

	it("applies line selectors to converted XLSX markdown", async () => {
		const bundlePath = await writeBundle(testDir, { "people.xlsx": makeXlsx() });
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: `${bundlePath}:people.xlsx:1-4` });
		const text = joinText(result.content);

		expect(text).toContain("## People");
		expect(text).toContain("| Name | Age |");
		expect(text).not.toContain("Cannot read binary archive entry");
		expect(text).not.toContain("<?xml");
	});

	it("rewrites archived PDF image placeholders to archive member handles", async () => {
		mockPdfConversion();
		const bundlePath = await writeBundle(testDir, { "report.pdf": enc("%PDF-stub") });
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: `${bundlePath}:report.pdf` });
		const text = joinText(result.content);

		expect(text).not.toContain("<!-- image:");
		expect(text).toContain("read `bundle.zip:report.pdf:p11-img0.png`");
	});

	it("lists extractable images for an archived PDF trailing-colon handle", async () => {
		mockPdfConversion();
		const bundlePath = await writeBundle(testDir, { "report.pdf": enc("%PDF-stub") });
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: `${bundlePath}:report.pdf:` });
		const text = joinText(result.content);

		expect(text).toContain("read `bundle.zip:report.pdf:p11-img0.png`");
	});

	it("reads an archived PDF image handle as an inline image block", async () => {
		mockPdfConversion();
		const bundlePath = await writeBundle(testDir, { "report.pdf": enc("%PDF-stub") });
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: `${bundlePath}:report.pdf:p11-img0.png` });

		const image = result.content.find(c => c.type === "image");
		expect(image).toBeDefined();
		expect(image && "mimeType" in image ? image.mimeType : undefined).toBe("image/png");
	});

	it("errors with available archived PDF image members for an unknown image handle", async () => {
		mockPdfConversion();
		const bundlePath = await writeBundle(testDir, { "report.pdf": enc("%PDF-stub") });
		const tool = new ReadTool(makeSession(testDir));

		await expect(tool.execute("call", { path: `${bundlePath}:report.pdf:missing.png` })).rejects.toThrow(
			/not found.*p11-img0\.png/s,
		);
	});

	it("keeps unknown binary members opaque", async () => {
		const bundlePath = await writeBundle(testDir, { "clip.mp4": new Uint8Array([0, 1, 2, 3]) });
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: `${bundlePath}:clip.mp4` });
		const text = joinText(result.content);

		expect(text).toContain("Cannot read binary archive entry");
		expect(text).toContain("clip.mp4");
		expect(text).not.toContain("\u0000");
	});

	it("does not route legacy RTF archive members through Markit", async () => {
		const bundlePath = await writeBundle(testDir, { "legacy.rtf": new Uint8Array([0, 1, 2, 3]) });
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: `${bundlePath}:legacy.rtf` });
		const text = joinText(result.content);

		expect(text).toContain("Cannot read binary archive entry");
		expect(text).toContain("legacy.rtf");
	});
});
