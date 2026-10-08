import { isReadableUrlPath } from "./read";
import { parseLineRangeSelection } from "./line-ranges";
import { t } from "../i18n";
import type { Component } from "../tui";
import { Text } from "../components/text";
import type { NativeToolHead, NativeToolView, RenderResultOptions } from "./renderer";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { compact, span, text } from "../native/describe";
import { plainText } from "../native/spans";
import { errorText, noteText, resultText, statsText } from "./native-view";
import { type Theme, theme } from "../theme/theme";
import type { OutputMeta } from "./output-meta";
import { truncate } from "@oh-my-pi/pi-utils";
import { renderStatusLine, urlHyperlink, urlLinkSpan } from "../render";
import type { OutputBlockVisualWindow } from "../render/output-block";
import { framedToolCard } from "../render/tool-card";
import {
	createMoreLinesHeadWindow,
	formatMoreItems,
	getDomain,
	PREVIEW_LIMITS,
	sanitizeDisplayLines,
	sanitizeDisplayWarning,
} from "../render/render-utils";
import { formatFullOutputReference, formatStyledArtifactReference } from "./output-meta";

/** Display metadata for fetch tool results. */
export interface ReadUrlToolDetails {
	kind: "url";
	url: string;
	finalUrl: string;
	contentType: string;
	method: string;
	truncated: boolean;
	notes: string[];
	meta?: OutputMeta;
}

// =============================================================================
// TUI Rendering
// =============================================================================

/** Restore the double slash in a collapsed HTTP URL scheme. */
export function repairCollapsedScheme(value: string): string {
	const m = value.match(/^(https?):\/(?!\/)/i);
	return m ? `${m[1]}://${value.slice(m[0].length)}` : value;
}

/** Recognize a valid raw, tail, or line-range URL selector token. */
function isUrlSelectorToken(token: string): boolean {
	if (token.toLowerCase() === "raw") return true;
	try {
		return parseLineRangeSelection(token) !== null;
	} catch {
		return false;
	}
}

/**
 * Peel one or more selector tokens off the right of a URL string. Walks back through
 * trailing `:tok` segments while each token (a) looks like a selector and (b) leaves
 * behind a string that still parses as a URL. Returns selectors left-to-right so callers
 * can apply them in source order.
 */
export function tryExtractEmbeddedUrlSelector(readPath: string): { path: string; sels: string[] } | null {
	let basePath = readPath;
	const sels: string[] = [];
	while (true) {
		const lastColonIndex = basePath.lastIndexOf(":");
		if (lastColonIndex <= 0) break;

		const candidate = basePath.slice(lastColonIndex + 1);
		const remainder = basePath.slice(0, lastColonIndex);
		if (!isReadableUrlPath(remainder)) break;
		if (!isUrlSelectorToken(candidate)) break;

		try {
			new URL(
				remainder.startsWith("http://") || remainder.startsWith("https://") ? remainder : `https://${remainder}`,
			);
		} catch {
			break;
		}

		sels.unshift(candidate);
		basePath = remainder;
	}
	if (sels.length === 0) return null;
	return { path: basePath, sels };
}

/** Count non-empty lines */
function countNonEmptyLines(text: string): number {
	return text.split("\n").filter(l => l.trim()).length;
}

function readUrlLinkTarget(input: string): string {
	try {
		const repaired = repairCollapsedScheme(input);
		const embedded = tryExtractEmbeddedUrlSelector(repaired);
		if (embedded && embedded.sels.filter(token => token.toLowerCase() !== "raw").length > 1) return input;
		return embedded?.path ?? repaired;
	} catch {
		return input;
	}
}

function formatReadUrlDescription(input: string): string {
	const target = readUrlLinkTarget(input);
	const displayUrl = target.match(/^www\./i) ? `https://${target}` : target;
	const domain = getDomain(displayUrl);
	const urlPath = truncate(displayUrl.replace(/^https?:\/\/[^/]+/, ""), 50, "…");
	const label = sanitizeDisplayWarning(`${domain}${urlPath ? ` ${urlPath}` : ""}`);
	return urlHyperlink(target, label);
}

/** Link span for a URL read target: `domain /path`, linked to the resolved target. */
function readUrlLinkSpan(input: string): TspSpan {
	const target = readUrlLinkTarget(input);
	const displayUrl = target.match(/^www\./i) ? `https://${target}` : target;
	const urlPath = displayUrl.replace(/^https?:\/\/[^/]+/, "");
	const label = `${getDomain(displayUrl)}${urlPath ? ` ${urlPath}` : ""}`.trim() || target;
	return urlLinkSpan(target, sanitizeDisplayWarning(label));
}

