import type { completeSimple, ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { ImageMetadata } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../sdk";
import {
	ImageInputTooLargeError,
	type LoadedImageInput,
	MAX_IMAGE_INPUT_BYTES,
	webpExclusionForModel,
} from "../utils/image-loading";
import { askImageQuestion, resolveImageQuestionModel } from "../utils/image-question";
import { formatBytes } from "./render-utils";
import { ToolError } from "./tool-errors";

export interface ReadImageContentOptions {
	/** Session that supplies the active model and delegated image-question model. */
	session: ToolSession;
	/** MIME type detected for the image. */
	mimeType: string;
	/** Detected image metadata (dimensions etc.), used for the text-model note. */
	imageMetadata: ImageMetadata | null;
	/** Raw byte size of the image; feeds the size cap and metadata note. */
	fileSize: number;
	/** Base read target embedded in the `?q=` suggestion. */
	questionPath: string;
	/** Explicit question delegated to a vision model, when present. */
	question?: string;
	/** Path attached as the result's sourcePath. */
	sourcePath: string;
	/** Loads the image input through the caller's channel (file-backed or bytes-backed). */
	load: (excludeWebP: boolean | undefined) => Promise<LoadedImageInput | null>;
	/** Completion implementation override used by tests. */
	completeImageRequest?: typeof completeSimple;
	/** Cancels delegated image questions with the parent read call. */
	signal?: AbortSignal;
}

/**
 * Build content blocks for an image read. Text-only active models receive
 * metadata and an executable `?q=` follow-up; image-capable models receive the
 * decoded image directly; explicit questions are delegated to a configured
 * vision model and returned as text. Too-large and unsupported images surface
 * as {@link ToolError}.
 */
export async function buildReadImageContent(options: ReadImageContentOptions): Promise<{
	content: Array<TextContent | ImageContent>;
	sourcePath: string;
}> {
	const {
		session,
		mimeType,
		imageMetadata,
		fileSize,
		questionPath,
		question,
		sourcePath,
		load,
		completeImageRequest,
		signal,
	} = options;
	const activeModelSupportsImages = session.getActiveModel?.()?.input.includes("image") ?? true;
	if (!question && !activeModelSupportsImages) {
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
			`To analyze the image, read \`${questionPath}?q=<question>\` — the question is answered by a vision model and returned as text.`,
		];
		return { content: [{ type: "text", text: metadataLines.join("\n") }], sourcePath };
	}

	if (fileSize > MAX_IMAGE_INPUT_BYTES) {
		const sizeStr = formatBytes(fileSize);
		const maxStr = formatBytes(MAX_IMAGE_INPUT_BYTES);
		throw new ToolError(`Image file too large: ${sizeStr} exceeds ${maxStr} limit.`);
	}
	try {
		const resolved = question ? resolveImageQuestionModel(session) : undefined;
		const imageInput = await load(webpExclusionForModel(resolved?.model ?? session.getActiveModel?.()));
		if (!imageInput) {
			throw new ToolError(`Read image file [${mimeType}] failed: unsupported image format.`);
		}
		if (question && resolved) {
			const answer = await askImageQuestion(session, resolved, imageInput, question, signal, completeImageRequest);
			return { content: [{ type: "text", text: answer.text }], sourcePath: imageInput.resolvedPath };
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
