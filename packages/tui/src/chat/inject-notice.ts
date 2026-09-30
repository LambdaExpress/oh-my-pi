import { sanitizeText } from "@oh-my-pi/pi-utils";
import { Box } from "../components/box";
import { Spacer } from "../components/spacer";
import { Text } from "../components/text";
import { t } from "../i18n";
import { theme } from "../theme";
import { Container } from "../tui";
import { replaceTabs, truncateToWidth } from "../utils";
import {
	type ContextInjectionItem,
	type ContextInjectionKind,
	normalizeContextInjectionItems,
} from "./context-injection";

/** Preview lines shown per source while the notice is collapsed. */
const COLLAPSED_PREVIEW_LINES = 2;

/** Sources whose name is a concrete file/rule/skill rather than a group label. */
function isNamedSource(kind: ContextInjectionKind): boolean {
	return kind === "context-file" || kind === "rule" || kind === "memory" || kind === "guidance";
}

/**
 * One notice per context-injection set: what the harness pushed into the
 * model's context (instruction files, rules, the skill index, memory, notes),
 * how big each source is, and a preview of the injected body.
 *
 * `display.foldToolRows` collapses the whole notice into one `Inject:` row, the
 * way every other activity row reads; `ctrl+o` (or the transcript's own
 * expansion gesture) reveals the previews. Records are replayed from the
 * session journal, so the notice survives transcript rebuilds.
 */
export class InjectNoticeComponent extends Container {
	#box: Box;
	#expanded = false;
	#items: ContextInjectionItem[];
	#toolActivityVisible = true;
	#toolRowsFolded = false;

	constructor(items: readonly ContextInjectionItem[]) {
		super();
		this.#items = normalizeContextInjectionItems(items);

		this.addChild(new Spacer(1));
		this.#box = new Box(1, 1, text => theme.bg("customMessageBg", text));
		this.#box.setIgnoreTight(true);
		this.addChild(this.#box);

		this.#rebuild();
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#toolActivityVisible === visible) return;
		this.#toolActivityVisible = visible;
		this.invalidate();
	}

	/**
	 * Fold the notice into one activity row (`Inject: <sources>`) so it reads
	 * like every other folded row; the banner with sizes and previews returns
	 * when the transcript unfolds.
	 */
	setToolRowsFolded(folded: boolean): void {
		if (this.#toolRowsFolded === folded) return;
		this.#toolRowsFolded = folded;
		this.invalidate();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#rebuild();
	}

	/** Merge another injection set into this notice (deduped by source). */
	addItems(items: readonly ContextInjectionItem[]): void {
		const merged = normalizeContextInjectionItems([...this.#items, ...items]);
		if (merged.length === this.#items.length) return;
		this.#items = merged;
		this.#rebuild();
	}

	override render(width: number): readonly string[] {
		if (!this.#toolActivityVisible || this.#items.length === 0) return [];
		if (this.#toolRowsFolded) return [this.#foldedRow(width)];
		return super.render(width);
	}

	/** One row for the whole notice: `Inject: <sources>`, accent-labeled like the TTSR row. */
	#foldedRow(width: number): string {
		const label = theme.fg("accent", theme.bold(t("Inject")));
		const items = this.#items;
		let detail: string;
		if (items.length === 1) {
			const item = items[0]!;
			const itemDetail = this.#itemDetail(item);
			const name = this.#displayLabel(item);
			detail = itemDetail ? `${name} — ${itemDetail}` : name;
		} else {
			// A monorepo injects `AGENTS.md` once per level: collapse repeated
			// names into `AGENTS.md ×2` instead of repeating the same word.
			const counts = new Map<string, number>();
			for (const item of items) {
				const name = this.#displayLabel(item);
				counts.set(name, (counts.get(name) ?? 0) + 1);
			}
			const names = [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
			const shown = names.slice(0, 3);
			const rest = names.length - shown.length;
			detail = rest > 0 ? `${shown.join(" · ")} ${t("{count} more", { count: rest })}` : shown.join(" · ");
		}
		return truncateToWidth(` ${label}${theme.fg("dim", ":")} ${theme.fg("muted", detail)}`, width);
	}

	/** Localized, sanitized name of one source (group labels are i18n keys). */
	#displayLabel(item: ContextInjectionItem): string {
		return this.#sanitize(isNamedSource(item.kind) ? item.label : t(item.label));
	}

	#rebuild(): void {
		this.#box.clear();
		if (this.#items.length === 0) return;

		const header = `${theme.bold(theme.fg("accent", t("Inject")))} ${theme.fg("dim", t("{count} sources", { count: this.#items.length }))}`;
		this.#box.addChild(new Text(header, 0, 0));
		this.#box.addChild(new Spacer(1));

		let truncated = false;
		for (const item of this.#items) {
			const detail = this.#itemDetail(item);
			const name = isNamedSource(item.kind)
				? theme.fg("accent", theme.bold(this.#displayLabel(item)))
				: theme.bold(this.#displayLabel(item));
			this.#box.addChild(new Text(detail ? `${name} ${theme.fg("dim", this.#sanitize(detail))}` : name, 0, 0));
			if (!item.preview) continue;
			for (const line of this.#previewLines(item.preview)) this.#box.addChild(new Text(line, 1, 0));
			truncated ||= this.#isPreviewTruncated(item.preview);
		}

		if (truncated) {
			this.#box.addChild(new Text(theme.fg("dim", ` ${t("(ctrl+o to expand)")}`), 0, 0));
		}
	}

	/** `(count)` for group sources plus any size/path detail, or `undefined` when unknown. */
	#itemDetail(item: ContextInjectionItem): string | undefined {
		const parts: string[] = [];
		if (item.count !== undefined) parts.push(`(${item.count})`);
		if (item.detail) parts.push(item.detail);
		return parts.length > 0 ? parts.join(" · ") : undefined;
	}

	/** Preview body, clipped to the collapsed budget when the notice is folded. */
	#previewLines(preview: string): string[] {
		const lines = preview
			.split("\n")
			.map(line => theme.fg("muted", `  ${this.#sanitize(line)}`))
			.slice(0, this.#expanded ? undefined : COLLAPSED_PREVIEW_LINES);
		return lines;
	}

	/** True when the collapsed line budget hid part of the preview. */
	#isPreviewTruncated(preview: string): boolean {
		if (this.#expanded) return false;
		return preview.split("\n").length > COLLAPSED_PREVIEW_LINES;
	}

	/** Injected bodies are foreign text: strip escapes, tabs, and stray control characters. */
	#sanitize(text: string): string {
		return replaceTabs(sanitizeText(text));
	}
}