function formatReadUrlMetadataValue(url: string, uiTheme: Theme): string {
	return urlHyperlink(url, uiTheme.fg("mdLinkUrl", sanitizeDisplayWarning(url)));
}

/** Render URL read call (URL preview) */
export function renderReadUrlCall(
	args: { path?: string; url?: string; raw?: boolean },
	_options: RenderResultOptions,
	uiTheme: Theme = theme,
): Component {
	const url = args.path ?? args.url ?? "";
	const description = formatReadUrlDescription(url);
	const meta: string[] = [];
	if (args.raw) meta.push("raw");
	const text = renderStatusLine({ icon: "pending", title: t("Read"), description, meta }, uiTheme);
	return new Text(text, 0, 0);
}

/** Native head of a URL read: `Read` plus the linked, one-line URL. */
function readUrlHead(input: string, meta: readonly string[] = []): NativeToolHead {
	const link = input ? readUrlLinkSpan(input) : undefined;
	return {
		title: t("Read"),
		target: link?.t || undefined,
		targetKind: "text",
		href: link?.href,
		meta: meta.length > 0 ? meta : undefined,
	};
}

/** TSP call view of a URL read: the head only, inline while pending. */
export function describeReadUrlCall(args: { path?: string; url?: string; raw?: boolean }): NativeToolView {
	return { tool: readUrlHead(args.path ?? args.url ?? "", args.raw ? ["raw"] : []), inline: true };
}

/** TSP result view of a URL read: a bounded content preview over one quiet stats line. */
export function describeReadUrlResult(result: {
	content: Array<{ type: string; text?: string }>;
	details?: ReadUrlToolDetails;
	isError?: boolean;
}): NativeToolView {
	const details = result.details;
	if (result.isError || !details) {
		const urlText = details?.finalUrl ?? details?.url ?? "";
		const message = sanitizeDisplayLines(resultText(result) || t("No response data"))
			.join("\n")
			.replace(/^Error:\s*/, "");
		return {
			tool: readUrlHead(urlText),
			tone: "error",
			body: [errorText(message.trim() || t("Read failed"))],
		};
	}

	const truncation = details.meta?.truncation;
	const truncated = Boolean(details.truncated || truncation);
	const contentText = result.content[0]?.text ?? "";
	const contentBody = contentText.includes("---\n\n")
		? contentText.split("---\n\n").slice(1).join("---\n\n")
		: contentText;
	const contentLines = sanitizeDisplayLines(contentBody).filter(l => l.trim());
	const shown = contentLines.slice(0, PREVIEW_LIMITS.EXPANDED_LINES);
	const hidden = contentLines.length - shown.length;
	const redirected = details.url !== details.finalUrl;

	const stats = statsText(
		[
			sanitizeDisplayWarning(details.contentType || t("unknown")),
			details.method ? sanitizeDisplayWarning(details.method) : "",
			t("{count} line{s}", { count: contentLines.length, s: contentLines.length === 1 ? "" : "s" }),
			t("{count} chars", { count: contentBody.trim().length }),
			hidden > 0 ? formatMoreItems(hidden, "line") : "",
			...details.notes.map(note => sanitizeDisplayWarning(note)),
		].filter(Boolean),
	);
	return {
		tool: readUrlHead(
			details.finalUrl,
			redirected ? [t("from {path}", { path: sanitizeDisplayWarning(getDomain(details.url)) })] : [],
		),
		tone: truncated ? "warning" : undefined,
		body: compact([
			shown.length > 0
				? text([span(plainText(shown.map(line => line.trimEnd()).join("\n")), "dim")], { wrap: "word" })
				: noteText(t("(no content)")),
			stats,
			truncated
				? text(
						[
							span(
								truncation?.artifactId
									? `${t("Output truncated")} · ${formatFullOutputReference(truncation.artifactId)}`
									: t("Output truncated"),
								"warning",
							),
						],
						{ wrap: "word", role: "omp.tool.notice" },
					)
				: undefined,
		]),
	};
}

