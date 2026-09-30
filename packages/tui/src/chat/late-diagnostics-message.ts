import { Container } from "../tui";
import { Disclosure } from "../components/disclosure";
import { Text } from "../components/text";
import { t } from "../i18n";
import { formatDiagnostics, truncateToWidth } from "../render/render-utils";
import { getLanguageFromPath, theme } from "../theme";

const EMPTY_ROWS: readonly string[] = [];

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
	#toolActivityVisible = true;
	// `display.foldToolRows`: one `Late diagnostics:` row instead of the tree.
	#toolRowsFolded = false;
	// Controlled expansion delegate with no summary: the collapsed and
	// expanded diagnostic trees are mutually exclusive slots, each formatted
	// lazily on its first render. Only the tool-visibility gate stays here.
	#disclosure: Disclosure | undefined;
	readonly #files: LateDiagnosticsFile[];

	constructor(files: LateDiagnosticsFile[]) {
		super();
		this.#files = files;

		this.#rebuild();
	}

	setExpanded(expanded: boolean): void {
		this.#disclosure?.setExpanded(expanded);
	}

	setToolActivityVisible(visible: boolean): void {
		this.#toolActivityVisible = visible;
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
		if (!this.#toolActivityVisible) return EMPTY_ROWS;
		if (this.#toolRowsFolded) return [this.#foldedRow(width)];
		return super.render(width);
	}

	/** `Late diagnostics: 2 files · <first file>` on one truncated row. */
	#foldedRow(width: number): string {
		const label = theme.fg("warning", theme.bold(t("Late diagnostics")));
		const count = this.#files.length;
		const first = this.#files.find(file => file.summary?.trim() || file.path);
		const head = first?.summary?.replace(/\s+/g, " ").trim() || first?.path;
		const countText = count === 1 ? t("1 file") : t("{count} files", { count });
		const detail = head
			? `${theme.fg("muted", countText)}${theme.fg("dim", " · ")}${theme.fg("accent", head)}`
			: theme.fg("muted", countText);
		return truncateToWidth(` ${label}${theme.fg("dim", ":")} ${detail}`, width);
	}

	override invalidate(): void {
		this.#rebuild();
	}

	#rebuild(): void {
		// Preserve controlled state across theme-invalidation rebuilds while
		// leaving both diagnostic trees unmaterialized until their next render.
		const expanded = this.#disclosure?.expanded ?? false;
		this.clear();
		this.#disclosure?.dispose();
		this.#disclosure = undefined;

		const input = this.#diagnosticInput() ?? { errored: false, summary: "", messages: [] };

		this.#disclosure = new Disclosure({
			collapsedBody: () => new Text(this.#format(input, false), 1, 0),
			body: () => new Text(this.#format(input, true), 1, 0),
			expanded,
		});
		this.addChild(this.#disclosure);
	}

	/** Aggregate file payloads; undefined when there is nothing to render. */
	#diagnosticInput(): { errored: boolean; summary: string; messages: string[] } | undefined {
		const messages: string[] = [];
		const summaries: string[] = [];
		let errored = false;
		for (const file of this.#files) {
			if (file.messages?.length) messages.push(...file.messages);
			if (file.summary) summaries.push(file.summary);
			if (file.errored) errored = true;
		}
		if (messages.length === 0) return undefined;
		return { errored, summary: summaries.join(", "), messages };
	}

	/** Render one branch of the diagnostic tree, reusing the tool renderer. */
	#format(input: { errored: boolean; summary: string; messages: string[] }, expanded: boolean): string {
		return formatDiagnostics(input, expanded, theme, fp => theme.getLangIcon(getLanguageFromPath(fp)), {
			title: t("Late diagnostics"),
		}).replace(/^\n+/, "");
	}
}
