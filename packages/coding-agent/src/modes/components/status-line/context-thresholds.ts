import { formatNumber } from "@oh-my-pi/pi-utils";

export type ContextUsageLevel = "normal" | "warning" | "high" | "error";

const CONTEXT_WARNING_PERCENT_THRESHOLD = 50;
const CONTEXT_WARNING_TOKEN_THRESHOLD = 150_000;
const CONTEXT_HIGH_PERCENT_THRESHOLD = 70;
const CONTEXT_HIGH_TOKEN_THRESHOLD = 270_000;
const CONTEXT_ERROR_PERCENT_THRESHOLD = 90;
const CONTEXT_ERROR_TOKEN_THRESHOLD = 500_000;

/**
 * Fixed escalation palette for the context gauge: green → yellow → orange →
 * red. Deliberately independent of the active theme — the middle tier used to
 * ride the theme's `thinkingHigh` slot, which most themes share with
 * `statusLineContext`, collapsing "normal" and the middle tier into the same
 * color (e.g. dark-github). Fixed values keep every tier distinguishable under
 * any theme; dark/light variants preserve contrast on both kinds of status-line
 * backgrounds.
 */
const CONTEXT_NORMAL_COLOR = "#3fb950";
const CONTEXT_WARNING_COLOR = "#d29922";
const CONTEXT_HIGH_COLOR = "#ffa657";
const CONTEXT_ERROR_COLOR = "#f85149";
const CONTEXT_NORMAL_COLOR_LIGHT = "#1a7f37";
const CONTEXT_WARNING_COLOR_LIGHT = "#9a6700";
const CONTEXT_HIGH_COLOR_LIGHT = "#bc4c00";
const CONTEXT_ERROR_COLOR_LIGHT = "#cf222e";

function reachesThreshold(
	contextPercent: number,
	contextWindow: number,
	percentThreshold: number,
	tokenThreshold: number,
): boolean {
	if (!Number.isFinite(contextPercent) || contextPercent <= 0) {
		return false;
	}

	if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
		return contextPercent >= percentThreshold;
	}

	const tokenPercentThreshold = (tokenThreshold / contextWindow) * 100;
	return contextPercent >= Math.min(percentThreshold, tokenPercentThreshold);
}

export function getContextUsageLevel(contextPercent: number, contextWindow: number): ContextUsageLevel {
	if (
		reachesThreshold(contextPercent, contextWindow, CONTEXT_ERROR_PERCENT_THRESHOLD, CONTEXT_ERROR_TOKEN_THRESHOLD)
	) {
		return "error";
	}

	if (reachesThreshold(contextPercent, contextWindow, CONTEXT_HIGH_PERCENT_THRESHOLD, CONTEXT_HIGH_TOKEN_THRESHOLD)) {
		return "high";
	}

	if (
		reachesThreshold(
			contextPercent,
			contextWindow,
			CONTEXT_WARNING_PERCENT_THRESHOLD,
			CONTEXT_WARNING_TOKEN_THRESHOLD,
		)
	) {
		return "warning";
	}

	return "normal";
}

/**
 * Format context usage as `<percent>%/<window>` when the model window is known.
 * Unknown windows render as `<tokens>/?`, because `0.0%/0` suggests a real
 * empty context instead of missing provider metadata.
 */
export function formatContextUsage(
	contextPercent: number | null | undefined,
	contextWindow: number,
	usedTokens?: number,
): string {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
		return `${formatNumber(usedTokens ?? 0)}/?`;
	}
	const pct = contextPercent === null || contextPercent === undefined ? "?" : `${contextPercent.toFixed(1)}%`;
	return `${pct}/${formatNumber(contextWindow)}`;
}

/**
 * Resolve the context gauge color for a usage level. Returns a raw hex string
 * from the fixed escalation palette — theme-independent by design, with
 * dark/light variants keyed off the theme's status-line background. Callers
 * render it via `Theme.fgHex`.
 */
export function getContextUsageThemeColor(level: ContextUsageLevel, isLight: boolean): string {
	switch (level) {
		case "error":
			return isLight ? CONTEXT_ERROR_COLOR_LIGHT : CONTEXT_ERROR_COLOR;
		case "high":
			return isLight ? CONTEXT_HIGH_COLOR_LIGHT : CONTEXT_HIGH_COLOR;
		case "warning":
			return isLight ? CONTEXT_WARNING_COLOR_LIGHT : CONTEXT_WARNING_COLOR;
		case "normal":
			return isLight ? CONTEXT_NORMAL_COLOR_LIGHT : CONTEXT_NORMAL_COLOR;
	}
}
