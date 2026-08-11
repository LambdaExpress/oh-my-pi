import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isEexist, isEnotempty, readImageMetadata, untilAborted } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../sdk";
import { loadImageInput, MAX_IMAGE_INPUT_BYTES, webpExclusionForModel } from "../utils/image-loading";
import { convertBufferWithMarkit, convertFileWithMarkit } from "../utils/markit";
import type { ArchiveReader } from "../utils/zip";
import type { ReadToolDetails } from "./read";
import { prependSuffixResolutionNotice } from "./read-format";
import { isNotFoundError } from "./read-path-resolution";
import { formatBytes } from "./render-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const MAX_IMAGE_SIZE = MAX_IMAGE_INPUT_BYTES;

const PDF_IMAGE_PLACEHOLDER_RE = /<!--\s*image:\s*([^\s<>]+)(.*?)-->/g;
const PDF_IMAGE_MEMBER_RE = /^(.*\.pdf):(.*)$/i;
const PDF_IMAGE_MEMBER_EXTENSION_RE = /\.png$/i;
const PDF_IMAGE_CACHE_BASENAME_MAX_LENGTH = 96;

interface PdfImageSnapshot {
	directory: string;
	filePath: string;
	digest: string;
}

interface PdfImageExtraction {
	controller: AbortController;
	promise: Promise<string>;
	settled: boolean;
	waiters: number;
}

const pdfImageExtractions = new Map<string, PdfImageExtraction>();

function pdfImageMemberPath(pdfPath: string, imageId: string): string {
	const member = PDF_IMAGE_MEMBER_EXTENSION_RE.test(imageId) ? imageId : `${imageId}.png`;
	return `${pdfPath}:${member}`;
}

export function rewritePdfImagePlaceholders(markdown: string, pdfPath: string): string {
	return markdown.replace(PDF_IMAGE_PLACEHOLDER_RE, (_match: string, imageId: string, metadataText: string) => {
		const metadata = metadataText.trim();
		const suffix = metadata.length > 0 ? ` (${metadata})` : "";
		return `Image ${imageId}${suffix}: read \`${pdfImageMemberPath(pdfPath, imageId)}\``;
	});
}

export function splitPdfImageMemberReadPath(readPath: string): { pdfPath: string; member: string } | null {
	const match = PDF_IMAGE_MEMBER_RE.exec(readPath);
	if (!match) return null;
	const pdfPath = match[1];
	const member = match[2];
	if (pdfPath === undefined || member === undefined) return null;
	if (member.length !== 0 && !PDF_IMAGE_MEMBER_EXTENSION_RE.test(member)) return null;
	return { pdfPath, member };
}

/**
 * Split an archive sub-path like `report.pdf:p11-img0.png` (or a trailing-colon
 * handle `report.pdf:`) into the PDF member path and the image member name,
 * validating that the PDF member exists as a file inside the archive. Returns
 * `null` when the sub-path is not an archive PDF image handle.
 */
export function splitArchivePdfImageMemberPath(
	archive: ArchiveReader,
	archiveSubPath: string,
): { pdfMemberPath: string; member: string } | null {
	const split = splitPdfImageMemberReadPath(archiveSubPath);
	if (!split) return null;
	const node = archive.getNode(split.pdfPath);
	if (!node || node.isDirectory) return null;
	return { pdfMemberPath: split.pdfPath, member: split.member };
}

/**
 * Rewrite markit's `<!-- image: <id> ... -->` placeholders from an in-memory
 * archive PDF conversion into read handles rooted at the archive path, e.g.
 * ``Image <id> (metadata): read `<archive>:<pdfMember>:<id>.png` ``. The
 * member-name suffix differs from {@link rewritePdfImagePlaceholders} because
 * the handle is an archive member path rather than a filesystem path.
 */
