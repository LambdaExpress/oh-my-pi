import type { Api, ImageContent, Model, TextContent } from "../types";

export const NON_VISION_IMAGE_PLACEHOLDER = "[image omitted: model does not support vision]";
export function partitionVisionContent(
	content: ReadonlyArray<TextContent | ImageContent>,
	supportsImages: boolean,
): {
	textBlocks: TextContent[];
	imageBlocks: ImageContent[];
	omittedImages: boolean;
} {
	const textBlocks = content.filter((block): block is TextContent => block.type === "text");
	const imageBlocks = content.filter((block): block is ImageContent => block.type === "image");
	return {
		textBlocks,
		imageBlocks: supportsImages ? imageBlocks : [],
		omittedImages: !supportsImages && imageBlocks.length > 0,
	};
}

export function joinTextWithImagePlaceholder(text: string, omittedImages: boolean): string {
	const parts: string[] = [];
	if (text.length > 0) {
		parts.push(text);
	}
	if (omittedImages) {
		parts.push(NON_VISION_IMAGE_PLACEHOLDER);
	}
	return parts.join("\n");
}

/**
 * Evaluates whether an OpenAI-compatible Chat Completions model genuinely
 * supports multimodal image inputs on the wire. Defensive guards override
 * misconfigured provider descriptors or user model entries (e.g. text-only
 * DashScope Qwen SKUs, DeepSeek models) whose endpoints reject `image_url`.
 */
export function isOpenAICompletionsVisionSupported(model: Model<"openai-completions">): boolean {
	if (!model.input.includes("image")) return false;
	if (model.compat.stripImageInput) return false;
	return true;
}

/**
 * Whether this model's transport actually puts image parts on the wire.
 *
 * `model.input` declares what the model can consume; a per-endpoint wire guard can
 * still drop image parts (the chat-completions encoder honors
 * `compat.stripImageInput`, e.g. for DeepSeek-family ids). Callers that decide
 * whether to compensate for a dropped image MUST use this instead of `model.input`
 * alone — otherwise a model declaring vision whose endpoint strips images silently
 * loses the attachment.
 */
export function modelCarriesImageInput(model: Model<Api>): boolean {
	if (!model.input.includes("image")) return false;
	if (model.api !== "openai-completions") return true;
	return (model.compat as { stripImageInput?: boolean } | undefined)?.stripImageInput !== true;
}
