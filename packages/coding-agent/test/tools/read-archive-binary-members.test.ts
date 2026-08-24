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
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { type ArchiveMemberContent, writeArchive } from "@oh-my-pi/pi-utils/ar";

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

async function makeXlsx(testDir: string): Promise<Uint8Array> {
	const xlsxPath = path.join(testDir, "fixture.xlsx");
	await writeArchive(
		xlsxPath,
		"zip",
		Object.entries({
			"xl/workbook.xml": enc(
				`<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="People" sheetId="1" r:id="rId1"/></sheets></workbook>`,
			),
			"xl/_rels/workbook.xml.rels": enc(
				`<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
			),
			"xl/worksheets/sheet1.xml": enc(
				`<?xml version="1.0"?><worksheet><sheetData><row><c t="inlineStr"><is><t>Name</t></is></c><c t="inlineStr"><is><t>Age</t></is></c></row><row><c t="inlineStr"><is><t>Alice</t></is></c><c><v>30</v></c></row></sheetData></worksheet>`,
			),
		}),
	);
	return Bun.file(xlsxPath).bytes();
}

async function writeBundle(testDir: string, entries: Record<string, ArchiveMemberContent>): Promise<string> {
	const bundlePath = path.join(testDir, "bundle.zip");
	await writeArchive(bundlePath, "zip", Object.entries(entries));
	return bundlePath;
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
		const bundlePath = await writeBundle(testDir, { "people.xlsx": await makeXlsx(testDir) });
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: `${bundlePath}:people.xlsx` });
		const text = joinText(result.content);

		expect(text).toContain("## People");
		expect(text).toContain("| Name | Age |");
		expect(text).toContain("| Alice | 30 |");
	});

	it("applies line selectors to converted XLSX markdown", async () => {
		const bundlePath = await writeBundle(testDir, { "people.xlsx": await makeXlsx(testDir) });
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: `${bundlePath}:people.xlsx:1-4` });
		const text = joinText(result.content);

		expect(text).toContain("## People");
		expect(text).toContain("| Name | Age |");
		expect(text).not.toContain("Cannot read binary archive entry");
		expect(text).not.toContain("<?xml");
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