export function rewriteArchivePdfImagePlaceholders(
	markdown: string,
	archiveDisplayPath: string,
	pdfMemberPath: string,
): string {
	return markdown.replace(PDF_IMAGE_PLACEHOLDER_RE, (_match: string, imageId: string, metadataText: string) => {
		const metadata = metadataText.trim();
		const suffix = metadata.length > 0 ? ` ${metadata}` : "";
		return `Image ${imageId}${suffix}: read \`${pdfImageMemberPath(`${archiveDisplayPath}:${pdfMemberPath}`, imageId)}\``;
	});
}
function pdfImageCacheDir(session: ToolSession, absolutePdfPath: string, contentDigest: string): string {
	const artifactsDir = session.getArtifactsDir?.();
	let root = artifactsDir ?? undefined;
	if (root === undefined) {
		const sessionFile = session.getSessionFile();
		root = sessionFile?.endsWith(".jsonl") ? sessionFile.slice(0, -6) : path.join(os.tmpdir(), "omp-read-pdf-images");
	}
	const basename = path
		.basename(absolutePdfPath)
		.replace(/[^A-Za-z0-9._-]/g, "_")
		.slice(0, PDF_IMAGE_CACHE_BASENAME_MAX_LENGTH);
	const pathDigest = Bun.hash(absolutePdfPath).toString(36);
	return path.join(root, "read-pdf-images", `${basename}-${pathDigest}-${contentDigest}`);
}

async function snapshotPdfSource(absolutePdfPath: string, signal?: AbortSignal): Promise<PdfImageSnapshot> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-read-pdf-"));
	try {
		const bytes = await untilAborted(signal, () => Bun.file(absolutePdfPath).bytes());
		signal?.throwIfAborted();
		const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
		const filePath = path.join(directory, "source.pdf");
		await Bun.write(filePath, bytes);
		signal?.throwIfAborted();
		return { directory, filePath, digest };
	} catch (error) {
		await fs.rm(directory, { recursive: true, force: true });
		throw error;
	}
}

async function listPdfImageMembers(imageDir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(imageDir, { withFileTypes: true });
		const members: string[] = [];
		for (const entry of entries) {
			if (entry.isFile() && PDF_IMAGE_MEMBER_EXTENSION_RE.test(entry.name)) members.push(entry.name);
		}
		return members.sort();
	} catch (error) {
		if (isNotFoundError(error)) return [];
		throw error;
	}
}

async function extractPdfImages(snapshot: PdfImageSnapshot, imageDir: string, signal: AbortSignal): Promise<string> {
	const markerPath = path.join(imageDir, ".extracted");
	try {
		await fs.stat(markerPath);
		return imageDir;
	} catch (error) {
		if (!isNotFoundError(error)) throw error;
	}

	await fs.mkdir(path.dirname(imageDir), { recursive: true });
	const stagingDir = await fs.mkdtemp(`${imageDir}.tmp-`);
	let published = false;
	try {
		const result = await convertFileWithMarkit(snapshot.filePath, signal, { imageDir: stagingDir });
		if (!result.ok) {
			throw new ToolError(`Cannot extract images from PDF: ${result.error ?? "conversion failed"}`);
		}
		await Bun.write(path.join(stagingDir, ".extracted"), "ok");
		try {
			await fs.rename(stagingDir, imageDir);
			published = true;
		} catch (error) {
			if (!isEexist(error) && !isEnotempty(error)) throw error;
			try {
				await fs.stat(markerPath);
			} catch (markerError) {
				if (isNotFoundError(markerError)) throw error;
				throw markerError;
			}
		}
		return imageDir;
	} finally {
		if (!published) await fs.rm(stagingDir, { recursive: true, force: true });
	}
}

function createPdfImageExtraction(snapshot: PdfImageSnapshot, imageDir: string): PdfImageExtraction {
	const controller = new AbortController();
	const promise = extractPdfImages(snapshot, imageDir, controller.signal).finally(() =>
		fs.rm(snapshot.directory, { recursive: true, force: true }),
	);
	const extraction: PdfImageExtraction = { controller, promise, settled: false, waiters: 0 };
	const settle = () => {
		extraction.settled = true;
		if (pdfImageExtractions.get(imageDir) === extraction) pdfImageExtractions.delete(imageDir);
	};
	void promise.then(settle, settle);
	return extraction;
}

async function waitForPdfImageExtraction(
	extraction: PdfImageExtraction,
	signal: AbortSignal | undefined,
): Promise<string> {
	extraction.waiters++;
	try {
		return await untilAborted(signal, extraction.promise);
	} finally {
		extraction.waiters--;
		if (extraction.waiters === 0 && !extraction.settled) {
			extraction.controller.abort();
			try {
				await extraction.promise;
			} catch {}
		}
	}
}

