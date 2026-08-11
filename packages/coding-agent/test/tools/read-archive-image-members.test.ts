/**
 * Archive member image reads through the `read` tool: PNG/JPEG/WebP members
 * decode into inline image blocks (or an `inspect_image` metadata note when
 * inspection is active), while oversized image members and non-image binaries
 * keep the status-quo opaque notice.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { MAX_IMAGE_INPUT_BYTES } from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { zip } from "@oh-my-pi/pi-coding-agent/utils/zip";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const enc = (value: string): Uint8Array => new TextEncoder().encode(value);

// 1x1 transparent PNG — small enough to pass through image loading untouched.
const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);

function makeSession(testDir: string, options: { inspectImage?: boolean } = {}): ToolSession {
	const sessionFile = path.join(testDir, "session.jsonl");
	const artifactsDir = sessionFile.slice(0, -6);
	return {
		cwd: testDir,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => null,
		// `isToolActive` drives the effective inspect_image state: restricted
		// slates (false) keep inlining images; granted slates (true) reduce
		// image reads to metadata plus an inspect_image suggestion.
		isToolActive: () => options.inspectImage === true,
		settings: Settings.isolated({ "images.autoResize": false, "inspect_image.enabled": false }),
	} as unknown as ToolSession;
}

function joinText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

async function writeBundle(testDir: string, entries: Record<string, Uint8Array>): Promise<string> {
	const bundlePath = path.join(testDir, "bundle.zip");
	await Bun.write(bundlePath, zip(entries));
	return bundlePath;
}

describe("read archive image members", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-archive-image-"));
	});

	afterEach(async () => {
		await removeWithRetries(testDir);
	});

	it("decodes a PNG member into an inline image block", async () => {
		const bundlePath = await writeBundle(testDir, { "clifford.png": TINY_PNG });
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: `${bundlePath}:clifford.png` });

		const image = result.content.find(c => c.type === "image");
		expect(image).toBeDefined();
		expect(image && "mimeType" in image ? image.mimeType : undefined).toBe("image/png");
		expect(image && "data" in image ? Buffer.from(image.data, "base64").equals(TINY_PNG) : false).toBe(true);
		expect(joinText(result.content)).toContain("Read image archive entry [clifford.png]");
		expect(joinText(result.content)).not.toContain("Cannot read binary archive entry");
	});

	it("decodes JPEG and WebP members detected by magic numbers", async () => {
		// 1x1 JPEG and WebP encodings of the same pixel, generated at runtime.
		const tinyJpeg = await new Bun.Image(TINY_PNG).jpeg().bytes();
		const tinyWebp = await new Bun.Image(TINY_PNG).webp().bytes();
		const bundlePath = await writeBundle(testDir, {
			"photo.jpg": tinyJpeg,
			"photo.webp": tinyWebp,
		});
		const tool = new ReadTool(makeSession(testDir));

		const jpegResult = await tool.execute("call", { path: `${bundlePath}:photo.jpg` });
		const jpegImage = jpegResult.content.find(c => c.type === "image");
		expect(jpegImage && "mimeType" in jpegImage ? jpegImage.mimeType : undefined).toBe("image/jpeg");
		expect(jpegImage && "data" in jpegImage ? Buffer.from(jpegImage.data, "base64").equals(tinyJpeg) : false).toBe(
			true,
		);

		const webpResult = await tool.execute("call", { path: `${bundlePath}:photo.webp` });
		const webpImage = webpResult.content.find(c => c.type === "image");
		expect(webpImage && "mimeType" in webpImage ? webpImage.mimeType : undefined).toBe("image/webp");
		expect(webpImage && "data" in webpImage ? Buffer.from(webpImage.data, "base64").equals(tinyWebp) : false).toBe(
			true,
		);
	});

	it("returns an inspect_image metadata note instead of an image block when inspection is active", async () => {
		const bundlePath = await writeBundle(testDir, { "clifford.png": TINY_PNG });
		const tool = new ReadTool(makeSession(testDir, { inspectImage: true }));

		const result = await tool.execute("call", { path: `${bundlePath}:clifford.png` });
		const text = joinText(result.content);

		expect(result.content.find(c => c.type === "image")).toBeUndefined();
		expect(text).toContain("Image metadata:");
		expect(text).toContain("- MIME: image/png");
		expect(text).toContain("- Dimensions: 1x1");
		expect(text).toContain('inspect_image with path="');
		expect(text).toContain(`${bundlePath}:clifford.png`);
		expect(text).not.toContain("Cannot read binary archive entry");
	});

	it("keeps oversized image members opaque", async () => {
		const oversized = Buffer.concat([TINY_PNG, Buffer.alloc(MAX_IMAGE_INPUT_BYTES + 1024)]);
		const bundlePath = await writeBundle(testDir, { "huge.png": oversized });
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: `${bundlePath}:huge.png` });
		const text = joinText(result.content);

		expect(result.content.find(c => c.type === "image")).toBeUndefined();
		expect(text).toContain("Cannot read binary archive entry");
		expect(text).toContain("huge.png");
	});

	it("keeps non-image binary members opaque", async () => {
		const bundlePath = await writeBundle(testDir, { "clip.mp4": new Uint8Array([0, 1, 2, 3]) });
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: `${bundlePath}:clip.mp4` });
		const text = joinText(result.content);

		expect(result.content.find(c => c.type === "image")).toBeUndefined();
		expect(text).toContain("Cannot read binary archive entry");
		expect(text).toContain("clip.mp4");
	});

	it("still reads text members as text", async () => {
		const bundlePath = await writeBundle(testDir, { "notes.txt": enc("hello archive") });
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: `${bundlePath}:notes.txt` });
		const text = joinText(result.content);

		expect(result.content.find(c => c.type === "image")).toBeUndefined();
		expect(text).toContain("hello archive");
		expect(text).not.toContain("Cannot read binary archive entry");
	});
});
