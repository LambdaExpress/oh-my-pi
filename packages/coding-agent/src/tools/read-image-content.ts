import type { completeSimple, ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { ImageMetadata } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../sdk";
import {
	convertImageToPng,
	ImageInputTooLargeError,
	InvalidImageDataError,
	type LoadedImageInput,
	MAX_IMAGE_INPUT_BYTES,
	webpExclusionForModel,
} from "../utils/image-loading";
import {
	askImageQuestion,
	ImageQuestionUnavailableError,
	type ResolvedImageQuestionModel,
	resolveImageQuestionModel,
} from "../utils/image-question";
import { formatBytes } from "./render-utils";
import { ToolError, throwIfAborted } from "./tool-errors";

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

function imageMetadataText(options: ReadImageContentOptions): string {
	const { imageMetadata, mimeType, fileSize, questionPath } = options;
	return [
		"Image metadata:",
		`- MIME: ${imageMetadata?.mimeType ?? mimeType}`,
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
	].join("\n");
}

/**
 * Build content blocks for an image read. Text-only active models receive
 * metadata and an executable `?q=` follow-up; image-capable models receive the
 * decoded image directly; explicit questions are delegated to a configured
 * vision model and returned as text. Service failures fall back to local image
 * content or metadata without resubmitting. Invalid and oversized inputs,
 * disabled submission, and cancellation remain errors.
 */
export async function buildReadImageContent(options: ReadImageContentOptions): Promise<{
	content: Array<TextContent | ImageContent>;
	sourcePath: string;
	contentType?: string;
}> {
	const { session, mimeType, fileSize, question, sourcePath, load, completeImageRequest, signal } = options;
	throwIfAborted(signal);
	const activeModel = session.getActiveModel?.();
	const activeModelSupportsImages = activeModel?.input.includes("image") ?? true;
	if (!question && !activeModelSupportsImages) {
		return { content: [{ type: "text", text: imageMetadataText(options) }], sourcePath };
	}

	if (fileSize > MAX_IMAGE_INPUT_BYTES) {
		const sizeStr = formatBytes(fileSize);
		const maxStr = formatBytes(MAX_IMAGE_INPUT_BYTES);
		throw new ToolError(`Image file too large: ${sizeStr} exceeds ${maxStr} limit.`);
	}
	try {
		let resolved: ResolvedImageQuestionModel | undefined;
		let unavailable: ImageQuestionUnavailableError | undefined;
		if (question) {
			try {
				resolved = resolveImageQuestionModel(session);
			} catch (error) {
				if (!(error instanceof ImageQuestionUnavailableError)) throw error;
				unavailable = error;
			}
		}
		// Loading stays outside the recoverable question catches: invalid bytes
		// must never enter the transcript, even when no service is available.
		const imageInput = await load(webpExclusionForModel(resolved?.model ?? activeModel));
		throwIfAborted(signal);
		if (!imageInput) {
			throw new ToolError(`Read image file [${mimeType}] failed: unsupported image format.`);
		}
		if (question && resolved) {
			try {
				const answer = await askImageQuestion(
					session,
					resolved,
					imageInput,
					question,
					signal,
					completeImageRequest,
				);
				return {
					content: [{ type: "text", text: answer.text }],
					sourcePath: imageInput.resolvedPath,
					contentType: imageInput.mimeType,
				};
			} catch (error) {
				throwIfAborted(signal);
				if (!(error instanceof ImageQuestionUnavailableError)) throw error;
				unavailable = error;
			}
		}
		if (unavailable) {
			const notice = `No image analysis was obtained. ${unavailable.message} No other service was tried.`;
			if (!activeModelSupportsImages) {
				return {
					content: [
						{
							type: "text",
							text: `${notice}\n\n${imageMetadataText(options)}\nCheck modelRoles.vision and its provider before requesting analysis again.`,
						},
					],
					sourcePath: imageInput.resolvedPath,
				};
			}
			let image: ImageContent = { type: "image", data: imageInput.data, mimeType: imageInput.mimeType };
			if (webpExclusionForModel(activeModel) && image.mimeType === "image/webp") {
				image = await convertImageToPng(image);
				throwIfAborted(signal);
			}
			return {
				content: [
					{
						type: "text",
						text: `${notice}\nLocal image fallback [${image.mimeType}]${imageInput.dimensionNote ? `\n${imageInput.dimensionNote}` : ""}`,
					},
					image,
				],
				sourcePath: imageInput.resolvedPath,
			};
		}
		return {
			content: [
				{ type: "text", text: imageInput.textNote },
				{ type: "image", data: imageInput.data, mimeType: imageInput.mimeType },
			],
			sourcePath: imageInput.resolvedPath,
		};
	} catch (error) {
		if (error instanceof ImageInputTooLargeError || error instanceof InvalidImageDataError) {
			throw new ToolError(error.message);
		}
		throw error;
	}
}