async function ensurePdfImageCache(
	session: ToolSession,
	absolutePdfPath: string,
	signal?: AbortSignal,
): Promise<string> {
	const snapshot = await snapshotPdfSource(absolutePdfPath, signal);
	const imageDir = pdfImageCacheDir(session, absolutePdfPath, snapshot.digest);
	const existing = pdfImageExtractions.get(imageDir);
	if (existing && !existing.settled && !existing.controller.signal.aborted) {
		await fs.rm(snapshot.directory, { recursive: true, force: true });
		return waitForPdfImageExtraction(existing, signal);
	}

	const extraction = createPdfImageExtraction(snapshot, imageDir);
	pdfImageExtractions.set(imageDir, extraction);
	return waitForPdfImageExtraction(extraction, signal);
}

function archivePdfImageCacheDir(session: ToolSession, absoluteArchivePath: string, pdfMemberPath: string): string {
	const artifactsDir = session.getArtifactsDir?.();
	let root = artifactsDir ?? undefined;
	if (root === undefined) {
		const sessionFile = session.getSessionFile();
		root = sessionFile?.endsWith(".jsonl") ? sessionFile.slice(0, -6) : path.join(os.tmpdir(), "omp-read-pdf-images");
	}
	const basename = path
		.basename(absoluteArchivePath)
		.replace(/[^A-Za-z0-9._-]/g, "_")
		.slice(0, PDF_IMAGE_CACHE_BASENAME_MAX_LENGTH);
	const key = Bun.hash(`${absoluteArchivePath}\0${pdfMemberPath}`).toString(36);
	return path.join(root, "read-archive-pdf-images", `${basename}-${key}`);
}

const archivePdfImageExtractions = new Map<string, Promise<string>>();

/**
 * Cache the images extracted from an archive PDF member. The member bytes are
 * converted in memory via {@link convertBufferWithMarkit} with the image
 * directory set, which writes each embedded image to `<id>.png`; a `.extracted`
 * marker makes subsequent reads reuse the directory without re-running the
 * converter. The directory is hash-named from the archive path + member path
 * so distinct archives never collide. Concurrent extractions of the same
 * member share one in-process promise.
 */
async function ensureArchivePdfImageCache(
	session: ToolSession,
	absoluteArchivePath: string,
	pdfMemberPath: string,
	pdfBytes: Uint8Array,
	signal?: AbortSignal,
): Promise<string> {
	const imageDir = archivePdfImageCacheDir(session, absoluteArchivePath, pdfMemberPath);
	const markerPath = path.join(imageDir, ".extracted");
	try {
		await fs.stat(markerPath);
		return imageDir;
	} catch (error) {
		if (!isNotFoundError(error)) throw error;
	}

	const existing = archivePdfImageExtractions.get(imageDir);
	if (existing) return untilAborted(signal, existing);

	const extraction = (async () => {
		await fs.rm(imageDir, { recursive: true, force: true });
		await fs.mkdir(imageDir, { recursive: true });
		const result = await convertBufferWithMarkit(pdfBytes, ".pdf", signal, { imageDir, useCache: false });
		if (!result.ok) {
			await fs.rm(imageDir, { recursive: true, force: true });
			throw new ToolError(
				`Cannot extract images from PDF archive member '${pdfMemberPath}': ${result.error ?? "conversion failed"}`,
			);
		}
		await Bun.write(markerPath, "ok");
		return imageDir;
	})();
	archivePdfImageExtractions.set(imageDir, extraction);
	void extraction.finally(() => {
		if (archivePdfImageExtractions.get(imageDir) === extraction) archivePdfImageExtractions.delete(imageDir);
	});
	return untilAborted(signal, extraction);
}

