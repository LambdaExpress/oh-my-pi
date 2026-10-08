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
import {
	type ArchiveMemberContent,
	archiveFormatFromPath,
	parseArchivePathCandidates,
	writeArchive,
} from "@oh-my-pi/pi-utils/ar";

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
		getActiveModel: () => ({ input: ["image"] }),
		settings: Settings.isolated({ "images.autoResize": false }),
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

	it.each(["unitypackage", "UNITYPACKAGE", "tar.gz", "tgz"])(
		"lists gzip TAR Unity assets and reads pathname members through .%s",
		async extension => {
			const guid = "0123456789abcdef0123456789abcdef";
			const assetPath = "Assets/Clothing/Lime&Chiffon.prefab";
			const bundlePath = path.join(testDir, `EveningGlow_Lime&Chiffon.${extension}`);
			await writeArchive(bundlePath, "tar.gz", [
				[`${guid}/asset`, "%YAML 1.1\n--- !u!1 &1000\nGameObject:\n  m_Name: EveningGlow\n"],
				[`${guid}/asset.meta`, `fileFormatVersion: 2\nguid: ${guid}\n`],
				[`${guid}/pathname`, assetPath],
			]);
			const tool = new ReadTool(makeSession(testDir));

			const overview = await tool.execute("overview", { path: bundlePath });
			expect(overview.details?.isDirectory).toBe(true);
			expect(joinText(overview.content)).toBe(`${guid}/`);

			const directory = await tool.execute("directory", { path: `${bundlePath}:${guid}` });
			expect(directory.details?.isDirectory).toBe(true);
			expect(joinText(directory.content)).toContain("asset.meta");
			expect(joinText(directory.content)).toContain("pathname");

			const pathname = await tool.execute("pathname", { path: `${bundlePath}:${guid}/pathname` });
			expect(pathname.details?.displayContent?.text).toBe(assetPath);

			const rawPathname = await tool.execute("raw-pathname", { path: `${bundlePath}:${guid}/pathname:raw` });
			expect(joinText(rawPathname.content)).toBe(assetPath);
		},
	);

	it("requires a complete archive extension before a member selector or end of path", () => {
		for (const extension of ["unitypackage", "tar.gz", "tgz"]) {
			const archivePath = `EveningGlow_Lime&Chiffon.${extension}`;
			expect(archiveFormatFromPath(`${archivePath}.txt`)).toBeUndefined();
			expect(parseArchivePathCandidates(`${archivePath}.txt:pathname`)).toEqual([]);
			expect(parseArchivePathCandidates(`${archivePath}:0123456789abcdef/pathname`)).toEqual([
				{ archivePath, subPath: "0123456789abcdef/pathname" },
			]);
		}
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

	it("lists ASAR archives and reads small member ranges beside an oversized member", async () => {
		const packageJson = enc('{\n  "name": "asar-fixture",\n  "main": "dist/app.js"\n}\n');
		const script = enc('const before = "before";\nconst selected = "selected";\nconst after = "after";\n');
		const largeSize = 65 * 1024 * 1024;
		const json = enc(
			JSON.stringify({
				files: {
					"package.json": { size: packageJson.byteLength, offset: "0" },
					dist: { files: { "app.js": { size: script.byteLength, offset: String(packageJson.byteLength) } } },
					"geoip-city.dat": { size: largeSize, offset: String(packageJson.byteLength + script.byteLength) },
				},
			}),
		);
		const paddedJsonSize = json.byteLength + ((4 - (json.byteLength % 4)) % 4);
		const header = Buffer.alloc(16 + paddedJsonSize);
		header.writeUInt32LE(4, 0);
		header.writeUInt32LE(header.byteLength - 8, 4);
		header.writeUInt32LE(header.byteLength - 12, 8);
		header.writeUInt32LE(json.byteLength, 12);
		header.set(json, 16);
		const bundlePath = path.join(testDir, "bundle.asar");
		await Bun.write(bundlePath, Buffer.concat([header, packageJson, script]));
		// Extend on disk without allocating or serializing the unrelated payload.
		await fs.truncate(bundlePath, header.byteLength + packageJson.byteLength + script.byteLength + largeSize);
		const tool = new ReadTool(makeSession(testDir));

		const overview = joinText((await tool.execute("overview", { path: bundlePath })).content);
		expect(overview).toContain("dist/");
		expect(overview).toContain("package.json");
		expect(overview).toContain("geoip-city.dat");

		const packageRange = joinText(
			(await tool.execute("package", { path: `${bundlePath}:package.json:2-3` })).content,
		);
		expect(packageRange).toContain('"name": "asar-fixture"');
		expect(packageRange).toContain('"main": "dist/app.js"');
		const scriptRange = joinText((await tool.execute("script", { path: `${bundlePath}:dist/app.js:2-2` })).content);
		expect(scriptRange).toContain('const selected = "selected";');
		expect(scriptRange).not.toContain('const before = "before";');
		expect(scriptRange).not.toContain('const after = "after";');

		await expect(tool.execute("large", { path: `${bundlePath}:geoip-city.dat:1-2` })).rejects.toThrow(
			"Archive member 'geoip-city.dat' is too large to extract in memory",
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
