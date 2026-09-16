import { Container, Text } from "@oh-my-pi/pi-tui";
import { t } from "../../i18n";
import { formatDiagnostics, truncateToWidth } from "../../tools/render-utils";
import { getLanguageFromPath, theme } from "../theme/theme";

/** One file's worth of late LSP diagnostics, as carried on the transcript message. */
export interface LateDiagnosticsFile {
	path?: string;
	summary?: string;
	errored?: boolean;
	messages?: string[];
}

/**
 * Renders late LSP diagnostics (arrived after edit/write returned) in the
 * transcript, reusing the same tree renderer the edit/write tools use so the
 * styling stays consistent. Supports the global tool-output expand toggle.
 */
export class LateDiagnosticsMessageComponent extends Container {
	#expanded = false;
	#toolActivityVisible = true;
	// `display.foldToolRows`: one `Late diagnostics:` row instead of the tree.
	#toolRowsFolded = false;
	constructor(private readonly files: LateDiagnosticsFile[]) {
		super();
		this.#rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#rebuild();
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#toolActivityVisible === visible) return;
		this.#toolActivityVisible = visible;
		this.invalidate();
	}

	/**
	 * Fold the report into one activity row (`display.foldToolRows`): file count
	 * plus the first file's summary, in place of the per-file tree. Unfolding
	 * restores the full report.
	 */
	setToolRowsFolded(folded: boolean): void {
		if (this.#toolRowsFolded === folded) return;
		this.#toolRowsFolded = folded;
		this.invalidate();
	}

	override render(width: number): readonly string[] {
		if (!this.#toolActivityVisible) return [];
		if (this.#toolRowsFolded) return [this.#foldedRow(width)];
		return super.render(width);
	}

	/** `Late diagnostics: 2 files · <first file>` on one truncated row. */
	#foldedRow(width: number): string {
		const label = theme.fg("warning", theme.bold(t("Late diagnostics")));
		const count = this.files.length;
		const first = this.files.find(file => file.summary?.trim() || file.path);
		const head = first?.summary?.replace(/\s+/g, " ").trim() || first?.path;
		const countText = count === 1 ? t("1 file") : t("{count} files", { count });
		const detail = head
			? `${theme.fg("muted", countText)}${theme.fg("dim", " · ")}${theme.fg("accent", head)}`
			: theme.fg("muted", countText);
		return truncateToWidth(` ${label}${theme.fg("dim", ":")} ${detail}`, width);
	}

	override invalidate(): void {
		super.invalidate();
		this.#rebuild();
	}

	#rebuild(): void {
		this.clear();

		const messages: string[] = [];
		const summaries: string[] = [];
		let errored = false;
		for (const file of this.files) {
			if (file.messages?.length) messages.push(...file.messages);
			if (file.summary) summaries.push(file.summary);
			if (file.errored) errored = true;
		}
		if (messages.length === 0) return;

		const text = formatDiagnostics(
			{ errored, summary: summaries.join(", "), messages },
			this.#expanded,
			theme,
			fp => theme.getLangIcon(getLanguageFromPath(fp)),
			{ title: t("Late diagnostics") },
		);
		const body = text.replace(/^\n+/, "");
		if (body) this.addChild(new Text(body, 1, 0));
	}
}