export async function readPdfImageMember(
	session: ToolSession,
	autoResizeImages: boolean,
	absolutePdfPath: string,
	pdfDisplayPath: string,
	member: string,
	suffixResolution: { from: string; to: string } | undefined,
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadToolDetails>> {
	const imageDir = await ensurePdfImageCache(session, absolutePdfPath, signal);
	const members = await listPdfImageMembers(imageDir);
	if (member.length === 0) {
		const text =
			members.length === 0
				? "No extractable PDF image members found."
				: `Extractable PDF image members:\n${members
						.map(imageMember => `- read \`${pdfDisplayPath}:${imageMember}\``)
						.join("\n")}`;
		return toolResult<ReadToolDetails>({ resolvedPath: absolutePdfPath, suffixResolution })
			.text(prependSuffixResolutionNotice(text, suffixResolution))
			.sourcePath(absolutePdfPath)
			.done();
	}

	if (!members.includes(member)) {
		const available = members.length === 0 ? "(none)" : members.join(", ");
		throw new ToolError(`PDF image member '${member}' not found. Available members: ${available}`);
	}

	const imagePath = path.join(imageDir, member);
	const imageStat = await Bun.file(imagePath).stat();
	if (imageStat.size > MAX_IMAGE_SIZE) {
		const sizeStr = formatBytes(imageStat.size);
		const maxStr = formatBytes(MAX_IMAGE_SIZE);
		throw new ToolError(`Image file too large: ${sizeStr} exceeds ${maxStr} limit.`);
	}
	const metadata = await readImageMetadata(imagePath);
	const mimeType = metadata?.mimeType;
	if (!mimeType) throw new ToolError(`PDF image member '${member}' is not a supported image.`);
	const imageInput = await loadImageInput({
		path: `${pdfDisplayPath}:${member}`,
		cwd: session.cwd,
		autoResize: autoResizeImages,
		maxBytes: MAX_IMAGE_SIZE,
		resolvedPath: imagePath,
		detectedMimeType: mimeType,
		excludeWebP: webpExclusionForModel(session.getActiveModel?.()),
	});
	if (!imageInput) {
		throw new ToolError(`Read image file [${mimeType}] failed: unsupported image format.`);
	}
	const textNote = prependSuffixResolutionNotice(imageInput.textNote, suffixResolution);
	return toolResult<ReadToolDetails>({ resolvedPath: absolutePdfPath, suffixResolution })
		.content([
			{ type: "text", text: textNote },
			{ type: "image", data: imageInput.data, mimeType: imageInput.mimeType },
		])
		.sourcePath(imageInput.resolvedPath)
		.done();
}

/**
 * Read an image extracted from an archive PDF member (handle like
 * `archive.zip:report.pdf:p11-img0.png`). An empty `member` lists the
 * extractable images as read handles; an unknown member raises a
 * {@link ToolError} naming the available members.
 */
export async function readArchivePdfImageMember(
	session: ToolSession,
	absoluteArchivePath: string,
	archiveDisplayPath: string,
	pdfMemberPath: string,
	pdfBytes: Uint8Array,
	member: string,
	details: ReadToolDetails,
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadToolDetails>> {
	const imageDir = await ensureArchivePdfImageCache(session, absoluteArchivePath, pdfMemberPath, pdfBytes, signal);
	const members = await listPdfImageMembers(imageDir);
	if (member.length === 0) {
		const text =
			members.length === 0
				? "No extractable PDF image members found."
				: `Extractable PDF image members:\n${members
						.map(imageMember => `- read \`${archiveDisplayPath}:${pdfMemberPath}:${imageMember}\``)
						.join("\n")}`;
		return toolResult<ReadToolDetails>(details).text(text).sourcePath(absoluteArchivePath).done();
	}

	if (!members.includes(member)) {
		const available = members.length === 0 ? "(none)" : members.join(", ");
		throw new ToolError(`PDF image member '${member}' not found. Available members: ${available}`);
	}

	const imagePath = path.join(imageDir, member);
	const imageStat = await Bun.file(imagePath).stat();
	if (imageStat.size > MAX_IMAGE_SIZE) {
		const sizeStr = formatBytes(imageStat.size);
		const maxStr = formatBytes(MAX_IMAGE_SIZE);
		throw new ToolError(`Image file too large: ${sizeStr} exceeds ${maxStr} limit.`);
	}
	const metadata = await readImageMetadata(imagePath);
	const mimeType = metadata?.mimeType;
	if (!mimeType) throw new ToolError(`PDF image member '${member}' is not a supported image.`);
	const imageInput = await loadImageInput({
		path: `${archiveDisplayPath}:${pdfMemberPath}:${member}`,
		cwd: session.cwd,
		autoResize: session.settings.get("images.autoResize"),
		maxBytes: MAX_IMAGE_SIZE,
		resolvedPath: imagePath,
		detectedMimeType: mimeType,
		excludeWebP: webpExclusionForModel(session.getActiveModel?.()),
	});
	if (!imageInput) {
		throw new ToolError(`Read image file [${mimeType}] failed: unsupported image format.`);
	}
	return toolResult<ReadToolDetails>(details)
		.content([
			{ type: "text", text: imageInput.textNote },
			{ type: "image", data: imageInput.data, mimeType: imageInput.mimeType },
		])
		.sourcePath(imageInput.resolvedPath)
		.done();
}
