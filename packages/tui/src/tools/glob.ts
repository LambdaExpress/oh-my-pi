import type { Component } from "../tui";
import { t } from "../i18n";
import { Text } from "../components/text";
import type { RenderResultOptions, ToolRenderer } from "./renderer";
import { type Theme } from "../theme/theme";
import type { OutputMeta } from "./output-meta";
import type { TruncationResult } from "./streaming-output";
import { toPathList } from "../render/render-utils";
import * as path from "node:path";
import { Ellipsis, fileHyperlink, renderFileList, renderStatusLine, renderTreeList, truncateToWidth } from "../render";
import {
	createCachedComponent,
	formatCountLabel,
	formatEmptyMessage,
	formatErrorMessage,
	PREVIEW_LIMITS,
} from "../render/render-utils";
import { formatFullOutputReference } from "./output-meta";

/** Display metadata for glob tool results. */
export interface GlobToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
	meta?: OutputMeta;
	// Fields for TUI rendering
	scopePath?: string;
	fileCount?: number;
	files?: string[];
	truncated?: boolean;
	error?: string;
	/** Working directory at search time. Used by the renderer to resolve relative
	 * file paths to absolute paths for OSC 8 hyperlinks. */
	cwd?: string;
	/** User-supplied paths whose base directory was missing on disk. The tool
	 * skipped these and continued with the surviving entries; surfaced as a
	 * non-fatal warning in the renderer and in the model-facing text. */
	missingPaths?: string[];
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface GlobRenderArgs {
	path?: string | string[];
	/** Legacy pre-`path` argument name; kept so historical transcripts still render a scope. */
	paths?: string | string[];
	limit?: number;
}

function formatGlobRenderPaths(args: GlobRenderArgs | undefined): string | undefined {
	const list = toPathList(args?.path ?? args?.paths);
	return list.length > 0 ? list.join(", ") : undefined;
}

function globStatusIcon(uiTheme: Theme): string {
	return uiTheme.fg("toolTitle", uiTheme.symbol("icon.search"));
}

/** Render glob calls and results in the transcript. */
export const globToolRenderer = {
	inline: true,
	renderCall(args: GlobRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.limit !== undefined) meta.push(`limit:${args.limit}`);

		const text = renderStatusLine(
			{
				icon: "pending",
				title: t("Glob"),
				titleColor: "toolTitle",
				description: formatGlobRenderPaths(args) || "*",
				meta,
			},
			uiTheme,
		);
		return new Text(text, 1, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GlobToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: GlobRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError || details?.error) {
			const errorText = details?.error || result.content?.find(c => c.type === "text")?.text || t("Unknown error");
			return new Text(formatErrorMessage(errorText, uiTheme), 1, 0);
		}

		const hasDetailedData = details?.fileCount !== undefined;
		const textContent = result.content?.find(c => c.type === "text")?.text;

		if (!hasDetailedData) {
			if (
				!textContent ||
				textContent.includes("No files matching") ||
				textContent.includes("No files found") ||
				textContent.trim() === ""
			) {
				return new Text(formatEmptyMessage(t("No files found"), uiTheme), 1, 0);
			}

			const lines = textContent.split("\n").filter(l => l.trim());
			const header = renderStatusLine(
				{
					iconOverride: globStatusIcon(uiTheme),
					title: t("Glob"),
					titleColor: "toolTitle",
					description: formatGlobRenderPaths(args),
					meta: [formatCountLabel("file", lines.length)],
				},
				uiTheme,
			);
			return createCachedComponent(
				() => options.expanded,
				width => {
					const listLines = renderTreeList(
						{
							items: lines,
							expanded: options.expanded,
							maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
							itemType: "file",
							renderItem: line => uiTheme.fg("accent", line),
						},
						uiTheme,
					);
					return [header, ...listLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
				},
				{ paddingX: 1 },
			);
		}

		const fileCount = details?.fileCount ?? 0;
		const truncation = details?.truncation ?? details?.meta?.truncation;
		const limits = details?.meta?.limits;
		const truncated = Boolean(details?.truncated || truncation || details?.resultLimitReached || limits?.resultLimit);
		const files = details?.files ?? [];

		const missingPaths = details?.missingPaths ?? [];
		const missingNote =
			missingPaths.length > 0
				? uiTheme.fg("warning", t("skipped missing: {paths}", { paths: missingPaths.join(", ") }))
				: undefined;

		if (fileCount === 0) {
			// `truncated` on an empty result means the scan timed out mid-walk —
			// render "incomplete", not a definitive "No files found".
			const emptyLabel = truncated ? t("No matches before timeout (scan incomplete)") : t("No files found");
			const header = renderStatusLine(
				{
					icon: "warning",
					title: t("Glob"),
					titleColor: "toolTitle",
					description: formatGlobRenderPaths(args),
					meta: truncated
						? [formatCountLabel("file", 0), uiTheme.fg("warning", t("timed out"))]
						: [formatCountLabel("file", 0)],
				},
				uiTheme,
			);
			const lines = [header, formatEmptyMessage(emptyLabel, uiTheme)];
			if (missingNote) lines.push(missingNote);
			return new Text(lines.join("\n"), 1, 0);
		}
		const meta: string[] = [formatCountLabel("file", fileCount)];
		if (details?.scopePath) meta.push(t("in {path}", { path: details.scopePath }));
		if (truncated) meta.push(uiTheme.fg("warning", t("truncated")));
		const header = renderStatusLine(
			{
				...(truncated ? { icon: "warning" as const } : { iconOverride: globStatusIcon(uiTheme) }),
				title: t("Glob"),
				titleColor: "toolTitle",
				description: formatGlobRenderPaths(args),
				meta,
			},
			uiTheme,
		);

		const truncationReasons: string[] = [];
		if (details?.resultLimitReached)
			truncationReasons.push(t("limit {count} results", { count: details.resultLimitReached }));
		if (limits?.resultLimit)
			truncationReasons.push(t("limit {count} results", { count: limits.resultLimit.reached }));
		if (truncation) truncationReasons.push(truncation.truncatedBy === "lines" ? t("line limit") : t("size limit"));
		const artifactId = truncation && "artifactId" in truncation ? truncation.artifactId : undefined;
		if (artifactId) truncationReasons.push(formatFullOutputReference(artifactId));

		const extraLines: string[] = [];
		if (truncationReasons.length > 0) {
			extraLines.push(uiTheme.fg("warning", t("truncated: {reasons}", { reasons: truncationReasons.join(", ") })));
		}
		if (missingNote) extraLines.push(missingNote);

		return createCachedComponent(
			() => options.expanded,
			width => {
				const cwd = details?.cwd;
				const fileLines = renderFileList(
					{
						files: files.map(entry => ({
							path: entry,
							isDirectory: entry.endsWith("/"),
							absPath: cwd && !entry.endsWith("/") ? path.resolve(cwd, entry) : undefined,
						})),
						expanded: options.expanded,
						maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
						hyperlinkFn: fileHyperlink,
					},
					uiTheme,
				);
				return [header, ...fileLines, ...extraLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
			},
			{ paddingX: 1 },
		);
	},
	mergeCallAndResult: true,
} satisfies ToolRenderer<GlobRenderArgs, GlobToolDetails>;
