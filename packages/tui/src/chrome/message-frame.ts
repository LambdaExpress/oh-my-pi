/**
 * Shared rendering for extension/hook custom message frames.
 *
 * `CustomMessageComponent` and `HookMessageComponent` share one behavior-owning
 * frame: it tries a user-supplied renderer first and falls back to a label plus
 * markdown body when the renderer returns nothing or throws. Hook messages
 * collapse to the first N lines when not expanded; extension messages render
 * in full.
 */

import type { TextContent } from "@oh-my-pi/pi-ai";
import { Box } from "../components/box";
import { Markdown } from "../components/markdown";
import { Spacer } from "../components/spacer";
import { Text } from "../components/text";
import { Ellipsis, truncateToWidth } from "../render";
import { sanitizeDisplayWarning, TRUNCATE_LENGTHS } from "../render/render-utils";
import { type Component, Container } from "../tui";
import { getMarkdownTheme, getThemeEpoch, type Theme, type ThemeColor, theme } from "../theme/index";
import { card, col, md, span, text } from "../native/describe";
import { type NativeNode, type NativeUiEvent, rootToggleExpanded } from "../native/node";
import { Memo } from "../native/memo";
import { colorTone } from "../native/tone";
/** Message shape consumed by the shared frame. */
export interface FramedMessage {
	customType: string;
	content: string | (TextContent | { type: string })[];
}

/**
 * Callable signature shared by `MessageRenderer` (extensions) and
 * `HookMessageRenderer` (hooks). Both narrow `message` to their own type;
 * this signature is the structural intersection callers can hand off here.
 */
export type FramedRenderer<M extends FramedMessage> = (
	message: M,
	options: { expanded: boolean },
	theme: Theme,
) => Component | undefined;

/** Presentation and extension-renderer policy for a framed custom message. */
export interface FramedMessageOptions<M extends FramedMessage> {
	readonly message: M;
	/** Theme-aware icon glyph shown before the custom type. */
	readonly icon?: string | (() => string);
	/** Hide the default type header while retaining the message body. */
	readonly hideHeader?: boolean | (() => boolean);
	/** Semantic color for the outline, defaulting to the muted border. */
	readonly borderColor?: ThemeColor;
	/** Collapse the markdown body to this many lines when `expanded` is false. Omit to never collapse. */
	readonly collapseAfterLines?: number;
	readonly customRenderer?: FramedRenderer<M>;
	/** Semantic role of the native card. */
	readonly role: string;
}

/**
 * Behavior-owning custom message frame. It retries extension renderers whenever
 * expansion or theme state changes and falls back to the shared card when a
 * renderer returns nothing or throws.
 */
export class FramedMessageComponent<M extends FramedMessage> extends Container {
	readonly #options: FramedMessageOptions<M>;
	readonly #box: Box;
	#customComponent: Component | undefined;
	#expanded = false;
	#toolRowsFolded = false;
	#foldedPreview: string | undefined;
	#foldedLine: { width: number; text: string } | undefined;
	#disposed = false;
	#version = 0;
	readonly #native = new Memo();

	constructor(options: FramedMessageOptions<M>) {
		super();
		this.#options = options;
		this.#box = new Box(1, 1, text => theme.bg("customMessageBg", text));
		this.#box.setIgnoreTight(true);
		this.#rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#rebuild();
	}

