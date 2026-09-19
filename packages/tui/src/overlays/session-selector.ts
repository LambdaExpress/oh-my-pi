import {
	type Component,
	Container,
	FuzzyText,
	Input,
	matchesKey,
	padding,
	replaceTabs,
	routeSelectListMouse,
	routeSgrMouseInput,
	ScrollView,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "../index";
import { formatBytes, isRecord } from "@oh-my-pi/pi-utils";
import { t } from "../i18n";
import { theme } from "../theme/theme";
import { contentRowWidth } from "../chrome/selector-helpers";
import { matchesAppInterrupt, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
/** Session lifecycle status presented by the picker. */
export type SessionSelectorStatus = "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";

/** Session listing fields consumed by the picker. */
export interface SessionSelectorEntry {
	path: string;
	id: string;
	cwd: string;
	title?: string;
	modified: Date;
	size: number;
	firstMessage: string;
	allMessagesText: string;
	status?: SessionSelectorStatus;
	/** Path to the parent session when this one was forked. */
	parentSessionPath?: string;
}
import { shortenPath } from "../render/render-utils";
import { HookSelectorComponent } from "./hook-selector";
import { bottomBorder, OverlayPanel, row, topBorder } from "../chrome/overlay-box";
import { MenuSelection, getMenuWindow } from "../components/menu-selection";

/**
 * Themed glyph + colored label for a session's lifecycle status, or `undefined`
 * when there is nothing useful to show (`unknown`/unset) so the metadata line
 * stays uncluttered. The glyph resolves through the active symbol preset
 * (nerdfont / unicode / ascii) via `theme.status.*`.
 */
function formatSessionStatus(status: SessionSelectorStatus | undefined): string | undefined {
	switch (status) {
		case "complete":
			return theme.fg("success", `${theme.status.success} ${t("done")}`);
		case "interrupted":
			return theme.fg("warning", `${theme.status.warning} ${t("interrupted")}`);
		case "aborted":
			return theme.fg("muted", `${theme.status.aborted} ${t("aborted")}`);
		case "error":
			return theme.fg("error", `${theme.status.error} ${t("error")}`);
		case "pending":
			return theme.fg("accent", `${theme.status.pending} ${t("pending")}`);
		default:
			return undefined;
	}
}

/** Returns the IDs of sessions whose recorded prompts match a query, best first. */
export type SessionHistoryMatcher = (query: string) => string[];

function sessionSearchText(session: SessionSelectorEntry): string {
	const parts = [
		session.id,
		session.title ?? "",
		session.cwd ?? "",
		session.firstMessage ?? "",
		session.allMessagesText,
		session.path,
	];
	return parts.filter(Boolean).join(" ");
}

/**
 * Lowercased per-session search haystack, built once and cached on the
 * {@link SessionSelectorEntry} itself (so it dies with the listing that produced it).
 * Rebuilding it per keystroke — a ~4KB string join plus `toLowerCase` per
 * session — was one of the costs that made resume search visibly lag.
 *
 * Only the string is cached. A prebuilt fuzzy index (~60KB per 4KB session)
 * would cost hundreds of MB on multi-thousand-session listings, so fuzzy
 * indexes are built transiently per scan visit instead (see
 * {@link scoreFuzzySession} callers).
 */
const kSearchTextLower = Symbol("session.searchTextLower");

interface SearchableSessionInfo extends SessionSelectorEntry {
	[kSearchTextLower]?: string;
}

function sessionTextLower(session: SessionSelectorEntry): string {
	const tagged = session as SearchableSessionInfo;
	let textLower = tagged[kSearchTextLower];
	if (textLower === undefined) {
		textLower = sessionSearchText(session).toLowerCase();
		tagged[kSearchTextLower] = textLower;
	}
	return textLower;
}

function tokenizeSessionQuery(query: string): string[] {
	const trimmed = query.trim().toLowerCase();
	return trimmed ? trimmed.split(/\s+/) : [];
}

function compareSessionRecency(a: SessionSelectorEntry, b: SessionSelectorEntry): number {
	return b.modified.getTime() - a.modified.getTime();
}

const MIN_PURE_FUZZY_TOKEN_SCORE = -20;

/** One ranked search hit; `index` is the session's position in the unfiltered list (recency order). */
interface RankedSessionMatch<T extends SessionSelectorEntry = SessionSelectorEntry> {
	session: T;
	score: number;
	index: number;
}

/**
 * True when every query token appears verbatim in the haystack. Literal
 * matches rank purely by recency, so they skip fuzzy scoring entirely — a pure
 * fast path, not a semantic change: a contiguous substring of the lowercased
 * text always lies within one normalized word per query sub-token, so every
 * literal token also fuzzy-matches.
 */
function isLiteralMatch(textLower: string, tokens: string[]): boolean {
	for (const token of tokens) {
		if (!textLower.includes(token)) return false;
	}
	return true;
}

/**
 * Fuzzy-score one non-literal session against every query token. Returns
 * undefined when a token fails to match or the weakest token is pure-fuzzy
 * noise. The caller builds `fuzzy` once per session visit so multi-token
 * queries share a single index.
 */
function scoreFuzzySession<T extends SessionSelectorEntry>(
	session: T,
	index: number,
	tokens: string[],
	fuzzy: FuzzyText,
): RankedSessionMatch<T> | undefined {
	let score = 0;
	let worstTokenScore = Number.NEGATIVE_INFINITY;
	for (const token of tokens) {
		const match = fuzzy.match(token);
		if (!match.matches) return undefined;
		score += match.score;
		worstTokenScore = Math.max(worstTokenScore, match.score);
	}
	if (worstTokenScore >= MIN_PURE_FUZZY_TOKEN_SCORE) return undefined;
	return { session, score, index };
}

function compareLiteralRank(a: RankedSessionMatch, b: RankedSessionMatch): number {
	return compareSessionRecency(a.session, b.session) || a.index - b.index;
}

function compareFuzzyRank(a: RankedSessionMatch, b: RankedSessionMatch): number {
	return a.score - b.score || compareSessionRecency(a.session, b.session) || a.index - b.index;
}

/** Exact titles lead partial titles; other matches retain their existing order. */
function prioritizeTitleMatches<T extends SessionSelectorEntry>(
	sessions: T[],
	tokens: string[],
	literal: RankedSessionMatch<T>[],
): T[] {
	const query = tokens.join(" ");
	const exact: T[] = [];
	const partial: T[] = [];
	const titleMatches = new Set<T>();
	// Title hits are literal matches, already ranked by recency and source index.
	for (const { session } of literal) {
		const title = session.title?.trim().toLowerCase().replace(/\s+/g, " ");
		if (title === query) exact.push(session);
		else if (title && isLiteralMatch(title, tokens)) partial.push(session);
		else continue;
		titleMatches.add(session);
	}
	if (titleMatches.size === 0) return sessions;
	return [...exact, ...partial, ...sessions.filter(session => !titleMatches.has(session))];
}

/**
 * Filter and rank session picker search results.
 *
 * Exact and partial title matches lead. Other literal matches rank by recency
 * rather than a slightly better fuzzy position match. Pure fuzzy/acronym
 * matches still sort by fuzzy score after literal matches, but weak pure
 * fuzzy tokens are dropped as noise.
 *
 * This is the synchronous reference implementation; {@link SessionList} runs
 * the same primitives incrementally so huge listings never block a keystroke.
 */
export function rankSessionSearchMatches<T extends SessionSelectorEntry>(allSessions: T[], query: string): T[] {
	const tokens = tokenizeSessionQuery(query);
	if (tokens.length === 0) return allSessions;

	const literal: RankedSessionMatch<T>[] = [];
	const fuzzyMatches: RankedSessionMatch<T>[] = [];
	for (let index = 0; index < allSessions.length; index++) {
		const session = allSessions[index]!;
		const textLower = sessionTextLower(session);
		if (isLiteralMatch(textLower, tokens)) {
			literal.push({ session, score: 0, index });
			continue;
		}
		const match = scoreFuzzySession(session, index, tokens, new FuzzyText(textLower));
		if (match) fuzzyMatches.push(match);
	}

	literal.sort(compareLiteralRank);
	fuzzyMatches.sort(compareFuzzyRank);
	const out: T[] = [];
	for (const match of literal) out.push(match.session);
	for (const match of fuzzyMatches) out.push(match.session);
	return prioritizeTitleMatches(out, tokens, literal);
}

/**
 * Combine metadata matches with prompt-history matches for ranking, using both
 * signals rather than replacing one with the other.
 *
 * - `fuzzy` is the ordered metadata/session-text result.
 * - `historyIds` are session IDs whose recorded prompts matched the query,
 *   ordered by prompt-history rank (typically newest matching prompt first); duplicates are tolerated.
 *
 * Ranking: prompt-history matches lead in history order, then remaining
 * metadata matches keep their existing order. A metadata match is never dropped,
 * and history matches not present in `allSessions` (e.g. deleted or out-of-scope
 * sessions) are ignored since they cannot be resumed from here.
 */
export function mergeSessionRanking<T extends SessionSelectorEntry>(
	allSessions: T[],
	fuzzy: T[],
	historyIds: string[],
): T[] {
	if (historyIds.length === 0) return fuzzy;

	const sessionsById = new Map<string, T>();
	for (const session of allSessions) {
		if (!sessionsById.has(session.id)) sessionsById.set(session.id, session);
	}

	const historyMatches: T[] = [];
	const historyPaths = new Set<string>();
	for (const id of historyIds) {
		const session = sessionsById.get(id);
		if (!session || historyPaths.has(session.path)) continue;
		historyMatches.push(session);
		historyPaths.add(session.path);
	}
	if (historyMatches.length === 0) return fuzzy;

	const metadataOnly = fuzzy.filter(session => !historyPaths.has(session.path));
	return [...historyMatches, ...metadataOnly];
}

/**
 * Delay before the prompt-history DB is consulted for the current query.
 * History matching hits SQLite synchronously (an FTS lookup plus a LIKE scan
 * over every stored prompt — tens to hundreds of ms on a year-old database),
 * so it must never run per keystroke: fuzzy results render immediately and
 * the history merge lands once typing pauses.
 */
const HISTORY_MERGE_DEBOUNCE_MS = 150;
/**
 * Minimum query length for history augmentation. A single character matches
 * essentially every stored prompt — the most expensive FTS prefix to expand —
 * and only reorders the recency-ranked list by noise.
 */
const HISTORY_MERGE_MIN_QUERY = 2;

/**
 * Sessions fuzzy-scored synchronously inside the keystroke itself. Small
 * listings finish within it, keeping the complete-in-one-frame behavior;
 * anything left spills into async chunks. A fuzzy visit costs ~100µs (index
 * build over the ≤4KB per-session corpus dominates), so 100 visits ≈ 10ms —
 * about one frame. Counts rather than a deadline keep chunk boundaries
 * deterministic (and testable under fake timers).
 */
const FUZZY_SCAN_INLINE_COUNT = 100;
/**
 * Sessions fuzzy-scored per async chunk (~15ms). Each chunk yields back to
 * the event loop so the next keystroke is never blocked behind a long scan; a
 * new query bumps the scan generation and orphans pending chunks.
 */
const FUZZY_SCAN_CHUNK_COUNT = 150;

/** Sessions shown per group before the "{count} more sessions" ellipsis row. */
const GROUP_PREVIEW_COUNT = 3;

/** One parent-folder group in the grouped (by-parent) scope. */
interface SessionGroup<T> {
	cwd: string;
	sessions: T[];
	expanded: boolean;
	showAll: boolean;
}

/**
 * One entry of the render/navigation menu: a group header, a session row, or
 * the "{count} more sessions" ellipsis row of an expanded group.
 */
type VisibleItem<T> = SessionGroup<T> | T | { moreOf: SessionGroup<T> };

function isSessionGroupItem<T>(item: VisibleItem<T>): item is SessionGroup<T> {
	return isRecord(item) && "sessions" in item;
}

function isMoreItem<T>(item: VisibleItem<T>): item is { moreOf: SessionGroup<T> } {
	return isRecord(item) && "moreOf" in item;
}

/** Stable menu key per visible item; group chrome keys by folder so it survives recomposition. */
function visibleItemKey<T extends SessionSelectorEntry>(item: VisibleItem<T>): string {
	if (isSessionGroupItem(item)) return `group:${item.cwd}`;
	if (isMoreItem(item)) return `more:${item.moreOf.cwd}`;
	return item.path;
}

/** Searchable text per visible item; only session rows contribute. */
function visibleItemSearchText<T extends SessionSelectorEntry>(item: VisibleItem<T>): string {
	return isSessionGroupItem(item) || isMoreItem(item) ? "" : sessionSearchText(item);
}

/**
 * Custom session list component with multi-line items and search
 */
class SessionList<T extends SessionSelectorEntry> implements Component {
	/** Menu over the render/navigation items (group headers, sessions, ellipsis rows). */
	#menu: MenuSelection<VisibleItem<T>>;
	/** Sessions matching the current query, in composed rank order. */
	#filteredSessions: T[] = [];
	/** Whether the list renders grouped by parent folder (by-parent scope). */
	#grouped = false;
	/** Full group list for the current dataset; rebuilt on dataset/toggle changes. */
	#groups: SessionGroup<T>[] = [];
	/** Cross-rebuild memory of per-group expand/show-all state, keyed by cwd. */
	#groupState = new Map<string, { expanded: boolean; showAll: boolean }>();
	// Maps a 0-based line within this list's own render to a visible-item
	// index (group header, session row, or ellipsis row), or undefined for
	// chrome rows (search line, blanks, scrollbar gap). Rebuilt every render so
	// the picker's mouse hit-testing tracks the live scroll window. Only
	// consulted while the picker holds the alternate screen (where the overlay
	// enables mouse tracking and paints from screen row 0).
	#hitRows: (number | undefined)[] = [];
	#hoveredIndex: number | null = null;
	readonly #searchInput: Input;
	onSelect?: (session: T) => void;
	onCancel?: () => void;
	onExit: () => void = () => {};
	onToggleScope?: () => void;
	// Snapshot of the live terminal-row getter; the visible window is derived
	// from it per render so the picker fits the viewport (and adapts to resize).
	readonly #getTerminalRows: () => number;

	onDeleteRequest?: (session: T) => void;

	#allSessions: T[];
	#showCwd: boolean;
	#pinnedIds: ReadonlySet<string>;
	readonly #getCurrentSessionPath: () => string | undefined;
	readonly #historyMatcher?: SessionHistoryMatcher;
	#historyMergeTimer: NodeJS.Timeout | undefined;
	/** Re-render hook for async list updates (fuzzy scan chunks, history merge). */
	onRequestRender?: () => void;

	// ── Incremental search state ──────────────────────────────────────────
	// The menu's visible list is always composed from these three inputs (see
	// #composeFiltered), so late-arriving fuzzy chunks and the debounced
	// history merge can land in any order without clobbering each other.
	/** Recency-ranked sessions whose text contains every query token verbatim. */
	#literalRanked: RankedSessionMatch<T>[] = [];
	/** Score-ranked fuzzy-only matches, appended by scan chunks. */
	#fuzzyRanked: RankedSessionMatch<T>[] = [];
	/** Prompt-history session IDs for the current query, once the merge landed. */
	#historyIds: string[] = [];
	/** Invalidates in-flight scan chunks when the query or dataset changes. */
	#scanGeneration = 0;
	#scanTimer: NodeJS.Timeout | undefined;
	/**
	 * True once the user moved the selection for the current query; blocks the
	 * history merge from reordering the list under their cursor. (Fuzzy chunks
	 * only append below the literal group, which never shifts existing rows.)
	 */
	#selectionMoved = false;
	/** True after a nonempty query; empty refilter restores current only then. */
	#hadFilterQuery = false;
	/** Last query passed to {@link #filterSessions}; same-query refilter keeps the index. */
	#lastFilterQuery = "";

	constructor(
		sessions: T[],
		showCwd = false,
		historyMatcher?: SessionHistoryMatcher,
		getTerminalRows: () => number = () => 24,
		pinnedIds: ReadonlySet<string> = new Set(),
		currentSessionPath?: string | (() => string | undefined),
	) {
		this.#getTerminalRows = getTerminalRows;
		this.#allSessions = sessions;
		this.#showCwd = showCwd;
		this.#pinnedIds = pinnedIds;
		this.#getCurrentSessionPath =
			typeof currentSessionPath === "function" ? currentSessionPath : () => currentSessionPath;
		this.#historyMatcher = historyMatcher;
		this.#menu = new MenuSelection<VisibleItem<T>>([], {
			getKey: visibleItemKey,
			getSearchText: visibleItemSearchText,
		});
		this.#filteredSessions = sessions;
		this.#composeVisible();
		this.#selectCurrentSession();
		this.#searchInput = new Input();

		// Handle Enter in search input - select current item
		this.#searchInput.onSubmit = () => {
			const item = this.#menu.selectedItem;
			if (item && !isSessionGroupItem(item) && !isMoreItem(item)) {
				this.onSelect?.(item);
			}
		};
	}

	/**
	 * Session-row line budget for one render, sized so the whole picker fits
	 * the current viewport instead of pushing its header/search off the top.
	 *
	 * Chrome (7) is the panel's top border, one spacer, the list's search line
	 * and its blank, and the pinned footer minus its leading blank (hint,
	 * blank, bottom border). The reserve covers below-editor hook widgets /
	 * cursor. The floor of 8 always admits two titled sessions (the tallest
	 * item at 4 lines: title + preview + metadata + separator).
	 */
	#lineBudget(): number {
		const CHROME = 7;
		const RESERVE = 1;
		return Math.max(8, this.#getTerminalRows() - CHROME - RESERVE);
	}

	/** PageUp/PageDown jump, approximated from the worst-case session height. */
	#pageSize(): number {
		return Math.max(2, Math.floor(this.#lineBudget() / 4));
	}

	/** Rendered line count of a visible item: group header / ellipsis row 1, session 3-4. */
	#itemHeight(item: VisibleItem<T>): number {
		if (isSessionGroupItem(item) || isMoreItem(item)) return 1;
		return item.title ? 4 : 3;
	}

	/** Focus the live session when it is in the visible list. */
	#selectCurrentSession(): void {
		const currentPath = this.#getCurrentSessionPath();
		if (!currentPath) return;
		const index = this.#menu.visibleItems.findIndex(
			item => !isSessionGroupItem(item) && !isMoreItem(item) && item.path === currentPath,
		);
		if (index >= 0) this.#menu.setSelectedIndex(index);
	}

	/** Replace the visible dataset, e.g. when toggling folder/all-projects scope. */
	setSessions(sessions: T[], showCwd: boolean, grouped = false, pinnedIds?: ReadonlySet<string>): void {
		this.#allSessions = sessions;
		this.#showCwd = showCwd;
		this.#grouped = grouped;
		if (pinnedIds !== undefined) this.#pinnedIds = pinnedIds;
		this.#groups = grouped ? this.#buildGroups(sessions) : [];
		this.#menu.setSelectedIndex(0);
		this.#filterSessions(this.#searchInput.getValue());
		this.#selectCurrentSession();
	}

	/**
	 * Group sessions by parent folder: groups sorted by newest member session,
	 * members sorted by recency, expand/show-all state restored from
	 * {@link #groupState} (defaults: expanded, preview only).
	 */
	#buildGroups(sessions: T[]): SessionGroup<T>[] {
		const byCwd = new Map<string, T[]>();
		for (const session of sessions) {
			// An empty cwd marks the unknown-folder group; the label is resolved
			// at render time so a locale switch re-translates it.
			const key = session.cwd ?? "";
			const list = byCwd.get(key);
			if (list) list.push(session);
			else byCwd.set(key, [session]);
		}
		const groups: SessionGroup<T>[] = [];
		for (const [cwd, groupSessions] of byCwd) {
			groupSessions.sort(compareSessionRecency);
			const state = this.#groupState.get(cwd);
			groups.push({
				cwd,
				sessions: groupSessions,
				expanded: state?.expanded ?? true,
				showAll: state?.showAll ?? false,
			});
		}
		groups.sort((a, b) => compareSessionRecency(a.sessions[0]!, b.sessions[0]!));
		return groups;
	}

	/**
	 * Rebuild the menu's render/navigation items from the current search result
	 * and grouping state. Flat scope mirrors {@link #filteredSessions} exactly;
	 * grouped scope expands group headers (or, while searching, auto-expands
	 * every group containing a hit) and appends ellipsis rows. The menu keeps
	 * the selected item by key, so recomposition never moves the cursor.
	 */
	#composeVisible(): void {
		const items: VisibleItem<T>[] = [];
		if (!this.#grouped) {
			items.push(...this.#filteredSessions);
		} else if (this.#searchInput.getValue().trim().length > 0) {
			const byCwd = new Map<string, T[]>();
			for (const session of this.#filteredSessions) {
				const key = session.cwd ?? "";
				const list = byCwd.get(key);
				if (list) list.push(session);
				else byCwd.set(key, [session]);
			}
			const hitGroups: SessionGroup<T>[] = [];
			for (const [cwd, hitSessions] of byCwd) {
				hitSessions.sort(compareSessionRecency);
				hitGroups.push({ cwd, sessions: hitSessions, expanded: true, showAll: true });
			}
			hitGroups.sort((a, b) => compareSessionRecency(a.sessions[0]!, b.sessions[0]!));
			for (const group of hitGroups) {
				items.push(group);
				items.push(...group.sessions);
			}
		} else {
			for (const group of this.#groups) {
				items.push(group);
				if (!group.expanded) continue;
				const shown = group.showAll ? group.sessions : group.sessions.slice(0, GROUP_PREVIEW_COUNT);
				items.push(...shown);
				if (!group.showAll && group.sessions.length > GROUP_PREVIEW_COUNT) items.push({ moreOf: group });
			}
		}
		this.#menu.setItems(items);
	}

	/** Toggle a group header's expanded state and rebuild the visible items. */
	#toggleGroup(cwd: string): void {
		const state = this.#groupState.get(cwd) ?? { expanded: true, showAll: false };
		state.expanded = !state.expanded;
		this.#groupState.set(cwd, state);
		this.#groups = this.#buildGroups(this.#allSessions);
		this.#composeVisible();
		this.onRequestRender?.();
	}

	/** Toggle a group's preview/all-members state and rebuild the visible items. */
	#toggleShowAll(cwd: string): void {
		const state = this.#groupState.get(cwd) ?? { expanded: true, showAll: false };
		state.showAll = !state.showAll;
		this.#groupState.set(cwd, state);
		this.#groups = this.#buildGroups(this.#allSessions);
		this.#composeVisible();
		this.onRequestRender?.();
	}

	#filterSessions(query: string): void {
		this.#scanGeneration++;
		if (this.#scanTimer !== undefined) {
			clearTimeout(this.#scanTimer);
			this.#scanTimer = undefined;
		}
		this.#selectionMoved = false;
		this.#historyIds = [];
		this.#literalRanked = [];
		this.#fuzzyRanked = [];

		const tokens = tokenizeSessionQuery(query);
		const hadQuery = this.#hadFilterQuery;
		const queryChanged = query !== this.#lastFilterQuery;
		this.#hadFilterQuery = tokens.length > 0;
		this.#lastFilterQuery = query;
		if (tokens.length === 0) {
			this.#filteredSessions = this.#allSessions;
			this.#composeVisible();
			if (hadQuery) this.#selectCurrentSession();
			this.#scheduleHistoryMerge(query);
			return;
		}

		// Literal pass: one substring scan per token per session, synchronous so
		// every keystroke gets immediate recency-ranked feedback regardless of
		// listing size.
		const literal: RankedSessionMatch<T>[] = [];
		const rest: number[] = [];
		const all = this.#allSessions;
		for (let index = 0; index < all.length; index++) {
			if (isLiteralMatch(sessionTextLower(all[index]!), tokens)) {
				literal.push({ session: all[index]!, score: 0, index });
			} else {
				rest.push(index);
			}
		}
		literal.sort(compareLiteralRank);
		this.#literalRanked = literal;

		// Fuzzy pass: building a fuzzy index per session is too expensive to run
		// across a huge listing inside one keystroke, so scan a bounded slice now
		// and spill the remainder into async chunks.
		this.#scanFuzzySlice(this.#scanGeneration, tokens, rest, 0, FUZZY_SCAN_INLINE_COUNT);
		this.#composeFiltered();
		// New query rebuilds ranking from scratch. Same-query refilter (delete)
		// and async compose (fuzzy chunks / history merge) only clamp so an
		// arrow selection survives. A live-session index > 0 would otherwise
		// land on a lower-ranked match after the first keystroke.
		if (queryChanged) this.#menu.setSelectedIndex(0);
		this.#scheduleHistoryMerge(query);
	}

	/**
	 * Score up to `budget` sessions from `rest[start..]` (indexes into the
	 * unfiltered list), then schedule the remainder on a macrotask so pending
	 * input events run first. Chunks that added matches recompose the visible
	 * list and request a render; a stale generation aborts silently.
	 */
	#scanFuzzySlice(generation: number, tokens: string[], rest: number[], start: number, budget: number): void {
		const all = this.#allSessions;
		const end = Math.min(rest.length, start + budget);
		for (let i = start; i < end; i++) {
			const index = rest[i]!;
			const session = all[index]!;
			const match = scoreFuzzySession(session, index, tokens, new FuzzyText(sessionTextLower(session)));
			if (match) this.#fuzzyRanked.push(match);
		}
		if (end >= rest.length) return;
		this.#scanTimer = setTimeout(() => {
			this.#scanTimer = undefined;
			if (generation !== this.#scanGeneration) return;
			const before = this.#fuzzyRanked.length;
			this.#scanFuzzySlice(generation, tokens, rest, end, FUZZY_SCAN_CHUNK_COUNT);
			if (this.#fuzzyRanked.length > before) {
				this.#composeFiltered();
				this.onRequestRender?.();
			}
		}, 0);
	}

	/**
	 * Rebuild the menu's visible list with title matches first, then other
	 * prompt-history hits, literal matches (recency), and fuzzy-only hits (score).
	 */
	#composeFiltered(): void {
		this.#fuzzyRanked.sort(compareFuzzyRank);
		const base: T[] = [];
		for (const match of this.#literalRanked) base.push(match.session);
		for (const match of this.#fuzzyRanked) base.push(match.session);
		this.#filteredSessions = prioritizeTitleMatches(
			this.#historyIds.length > 0 ? mergeSessionRanking(this.#allSessions, base, this.#historyIds) : base,
			tokenizeSessionQuery(this.#searchInput.getValue()),
			this.#literalRanked,
		);
		this.setHoverIndex(null);
		this.#composeVisible();
	}

	/**
	 * Augment ranked results with prompt-history matches without replacing them.
	 * The session-list corpus only sees the first 4KB of each session, so a prompt
	 * typed deep into a long session is invisible to text search; `historyMatcher`
	 * recovers those via `history.db`. The lookup hits SQLite synchronously, so it
	 * is debounced off the keystroke path ({@link HISTORY_MERGE_DEBOUNCE_MS}) and
	 * composed in when it lands, discarded if the query changed meanwhile.
	 */
	#scheduleHistoryMerge(query: string): void {
		if (this.#historyMergeTimer !== undefined) {
			clearTimeout(this.#historyMergeTimer);
			this.#historyMergeTimer = undefined;
		}
		const matcher = this.#historyMatcher;
		const trimmed = query.trim();
		if (!matcher || trimmed.length < HISTORY_MERGE_MIN_QUERY) return;
		this.#historyMergeTimer = setTimeout(() => {
			this.#historyMergeTimer = undefined;
			if (this.#searchInput.getValue() !== query) return;
			if (this.#selectionMoved) return;
			const historyIds = matcher(trimmed);
			if (historyIds.length === 0) return;
			this.#historyIds = historyIds;
			this.#composeFiltered();
			this.onRequestRender?.();
		}, HISTORY_MERGE_DEBOUNCE_MS);
	}

	/** Cancel pending async search work; idempotent, called on every picker exit path. */
	dispose(): void {
		this.#scanGeneration++;
		if (this.#scanTimer !== undefined) {
			clearTimeout(this.#scanTimer);
			this.#scanTimer = undefined;
		}
		if (this.#historyMergeTimer !== undefined) {
			clearTimeout(this.#historyMergeTimer);
			this.#historyMergeTimer = undefined;
		}
	}

	removeSession(sessionPath: string): void {
		const index = this.#allSessions.findIndex(s => s.path === sessionPath);
		if (index === -1) return;
		this.#allSessions.splice(index, 1);
		if (this.#grouped) this.#groups = this.#buildGroups(this.#allSessions);
		// Re-filter to update the composed result set
		this.#filterSessions(this.#searchInput.getValue());
		// Adjust selection if we deleted the last item or beyond
		if (this.#menu.selectedIndex >= this.#menu.visibleItems.length) {
			this.#menu.setSelectedIndex(Math.max(0, this.#menu.visibleItems.length - 1));
		}
		this.setHoverIndex(null);
	}

	/** Resolve a list-local rendered-line index to a visible-item index. */
	hitTest(line: number): number | undefined {
		return this.#hitRows[line];
	}

	setHoverIndex(index: number | null): void {
		if (index === null || index < 0 || index >= this.#menu.visibleItems.length) {
			this.#hoveredIndex = null;
			return;
		}
		this.#hoveredIndex = index;
	}

	/** Wheel notch: move the selection one step (clamped, no wrap). */
	handleWheel(delta: -1 | 1): void {
		if (this.#menu.visibleItems.length === 0) return;
		this.#selectionMoved = true;
		this.#menu.move(delta, false);
	}

	/**
	 * Mouse click: group headers and ellipsis rows toggle their group, session
	 * rows are selected and resumed.
	 */
	clickItem(index: number): void {
		const item = this.#menu.visibleItems[index];
		if (!item) return;
		if (isSessionGroupItem(item)) {
			this.#toggleGroup(item.cwd);
			return;
		}
		if (isMoreItem(item)) {
			this.#toggleShowAll(item.moreOf.cwd);
			return;
		}
		this.#menu.setSelectedIndex(index);
		this.onSelect?.(item);
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		this.#hitRows = [];

		// Render search input
		lines.push(...this.#searchInput.render(width));
		lines.push(""); // Blank line after search

		if (this.#menu.visibleItems.length === 0) {
			if (this.#showCwd) {
				// "All" scope - no sessions anywhere that match filter
				lines.push(truncateToWidth(theme.fg("muted", `  ${t("No sessions found")}`), width));
			} else {
				// "Current folder" scope - hint to try "all"
				lines.push(
					truncateToWidth(
						theme.fg("muted", `  ${t("No sessions in current folder. Press Tab to view all.")}`),
						width,
					),
				);
			}
			return lines;
		}

		// Format dates
		const formatDate = (date: Date): string => {
			const now = new Date();
			const diffMs = now.getTime() - date.getTime();
			const diffMins = Math.floor(diffMs / 60000);
			const diffHours = Math.floor(diffMs / 3600000);
			const diffDays = Math.floor(diffMs / 86400000);

			if (diffMins < 1) return t("just now");
			if (diffMins < 60) return diffMins === 1 ? t("1 minute ago") : t("{count} minutes ago", { count: diffMins });
			if (diffHours < 24) return diffHours === 1 ? t("1 hour ago") : t("{count} hours ago", { count: diffHours });
			if (diffDays === 1) return t("1 day ago");
			if (diffDays < 7) return t("{count} days ago", { count: diffDays });

			return date.toLocaleDateString();
		};

		// Window the list around the selection by actual line height (group
		// headers and ellipsis rows are 1 line, sessions 3-4) until the viewport
		// budget is spent, so short sessions never strand blank rows a
		// worst-case count-based window would leave (then padded by
		// fill-height).
		const filtered = this.#menu.visibleItems;
		const budget = this.#lineBudget();
		const itemHeight = (item: VisibleItem<T>): number => this.#itemHeight(item);
		const {
			startIndex,
			endIndex,
			rowOffset: offsetRows,
			totalRows: rawTotalRows,
		} = getMenuWindow(filtered.map(itemHeight), this.#menu.selectedIndex, budget);

		// Each session block is built into sessionLines, then wrapped by ScrollView
		// so the right-edge scrollbar is proportional at the physical-line level.
		const sessionLines: string[] = [];
		const sessionRowIndex: number[] = [];
		const rowWidth = contentRowWidth(width, rawTotalRows, budget);
		const currentPath = this.#getCurrentSessionPath();
		for (let i = startIndex; i < endIndex; i++) {
			const blockStart = sessionLines.length;
			const isSelected = i === this.#menu.selectedIndex;
			const isHovered = i === this.#hoveredIndex && !isSelected;

			const item = filtered[i];
			if (item === undefined) continue;
			if (isSessionGroupItem(item)) {
				const caret = item.expanded ? "▾" : "▸";
				const label = item.cwd || t("unknown folder");
				const headerText = `${theme.fg("muted", caret)} ${shortenPath(label)} ${theme.fg("accent", `(${item.sessions.length})`)}`;
				let headerLine = truncateToWidth(isSelected ? theme.bold(headerText) : headerText, rowWidth);
				if (isHovered) headerLine = theme.bg("selectedBg", headerLine);
				sessionLines.push(headerLine);
				sessionRowIndex[sessionLines.length - 1] = i;
				continue;
			}
			if (isMoreItem(item)) {
				const moreText = `  … ${t("{count} more sessions", { count: item.moreOf.sessions.length - GROUP_PREVIEW_COUNT })}`;
				let moreLine = truncateToWidth(theme.fg("dim", moreText), rowWidth);
				if (isSelected) moreLine = theme.bold(moreLine);
				if (isHovered) moreLine = theme.bg("selectedBg", moreLine);
				sessionLines.push(moreLine);
				sessionRowIndex[sessionLines.length - 1] = i;
				continue;
			}

			const session = item;
			// Normalize first message to single line
			const normalizedMessage = session.firstMessage.replace(/\n/g, " ").trim();

			// First line: cursor + optional pin icon + title (or first message if no title)
			const cursorSymbol = `${theme.nav.cursor} `;
			const cursorWidth = visibleWidth(cursorSymbol);
			const cursor = isSelected ? theme.fg("accent", cursorSymbol) : padding(cursorWidth);
			const maxWidth = rowWidth - cursorWidth; // Account for cursor width

			const isPinned = this.#pinnedIds.has(session.id);
			const pinPrefix = isPinned ? `${theme.fg("accent", theme.icon.pin)} ` : "";
			const pinPrefixWidth = isPinned ? visibleWidth(`${theme.icon.pin} `) : 0;
			const maxTextWidth = Math.max(0, maxWidth - pinPrefixWidth);

			if (session.title) {
				// Has title: show title on first line, dimmed first message on second line
				const truncatedTitle = truncateToWidth(session.title, maxTextWidth);
				const titleLine = `${cursor}${pinPrefix}${isSelected ? theme.bold(truncatedTitle) : truncatedTitle}`;
				sessionLines.push(titleLine);

				// Second line: dimmed first message preview
				const truncatedPreview = truncateToWidth(normalizedMessage, maxWidth);
				sessionLines.push(`  ${theme.fg("dim", truncatedPreview)}`);
			} else {
				// No title: show first message as main line
				const truncatedMsg = truncateToWidth(normalizedMessage, maxTextWidth);
				const messageLine = `${cursor}${pinPrefix}${isSelected ? theme.bold(truncatedMsg) : truncatedMsg}`;
				sessionLines.push(messageLine);
			}

			// Metadata line: date + file size + current marker + lifecycle status
			// (+ project dir in all-projects scope). The status segment carries
			// its own color, so each segment is dimmed individually rather than
			// wrapping the whole line.
			const dim = (s: string) => theme.fg("dim", s);
			const dot = dim(theme.sep.dot);
			const modified = formatDate(session.modified);
			let metadata = `  ${dim(modified)} ${dot} ${dim(formatBytes(session.size))}`;
			if (currentPath !== undefined && session.path === currentPath) {
				metadata += ` ${dot} ${theme.fg("accent", t("current"))}`;
			}
			const status = formatSessionStatus(session.status);
			if (status) {
				metadata += ` ${dot} ${status}`;
			}
			if (session.parentSessionPath) {
				metadata += ` ${dot} ${dim(`${theme.icon.branch} ${t("fork")}`)}`;
			}
			if (this.#showCwd && session.cwd) {
				metadata += ` ${dot} ${dim(shortenPath(session.cwd))}`;
			}
			const metadataLine = truncateToWidth(metadata, rowWidth);

			sessionLines.push(metadataLine);
			sessionLines.push(""); // Blank line between sessions
			for (let k = blockStart; k < sessionLines.length; k++) {
				sessionRowIndex[k] = i;
				if (isHovered) sessionLines[k] = theme.bg("selectedBg", sessionLines[k] ?? "");
			}
		}

		// Wrap the rendered window in a ScrollView for a proportional right-edge
		// bar, with exact physical-line totals from the per-item heights.
		const sv = new ScrollView(sessionLines, {
			height: sessionLines.length,
			scrollbar: "auto",
			totalRows: rawTotalRows,
			theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
		});
		sv.setScrollOffset(offsetRows);
		const sessionRegionStart = lines.length;
		const svLines = sv.render(width);
		for (let k = 0; k < svLines.length; k++) this.#hitRows[sessionRegionStart + k] = sessionRowIndex[k];
		lines.push(...svLines);

		return lines;
	}

	handleInput(keyData: string): void {
		// Delete key — or Backspace on an empty search query — request delete
		// confirmation from the parent. macOS laptops have no dedicated Forward
		// Delete key: Fn+Backspace is the only way to send \e[3~, and many macOS
		// terminals (Terminal.app, some iTerm2 profiles) deliver \x7f for that
		// combo instead. Regular Backspace on an empty query means "delete
		// session"; with a typed query it stays bound to the search Input so users
		// can still edit their filter text.
		if (
			matchesKey(keyData, "delete") ||
			(matchesKey(keyData, "backspace") && this.#searchInput.getValue().length === 0)
		) {
			const item = this.#menu.selectedItem;
			if (item && !isSessionGroupItem(item) && !isMoreItem(item) && this.onDeleteRequest) {
				this.onDeleteRequest(item);
			}
			return;
		}
		// Up arrow
		if (matchesSelectUp(keyData)) {
			this.#selectionMoved = true;
			this.#menu.move(-1, false);
			return;
		}
		// Down arrow
		if (matchesSelectDown(keyData)) {
			this.#selectionMoved = true;
			this.#menu.move(1, false);
			return;
		}
		// Page up - jump up by maxVisible items
		if (matchesKey(keyData, "pageUp")) {
			this.#selectionMoved = true;
			this.#menu.move(-this.#pageSize(), false);
			return;
		}
		// Page down - jump down by maxVisible items
		if (matchesKey(keyData, "pageDown")) {
			this.#selectionMoved = true;
			this.#menu.move(this.#pageSize(), false);
			return;
		}
		// Left/Right on a group header toggles it (collapse/expand).
		if (matchesKey(keyData, "left") || matchesKey(keyData, "right")) {
			const item = this.#menu.selectedItem;
			if (isSessionGroupItem(item)) this.#toggleGroup(item.cwd);
			return;
		}
		// Enter
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const item = this.#menu.selectedItem;
			if (!item) return;
			if (isSessionGroupItem(item)) {
				this.#toggleGroup(item.cwd);
				return;
			}
			if (isMoreItem(item)) {
				this.#toggleShowAll(item.moreOf.cwd);
				return;
			}
			if (this.onSelect) {
				this.onSelect(item);
			}
			return;
		}
		// Escape - cancel
		if (matchesAppInterrupt(keyData)) {
			if (this.onCancel) {
				this.onCancel();
			}
			return;
		}
		// Ctrl+C - exit
		if (matchesKey(keyData, "ctrl+c")) {
			this.onExit();
			return;
		}
		// Tab - toggle folder / all-projects scope
		if (matchesKey(keyData, "tab")) {
			this.onToggleScope?.();
			return;
		}
		// Pass everything else to search input
		this.#searchInput.handleInput(keyData);
		this.#filterSessions(this.#searchInput.getValue());
	}
}

export interface SessionSelectorOptions<T extends SessionSelectorEntry = SessionSelectorEntry> {
	onDelete?: (session: T) => Promise<boolean>;
	historyMatcher?: SessionHistoryMatcher;
	/** Loads sessions across all projects for the all-projects scope toggle (Tab). */
	loadAllSessions?: () => Promise<T[]>;
	/** Preloaded all-projects list; cached so the first Tab toggle is instant. */
	allSessions?: T[];
	/** Picker heading; defaults to "Resume Session". */
	title?: string;
	/** Fixed scope label, or false to omit the scope suffix. */
	scopeLabel?: string | false;
	/** Show each session's working directory in the list. */
	showCwd?: boolean;
	/**
	 * Reads the live terminal height so the visible window fits the viewport.
	 * Omitted only in tests; defaults to a conservative 24 rows.
	 */
	getTerminalRows?: () => number;
	/**
	 * Fill the whole viewport and pin the footer (hint + bottom border) to the
	 * last rows, so the footer stops drifting as the list window changes height.
	 * Set by the standalone `--resume` picker (fullscreen alternate screen); the
	 * in-editor selector leaves it off and renders compactly.
	 */
	fillHeight?: boolean;
	/** Set of pinned session ids to display with a pin indicator. */
	pinnedIds?: ReadonlySet<string>;
	/** Path of the live session, or a getter so detach/newSession stays accurate. */
	currentSessionPath?: string | (() => string | undefined);
}

/**
 * Component that renders a session selector with optional confirmation dialog
 */
export class SessionSelectorComponent<T extends SessionSelectorEntry = SessionSelectorEntry> extends OverlayPanel {
	#sessionList: SessionList<T>;
	#confirmationDialog: HookSelectorComponent | null = null;
	// Hosts whichever of `#sessionList` / `#confirmationDialog` is live this
	// frame. The delete dialog REPLACES the list in this slot rather than being
	// appended below the picker chrome, so the picker is always
	// `chrome + max(list, dialog) + chrome` and never overflows the viewport
	// (issue #3283: an overflowing dialog frame committed the header into
	// scrollback, stranding it above the viewport once the dialog closed).
	#contentSlot: Container;
	#messageContainer: Container;
	#onDelete?: (session: T) => Promise<boolean>;
	#onRequestRender?: () => void;
	readonly #loadAllSessions?: () => Promise<T[]>;
	#folderSessions: T[];
	#globalSessions: T[] | null = null;
	#scope: "folder" | "flat" | "grouped" = "folder";
	#toggling = false;
	#inputLocked = false;
	// 0-based line where the session list begins within this component's own
	// render, captured each frame. The fullscreen picker overlay paints from
	// screen row 0, so a mouse row maps to `row - #listLineOffset` inside the
	// list. Only meaningful while the picker holds the alternate screen.
	#listLineOffset = 0;
	// 0-based line where the pinned footer begins; clicks at or below it never
	// hit-test the list, so a footer click on a cramped (trimmed) frame can't
	// resume a session scrolled off-screen.
	#footerStart = 0;
	readonly #getTerminalRows: () => number;
	readonly #fillHeight: boolean;
	readonly #title: string;
	readonly #scopeLabel: string | false | undefined;

	constructor(
		sessions: T[],
		onSelect: (session: T) => void,
		onCancel: () => void,
		onExit: () => void,
		options: SessionSelectorOptions<T> = {},
	) {
		super(options.title ?? t("Resume Session"));

		this.#messageContainer = new Container();
		this.#onDelete = options.onDelete;
		this.#loadAllSessions = options.loadAllSessions;
		this.#folderSessions = sessions;
		this.#globalSessions = options.allSessions ?? null;
		this.#getTerminalRows = options.getTerminalRows ?? (() => 24);
		this.#fillHeight = options.fillHeight ?? false;
		this.#title = options.title ?? t("Resume Session");
		this.#scopeLabel = options.scopeLabel;
		this.title = this.#headerLabel();
		// One spacer of breathing room; OverlayPanel supplies the two outer
		// border rows and the horizontal inset.
		this.addChild(new Spacer(1));
		this.addChild(this.#messageContainer);
		// Create session list in folder scope; the empty-state hint invites the
		// user to Tab into all-projects rather than silently surfacing other
		// projects' history (issue #3099).
		this.#sessionList = new SessionList(
			sessions,
			options.showCwd ?? false,
			options.historyMatcher,
			options.getTerminalRows,
			options.pinnedIds,
			options.currentSessionPath,
		);
		// Every exit path cancels the list's pending history merge, so a stale
		// debounce timer can never run its SQLite lookup after the picker closed.
		this.#sessionList.onSelect = session => {
			this.#sessionList.dispose();
			onSelect(session);
		};
		this.#sessionList.onCancel = () => {
			this.#sessionList.dispose();
			onCancel();
		};
		this.#sessionList.onExit = () => {
			this.#sessionList.dispose();
			onExit();
		};
		this.#sessionList.onRequestRender = () => this.#onRequestRender?.();
		this.#sessionList.onDeleteRequest = (session: T) => {
			this.#showDeleteConfirmation(session);
		};
		if (this.#loadAllSessions || this.#globalSessions) {
			this.#sessionList.onToggleScope = () => {
				void this.#toggleScope();
			};
		}
		this.#contentSlot = new Container();
		this.#contentSlot.addChild(this.#sessionList);
		this.addChild(this.#contentSlot);
	}

	#headerLabel(): string {
		if (this.#scopeLabel === false) return theme.bold(this.#title);
		const scopeLabel =
			this.#scopeLabel ??
			(this.#scope === "folder" ? t("current folder") : this.#scope === "flat" ? t("all projects") : t("by parent"));
		return `${theme.bold(this.#title)} ${theme.fg("muted", `(${scopeLabel})`)}`;
	}

	/**
	 * Cycle through folder → flat (all projects) → grouped (by parent) → folder.
	 * The global list is loaded lazily on the first switch to a global scope and
	 * cached, so the common folder-scope path never pays for the cross-project
	 * scan and flat ↔ grouped reuse the same cached list.
	 */
	async #toggleScope(): Promise<void> {
		if (this.#toggling || this.#confirmationDialog) return;
		if (this.#scope === "folder") {
			let global = this.#globalSessions;
			if (!global) {
				if (!this.#loadAllSessions) return;
				this.#toggling = true;
				this.#messageContainer.clear();
				this.#messageContainer.addChild(new Text(theme.fg("muted", t("Loading all projects…")), 0, 0));
				this.#onRequestRender?.();
				try {
					global = await this.#loadAllSessions();
				} catch (err) {
					this.#showError(err instanceof Error ? err.message : String(err));
					this.#toggling = false;
					this.#onRequestRender?.();
					return;
				}
				this.#globalSessions = global;
				this.#messageContainer.clear();
				this.#toggling = false;
			}
			this.#scope = "flat";
			this.#sessionList.setSessions(global, true);
		} else if (this.#scope === "flat") {
			this.#scope = "grouped";
			this.#sessionList.setSessions(this.#globalSessions ?? [], true, true);
		} else {
			this.#scope = "folder";
			this.#sessionList.setSessions(this.#folderSessions, false);
		}
		this.title = this.#headerLabel();
		this.#onRequestRender?.();
	}

	setOnRequestRender(callback: () => void): void {
		this.#onRequestRender = callback;
	}
	/** Ignore input after selection while the host resumes the session. */
	lockInput(): void {
		this.#inputLocked = true;
	}
	/** Re-enable input after a failed resume so the user can pick again. */
	unlockInput(): void {
		this.#inputLocked = false;
	}

	/**
	 * Dispose the session list explicitly: while the delete-confirmation dialog
	 * is mounted the list is detached from the child tree, so Container's
	 * child-walking dispose would miss its pending history-merge timer.
	 */
	override dispose(): void {
		this.#sessionList.dispose();
		super.dispose();
	}

	#clearError(): void {
		this.#messageContainer.clear();
	}

	#showError(message: string): void {
		this.#messageContainer.clear();
		this.#messageContainer.addChild(new Text(theme.fg("error", `${t("Error")}: ${replaceTabs(message)}`), 0, 0));
		this.#messageContainer.addChild(new Spacer(1));
	}

	#showDeleteConfirmation(session: T): void {
		const displayName = session.title || session.firstMessage.slice(0, 40) || session.id;
		const closeDialog = () => {
			this.#confirmationDialog = null;
			// Restore the SessionList into the content slot so the picker is back
			// to its normal layout on the very next render — the same frame the
			// dialog disappears.
			this.#contentSlot.clear();
			this.#contentSlot.addChild(this.#sessionList);
			this.#onRequestRender?.();
		};
		this.#confirmationDialog = new HookSelectorComponent(
			`${t("Delete session?")}\n${displayName}`,
			[t("Yes"), t("No")],
			async (option: string) => {
				if (option === t("Yes") && this.#onDelete) {
					this.#clearError();
					try {
						const deleted = await this.#onDelete(session);
						if (deleted) {
							this.#sessionList.removeSession(session.path);
							this.#folderSessions = this.#folderSessions.filter(s => s.path !== session.path);
							if (this.#globalSessions) {
								this.#globalSessions = this.#globalSessions.filter(s => s.path !== session.path);
							}
						}
					} catch (err) {
						this.#showError(err instanceof Error ? err.message : String(err));
					}
				}
				closeDialog();
			},
			closeDialog,
		);
		// Swap the SessionList out of the content slot and mount the dialog in its
		// place: the dialog competes only with the SessionList's rendered budget,
		// never the SessionList AND the picker chrome, so the picker frame stays
		// inside the terminal viewport and the TUI never commits the header into
		// scrollback (issue #3283).
		this.#contentSlot.clear();
		this.#contentSlot.addChild(this.#confirmationDialog);
		this.#onRequestRender?.();
	}

	/**
	 * Render the panel directly so fill-height mode can keep its footer pinned
	 * while sharing OverlayPanel's exact rounded-box chrome. Children receive
	 * the panel's inner width before their rows are wrapped.
	 */
	override render(width: number): readonly string[] {
		const innerWidth = Math.max(1, width - 4);
		const lines: string[] = [topBorder(width, this.title)];
		for (const child of this.children) {
			const childLines = child.render(innerWidth);
			if (child === this.#contentSlot) this.#listLineOffset = lines.length;
			for (const line of childLines) lines.push(row(line, width));
		}
		const footer = this.#footerLines(width);
		if (this.#fillHeight) {
			const target = Math.max(0, this.#getTerminalRows() - footer.length);
			if (lines.length > target) lines.length = target;
			else for (let i = lines.length; i < target; i++) lines.push(row("", width));
		}
		this.#footerStart = lines.length;
		for (const line of footer) lines.push(line);
		return lines;
	}

	/** Blank · keybinding hint · bottom border. Rendered by {@link render}. */
	#footerLines(width: number): string[] {
		const scopeHint =
			this.#scope === "folder" ? t("all projects") : this.#scope === "flat" ? t("by parent") : t("current folder");
		const hint = theme.fg(
			"muted",
			t("[Del/⌫ delete · Enter select · Tab {scope} · Esc cancel]", { scope: scopeHint }),
		);
		return [row("", width), row(hint, width), row("", width), bottomBorder(width)];
	}

	handleInput(keyData: string): void {
		if (this.#inputLocked) return;
		if (keyData.startsWith("\x1b[<")) {
			this.#handleMouse(keyData);
			return;
		}
		if (this.#confirmationDialog) {
			this.#confirmationDialog.handleInput(keyData);
		} else {
			this.#sessionList.handleInput(keyData);
		}
	}

	/**
	 * SGR mouse reports, delivered only while the picker holds the alternate
	 * screen (the fullscreen overlay enables tracking and paints from screen row
	 * 0). Wheel scrolls the list; a left click resumes the session under the
	 * pointer. Mouse is inert while the delete-confirmation dialog is open.
	 */
	#handleMouse(data: string): void {
		if (this.#confirmationDialog) return;
		routeSgrMouseInput(data, event => {
			if (event.row >= this.#footerStart) {
				this.#sessionList.setHoverIndex(null);
				this.#onRequestRender?.();
				return true;
			}
			const listLine = event.row - this.#listLineOffset;
			const handled = routeSelectListMouse(this.#sessionList, event, listLine);
			if (handled) this.#onRequestRender?.();
			return true;
		});
	}

	getSessionList(): SessionList<T> {
		return this.#sessionList;
	}
}
