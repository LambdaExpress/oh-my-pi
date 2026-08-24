/**
 * Diff pane of the git TUI, with four view modes:
 *
 * - `split` (default): old file left, new file right, aligned line-by-line
 *   with word-level intraline emphasis and faint fillers for one-sided rows.
 * - `inline`: the full file with deletions/additions stacked in place.
 * - `hunk`: only the changed regions (3 context lines), one block per hunk
 *   with `@@` headers and per-hunk stage/unstage/discard buttons.
 * - `file`: the current (new) side only, plain syntax-highlighted view.
 *
 * The right edge carries a minimap-style scrollbar encoding change density
 * (deletions > additions > changes > context, hunk headers in accent) with
 * the visible viewport brightened; clicking it seeks. Long lines either pan
 * horizontally (`←`/`→`) or soft-wrap when word wrap is enabled.
 */
import { diffWords, structuredPatchHunks } from "@oh-my-pi/pi-natives";
import { replaceTabs, sliceWithWidth, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { getLanguageFromPath, highlightCode, theme } from "../../modes/theme/theme";
import { bgAnsi, canvasHex, fgAnsi, mixHex, pill, selectionBgAnsi, textHex, withBg } from "./colors";

/** Column ranges (inclusive start, exclusive end) carrying intraline emphasis. */
type MarkRanges = readonly (readonly [number, number])[];

type RowKind = "context" | "change" | "add" | "del";

interface DiffRow {
	readonly kind: RowKind;
	readonly oldNum?: number;
	readonly newNum?: number;
	/** Syntax-highlighted, tab-expanded line for each side ("" when absent). */
	readonly oldText: string;
	readonly newText: string;
	readonly oldWidth: number;
	readonly newWidth: number;
	readonly oldMarks?: MarkRanges;
	readonly newMarks?: MarkRanges;
	/** Raw (untab-expanded) source lines, for patch construction. */
	readonly oldRaw?: string;
	readonly newRaw?: string;
}

/** One changed region with its applyable patch for hunk-level staging. */
export interface HunkBlock {
	/** `@@ -a,b +c,d @@` header shown above the block. */
	readonly header: string;
	/** Standalone patch text for this hunk, or "" when not applyable. */
	readonly patch: string;
	readonly rows: readonly DiffRow[];
}

/** Aligned diff document produced by {@link buildDiffDocument}. */
export interface DiffDocument {
	readonly filePath: string;
	readonly rows: readonly DiffRow[];
	readonly hunks: readonly HunkBlock[];
	/** New-side lines for the `file` view (highlighted + display width). */
	readonly fileLines: readonly { text: string; width: number }[];
	readonly additions: number;
	readonly deletions: number;
	readonly gutterWidth: number;
	readonly maxLineWidth: number;
	/** False when built with whitespace-ignore: hunk patches would not apply. */
	readonly canPatch: boolean;
	/** Raw input texts and newline state, for line-selection patches. */
	readonly rawOld: string;
	readonly rawNew: string;
	readonly oldEndsNewline: boolean;
	readonly newEndsNewline: boolean;
	/** Index into {@link rows} for each 1-based new-file line number. */
	readonly rowIndexByNewLine: readonly number[];
}

/** How the pane presents the document. */
export type ViewMode = "split" | "inline" | "hunk" | "file";

/** Hunk-button actions raised to the root component. */
export type HunkAction = "stage" | "unstage" | "discard";

/** Skip syntax highlighting above this size to keep the pane responsive. */
const HIGHLIGHT_LIMIT_BYTES = 512 * 1024;
/** Cap on intraline word-diff pairs per document. */
const INTRALINE_PAIR_LIMIT = 1_500;
/** Context lines around each hunk in the hunk view. */
const HUNK_CONTEXT = 3;

function intralineMarks(oldLine: string, newLine: string): { old: MarkRanges; new: MarkRanges } {
	const oldRanges: [number, number][] = [];
	const newRanges: [number, number][] = [];
	let oldCol = 0;
	let newCol = 0;
	for (const change of diffWords(oldLine, newLine)) {
		const width = visibleWidth(change.value);
		if (change.removed) {
			pushRange(oldRanges, oldCol, oldCol + width);
			oldCol += width;
		} else if (change.added) {
			pushRange(newRanges, newCol, newCol + width);
			newCol += width;
		} else {
			oldCol += width;
			newCol += width;
		}
	}
	return { old: oldRanges, new: newRanges };
}

function pushRange(ranges: [number, number][], start: number, end: number): void {
	if (end <= start) return;
	const last = ranges[ranges.length - 1];
	if (last && start <= last[1]) last[1] = Math.max(last[1], end);
	else ranges.push([start, end]);
}

/** Options for {@link buildDiffDocument}. */
export interface DiffBuildOptions {
	/** Align ignoring leading/trailing whitespace (disables hunk patches). */
	ignoreWhitespace?: boolean;
}

/** Build the aligned document for one file from its raw old/new texts. */
export function buildDiffDocument(
	oldRaw: string,
	newRaw: string,
	filePath: string,
	options: DiffBuildOptions = {},
): DiffDocument {
	const ignoreWs = options.ignoreWhitespace === true;
	const oldLines = oldRaw.length === 0 ? [] : oldRaw.replace(/\n$/, "").split("\n");
	const newLines = newRaw.length === 0 ? [] : newRaw.replace(/\n$/, "").split("\n");
	const oldPlain = oldLines.map(replaceTabs);
	const newPlain = newLines.map(replaceTabs);
	const lang = getLanguageFromPath(filePath);
	const highlightable = oldRaw.length + newRaw.length <= HIGHLIGHT_LIMIT_BYTES;
	const oldHl = highlightable && lang ? highlightCode(oldPlain.join("\n"), lang) : oldPlain;
	const newHl = highlightable && lang ? highlightCode(newPlain.join("\n"), lang) : newPlain;

	// Alignment basis: raw lines, or trimmed lines when ignoring whitespace.
	// Line numbers stay 1:1 with the raw text either way.
	// The raw text is passed through untouched so trailing-newline state is
	// preserved — hunk patches must match `git apply`'s view of the file.
	const oldBasis = ignoreWs
		? oldLines.map(line => line.trim()).join("\n") + (oldRaw.endsWith("\n") ? "\n" : "")
		: oldRaw;
	const newBasis = ignoreWs
		? newLines.map(line => line.trim()).join("\n") + (newRaw.endsWith("\n") ? "\n" : "")
		: newRaw;

	let additions = 0;
	let deletions = 0;
	let intralinePairs = 0;
	let maxLineWidth = 0;
	const touch = (line: string | undefined): void => {
		if (line !== undefined) maxLineWidth = Math.max(maxLineWidth, line.length);
	};

	const makeRow = (kind: RowKind, oldIdx: number | undefined, newIdx: number | undefined): DiffRow => {
		let marks: { old: MarkRanges; new: MarkRanges } | undefined;
		if (kind === "change" && oldIdx !== undefined && newIdx !== undefined && intralinePairs < INTRALINE_PAIR_LIMIT) {
			intralinePairs++;
			marks = intralineMarks(oldPlain[oldIdx] ?? "", newPlain[newIdx] ?? "");
		}
		return {
			kind,
			oldNum: oldIdx === undefined ? undefined : oldIdx + 1,
			newNum: newIdx === undefined ? undefined : newIdx + 1,
			oldText: oldIdx === undefined ? "" : (oldHl[oldIdx] ?? ""),
			newText: newIdx === undefined ? "" : (newHl[newIdx] ?? ""),
			oldWidth: oldIdx === undefined ? 0 : visibleWidth(oldPlain[oldIdx] ?? ""),
			newWidth: newIdx === undefined ? 0 : visibleWidth(newPlain[newIdx] ?? ""),
			oldMarks: marks?.old,
			newMarks: marks?.new,
			oldRaw: oldIdx === undefined ? undefined : oldLines[oldIdx],
			newRaw: newIdx === undefined ? undefined : newLines[newIdx],
		};
	};

	/** Walk one structured hunk into aligned rows (shared by both passes). */
	const walkHunk = (hunk: { oldStart: number; newStart: number; lines: string[] }, count: boolean): DiffRow[] => {
		const rows: DiffRow[] = [];
		let oldNum = hunk.oldStart;
		let newNum = hunk.newStart;
		let pendingDel: number[] = [];
		let pendingAdd: number[] = [];
		const flush = (): void => {
			const paired = Math.min(pendingDel.length, pendingAdd.length);
			for (let i = 0; i < paired; i++) rows.push(makeRow("change", pendingDel[i], pendingAdd[i]));
			for (let i = paired; i < pendingDel.length; i++) rows.push(makeRow("del", pendingDel[i], undefined));
			for (let i = paired; i < pendingAdd.length; i++) rows.push(makeRow("add", undefined, pendingAdd[i]));
			pendingDel = [];
			pendingAdd = [];
		};
		for (const line of hunk.lines) {
			const tag = line[0];
			if (tag === "\\") continue;
			if (tag === "-") {
				if (count) deletions++;
				touch(oldPlain[oldNum - 1]);
				pendingDel.push(oldNum - 1);
				oldNum++;
			} else if (tag === "+") {
				if (count) additions++;
				touch(newPlain[newNum - 1]);
				pendingAdd.push(newNum - 1);
				newNum++;
			} else {
				flush();
				touch(oldPlain[oldNum - 1]);
				touch(newPlain[newNum - 1]);
				rows.push(makeRow("context", oldNum - 1, newNum - 1));
				oldNum++;
				newNum++;
			}
		}
		flush();
		return rows;
	};

	// Pass 1: one mega-context hunk aligns the entire file.
	const megaHunks = structuredPatchHunks(oldBasis, newBasis, oldLines.length + newLines.length + 1);
	const rows: DiffRow[] = [];
	for (const hunk of megaHunks) rows.push(...walkHunk(hunk, true));
	if (megaHunks.length === 0) {
		// Identical files: show pure context.
		for (let i = 0; i < oldLines.length; i++) {
			touch(oldPlain[i]);
			rows.push(makeRow("context", i, i));
		}
	}

	// Pass 2: tight hunks for the hunk view + per-hunk patches. Patch bodies
	// must be raw lines, so whitespace-ignore alignment cannot produce patches.
	const canPatch = !ignoreWs;
	const tightHunks = structuredPatchHunks(oldBasis, newBasis, HUNK_CONTEXT);
	const hunks: HunkBlock[] = tightHunks.map(hunk => ({
		header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
		patch: canPatch
			? `--- a/${filePath}\n+++ b/${filePath}\n@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}\n`
			: "",
		rows: walkHunk(hunk, false),
	}));

	const fileLines = newPlain.map((line, i) => ({ text: newHl[i] ?? "", width: visibleWidth(line) }));
	const gutterWidth = Math.max(3, String(Math.max(oldLines.length, newLines.length)).length);
	const rowIndexByNewLine: number[] = new Array(newLines.length + 1).fill(-1);
	rows.forEach((row, index) => {
		if (row.newNum !== undefined && rowIndexByNewLine[row.newNum] === -1) rowIndexByNewLine[row.newNum] = index;
	});
	return {
		filePath,
		rows,
		hunks,
		fileLines,
		additions,
		deletions,
		gutterWidth,
		maxLineWidth,
		canPatch,
		rawOld: oldRaw,
		rawNew: newRaw,
		oldEndsNewline: oldRaw.endsWith("\n"),
		newEndsNewline: newRaw.endsWith("\n"),
		rowIndexByNewLine,
	};
}
/**
 * Build a patch covering only the changed rows inside `[from, to]` (indices
 * into `doc.rows`).
 *
 * - `apply`: base is the old side; the target adopts only the selected
 *   changes. Staging selected lines = apply this to the index.
 * - `revert`: base is the new side; the target undoes only the selected
 *   changes. Unstaging selected lines = apply `--cached`; discarding
 *   selected lines = apply to the worktree.
 *
 * Returns `null` when the selection touches no changes or the document
 * cannot produce patches (whitespace-ignore alignment).
 */
export function buildLineSelectionPatch(
	doc: DiffDocument,
	from: number,
	to: number,
	intent: "apply" | "revert",
): string | null {
	if (!doc.canPatch) return null;
	const target: string[] = [];
	let touched = false;
	for (let i = 0; i < doc.rows.length; i++) {
		const row = doc.rows[i];
		const selected = i >= from && i <= to;
		if (selected && row.kind !== "context") touched = true;
		const useNew = intent === "apply" ? selected : !selected;
		switch (row.kind) {
			case "context":
				target.push(row.oldRaw ?? "");
				break;
			case "change":
				target.push((useNew ? row.newRaw : row.oldRaw) ?? "");
				break;
			case "del":
				if (!useNew) target.push(row.oldRaw ?? "");
				break;
			case "add":
				if (useNew) target.push(row.newRaw ?? "");
				break;
		}
	}
	if (!touched) return null;
	const base = intent === "apply" ? doc.rawOld : doc.rawNew;
	const baseEndsNL = intent === "apply" ? doc.oldEndsNewline : doc.newEndsNewline;
	const otherEndsNL = intent === "apply" ? doc.newEndsNewline : doc.oldEndsNewline;
	const lastRow = doc.rows[doc.rows.length - 1];
	const lastSelected = lastRow !== undefined && to >= doc.rows.length - 1 && lastRow.kind !== "context";
	const endsNL = lastSelected ? otherEndsNL : baseEndsNL;
	const targetText = target.join("\n") + (endsNL && target.length > 0 ? "\n" : "");
	const hunks = structuredPatchHunks(base, targetText, HUNK_CONTEXT);
	if (hunks.length === 0) return null;
	const body = hunks
		.map(
			hunk =>
				`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}`,
		)
		.join("\n");
	return `--- a/${doc.filePath}\n+++ b/${doc.filePath}\n${body}\n`;
}

// ── palette ──────────────────────────────────────────────────────────────────

interface DiffPalette {
	addSoft: string;
	addStrong: string;
	delSoft: string;
	delStrong: string;
	fillAdd: string;
	fillDel: string;
	mapAdd: string;
	mapDel: string;
	mapChange: string;
	mapContext: string;
	mapHunk: string;
	gutterAdd: string;
	gutterDel: string;
}

let paletteCache: { key: string; palette: DiffPalette } | undefined;

function palette(): DiffPalette {
	const added = theme.getColorHex("toolDiffAdded");
	const removed = theme.getColorHex("toolDiffRemoved");
	const accent = theme.getColorHex("accent");
	const dark = theme.statusLineLuminance === undefined || theme.statusLineLuminance <= 0.5;
	const canvas = canvasHex();
	const text = textHex();
	const key = `${added}\u0000${removed}\u0000${accent}\u0000${dark}\u0000${canvas}\u0000${text}`;
	if (paletteCache?.key === key) return paletteCache.palette;
	const built: DiffPalette = {
		addSoft: bgAnsi(mixHex(canvas, added, dark ? 0.18 : 0.24)),
		addStrong: bgAnsi(mixHex(canvas, added, dark ? 0.42 : 0.48)),
		delSoft: bgAnsi(mixHex(canvas, removed, dark ? 0.18 : 0.24)),
		delStrong: bgAnsi(mixHex(canvas, removed, dark ? 0.42 : 0.48)),
		fillAdd: bgAnsi(mixHex(canvas, added, 0.07)),
		fillDel: bgAnsi(mixHex(canvas, removed, 0.07)),
		mapAdd: added,
		mapDel: removed,
		mapChange: mixHex(added, removed, 0.5),
		mapContext: mixHex(canvas, text, 0.2),
		mapHunk: accent,
		gutterAdd: added,
		gutterDel: removed,
	};
	paletteCache = { key, palette: built };
	return built;
}

// ── pane ─────────────────────────────────────────────────────────────────────

/** Placeholder states shown instead of a document. */
export type DiffPaneState = "empty" | "loading" | "binary" | "tooLarge" | "ready";

/** One rendered line of the current view. */
type Visual =
	| { t: "split"; row: DiffRow; seg: number; rowIndex: number }
	| { t: "line"; row: DiffRow; side: "old" | "new" | "both"; seg: number; rowIndex: number }
	| { t: "file"; index: number; seg: number; rowIndex: number }
	| { t: "header"; hunk: number }
	| { t: "blank" };

/** Result of a left click inside the pane. */
export type PaneClick = { type: "hunk-action"; hunk: HunkBlock; action: HunkAction } | { type: "handled" } | null;

/**
 * Scrollable diff viewport. The root component feeds it key/mouse input and
 * composes its rendered lines into the frame.
 */
export class DiffPane {
	#doc: DiffDocument | null = null;
	#docVersion = 0;
	state: DiffPaneState = "empty";
	/** Message shown in the empty state. */
	emptyMessage = "No changes";
	mode: ViewMode = "split";
	wrap = false;
	/** Which hunk buttons apply: staging (unstaged), unstaging (staged), or none. */
	patchTarget: "stage" | "unstage" | null = null;
	selectedHunk = 0;
	scrollTop = 0;
	scrollLeft = 0;
	/** Pane holds keyboard focus: cursor/selection highlights render. */
	focused = false;
	/** Cursor as a visual-row index; navigation keys move it. */
	cursor = 0;
	/** Shift-selection anchor (visual-row index), or null when no selection. */
	anchor: number | null = null;
	#lastHeight = 1;
	#lastWidth = 0;
	#layoutCache: { key: string; visuals: Visual[] } | undefined;
	/** Per visible row: clickable hunk-button ranges recorded during render. */
	#hits: ({ hunk: number; primary?: [number, number]; discard?: [number, number] } | undefined)[] = [];

	get doc(): DiffDocument | null {
		return this.#doc;
	}

	setDocument(doc: DiffDocument | null, state: DiffPaneState): void {
		this.#doc = doc;
		this.#docVersion++;
		this.state = state;
		this.scrollTop = 0;
		this.scrollLeft = 0;
		this.selectedHunk = 0;
		this.cursor = 0;
		this.anchor = null;
		if (doc && this.mode !== "file" && this.mode !== "hunk") {
			const visuals = this.#layout(this.#lastWidth || 80);
			const first = visuals.findIndex(visual => visualKind(visual) !== "context");
			if (first > 0) {
				this.cursor = first;
				this.scrollTop = Math.max(0, first - Math.floor(this.#lastHeight / 3));
			}
		}
	}

	setMode(mode: ViewMode): void {
		if (this.mode === mode) return;
		this.mode = mode;
		this.scrollTop = 0;
		this.scrollLeft = 0;
		this.cursor = 0;
		this.anchor = null;
	}

	cycleMode(): void {
		const order: ViewMode[] = ["split", "inline", "hunk", "file"];
		this.setMode(order[(order.indexOf(this.mode) + 1) % order.length]);
	}

	toggleWrap(): void {
		this.wrap = !this.wrap;
		this.scrollLeft = 0;
		this.#layoutCache = undefined;
	}

	// ── scrolling ──────────────────────────────────────────────────────────

	#total(): number {
		return this.#doc ? this.#layout(this.#lastWidth || 80).length : 0;
	}

	#clampScroll(): void {
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, this.#total() - this.#lastHeight)));
		const maxLeft = this.wrap ? 0 : Math.max(0, (this.#doc?.maxLineWidth ?? 0) - 8);
		this.scrollLeft = Math.max(0, Math.min(this.scrollLeft, maxLeft));
	}

	scrollBy(delta: number): void {
		this.scrollTop += delta;
		this.#clampScroll();
	}

	pageBy(direction: 1 | -1): void {
		this.scrollBy(direction * Math.max(1, this.#lastHeight - 2));
	}

	scrollLeftBy(delta: number): void {
		this.scrollLeft += delta;
		this.#clampScroll();
	}
	/** Move the read-only cursor; `extend` grows the shift selection. */
	moveCursor(delta: number, extend: boolean): void {
		const total = this.#total();
		if (total === 0) return;
		if (extend) {
			if (this.anchor === null) this.anchor = this.cursor;
		} else {
			this.anchor = null;
		}
		this.cursor = Math.max(0, Math.min(total - 1, this.cursor + delta));
		if (this.cursor < this.scrollTop) this.scrollTop = this.cursor;
		if (this.cursor >= this.scrollTop + this.#lastHeight) this.scrollTop = this.cursor - this.#lastHeight + 1;
		this.#clampScroll();
	}

	/** Drop the shift selection. True when there was one. */
	clearSelection(): boolean {
		if (this.anchor === null) return false;
		this.anchor = null;
		return true;
	}

	/**
	 * Selected span as indices into `doc.rows` (shift selection, or the cursor
	 * row alone). Null when the cursor sits on rows that cannot map back to the
	 * document (hunk-view rows, headers).
	 */
	get selection(): { from: number; to: number; explicit: boolean } | null {
		if (!this.#doc) return null;
		const visuals = this.#layout(this.#lastWidth || 80);
		const a = this.anchor === null ? this.cursor : Math.min(this.anchor, this.cursor);
		const b = this.anchor === null ? this.cursor : Math.max(this.anchor, this.cursor);
		let from = Number.POSITIVE_INFINITY;
		let to = -1;
		for (let i = a; i <= b; i++) {
			const index = visualRowIndex(visuals[i]);
			if (index >= 0) {
				from = Math.min(from, index);
				to = Math.max(to, index);
			}
		}
		return to >= 0 ? { from, to, explicit: this.anchor !== null } : null;
	}

	/** Center the viewport on a visual row (minimap seek, hunk jump). */
	seekTo(row: number): void {
		this.scrollTop = Math.round(row - this.#lastHeight / 2);
		this.#clampScroll();
	}

	/** Jump to the next/previous hunk; selects it in hunk view. */
	jumpHunk(direction: 1 | -1): void {
		const doc = this.#doc;
		if (!doc || doc.hunks.length === 0) return;
		const visuals = this.#layout(this.#lastWidth || 80);
		if (this.mode === "hunk") {
			this.selectedHunk = Math.max(0, Math.min(doc.hunks.length - 1, this.selectedHunk + direction));
			const header = visuals.findIndex(visual => visual.t === "header" && visual.hunk === this.selectedHunk);
			if (header >= 0) {
				this.cursor = header;
				this.anchor = null;
				this.scrollTop = Math.max(0, header - 1);
				this.#clampScroll();
			}
			return;
		}
		// Other modes: jump between change blocks.
		const starts: number[] = [];
		let inChange = false;
		for (let i = 0; i < visuals.length; i++) {
			const kind = visualKind(visuals[i]);
			const changed = kind !== "context" && kind !== null;
			if (changed && !inChange) starts.push(i);
			inChange = changed;
		}
		if (starts.length === 0) return;
		const reference = this.cursor;
		const next =
			direction > 0
				? (starts.find(start => start > reference) ?? starts[starts.length - 1])
				: ([...starts].reverse().find(start => start < reference) ?? starts[0]);
		this.cursor = next;
		this.anchor = null;
		this.scrollTop = Math.max(0, next - Math.floor(this.#lastHeight / 3));
		this.#clampScroll();
	}

	/** Currently selected hunk (hunk view), if any. */
	get currentHunk(): HunkBlock | null {
		return this.#doc?.hunks[this.selectedHunk] ?? null;
	}

	// ── mouse ──────────────────────────────────────────────────────────────

	/** Handle a left click at pane-local coordinates. */
	clickAt(col: number, row: number, shift = false): PaneClick {
		if (this.#lastWidth > 0 && col >= this.#lastWidth - 2) {
			const total = this.#total();
			if (total > 0 && this.#lastHeight > 0) this.seekTo(Math.floor(((row + 0.5) / this.#lastHeight) * total));
			return { type: "handled" };
		}
		const hit = this.#hits[row];
		if (hit && this.#doc) {
			this.selectedHunk = hit.hunk;
			if (hit.primary && col >= hit.primary[0] && col < hit.primary[1] && this.patchTarget) {
				return { type: "hunk-action", hunk: this.#doc.hunks[hit.hunk], action: this.patchTarget };
			}
			if (hit.discard && col >= hit.discard[0] && col < hit.discard[1] && this.patchTarget === "stage") {
				return { type: "hunk-action", hunk: this.#doc.hunks[hit.hunk], action: "discard" };
			}
			return { type: "handled" };
		}
		const visual = this.scrollTop + row;
		if (visual < this.#total()) {
			if (shift) {
				if (this.anchor === null) this.anchor = this.cursor;
			} else {
				this.anchor = null;
			}
			this.cursor = visual;
			return { type: "handled" };
		}
		return null;
	}

	// ── layout ─────────────────────────────────────────────────────────────

	#splitTextWidth(width: number): number {
		const gutter = this.#doc?.gutterWidth ?? 4;
		// [gutterL][ textL ][│][gutterR][ textR ][minimap(2)]
		return Math.max(8, Math.floor((width - 2 * (gutter + 2) - 1 - 2) / 2));
	}

	#lineTextWidth(width: number): number {
		const gutter = this.#doc?.gutterWidth ?? 4;
		// [oldNum][newNum][ text ][minimap(2)]
		return Math.max(8, width - 2 * (gutter + 1) - 3);
	}

	#layout(width: number): Visual[] {
		const doc = this.#doc;
		if (!doc) return [];
		const key = `${this.#docVersion}\u0000${this.mode}\u0000${this.wrap}\u0000${width}`;
		if (this.#layoutCache?.key === key) return this.#layoutCache.visuals;
		const visuals: Visual[] = [];
		const segsFor = (textWidth: number, ...widths: number[]): number =>
			this.wrap ? Math.max(1, Math.ceil(Math.max(...widths, 1) / textWidth)) : 1;
		switch (this.mode) {
			case "split": {
				const textWidth = this.#splitTextWidth(width);
				doc.rows.forEach((row, rowIndex) => {
					const segs = segsFor(textWidth, row.oldWidth, row.newWidth);
					for (let seg = 0; seg < segs; seg++) visuals.push({ t: "split", row, seg, rowIndex });
				});
				break;
			}
			case "inline": {
				const textWidth = this.#lineTextWidth(width);
				doc.rows.forEach((row, rowIndex) => {
					if (row.kind === "change") {
						for (let seg = 0; seg < segsFor(textWidth, row.oldWidth); seg++)
							visuals.push({ t: "line", row, side: "old", seg, rowIndex });
						for (let seg = 0; seg < segsFor(textWidth, row.newWidth); seg++)
							visuals.push({ t: "line", row, side: "new", seg, rowIndex });
					} else {
						const side = row.kind === "del" ? "old" : row.kind === "add" ? "new" : "both";
						const rowWidth = side === "old" ? row.oldWidth : row.newWidth;
						for (let seg = 0; seg < segsFor(textWidth, rowWidth); seg++)
							visuals.push({ t: "line", row, side, seg, rowIndex });
					}
				});
				break;
			}
			case "hunk": {
				const textWidth = this.#lineTextWidth(width);
				doc.hunks.forEach((hunk, index) => {
					visuals.push({ t: "header", hunk: index });
					for (const row of hunk.rows) {
						if (row.kind === "change") {
							for (let seg = 0; seg < segsFor(textWidth, row.oldWidth); seg++)
								visuals.push({ t: "line", row, side: "old", seg, rowIndex: -1 });
							for (let seg = 0; seg < segsFor(textWidth, row.newWidth); seg++)
								visuals.push({ t: "line", row, side: "new", seg, rowIndex: -1 });
						} else {
							const side = row.kind === "del" ? "old" : row.kind === "add" ? "new" : "both";
							const rowWidth = side === "old" ? row.oldWidth : row.newWidth;
							for (let seg = 0; seg < segsFor(textWidth, rowWidth); seg++)
								visuals.push({ t: "line", row, side, seg, rowIndex: -1 });
						}
					}
					visuals.push({ t: "blank" });
				});
				break;
			}
			case "file": {
				const gutter = doc.gutterWidth;
				const textWidth = Math.max(8, width - gutter - 1 - 2 - 2);
				doc.fileLines.forEach((line, index) => {
					const rowIndex = doc.rowIndexByNewLine[index + 1] ?? -1;
					for (let seg = 0; seg < segsFor(textWidth, line.width); seg++)
						visuals.push({ t: "file", index, seg, rowIndex });
				});
				break;
			}
		}
		this.#layoutCache = { key, visuals };
		return visuals;
	}

	// ── render ─────────────────────────────────────────────────────────────

	render(width: number, height: number): string[] {
		this.#lastWidth = width;
		this.#lastHeight = height;
		this.#hits = new Array(height);
		const doc = this.#doc;
		if (!doc || this.state !== "ready") {
			const message =
				this.state === "loading"
					? "Loading diff…"
					: this.state === "binary"
						? "Binary file"
						: this.state === "tooLarge"
							? "File too large to diff"
							: this.emptyMessage;
			const lines: string[] = [];
			for (let i = 0; i < height; i++) {
				lines.push(
					i === Math.floor(height / 2) ? truncateToWidth(centerText(theme.fg("dim", message), width), width) : "",
				);
			}
			return lines;
		}

		const visuals = this.#layout(width);
		this.#clampScroll();
		const colors = palette();
		const minimap = this.#renderMinimap(visuals, height, colors);
		const selectFrom = this.anchor === null ? this.cursor : Math.min(this.anchor, this.cursor);
		const selectTo = this.anchor === null ? this.cursor : Math.max(this.anchor, this.cursor);
		const selectionBg = selectionBgAnsi();
		const lines: string[] = [];
		for (let i = 0; i < height; i++) {
			const visual = visuals[this.scrollTop + i];
			if (!visual) {
				lines.push(`${" ".repeat(Math.max(0, width - 1))}${minimap[i]}`);
				continue;
			}
			// Pad every body to exactly width-2 so the minimap column never drifts.
			const body = this.#renderVisual(visual, doc, width, colors, i);
			let padded = `${body}${" ".repeat(Math.max(0, width - 2 - visibleWidth(body)))}`;
			const visualIndex = this.scrollTop + i;
			if (this.focused && visualIndex >= selectFrom && visualIndex <= selectTo) {
				padded = `${withBg(padded, selectionBg)}\x1b[0m`;
			}
			lines.push(`${padded} ${minimap[i]}`);
		}
		return lines;
	}

	#renderVisual(visual: Visual, doc: DiffDocument, width: number, colors: DiffPalette, screenRow: number): string {
		switch (visual.t) {
			case "blank":
				return " ".repeat(Math.max(0, width - 2));
			case "header":
				return this.#renderHeader(visual.hunk, doc, width, screenRow);
			case "split": {
				const textWidth = this.#splitTextWidth(width);
				const startCol = this.wrap ? visual.seg * textWidth : this.scrollLeft;
				const left = this.#renderSide(
					visual.row,
					"old",
					doc.gutterWidth,
					textWidth,
					colors,
					startCol,
					visual.seg === 0,
				);
				const right = this.#renderSide(
					visual.row,
					"new",
					doc.gutterWidth,
					textWidth,
					colors,
					startCol,
					visual.seg === 0,
				);
				return `${left}${theme.fg("borderMuted", "│")}${right}`;
			}
			case "line":
				return this.#renderLine(visual, doc, width, colors);
			case "file": {
				const gutter = doc.gutterWidth;
				const textWidth = Math.max(8, width - gutter - 1 - 2 - 2);
				const startCol = this.wrap ? visual.seg * textWidth : this.scrollLeft;
				const line = doc.fileLines[visual.index];
				const slice = sliceWithWidth(line.text, startCol, textWidth);
				const gutterText =
					visual.seg === 0 ? theme.fg("dim", String(visual.index + 1).padStart(gutter)) : " ".repeat(gutter);
				return `${gutterText} ${slice.text}${" ".repeat(Math.max(0, textWidth - slice.width))}`;
			}
		}
	}

	#renderHeader(hunkIndex: number, doc: DiffDocument, width: number, screenRow: number): string {
		const hunk = doc.hunks[hunkIndex];
		const selected = this.mode === "hunk" && hunkIndex === this.selectedHunk;
		const headerText = selected ? theme.fg("accent", theme.bold(hunk.header)) : theme.fg("accent", hunk.header);
		let buttons = "";
		let primary: [number, number] | undefined;
		let discard: [number, number] | undefined;
		if (this.patchTarget && doc.canPatch) {
			const primaryLabel =
				this.patchTarget === "stage"
					? pill(" Stage Hunk ", theme.getColorHex("toolDiffAdded"))
					: pill(" Unstage Hunk ", theme.getColorHex("warning"));
			const discardLabel =
				this.patchTarget === "stage" ? pill(" Discard Hunk ", theme.getColorHex("toolDiffRemoved")) : "";
			const total = visibleWidth(primaryLabel) + (discardLabel ? visibleWidth(discardLabel) + 1 : 0);
			const from = Math.max(0, width - 2 - total);
			let cursor = from;
			if (discardLabel) {
				discard = [cursor, cursor + visibleWidth(discardLabel)];
				buttons += `${discardLabel} `;
				cursor += visibleWidth(discardLabel) + 1;
			}
			primary = [cursor, cursor + visibleWidth(primaryLabel)];
			buttons += primaryLabel;
			this.#hits[screenRow] = { hunk: hunkIndex, primary, discard };
			const pad = Math.max(1, from - visibleWidth(hunk.header) - (selected ? 2 : 0));
			return truncateToWidth(
				`${selected ? theme.fg("accent", "▶ ") : ""}${headerText}${" ".repeat(pad)}${buttons}`,
				width - 2,
			);
		}
		this.#hits[screenRow] = { hunk: hunkIndex };
		return truncateToWidth(`${selected ? theme.fg("accent", "▶ ") : ""}${headerText}`, width - 2);
	}

	#renderLine(visual: Visual & { t: "line" }, doc: DiffDocument, width: number, colors: DiffPalette): string {
		const { row, side, seg } = visual;
		const gutter = doc.gutterWidth;
		const textWidth = this.#lineTextWidth(width);
		const startCol = this.wrap ? seg * textWidth : this.scrollLeft;
		const first = seg === 0;
		const oldLabel =
			first && row.oldNum !== undefined && side !== "new" ? String(row.oldNum).padStart(gutter) : " ".repeat(gutter);
		const newLabel =
			first && row.newNum !== undefined && side !== "old" ? String(row.newNum).padStart(gutter) : " ".repeat(gutter);
		const isDel = side === "old" && row.kind !== "context";
		const isAdd = side === "new" && row.kind !== "context";
		const gutterText = isDel
			? `${fgAnsi(colors.gutterDel) + oldLabel + " ".repeat(gutter + 1)}\x1b[0m`
			: isAdd
				? `${" ".repeat(gutter)}${fgAnsi(colors.gutterAdd)}${newLabel}\x1b[0m `
				: theme.fg("dim", `${oldLabel}${newLabel} `);
		const text = side === "old" ? row.oldText : row.newText;
		const marks = side === "old" ? row.oldMarks : row.newMarks;
		let body: string;
		if (!isDel && !isAdd) {
			const slice = sliceWithWidth(text, startCol, textWidth);
			body = ` ${slice.text}${" ".repeat(Math.max(0, textWidth - slice.width))} `;
		} else {
			const soft = isDel ? colors.delSoft : colors.addSoft;
			const strong = isDel ? colors.delStrong : colors.addStrong;
			if (marks && marks.length > 0 && row.kind === "change") {
				body = `${withBg(` ${this.#renderMarked(text, marks, textWidth, soft, strong, startCol)} `, soft)}\x1b[0m`;
			} else {
				const slice = sliceWithWidth(text, startCol, textWidth);
				body = `${withBg(` ${slice.text}${" ".repeat(Math.max(0, textWidth - slice.width))} `, soft)}\x1b[0m`;
			}
		}
		return `${gutterText}${body}`;
	}

	#renderSide(
		row: DiffRow,
		side: "old" | "new",
		gutter: number,
		textWidth: number,
		colors: DiffPalette,
		startCol: number,
		first: boolean,
	): string {
		const num = side === "old" ? row.oldNum : row.newNum;
		const text = side === "old" ? row.oldText : row.newText;
		const marks = side === "old" ? row.oldMarks : row.newMarks;
		const present = num !== undefined;
		const changed = row.kind === "change" || (side === "old" ? row.kind === "del" : row.kind === "add");

		let gutterText: string;
		if (present && first) {
			const label = String(num).padStart(gutter);
			gutterText = changed
				? `${fgAnsi(side === "old" ? colors.gutterDel : colors.gutterAdd) + label}\x1b[0m`
				: theme.fg("dim", label);
		} else {
			gutterText = " ".repeat(gutter);
		}

		if (!present) {
			// Filler side of a one-sided row: faint tint, no text.
			const fill = side === "old" ? colors.fillDel : colors.fillAdd;
			const tinted = row.kind === "add" || row.kind === "del";
			const body = tinted ? `${fill}${" ".repeat(textWidth + 2)}\x1b[0m` : " ".repeat(textWidth + 2);
			return `${gutterText}${body}`;
		}

		const soft = side === "old" ? colors.delSoft : colors.addSoft;
		const strong = side === "old" ? colors.delStrong : colors.addStrong;
		let body: string;
		if (!changed) {
			const slice = sliceWithWidth(text, startCol, textWidth);
			body = ` ${slice.text}${" ".repeat(Math.max(0, textWidth - slice.width))} `;
		} else if (marks && marks.length > 0) {
			body = `${withBg(` ${this.#renderMarked(text, marks, textWidth, soft, strong, startCol)} `, soft)}\x1b[0m`;
		} else {
			const slice = sliceWithWidth(text, startCol, textWidth);
			body = `${withBg(` ${slice.text}${" ".repeat(Math.max(0, textWidth - slice.width))} `, soft)}\x1b[0m`;
		}
		return `${gutterText}${body}`;
	}

	/** Compose a changed line from soft/strong background segments along mark ranges. */
	#renderMarked(
		text: string,
		marks: MarkRanges,
		textWidth: number,
		soft: string,
		strong: string,
		startCol: number,
	): string {
		const end = startCol + textWidth;
		let cursor = startCol;
		let out = "";
		let used = 0;
		const emit = (from: number, to: number, bg: string): void => {
			if (to <= from) return;
			const slice = sliceWithWidth(text, from, to - from);
			out += `${withBg(slice.text, bg)}\x1b[0m`;
			used += slice.width;
		};
		for (const [markStart, markEnd] of marks) {
			if (markEnd <= cursor) continue;
			if (markStart >= end) break;
			emit(cursor, Math.min(markStart, end), soft);
			emit(Math.max(markStart, cursor), Math.min(markEnd, end), strong);
			cursor = Math.min(markEnd, end);
		}
		emit(cursor, end, soft);
		if (used < textWidth) out += `${soft}${" ".repeat(textWidth - used)}\x1b[0m`;
		return out;
	}

	#renderMinimap(visuals: Visual[], height: number, colors: DiffPalette): string[] {
		const total = visuals.length;
		const lines: string[] = [];
		const bandKind = (band: number): RowKind | "hunk" | null => {
			const from = Math.floor((band * total) / (height * 2));
			const to = Math.max(from + 1, Math.floor(((band + 1) * total) / (height * 2)));
			if (from >= total) return null;
			let best: RowKind | "hunk" = "context";
			for (let i = from; i < Math.min(to, total); i++) {
				const kind = visualKind(visuals[i]);
				if (kind === "del") return "del";
				if (kind === "add") best = "add";
				else if (kind === "change" && best !== "add") best = "change";
				else if (kind === "hunk" && best === "context") best = "hunk";
			}
			return best;
		};
		const kindColor = (kind: RowKind | "hunk" | null, band: number): string | null => {
			if (kind === null) return null;
			const base =
				kind === "del"
					? colors.mapDel
					: kind === "add"
						? colors.mapAdd
						: kind === "change"
							? colors.mapChange
							: kind === "hunk"
								? colors.mapHunk
								: colors.mapContext;
			const docRow = Math.floor((band * total) / (height * 2));
			const inViewport = docRow >= this.scrollTop && docRow < this.scrollTop + height;
			return inViewport ? mixHex(base, textHex(), 0.25) : base;
		};
		for (let i = 0; i < height; i++) {
			const topColor = kindColor(bandKind(i * 2), i * 2);
			const bottomColor = kindColor(bandKind(i * 2 + 1), i * 2 + 1);
			if (topColor === null && bottomColor === null) {
				lines.push(" ");
			} else {
				const fg = fgAnsi(topColor ?? bottomColor ?? "#000000");
				const bg = bottomColor ? bgAnsi(bottomColor) : "";
				lines.push(`${fg}${bg}▀\x1b[0m`);
			}
		}
		return lines;
	}
}

/** Index into `doc.rows` a visual maps to, or -1 (headers, blanks, hunk rows). */
function visualRowIndex(visual: Visual | undefined): number {
	if (!visual) return -1;
	switch (visual.t) {
		case "split":
		case "line":
		case "file":
			return visual.rowIndex;
		default:
			return -1;
	}
}

function visualKind(visual: Visual): RowKind | "hunk" | null {
	switch (visual.t) {
		case "split":
			return visual.row.kind;
		case "line":
			return visual.row.kind === "change" ? (visual.side === "old" ? "del" : "add") : visual.row.kind;
		case "header":
			return "hunk";
		case "file":
			return "context";
		default:
			return null;
	}
}

function centerText(text: string, width: number): string {
	const pad = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
	return " ".repeat(pad) + text;
}
