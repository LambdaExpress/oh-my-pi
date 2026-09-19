/**
 * Render a code or markdown cell with optional output section.
 */
import { Markdown } from "../components/markdown";
import { t } from "../i18n";
import { getMarkdownTheme, highlightCode, type Theme } from "../theme/theme";
import { type OutputBlockSection, outputBlockContentWidth, renderOutputBlock } from "./output-block";
import { formatOutputPaneLines, splitTerminalOutputLines, styleToolOutputLine } from "./output-pane";
import {
	createEarlierLinesTailWindow,
	createMoreLinesHeadWindow,
	formatDuration,
	formatExpandHint,
	formatMoreItems,
	formatStatusIcon,
	replaceTabs,
	wrapTextWithAnsi,
} from "./render-utils";
import type { State } from "./types";

/** Content and display limits for a code preview with optional output. */
export interface CodeCellOptions {
	code: string;
	language?: string;
	index?: number;
	total?: number;
	title?: string;
	status?: "pending" | "running" | "warning" | "complete" | "error";
	spinnerFrame?: number;
	duration?: number;
	output?: string;
	outputMaxLines?: number;
	codeMaxLines?: number;
	/**
	 * Limit collapsed head previews by wrapped terminal rows instead of logical
	 * lines. Opt-in so existing code-cell callers retain logical-line limits.
	 */
	codeMaxVisualRows?: number;
	/**
	 * Show the LAST `codeMaxLines` rows (the live streaming edge) instead of the
	 * first, with a "… N earlier lines" marker on top. Lets a pending preview
	 * follow code as it is written while staying bounded. Ignored when `expanded`.
	 */
	codeTail?: boolean;
	expanded?: boolean;
	/**
	 * Prefix the header with the cell's language icon (resolved through the
	 * active symbol preset: nerd-font devicon, unicode emoji, or ascii
	 * shorthand). Opt-in so only the eval kernel renderer labels each cell;
	 * read/write/browser code cells stay icon-free.
	 */
	showLanguage?: boolean;
	width: number;
	codeStartLine?: number;
	codeLineNumbers?: Array<number | null>;
}

function getState(status?: CodeCellOptions["status"]): State | undefined {
	if (!status) return undefined;
	if (status === "complete") return "success";
	if (status === "error") return "error";
	if (status === "warning") return "warning";
	if (status === "running") return "running";
	return "pending";
}

function formatHeader(options: CodeCellOptions, theme: Theme): { title: string; meta?: string } {
	const { index, total, title, status, spinnerFrame, duration, language, showLanguage } = options;
	const parts: string[] = [];
	if (showLanguage && language) {
		const langIcon = theme.getLangIconStyled(language);
		if (langIcon) parts.push(langIcon);
	}
	if (status) {
		const icon = formatStatusIcon(
			status === "complete"
				? "done"
				: status === "error"
					? "error"
					: status === "warning"
						? "warning"
						: status === "running"
							? "running"
							: "pending",
			theme,
			spinnerFrame,
		);
		if (status === "pending" || status === "running") {
			parts.push(`${icon} ${theme.fg("muted", status)}`);
		} else {
			parts.push(icon);
		}
	}
	if (index !== undefined && total !== undefined && total > 1) {
		parts.push(theme.fg("accent", `[${index + 1}/${total}]`));
	}
	if (title) {
		parts.push(theme.fg("toolTitle", title));
	}
	const headerTitle = parts.length > 0 ? parts.join(" ") : theme.fg("toolTitle", t("Code"));

	const metaParts: string[] = [];
	if (duration !== undefined) {
		metaParts.push(theme.fg("dim", `(${formatDuration(duration)})`));
	}
	if (metaParts.length === 0) return { title: headerTitle };
	return { title: headerTitle, meta: metaParts.join(theme.fg("dim", theme.sep.dot)) };
}

function renderCellOutput(
	output: string | undefined,
	expanded: boolean,
	outputMaxLines: number,
	theme: Theme,
): readonly string[] {
	if (!output?.trim()) return [];
	return formatOutputPaneLines(
		{
			lines: splitTerminalOutputLines(output),
			expanded,
			collapsedMaxLines: outputMaxLines,
			edge: "head",
			styleLine: line => styleToolOutputLine(line, theme),
			formatHidden: hidden => formatMoreItems(hidden, "line"),
		},
		theme,
	).lines;
}

