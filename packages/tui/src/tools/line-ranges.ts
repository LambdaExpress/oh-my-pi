import { ToolError } from "./tool-errors";

/**
 * Inclusive line range describing one selector segment (e.g. `50-100`,
 * `301-`, or `50+10`). `endLine` is `undefined` for open-ended ranges.
 */
export interface LineRange {
	startLine: number;
	endLine: number | undefined;
}

/** Shared line-range grammar for selector recognition and parsing. */
export const LINE_RANGE_CHUNK_SOURCE = String.raw`L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?`;
const LINE_RANGE_CHUNK_RE = new RegExp(`^${LINE_RANGE_CHUNK_SOURCE}$`, "i");
const TAIL_RANGE_CHUNK_RE = /^-(\d+)$/;
// Path splitting only peels complete selectors; parsing can explain incomplete counts.
const LINE_SELECTION_CHUNK_SOURCE = String.raw`(?:${LINE_RANGE_CHUNK_SOURCE}(?<=[\d.-])|-\d+)`;
/** Composable positive/open/count/tail grammar for trailing read selectors. */
export const LINE_RANGE_SELECTION_SOURCE = `${LINE_SELECTION_CHUNK_SOURCE}(?:,${LINE_SELECTION_CHUNK_SOURCE})*`;

/** Parse a single `N`, `N-M`, `N-`, `N+K`, or `..`-aliased (`N..M`, `N..`) chunk. Throws via {@link ToolError} on invalid bounds. */
export function parseLineRangeChunk(sel: string): LineRange | null {
	return parseChunk(sel, false);
}

/** `pinBare` makes a separator-less `N` the single line `N` instead of "from `N` onward". */
function parseChunk(sel: string, pinBare: boolean): LineRange | null {
	const lineMatch = LINE_RANGE_CHUNK_RE.exec(sel);
	if (!lineMatch) return null;
	const rawStart = Number.parseInt(lineMatch[1]!, 10);
	if (rawStart < 1) {
		throw new ToolError("Line selector 0 is invalid; lines are 1-indexed. Use :1.");
	}
	// `..` is a forgiving alias for `-` (e.g. `2724..2727` == `2724-2727`).
	const sep = lineMatch[2] === ".." ? "-" : lineMatch[2];
	const rhs = lineMatch[3] ? Number.parseInt(lineMatch[3], 10) : undefined;
	let rawEnd: number | undefined;
	if (sep === "+") {
		if (rhs === undefined || rhs < 1) {
			throw new ToolError(`Invalid range ${rawStart}+${rhs ?? 0}: count must be >= 1.`);
		}
		rawEnd = rawStart + rhs - 1;
	} else if (sep === "-") {
		// `301-` is shorthand for "from 301 onward" — equivalent to a lone bare `301`.
		if (rhs !== undefined) {
			if (rhs < rawStart) {
				throw new ToolError(`Invalid range ${rawStart}-${rhs}: end must be >= start.`);
			}
			rawEnd = rhs;
		}
	} else if (pinBare) {
		rawEnd = rawStart;
	}
	return { startLine: rawStart, endLine: rawEnd };
}

/**
 * Parse a selection without guessing the source's line count. Absolute ranges
 * are merged; tails retain their largest count because all tails end at EOF.
 */
export function parseLineRangeSelection(sel: string): { ranges: LineRange[]; tailCount?: number } | null {
	const chunks = sel.split(",");
	// A lone `:50` means "from line 50". Inside a comma list, a bare number is
	// that one line; otherwise `:19,59` collapses to "from 19 through EOF".
	const pinBare = chunks.length > 1;
	const parsed: LineRange[] = [];
	let tailCount: number | undefined;
	for (const chunk of chunks) {
		const tail = TAIL_RANGE_CHUNK_RE.exec(chunk);
		if (tail) {
			const count = Number.parseInt(tail[1]!, 10);
			if (count < 1) {
				throw new ToolError("Tail selector -0 is invalid; use :-N with N >= 1 to read the last N lines.");
			}
			tailCount = Math.max(tailCount ?? 0, count);
			continue;
		}
		const range = parseChunk(chunk, pinBare);
		if (!range) return null;
		parsed.push(range);
	}
	const ranges = parsed.length > 0 ? mergeLineRanges(parsed as [LineRange, ...LineRange[]]) : [];
	return tailCount === undefined ? { ranges } : { ranges, tailCount };
}

/**
 * Parse absolute ranges only. Callers without a source line count must not
 * silently interpret a tail as an absolute match filter.
 */
export function parseLineRanges(sel: string): [LineRange, ...LineRange[]] | null {
	const selection = parseLineRangeSelection(sel);
	if (!selection || selection.tailCount !== undefined || selection.ranges.length === 0) return null;
	return selection.ranges as [LineRange, ...LineRange[]];
}

/** Sort and merge absolute ranges without mutating a parsed selector or its ranges. */
export function mergeLineRanges(ranges: readonly [LineRange, ...LineRange[]]): [LineRange, ...LineRange[]] {
	const ordered = [...ranges].sort((a, b) => a.startLine - b.startLine);
	const merged: LineRange[] = [ordered[0]!];
	for (let i = 1; i < ordered.length; i++) {
		const current = ordered[i]!;
		const last = merged[merged.length - 1];
		// Open-ended (endLine undefined) means "to EOF" — any later range is absorbed.
		if (last.endLine === undefined) continue;
		// Merge when current starts within (or immediately after) the last range.
		if (current.startLine <= last.endLine + 1) {
			if (current.endLine === undefined || current.endLine > last.endLine) {
				merged[merged.length - 1] = { startLine: last.startLine, endLine: current.endLine };
			}
			continue;
		}
		merged.push(current);
	}
	return merged as [LineRange, ...LineRange[]];
}

/**
 * Extract the line-range component from a read-tool selector that may also
 * carry a verbatim/index display mode (`raw`, `conflicts`) — alone or compounded
 * with a range (`raw:50-100`, `50-100:raw`). Returns the parsed ranges when the
 * selector names any, otherwise `undefined` (pure `raw`/`conflicts`/none).
 *
 * Used by content search, which honors line ranges as a match filter but has no
 * use for verbatim/conflict display modes — so those selectors are accepted and
 * treated as an unfiltered, whole-resource search rather than rejected.
 */
export function selectorLineRanges(sel: string | undefined): [LineRange, ...LineRange[]] | undefined {
	if (!sel) return undefined;
	for (const chunk of sel.split(":")) {
		const lower = chunk.toLowerCase();
		if (lower === "raw" || lower === "conflicts") continue;
		const ranges = parseLineRanges(chunk);
		if (ranges) return ranges;
	}
	return undefined;
}