	setToolRowsFolded(folded: boolean): void {
		if (this.#toolRowsFolded === folded) return;
		this.#toolRowsFolded = folded;
		this.#foldedLine = undefined;
	}

	override render(width: number): readonly string[] {
		if (this.#disposed) return [];
		if (!this.#toolRowsFolded) return super.render(width);
		if (this.#foldedLine?.width === width) return [this.#foldedLine.text];
		const icon = typeof this.#options.icon === "function" ? this.#options.icon() : this.#options.icon;
		const type = sanitizeDisplayWarning(this.#options.message.customType);
		const title = theme.fg("customMessageLabel", theme.bold(icon ? `${icon} ${type}` : type));
		const preview = this.#foldedMessagePreview();
		const detail = preview ? `: ${theme.fg("muted", preview)}` : "";
		// An extension renderer may show additional details absent from the persisted
		// message body. Make that disclosure visible instead of implying the preview is complete.
		const more = this.#customComponent ? ` ${theme.fg("dim", "…")}` : "";
		const text = truncateToWidth(` ${title}${detail}${more}`, width, Ellipsis.Unicode);
		this.#foldedLine = { width, text };
		return [text];
	}

	#foldedMessagePreview(): string {
		if (this.#foldedPreview !== undefined) return this.#foldedPreview;
		const content = this.#options.message.content;
		const text =
			typeof content === "string"
				? content
				: content
						.filter((item): item is TextContent => item.type === "text")
						.map(item => item.text)
						.join(" ");
		this.#foldedPreview = truncateToWidth(
			sanitizeDisplayWarning(text).replace(/\s+/g, " "),
			TRUNCATE_LENGTHS.LONG,
			Ellipsis.Unicode,
		);
		return this.#foldedPreview;
	}

	override invalidate(): void {
		this.#rebuild();
	}

	override dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		super.dispose();
		for (const child of this.#box.children) child.dispose?.();
		this.#box.clear();
		this.clear();
		this.#customComponent = undefined;
	}

	/**
	 * The extension renderer's component when it supplied one; otherwise a
	 * card with the type tag as its head and the markdown body, clamped by the
	 * terminal while collapsed.
	 */
	override describe(): NativeNode {
		const key = [this.#version, this.#expanded, this.#toolRowsFolded, getThemeEpoch()];
		return this.#native.get(key, () => {
			if (this.#toolRowsFolded) {
				const tag = sanitizeDisplayWarning(this.#options.message.customType);
				const preview = this.#foldedMessagePreview();
				return text(
					[
						span(tag, "customMessageLabel strong"),
						...(preview ? [span(`: ${preview}`, "muted")] : []),
						...(this.#customComponent ? [span(" …", "dim")] : []),
					],
					{ role: this.#options.role, wrap: "none", truncate: "end", lines: 1 },
				);
			}
			if (this.#customComponent) return col([this.#customComponent], { role: this.#options.role });
			const hideHeader =
				typeof this.#options.hideHeader === "function" ? this.#options.hideHeader() : this.#options.hideHeader;
			// The role icon (Tern's named icon) replaces the nerd glyph.
			const tag = this.#options.message.customType;
			const collapseAfterLines = this.#options.collapseAfterLines;
			return card(
				{
					role: this.#options.role,
					tone: colorTone(this.#options.borderColor),
					head: hideHeader ? undefined : [span(tag, "customMessageLabel strong")],
					collapsible: collapseAfterLines !== undefined,
					collapsed: collapseAfterLines !== undefined ? !this.#expanded : undefined,
					preview: collapseAfterLines !== undefined ? { lines: collapseAfterLines } : undefined,
				},
				[md(this.#messageText())],
			);
		});
	}

	handleNativeEvent(event: NativeUiEvent): void {
		const expanded = rootToggleExpanded(event);
		if (expanded !== undefined) this.setExpanded(expanded);
	}

	#messageText(): string {
		const content = this.#options.message.content;
		if (typeof content === "string") return content;
		return content
			.filter((part): part is TextContent => part.type === "text")
			.map(part => part.text)
			.join("\n");
	}

	#rebuild(): void {
		if (this.#disposed) return;
		this.#foldedLine = undefined;
		this.#foldedPreview = undefined;
		this.#version++;
		let nextCustomComponent: Component | undefined;
		const customRenderer = this.#options.customRenderer;
		if (customRenderer) {
			try {
				nextCustomComponent = customRenderer(this.#options.message, { expanded: this.#expanded }, theme);
			} catch {
				// A broken extension renderer must not hide its persisted message.
			}
		}

		const previousCustomComponent = this.#customComponent;
		if (nextCustomComponent) {
			if (nextCustomComponent === previousCustomComponent) {
				super.invalidate();
				return;
			}
			if (previousCustomComponent) {
				this.removeChild(previousCustomComponent);
				previousCustomComponent.dispose?.();
			}
			this.removeChild(this.#box);
			for (const child of this.#box.children) child.dispose?.();
			this.#box.clear();
			this.#customComponent = nextCustomComponent;
			this.addChild(nextCustomComponent);
			return;
		}

		if (previousCustomComponent) {
			this.removeChild(previousCustomComponent);
			previousCustomComponent.dispose?.();
			this.#customComponent = undefined;
		}
		this.removeChild(this.#box);
		for (const child of this.#box.children) child.dispose?.();
		this.#box.clear();
		this.#box.setBorder({
			chars: theme.boxRound,
			color: text => theme.fg(this.#options.borderColor ?? "borderMuted", text),
		});

		const hideHeader =
			typeof this.#options.hideHeader === "function" ? this.#options.hideHeader() : this.#options.hideHeader;
		if (!hideHeader) {
			const icon = typeof this.#options.icon === "function" ? this.#options.icon() : this.#options.icon;
			const tag = icon ? `${icon} ${this.#options.message.customType}` : this.#options.message.customType;
			this.#box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(tag)), 0, 0));
			this.#box.addChild(new Spacer(1));
		}

		let text = this.#messageText();

		const collapseAfterLines = this.#options.collapseAfterLines;
		if (!this.#expanded && collapseAfterLines !== undefined) {
			const lines = text.split("\n");
			if (lines.length > collapseAfterLines) text = `${lines.slice(0, collapseAfterLines).join("\n")}\n…`;
		}

		this.#box.addChild(
			new Markdown(text, 0, 0, getMarkdownTheme(), {
				color: value => theme.fg("customMessageText", value),
			}),
		);
		this.addChild(this.#box);
	}
}