/** Render a syntax-highlighted code preview and its optional output block. */
export function renderCodeCell(options: CodeCellOptions, theme: Theme): string[] {
	const {
		code,
		language,
		output,
		expanded = false,
		outputMaxLines = 6,
		codeMaxLines = 12,
		width,
		codeStartLine,
		codeLineNumbers,
	} = options;
	const { title, meta } = formatHeader(options, theme);
	const state = getState(options.status);

	const normalizedCode = replaceTabs(code ?? "");
	const rawCodeLines = splitTerminalOutputLines(normalizedCode);
	const tail = options.codeTail === true && !expanded && rawCodeLines.length > 0;
	const visualHead =
		!expanded && !tail && options.codeMaxVisualRows !== undefined && Number.isFinite(options.codeMaxVisualRows);
	const maxVisualRows = Math.max(0, Math.floor(options.codeMaxVisualRows ?? 0));

	const hasLineNumbers = codeLineNumbers !== undefined || codeStartLine !== undefined;
	const lineNumberAt = (lineIndex: number): number | null =>
		codeLineNumbers !== undefined ? (codeLineNumbers[lineIndex] ?? null) : (codeStartLine ?? 0) + lineIndex;
	let maxCodeLines = expanded ? rawCodeLines.length : Math.min(rawCodeLines.length, codeMaxLines);
	let startIndex = tail ? rawCodeLines.length - maxCodeLines : 0;
	let endIndex = startIndex + maxCodeLines;
	const lineNumbersForRange = (from: number, to: number): Array<number | null> | undefined =>
		hasLineNumbers ? Array.from({ length: to - from }, (_, i) => lineNumberAt(from + i)) : undefined;
	let visibleLineNumbers = lineNumbersForRange(startIndex, endIndex);
	const resolveLineNumberWidth = (from: number, to: number): number => {
		let maxVal = 0;
		for (let i = from; i < to; i++) {
			const lineNum = lineNumberAt(i);
			if (lineNum !== null) maxVal = Math.max(maxVal, lineNum);
		}
		return maxVal > 0 ? Math.max(2, String(maxVal).length) : 0;
	};
	const lineNumberWidth = hasLineNumbers
		? resolveLineNumberWidth(visualHead ? 0 : startIndex, visualHead ? rawCodeLines.length : endIndex)
		: 0;

	const rawLineWithGutter = (lineIndex: number): string => {
		if (lineNumberWidth === 0) return rawCodeLines[lineIndex] ?? "";
		const lineNum = lineNumberAt(lineIndex);
		const gutter =
			lineNum !== null && lineNum !== undefined
				? String(lineNum).padStart(lineNumberWidth, " ")
				: " ".repeat(lineNumberWidth);
		return `${gutter} ${rawCodeLines[lineIndex] ?? ""}`;
	};
	const contentWidth = outputBlockContentWidth(width);
	const measureVisualRows = (from: number, to: number): number => {
		let rows = 0;
		for (let i = from; i < to; i++) {
			rows += wrapTextWithAnsi(rawLineWithGutter(i).trimEnd(), contentWidth).length;
		}
		return rows;
	};

	let hiddenCodeRows = rawCodeLines.length - maxCodeLines;
	if (visualHead) {
		startIndex = 0;
		endIndex = 0;
		let measuredRows = 0;
		while (endIndex < rawCodeLines.length && measuredRows < maxVisualRows) {
			measuredRows += measureVisualRows(endIndex, endIndex + 1);
			endIndex++;
		}
		maxCodeLines = endIndex;
		visibleLineNumbers = lineNumbersForRange(0, endIndex);
		hiddenCodeRows = measureVisualRows(endIndex, rawCodeLines.length);
	} else if (tail) {
		hiddenCodeRows = measureVisualRows(0, startIndex);
	}

	const visibleCode = rawCodeLines.slice(startIndex, endIndex).join("\n");
	const codeLines = endIndex > startIndex ? highlightCode(visibleCode, language) : [];

	if (lineNumberWidth > 0 && visibleLineNumbers) {
		for (let i = 0; i < codeLines.length; i++) {
			const lineNum = visibleLineNumbers[i];
			const gutter =
				lineNum !== null && lineNum !== undefined
					? String(lineNum).padStart(lineNumberWidth, " ")
					: " ".repeat(lineNumberWidth);
			codeLines[i] = theme.fg("dim", `${gutter} `) + codeLines[i];
		}
	}

	if (!tail && !visualHead && hiddenCodeRows > 0) {
		const hint = formatExpandHint(theme, expanded, hiddenCodeRows > 0);
		const gutterPad = lineNumberWidth > 0 ? " ".repeat(lineNumberWidth + 1) : "";
		const moreLine = `${formatMoreItems(hiddenCodeRows, "line")}${hint ? ` ${hint}` : ""}`;
		codeLines.push(theme.fg("dim", gutterPad + moreLine));
	}

	const outputLines = renderCellOutput(output, expanded, outputMaxLines, theme);

	const codeSection: OutputBlockSection = { lines: codeLines };
	const gutterPad = lineNumberWidth > 0 ? " ".repeat(lineNumberWidth + 1) : "";
	if (tail) {
		codeSection.visualWindow = createEarlierLinesTailWindow(theme, {
			// The tail window is measured in wrapped visual rows; keep the full preview
			// budget even when the code contains only one long logical line.
			max: codeMaxLines,
			hiddenRows: hiddenCodeRows,
			markerPrefix: gutterPad,
			markerKey: `code-cell:${lineNumberWidth}`,
		});
	} else if (visualHead) {
		codeSection.visualWindow = createMoreLinesHeadWindow(theme, {
			maxContentRows: maxVisualRows,
			hiddenRows: hiddenCodeRows,
			markerPrefix: gutterPad,
			markerKey: `code-cell:${lineNumberWidth}`,
		});
	}
	const sections: Array<{ label?: string; lines: readonly string[] }> = [codeSection];
	if (outputLines.length > 0) {
		sections.push({ label: theme.fg("toolTitle", t("Output")), lines: outputLines });
	}

	return renderOutputBlock({ header: title, headerMeta: meta, state, sections, width }, theme);
}