/** Render URL read result with tree-based layout */
export function renderReadUrlResult(
	result: { content: Array<{ type: string; text?: string }>; details?: ReadUrlToolDetails; isError?: boolean },
	options: RenderResultOptions,
	uiTheme: Theme = theme,
): Component {
	const details = result.details;

	if (result.isError || !details) {
		const rawErrorText = result.content?.find(c => c.type === "text")?.text ?? "";
		const errorText = (rawErrorText || t("No response data")).replace(/^Error:\s*/, "");
		const urlText = details?.finalUrl ?? details?.url ?? "";
		const description = urlText ? formatReadUrlDescription(urlText) : undefined;
		const header = renderStatusLine({ icon: "error", title: t("Read"), description }, uiTheme);
		const errorLines = sanitizeDisplayLines(errorText).map(line => uiTheme.fg("error", line));
		return framedToolCard(uiTheme, () => ({
			header,
			phase: "error",
			sections: [{ content: errorLines }],
		}));
	}

	const description = formatReadUrlDescription(details.finalUrl);
	const hasRedirect = details.url !== details.finalUrl;
	const hasNotes = details.notes.length > 0;
	const truncation = details.meta?.truncation;
	const truncated = Boolean(details.truncated || truncation);

	const header = renderStatusLine(
		{
			icon: truncated ? "warning" : "success",
			title: t("Read"),
			description,
		},
		uiTheme,
	);

	const contentText = result.content[0]?.text ?? "";
	const contentBody = contentText.includes("---\n\n")
		? contentText.split("---\n\n").slice(1).join("---\n\n")
		: contentText;
	const lineCount = countNonEmptyLines(contentBody);
	const charCount = contentBody.trim().length;
	const contentLines = contentBody.split("\n").filter(l => l.trim());

	const metadataLines: string[] = [
		`${uiTheme.fg("muted", t("Content-Type:"))} ${sanitizeDisplayWarning(details.contentType || t("unknown"))}`,
		`${uiTheme.fg("muted", t("Method:"))} ${sanitizeDisplayWarning(details.method)}`,
	];
	if (hasRedirect) {
		metadataLines.push(
			`${uiTheme.fg("muted", t("Final URL:"))} ${formatReadUrlMetadataValue(details.finalUrl, uiTheme)}`,
		);
	}
	const lineLabel = t("{count} line{s}", { count: lineCount, s: lineCount === 1 ? "" : "s" });
	metadataLines.push(`${uiTheme.fg("muted", t("Lines:"))} ${lineLabel}`);
	metadataLines.push(`${uiTheme.fg("muted", t("Chars:"))} ${charCount}`);
	if (truncated) {
		metadataLines.push(uiTheme.fg("warning", `${uiTheme.status.warning} ${t("Output truncated")}`));
		if (truncation?.artifactId) metadataLines.push(formatStyledArtifactReference(truncation.artifactId, uiTheme));
	}
	if (hasNotes) {
		metadataLines.push(
			`${uiTheme.fg("muted", t("Notes:"))} ${details.notes.map(note => sanitizeDisplayWarning(note)).join("; ")}`,
		);
	}

	let lastExpanded: boolean | undefined;
	let contentPreviewLines: string[] | undefined;
	let contentPreviewWindow: OutputBlockVisualWindow | undefined;
	return framedToolCard(
		uiTheme,
		() => {
			const { expanded } = options;

			if (contentPreviewLines === undefined || lastExpanded !== expanded) {
				// The preview budget counts *rendered* rows, not logical lines: one
				// long URL must still fold to the configured height instead of
				// wrapping into dozens of rows. The output frame re-wraps at the live
				// width, so the window is reevaluated after every resize.
				contentPreviewWindow = createMoreLinesHeadWindow(uiTheme, {
					maxContentRows: expanded ? 12 : 3,
					expandHint: !expanded,
					markerKey: "read-url-content-preview",
				});
				contentPreviewLines =
					contentLines.length > 0
						? contentLines
								.flatMap(line => sanitizeDisplayLines(line))
								.map(line => line.trimEnd())
								.map(line => uiTheme.fg("dim", line))
						: [uiTheme.fg("dim", t("(no content)"))];
				lastExpanded = expanded;
			}

			return {
				header,
				phase: truncated ? "warning" : "success",
				sections: [
					{ label: uiTheme.fg("toolTitle", t("Metadata")), content: metadataLines },
					{
						label: uiTheme.fg("toolTitle", t("Content Preview")),
						content: contentPreviewLines,
						visualWindow: contentPreviewWindow,
					},
				],
				applyBg: false,
			};
		},
		{
			onInvalidate: () => {
				lastExpanded = undefined;
				contentPreviewLines = undefined;
				contentPreviewWindow = undefined;
			},
		},
	);
}
