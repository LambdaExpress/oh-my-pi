import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { ImageMetadata } from "@oh-my-pi/pi-utils";
import { ImageInputTooLargeError, type LoadedImageInput, MAX_IMAGE_INPUT_BYTES } from "../utils/image-loading";
import { formatBytes } from "./render-utils";
import { ToolError } from "./tool-errors";

export interface ReadImageContentOptions {
	/** Effective `inspect_image` state: a metadata note replaces the image block when active. */
	inspectImageActive: boolean;
	/** MIME type detected for the image. */
	mimeType: string;
	/** Detected image metadata (dimensions etc.), used for the inspect_image note. */
	imageMetadata: ImageMetadata | null;
	/** Raw byte size of the image; feeds the size cap and the inspect_image note. */
	fileSize: number;
	/** Path embedded in the inspect_image suggestion (cwd-relative for files, member read path for archive entries). */
	inspectHintPath: string;
	/** Path attached as the result's sourcePath when inspection is active (no image input is loaded then). */
	sourcePath: string;
	/** Loads the image input through the caller's channel (file-backed or bytes-backed). */
	load: () => Promise<LoadedImageInput | null>;
}

/**
 * Build content blocks for an image read: an `inspect_image` metadata note when
 * inspection is active, otherwise the decoded image block. Shared by the
 * plain-file, `local://`, PDF-member, and archive-member read paths so they all
 * honor the effective inspect_image state, the size cap, and auto-resize
 * identically. Too-large / unsupported images surface as {@link ToolError}.
 */
export async function buildReadImageContent(options: ReadImageContentOptions): Promise<{
	content: Array<TextContent | ImageContent>;
	sourcePath: string;
}> {
	const { inspectImageActive, mimeType, imageMetadata, fileSize, inspectHintPath, sourcePath, load } = options;
	if (inspectImageActive) {
		const outputMime = imageMetadata?.mimeType ?? mimeType;
		const metadataLines = [
			"Image metadata:",
			`- MIME: ${outputMime}`,
			`- Bytes: ${fileSize} (${formatBytes(fileSize)})`,
			imageMetadata?.width !== undefined && imageMetadata.height !== undefined
				? `- Dimensions: ${imageMetadata.width}x${imageMetadata.height}`
				: "- Dimensions: unknown",
			imageMetadata?.channels !== undefined ? `- Channels: ${imageMetadata.channels}` : "- Channels: unknown",
			imageMetadata?.hasAlpha === true
				? "- Alpha: yes"
				: imageMetadata?.hasAlpha === false
					? "- Alpha: no"
					: "- Alpha: unknown",
			"",
			`If you want to analyze the image, call inspect_image with path="${inspectHintPath}" and a question describing what to inspect and the desired output format.`,
		];
		return { content: [{ type: "text", text: metadataLines.join("\n") }], sourcePath };
	}

	if (fileSize > MAX_IMAGE_INPUT_BYTES) {
		const sizeStr = formatBytes(fileSize);
		const maxStr = formatBytes(MAX_IMAGE_INPUT_BYTES);
		throw new ToolError(`Image file too large: ${sizeStr} exceeds ${maxStr} limit.`);
	}
	try {
		const imageInput = await load();
		if (!imageInput) {
			throw new ToolError(`Read image file [${mimeType}] failed: unsupported image format.`);
		}
		return {
			content: [
				{ type: "text", text: imageInput.textNote },
				{ type: "image", data: imageInput.data, mimeType: imageInput.mimeType },
			],
			sourcePath: imageInput.resolvedPath,
		};
	} catch (error) {
		if (error instanceof ImageInputTooLargeError) {
			throw new ToolError(error.message);
		}
		throw error;
	}
}
