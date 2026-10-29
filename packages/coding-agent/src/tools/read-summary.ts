import * as path from "node:path";
import { type SummaryResult, summarizeCodeAsync } from "@oh-my-pi/pi-natives";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { isMarkdownPath } from "@oh-my-pi/pi-tui/theme";
import type { ClientBridge } from "../session/client-bridge";
import type { ToolSession } from "../sdk";
import { type FileDisplayMode, resolveFileDisplayMode } from "../utils/file-display-mode";
import { ensureGrammar } from "../utils/grammars";
import { countTextLines } from "./read-format";
import { formatReadSummary } from "@oh-my-pi/pi-tui/tools/read";
import { throwIfAborted } from "./tool-errors";

import {
	cfgReadSummarizeMinBodyLines,
	cfgReadSummarizeMinCommentLines,
	cfgReadSummarizeMinTotalLines,
	cfgReadSummarizeUnfoldLimit,
	cfgReadSummarizeUnfoldUntil,
} from "./settings";

// Per-session memo for tree-sitter summaries. `summarizeCodeAsync` is a pure function
// of (code, path, fold settings) but costs ~12-18ms for a ~1500-line file, and a
// repeat summary read of the same unchanged file re-parses from scratch. Key on
// the content hash of the freshly-read bytes (+ path + fold settings): the file
// is still read fresh on every call, so a hit only reuses the deterministic
// parse — there is no staleness window and no stat guard is needed. Bounded LRU,
// aged out with the session via WeakMap.
// Unusable results omit the native segments: the full SummaryResult embeds
// the whole source in kept segments. C# declaration-only results remain
// usable even without omissions, so bare reads retain all declarations.
const SUMMARY_CACHE_MAX = 48;
export interface ReadSummaryAttempt {
	summary: SummaryResult | null;
	/** Complete, display-ready explanation when a C# declaration view is unavailable. */
	unavailable?: string;
}
const NO_SUMMARY: ReadSummaryAttempt = { summary: null };
const summaryParseCaches = new WeakMap<object, LRUCache<string, ReadSummaryAttempt>>();
function getSummaryParseCache(session: object): LRUCache<string, ReadSummaryAttempt> {
	let cache = summaryParseCaches.get(session);
	if (!cache) {
		cache = new LRUCache<string, ReadSummaryAttempt>({ max: SUMMARY_CACHE_MAX });
		summaryParseCaches.set(session, cache);
	}
	return cache;
}
const MAX_SUMMARY_BYTES = 2 * 1024 * 1024;
const MAX_SUMMARY_LINES = 20_000;
/**
 * Prose files (Markdown flavors and plain text) skip code-block summarization
 * unless `read.summarize.prose` opts them in.
 */
export function isProseSummaryPath(filePath: string): boolean {
	return isMarkdownPath(filePath) || path.extname(filePath).toLowerCase() === ".txt";
}
export function getReadTextFileBridge(session: ToolSession): ClientBridge | undefined {
	const bridge = session.getClientBridge?.();
	return bridge?.capabilities.readTextFile && bridge.readTextFile ? bridge : undefined;
}

export function routeReadThroughBridge(
	session: ToolSession,
	absolutePath: string,
	options?: { line?: number; limit?: number },
): Promise<string> | undefined {
	const bridge = getReadTextFileBridge(session);
	return bridge ? bridge.readTextFile!({ path: absolutePath, ...options }) : undefined;
}
/**
 * Structural summary attempt for `absolutePath`. Unavailable C# declaration
 * views explain why the caller must return a source excerpt instead.
 * `diskText` lets a caller that already read the file
 * hand those bytes over instead of forcing a second read; an ACP bridge still
 * wins, since the editor's buffer is the source of truth. `languagePath`
 * overrides only parser-language inference (speculative reads pass the
 * requested lexical path while reading the resolved target); bytes and cache
 * identity stay on `absolutePath`.
 */
export async function trySummarize(
	session: ToolSession,
	absolutePath: string,
	fileSize: number,
	signal?: AbortSignal,
	diskText?: string,
	languagePath?: string,
): Promise<ReadSummaryAttempt> {
	const summaryPath = languagePath ?? absolutePath;
	const csharp = path.extname(summaryPath).toLowerCase() === ".cs";
	const unavailable = (reason: string): ReadSummaryAttempt =>
		csharp
			? {
					summary: null,
					unavailable: `C# declarations-only summary unavailable: ${reason.replace(/\.+$/, "")}. Showing a source excerpt instead; executable bodies may be included and declarations may be omitted. Use explicit :start-end or :raw for source text.`,
				}
			: NO_SUMMARY;
	if (fileSize > MAX_SUMMARY_BYTES) return unavailable("the source exceeds the 2 MiB parser limit");

	try {
		throwIfAborted(signal);
		const bridgePromise = routeReadThroughBridge(session, absolutePath);
		const readDisk = async () => diskText ?? (await Bun.file(absolutePath).text());
		const code = bridgePromise !== undefined ? await bridgePromise.catch(readDisk) : await readDisk();
		throwIfAborted(signal);
		const lineCount = countTextLines(code);
		if (lineCount > MAX_SUMMARY_LINES) return unavailable("the source exceeds the 20,000-line parser limit");
		if (!csharp && lineCount < cfgReadSummarizeMinTotalLines.get(session.settings)) return NO_SUMMARY;
		if (code.length === 0) return NO_SUMMARY;

		const minBodyLines = cfgReadSummarizeMinBodyLines.get(session.settings);
		const minCommentLines = cfgReadSummarizeMinCommentLines.get(session.settings);
		const unfoldUntilLines = cfgReadSummarizeUnfoldUntil.get(session.settings);
		const unfoldLimitLines = cfgReadSummarizeUnfoldLimit.get(session.settings);
		const cache = getSummaryParseCache(session);
		const cacheKey = `${absolutePath}\0${languagePath ?? ""}\0${Bun.hash(code)}\0${minBodyLines},${minCommentLines},${unfoldUntilLines},${unfoldLimitLines}`;
		const memoized = cache.get(cacheKey);
		if (memoized !== undefined) return memoized;
		if (!(await ensureGrammar(csharp ? { lang: "csharp" } : { path: summaryPath }))) {
			return unavailable("the grammar is not installed and could not be downloaded");
		}
		throwIfAborted(signal);
		const result = await summarizeCodeAsync({
			code,
			path: summaryPath,
			lang: csharp ? "csharp" : undefined,
			minBodyLines,
			minCommentLines,
			unfoldUntilLines,
			unfoldLimitLines,
		});
		const attempt = result.parsed
			? result.elided || csharp
				? { summary: result }
				: NO_SUMMARY
			: unavailable("the source could not be parsed without syntax errors");
		cache.set(cacheKey, attempt);
		return attempt;
	} catch (error) {
		throwIfAborted(signal);
		return unavailable(error instanceof Error ? error.message : String(error));
	}
}

/** Read session display preferences and format a structural summary. */
export function renderSummary(
	session: ToolSession,
	summary: SummaryResult,
	/** Override for callers that already resolved the mode (e.g. immutable internal resources). */
	displayModeOverride?: FileDisplayMode,
) {
	return formatReadSummary(displayModeOverride ?? resolveFileDisplayMode(session), summary);
}