/** Content and display limits for a Markdown preview with optional output. */
export interface MarkdownCellOptions {
	content: string;
	index?: number;
	total?: number;
	title?: string;
	status?: "pending" | "running" | "warning" | "complete" | "error";
	spinnerFrame?: number;
	duration?: number;
	output?: string;
	outputMaxLines?: number;
	contentMaxLines?: number;
	expanded?: boolean;
	width: number;
}

/** Render a Markdown preview and its optional output block. */
export function renderMarkdownCell(options: MarkdownCellOptions, theme: Theme): string[] {
	const { content, output, expanded = false, outputMaxLines = 6, contentMaxLines = 12, width } = options;
	const codeOptions: CodeCellOptions = {
		code: "",
		index: options.index,
		total: options.total,
		title: options.title,
		status: options.status,
		spinnerFrame: options.spinnerFrame,
		duration: options.duration,
		width,
	};
	const { title, meta } = formatHeader(codeOptions, theme);
	const state = getState(options.status);

	// Markdown component manages its own wrapping at the same inner width as
	// `renderOutputBlock`, so collapsed row caps are applied after final wrapping.
	const innerWidth = Math.max(20, outputBlockContentWidth(width));
	const allLines = content.trim() ? new Markdown(content, 0, 0, getMarkdownTheme()).render(innerWidth) : [];
	const maxContentLines = expanded ? allLines.length : Math.min(allLines.length, contentMaxLines);
	const contentLines = allLines.slice(0, maxContentLines);
	const hiddenContentLines = allLines.length - maxContentLines;
	if (hiddenContentLines > 0) {
		const hint = formatExpandHint(theme, expanded, hiddenContentLines > 0);
		const moreLine = `${formatMoreItems(hiddenContentLines, "line")}${hint ? ` ${hint}` : ""}`;
		contentLines.push(theme.fg("dim", moreLine));
	}

	const outputLines = renderCellOutput(output, expanded, outputMaxLines, theme);

	const sections: Array<{ label?: string; lines: readonly string[] }> = [{ lines: contentLines }];
	if (outputLines.length > 0) {
		sections.push({ label: theme.fg("toolTitle", t("Output")), lines: outputLines });
	}

	return renderOutputBlock({ header: title, headerMeta: meta, state, sections, width }, theme);
}
