import { type Component, Container, type HistoryBatch } from "../tui";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { isToolActivityComponent, isToolRowsFoldComponent } from "./tool-activity";

/** Shared animation time supplied by the constrained transcript root. */
export interface AnimationFrame {
	readonly tick: number;
	readonly now: number;
}

/** Lets an active block adapt its presentation to its allocated viewport rows. */
export interface TranscriptPresentationTarget {
	setTranscriptAllocation?(rows: number, frame: AnimationFrame): void;
}

/** Presentation declaration captured permanently when a block is added. */
export type TranscriptBlockMode = "mutable" | "appendOnly";

/** Immutable width-independent identity for one stable semantic row. */
export interface TranscriptStableRow {
	readonly key: string;
}

/** Explicit semantic-row contract for a block whose stable head may enter native history. */
export interface AppendOnlyTranscriptBlock {
	readonly transcriptBlockMode: "appendOnly";
	getTranscriptStableRows(): readonly TranscriptStableRow[];
	renderTranscriptStableRows(count: number, width: number): readonly string[];
	/**
	 * Discard every published stable row so the block re-renders its head from
	 * scratch. Called only alongside a destructive display reset (e.g. a
	 * thinking-visibility toggle) that clears the native scrollback those rows
	 * occupied — the sole context in which the append-only "published bytes never
	 * change" contract may be retracted. Optional: blocks whose stable-row
	 * presentation never changes may omit it.
	 */
	resetTranscriptStableRows?(): void;
	/**
	 * Whether the container may retire this block's live rows before
	 * finalization — the overflow safety valve, which writes rows terminal
	 * history cannot later retract. Blocks whose bytes may still be revised
	 * (a `stream-revision: possible` wire) answer false; finalization still
	 * retires the whole block. Absent: allowed.
	 */
	allowsMidStreamRetirement?(): boolean;
}

interface FinalizableBlock {
	isTranscriptBlockFinalized?(): boolean;
	/** Legacy provider-declared settled prefix; retained for mutable blocks. */
	getTranscriptBlockSettledPrefix?(
		width: number,
		rendered: readonly string[],
	): { rowCount: number; cursor: unknown } | undefined;
	resolveTranscriptBlockSettledPrefix?(
		cursor: unknown,
		width: number,
		rendered: readonly string[],
	): number | undefined;
	/** Zero-row ordering markers may let finalized successors retire while marker remains open. */
	allowsTranscriptSuccessorRetirement?(): boolean;
}

/**
 * Block lifecycle:
 * - `active`: still mutating; renders live and counts against tool admission.
 * - `settled`: finalized but retained in the mutable viewport until pressure.
 * - `committed`: logically retired; replay never rewinds this state.
 */
type BlockState = "active" | "settled" | "committed";

interface TranscriptEntry {
	component: Component;
	state: BlockState;
	mode: TranscriptBlockMode;
	stableRows: readonly TranscriptStableRow[];
	renderedStableByWidth: Map<number, readonly string[]>;
	/**
	 * Rendered row counts per `(width, snapshot count)`: lets the projected
	 * length skip the re-render when the same prefix was already rendered.
	 * Keyed on both dimensions because one snapshot commonly renders to
	 * multiple physical rows (Markdown wrap).
	 */
	stableRowCountByWidth: Map<number, Map<number, number>>;
	emitted: number;
	/**
	 * Set when a published stable row drifted (retraction, byte change within a
	 * width epoch, or no longer a render prefix). Rows already in native
	 * scrollback cannot be retracted, so the entry keeps its last good stable
	 * state for emitted-row slicing but never emits another mid-stream row.
	 */
	stableFrozen: boolean;
	/** Exact active rows already appended as an overflow safety valve. */
	snapshot?: SnapshotWatermark;
	partial?: PartialWatermark;
}

interface PartialWatermark {
	cursor: unknown;
	width: number;
	rowCount: number;
}

interface SnapshotWatermark {
	width: number;
	rowCount: number;
	prefix: readonly string[];
	separator: boolean;
}

interface RetirementPreservingRebuild {
	entries: readonly TranscriptEntry[];
	width: number;
}

type RetirementPolicy = "pressure" | "flush";
type Offered =
	| { batch: HistoryBatch; kind: "append"; entry: number; emittedEnd: number }
	| { batch: HistoryBatch; kind: "snapshot"; entry: number; watermark: SnapshotWatermark }
	| {
			batch: HistoryBatch;
			kind: "commit";
			entries: readonly number[];
			partial?: { entry: number; watermark: PartialWatermark };
	  }
	| { batch: HistoryBatch; kind: "replay" };

const MAX_LIVE_BLOCKS = 256;
/** Grace before a pressure-blocked frontier is reported; a streaming block may legitimately hold it briefly. */
const PINNED_FRONTIER_WARN_MS = 30_000;
const EMPTY_ROWS: readonly string[] = [];
const EMPTY_STABLE_ROWS: readonly TranscriptStableRow[] = [];

function isFinalized(component: Component): boolean {
	const block = component as Component & FinalizableBlock;
	return block.isTranscriptBlockFinalized?.() ?? true;
}

function blockMode(component: Component): TranscriptBlockMode {
	return (component as Component & Partial<AppendOnlyTranscriptBlock>).transcriptBlockMode === "appendOnly"
		? "appendOnly"
		: "mutable";
}

function allowsSuccessorRetirement(component: Component): boolean {
	return (component as Component & FinalizableBlock).allowsTranscriptSuccessorRetirement?.() === true;
}

/** A block's live rows retire mid-stream unless it declares its bytes revisable. */
function allowsMidStreamRetirement(component: Component): boolean {
	return (component as Component & AppendOnlyTranscriptBlock).allowsMidStreamRetirement?.() !== false;
}

function isPlainBlank(line: string): boolean {
	return !/\S/.test(line);
}

/** Whether `prefix` matches `rows` byte-for-byte from the top. */
export function isRowPrefix(prefix: readonly string[], rows: readonly string[]): boolean {
	if (prefix.length > rows.length) return false;
	for (let index = 0; index < prefix.length; index++) {
		if (prefix[index] !== rows[index]) return false;
	}
	return true;
}

function isStablePrefix(prefix: readonly TranscriptStableRow[], rows: readonly TranscriptStableRow[]): boolean {
	if (prefix.length > rows.length) return false;
	for (let index = 0; index < prefix.length; index++) {
		if (prefix[index]!.key !== rows[index]!.key) return false;
	}
	return true;
}

function hasSameVisibleRows(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		if (Bun.stripANSI(left[index]!) !== Bun.stripANSI(right[index]!)) return false;
	}
	return true;
}

/** Strip leading/trailing all-blank rows; the viewport allocator measures blocks by this trimmed height. */
export function trimBlankEdges(rows: readonly string[]): readonly string[] {
	let start = 0;
	let end = rows.length;
	while (start < end && isPlainBlank(rows[start]!)) start++;
	while (end > start && isPlainBlank(rows[end - 1]!)) end--;
	return start === 0 && end === rows.length ? rows : rows.slice(start, end);
}

/** One live block's row span in the last `renderViewport` output (half-open `[start, end)`). */
export interface TranscriptViewportSpan {
	component: Component;
	start: number;
	end: number;
}

/** Owns transcript order, live capacity, and ordered immutable retirement. */
export class TranscriptContainer extends Container {
	#entries: TranscriptEntry[] = [];
	#frontier = 0;
	#nextBatchId = 1;
	#offered: Offered | undefined;
	#replayPending = false;
	#replayRequested = false;
	#toolActivityVisible = true;
	#toolRowsFolded = false;
	// Tail of the immutable terminal tape: the block whose rows were written
	// last, and whether a separator blank already follows them. Separators are
	// only ever written by the block that FOLLOWS, because a run of folded tool
	// rows is open-ended — the next row of the run may arrive long after this one
	// retires, and a trailing blank written now could not be taken back.
	#tapeTail: { component: Component | undefined; separated: boolean } = {
		component: undefined,
		separated: false,
	};
	#lastFrame: AnimationFrame = { tick: 0, now: 0 };
	#retirementPreservingRebuild: RetirementPreservingRebuild | undefined;
	// Start rows from the last full render(), keyed by child component (transcript deep-links).
	#childStartRows = new Map<Component, number>();
	// Watchdog for the wedge where an unfinalized frontier block pins pressure
	// retirement: everything behind it stays live and degrades to one-line
	// allocations. Logs once per pinned episode after a grace period.
	#pinnedFrontier: { index: number; since: number; logged: boolean } | undefined;
	/** Block spans of the last `renderViewport` output, for click hit-testing. */
	#lastViewportSpans: TranscriptViewportSpan[] = [];
	override addChild(component: Component): void {
		if (isToolActivityComponent(component)) component.setToolActivityVisible(this.#toolActivityVisible);
		if (isToolRowsFoldComponent(component)) component.setToolRowsFolded(this.#toolRowsFolded);
		super.addChild(component);
		this.#entries.push({
			component,
			state: "active",
			mode: blockMode(component),
			stableRows: EMPTY_STABLE_ROWS,
			renderedStableByWidth: new Map(),
			stableRowCountByWidth: new Map(),
			emitted: 0,
			stableFrozen: false,
			snapshot: undefined,
			partial: undefined,
		});
	}

	override removeChild(component: Component): void {
		if (this.children.indexOf(component) < 0 || !this.canRemoveBlock(component)) return;
		super.removeChild(component);
		this.#entries = this.#entries.filter(candidate => candidate.component !== component);
		this.#frontier = Math.min(this.#frontier, this.#entries.length);
		this.#childStartRows.delete(component);
	}

	override clear(): void {
		super.clear();
		this.#entries = [];
		this.#frontier = 0;
		this.#offered = undefined;
		this.#childStartRows.clear();
		this.#pinnedFrontier = undefined;
		this.#replayPending = false;
		this.#replayRequested = false;
		this.#retirementPreservingRebuild = undefined;
		this.#lastViewportSpans = [];
		this.#tapeTail = { component: undefined, separated: false };
	}

	/**
	 * Clear the component tree for a rebuild that should retain the same visible
	 * history. {@link finishRetirementPreservingRebuild} transfers acknowledged
	 * native-scrollback ownership to equivalent rebuilt blocks.
	 */
	beginRetirementPreservingRebuild(width: number): void {
		this.#syncEntries();
		const entries = this.#entries.slice();
		super.clear();
		this.#entries = [];
		this.#frontier = 0;
		this.#offered = undefined;
		this.#childStartRows.clear();
		this.#pinnedFrontier = undefined;
		this.#replayPending = false;
		this.#replayRequested = false;
		this.#retirementPreservingRebuild = { entries, width: Math.max(1, Math.trunc(width)) };
	}

	/**
	 * Reconcile rebuilt blocks with the rows already owned by native scrollback.
	 * Returns false when any retired block changed shape; callers must then erase
	 * and replay the logical transcript instead of appending across the mismatch.
	 */
	finishRetirementPreservingRebuild(): boolean {
		const rebuild = this.#retirementPreservingRebuild;
		if (!rebuild) return true;
		this.#retirementPreservingRebuild = undefined;
		let preserved = true;
		for (let index = 0; index < rebuild.entries.length; index++) {
			const previous = rebuild.entries[index]!;
			if (
				previous.state !== "committed" &&
				previous.emitted === 0 &&
				previous.snapshot === undefined &&
				previous.partial === undefined
			)
				continue;
			const current = this.#entries[index];
			if (!current) {
				preserved = false;
				break;
			}
			if (previous.component === current.component) {
				this.#entries[index] = previous;
				continue;
			}
			this.#setAllocation(previous.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			this.#setAllocation(current.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const previousRows = trimBlankEdges(previous.component.render(rebuild.width));
			const currentRows = trimBlankEdges(current.component.render(rebuild.width));
			if (!isFinalized(current.component) || !hasSameVisibleRows(previousRows, currentRows)) {
				preserved = false;
				break;
			}
			if (previous.state === "committed") {
				this.#entries[index] = { ...current, state: "committed" };
				continue;
			}
			const retired = this.#retiredPrefixLength(previous, rebuild.width, previousRows);
			if (retired <= 0 || retired > currentRows.length) {
				preserved = false;
				break;
			}
			this.#entries[index] = {
				...current,
				state: previous.state,
				snapshot: {
					width: rebuild.width,
					rowCount: retired,
					prefix: currentRows.slice(0, retired),
					separator: previous.snapshot?.separator === true,
				},
			};
		}
		this.#frontier = this.#entries.findIndex(entry => entry.state !== "committed");
		if (this.#frontier < 0) this.#frontier = this.#entries.length;
		return preserved;
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#toolActivityVisible === visible) return;
		this.#toolActivityVisible = visible;
		for (const child of this.children) {
			if (isToolActivityComponent(child)) child.setToolActivityVisible(visible);
		}
		this.invalidate();
	}

	/**
	 * Fold every tool row into its one-line activity summary (or restore the
	 * full cards). Children keep their own copy so blocks mounting later —
	 * live streaming, transcript rebuilds — land in the same presentation.
	 */
	setToolRowsFolded(folded: boolean): void {
		if (this.#toolRowsFolded === folded) return;
		this.#toolRowsFolded = folded;
		for (const child of this.children) {
			if (isToolRowsFoldComponent(child)) child.setToolRowsFolded(folded);
		}
		this.invalidate();
	}

	/**
	 * Forget the append-only emission ledger — emitted counts, published stable
	 * rows, per-width render cache, and freeze state — for every block, and ask
	 * each append-only block to drop its own published rows. The next replay then
	 * re-renders each block from its current {@link Component.render}, applying a
	 * changed presentation (e.g. a thinking-visibility toggle) to rows that were
	 * already emitted as stable heads while streaming (#10177).
	 *
	 * Callers MUST pair this with a scrollback-clearing {@link resetDisplay}: the
	 * emitted rows it forgets still sit in native history until that clear
	 * rewrites them, so unpaired use would duplicate them on the next retirement.
	 */
	resetStableEmission(): void {
		this.#syncEntries();
		if (this.#offered?.kind === "append") this.#offered = undefined;
		for (const entry of this.#entries) {
			entry.emitted = 0;
			entry.stableRows = EMPTY_STABLE_ROWS;
			entry.renderedStableByWidth = new Map();
			entry.stableRowCountByWidth = new Map();
			entry.stableFrozen = false;
			if (entry.mode === "appendOnly") {
				(entry.component as Component & AppendOnlyTranscriptBlock).resetTranscriptStableRows?.();
			}
		}
	}

	/** Whether a transient block may be discarded without leaving tape history. */
	canRemoveBlock(component: Component): boolean {
		// An unsnapshotted active/settled block still lives only in the mutable
		// viewport and can disappear without a trace. Semantic/visual prefixes,
		// committed blocks, and offered actions already own terminal history and
		// must remain in the transcript ledger.
		this.#syncEntries();
		const index = this.#entries.findIndex(entry => entry.component === component);
		if (index < 0) return false;
		const entry = this.#entries[index]!;
		if (
			entry.state === "committed" ||
			entry.emitted > 0 ||
			entry.snapshot !== undefined ||
			entry.partial !== undefined
		)
			return false;
		if (
			this.#offered?.kind === "commit" &&
			(this.#offered.entries.includes(index) || this.#offered.partial?.entry === index)
		)
			return false;
		if ((this.#offered?.kind === "append" || this.#offered?.kind === "snapshot") && index === this.#offered.entry)
			return false;
		return true;
	}

	/** Lifecycle state per block in transcript order (diagnostics and tests). */
	blockStates(): readonly BlockState[] {
		this.#syncEntries();
		return this.#entries.map(entry => entry.state);
	}

	/** Permanently captured presentation mode per block (diagnostics and tests). */
	blockModes(): readonly TranscriptBlockMode[] {
		this.#syncEntries();
		return this.#entries.map(entry => entry.mode);
	}

	/** Emitted stable semantic-row counts in transcript order. */
	emittedStableRows(): readonly number[] {
		this.#syncEntries();
		return this.#entries.map(entry => entry.emitted);
	}

	/** Whether visible active capacity and live-block memory permit another admission. */
	canAdmit(rows: number): boolean {
		const active = this.#entries.filter(entry => entry.state === "active").length;
		return Math.max(0, Math.trunc(rows)) > active && this.#liveCount() < MAX_LIVE_BLOCKS;
	}

	/** Prepares one atomic replay of the committed ledger and an emitted active-head prefix. */
	beginReplay(): void {
		this.#syncEntries();
		if (this.#offered !== undefined) {
			this.#replayRequested = true;
			return;
		}
		// Mutable overflow snapshots have no width-independent identity. A
		// destructive replay clears them and returns the complete mutable block to
		// the live viewport; append-only rows retain their semantic emission state.
		for (const entry of this.#entries) {
			entry.snapshot = undefined;
			entry.partial = undefined;
		}
		this.#startReplay();
	}

	/** Legacy destructive reset retained for embedders that rebuild directly. */
	resetRetirement(): void {
		this.#frontier = 0;
		this.#offered = undefined;
		this.#replayPending = false;
		this.#replayRequested = false;
		for (const entry of this.#entries) {
			entry.snapshot = undefined;
			entry.partial = undefined;
			entry.emitted = 0;
			if (entry.state === "committed") entry.state = isFinalized(entry.component) ? "settled" : "active";
		}
	}
	/**
	 * Drop a not-yet-offered replay so a shutdown flush emits only un-retired
	 * rows. The terminal already holds the committed ledger; re-streaming it at
	 * quit is pure write volume. An already offered replay batch stays valid.
	 */
	cancelReplay(): void {
		this.#replayPending = false;
		this.#replayRequested = false;
	}

	/** Total rows the live, un-emitted tail occupies at `width`. */
	liveRowCount(width: number): number {
		this.#syncEntries();
		this.#settleFinalized();
		let total = 0;
		for (const { entry, index } of this.#liveEntries()) {
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const rendered = this.#renderEntry(entry, width);
			const block = rendered.slice(this.#projectedPrefixLength(entry, index, width, rendered));
			if (block.length > 0) total += block.length + (total > 0 ? 1 : 0);
		}
		return total;
	}

	/** Block spans of the last `renderViewport` output, in output coordinates. Empty when the tail is empty. */
	getLastViewportSpans(): readonly TranscriptViewportSpan[] {
		return this.#lastViewportSpans;
	}

	/** Collapse a per-line owner list into run-length block spans, clamped to `length`. */
	#commitViewportSpans(owners: readonly (Component | undefined)[], length: number = owners.length): void {
		const spans: TranscriptViewportSpan[] = [];
		let index = 0;
		while (index < length) {
			const component = owners[index];
			if (component === undefined) {
				index++;
				continue;
			}
			let end = index + 1;
			while (end < length && owners[end] === component) end++;
			spans.push({ component, start: index, end });
			index = end;
		}
		this.#lastViewportSpans = spans;
	}

	/** Render the live tail, constrained to the supplied transcript height. */
	renderViewport(width: number, rows: number, frame: AnimationFrame = this.#lastFrame): readonly string[] {
		this.#lastFrame = frame;
		this.#syncEntries();
		this.#settleFinalized();
		const live = this.#liveEntries();
		const capacity = Math.max(0, Math.trunc(rows));
		if (live.length === 0) {
			this.#lastViewportSpans = [];
			return EMPTY_ROWS;
		}

		const output: string[] = [];
		const owners: (Component | undefined)[] = [];
		// The first live block separates from the tape's last block when that
		// boundary is not a folded run (the tape never writes a trailing blank
		// after a folded row, so the decision lands here).
		let previous: Component | undefined = this.#tapeTail.separated ? undefined : this.#tapeTail.component;
		for (const candidate of live) {
			this.#setAllocation(candidate.entry.component, Number.MAX_SAFE_INTEGER, frame);
			const rendered = this.#renderEntry(candidate.entry, width);
			const block = rendered.slice(this.#projectedPrefixLength(candidate.entry, candidate.index, width, rendered));
			if (block.length === 0) continue;
			if (
				previous !== undefined &&
				previous !== candidate.entry.component &&
				this.#keepsBlankBetween(previous, candidate.entry.component)
			) {
				output.push("");
				owners.push(undefined);
			}
			for (const line of block) {
				output.push(line);
				owners.push(candidate.entry.component);
			}
			previous = candidate.entry.component;
		}
		const drop = Math.max(0, output.length - capacity);
		this.#commitViewportSpans(owners.slice(drop), output.length - drop);
		return drop > 0 ? output.slice(drop) : output;
	}

	/** Offers stable-head emission or the shortest finalized prefix needed under pressure. */
	peekFinalizedBatch(width: number, capacity: number): HistoryBatch | undefined {
		return this.#peekBatch(width, capacity, "pressure");
	}

	/** Returns only a prepared complete replay, never a normal retirement offer. */
	peekReplayBatch(width: number): HistoryBatch | undefined {
		this.#syncEntries();
		this.#settleFinalized();
		return this.#peekReplayBatch(width);
	}

	#peekReplayBatch(width: number): HistoryBatch | undefined {
		if (this.#offered !== undefined) {
			return this.#offered.kind === "replay" ? this.#offered.batch : undefined;
		}
		if (!this.#replayPending) return undefined;
		const rows = this.#renderReplay(width);
		this.#replayPending = false;
		if (rows.length === 0) return undefined;
		const batch: HistoryBatch = { id: this.#nextBatchId++, rows, kind: "replay" };
		this.#offered = { batch, kind: "replay" };
		return batch;
	}

	/** Offers the complete currently eligible prefix for graceful shutdown. */
	peekFlushBatch(width: number): HistoryBatch | undefined {
		return this.#peekBatch(width, 0, "flush");
	}

	/** Recompose the unacknowledged batch so a discarded TUI frame can be rendered again. */
	rerenderOfferedBatch(width: number): HistoryBatch | undefined {
		const offered = this.#offered;
		if (offered === undefined) return undefined;
		let rows: readonly string[];
		if (offered.kind === "append") {
			const entry = this.#entries[offered.entry];
			if (entry === undefined) return undefined;
			const before = this.#renderStablePrefix(entry, entry.emitted, width);
			const after = this.#renderStablePrefix(entry, offered.emittedEnd, width);
			rows = after.slice(before.length);
			this.#recordTapeTail(entry.component, rows);
		} else if (offered.kind === "snapshot") {
			const entry = this.#entries[offered.entry];
			if (entry === undefined) return undefined;
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const rendered = this.#renderEntry(entry, width);
			const start = this.#retiredPrefixLength(entry, width, rendered);
			const offeredRows = Math.max(0, offered.batch.rows.length - (offered.watermark.separator ? 1 : 0));
			const rowCount = Math.min(rendered.length, start + offeredRows);
			const prefix =
				entry.snapshot?.width === width
					? [...entry.snapshot.prefix, ...rendered.slice(entry.snapshot.rowCount, rowCount)]
					: rendered.slice(0, rowCount);
			const watermark: SnapshotWatermark = {
				width,
				rowCount,
				prefix,
				separator: rowCount > start && rowCount === rendered.length && !this.#isFoldedToolRow(entry.component),
			};
			const rerendered = Array.from(rendered.slice(start, rowCount));
			if (watermark.separator) rerendered.push("");
			offered.watermark = watermark;
			this.#recordTapeTail(entry.component, rerendered);
			rows = rerendered;
		} else if (offered.kind === "commit") {
			const lastCommitted = offered.entries.at(-1);
			const rerendered = Array.from(this.#renderSelection(offered.entries, width, offered.partial === undefined));
			if (offered.partial !== undefined) {
				const entry = this.#entries[offered.partial.entry];
				if (entry !== undefined) {
					this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
					const rendered = this.#renderEntry(entry, width);
					const end = this.#resolvePartial(offered.partial.watermark, entry, width, rendered);
					const prefix = rendered.slice(this.#retiredPrefixLength(entry, width, rendered), end);
					if (prefix.length > 0) {
						const last = lastCommitted === undefined ? undefined : this.#entries[lastCommitted]?.component;
						if (rerendered.length > 0 && this.#keepsBlankBetween(last, entry.component)) rerendered.push("");
						rerendered.push(...prefix);
					}
					this.#recordTapeTail(entry.component, rerendered);
				} else {
					this.#recordTapeTail(undefined, rerendered);
				}
			} else {
				this.#recordTapeTail(
					lastCommitted === undefined ? undefined : this.#entries[lastCommitted]?.component,
					rerendered,
				);
			}
			rows = rerendered;
		} else {
			rows = this.#renderReplay(width);
		}
		offered.batch = { id: offered.batch.id, rows, kind: offered.batch.kind };
		return offered.batch;
	}

	#peekBatch(width: number, capacity: number, policy: RetirementPolicy): HistoryBatch | undefined {
		this.#syncEntries();
		this.#settleFinalized();
		if (this.#offered !== undefined) return this.#offered.batch;
		const replay = this.#peekReplayBatch(width);
		if (replay !== undefined) return replay;

		this.#completeFullyEmittedHeads(width);
		const room = Math.max(0, Math.trunc(capacity));
		const live = this.#liveEntries();
		if (live.length === 0) return undefined;
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		const rendered: (readonly string[])[] = new Array(live.length);
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		const heights: number[] = new Array(live.length);
		let total = 0;
		let visible = 0;
		for (let index = 0; index < live.length; index++) {
			const candidate = live[index]!;
			this.#setAllocation(candidate.entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const renderedEntry = this.#renderEntry(candidate.entry, width);
			const rows = renderedEntry.slice(this.#retiredPrefixLength(candidate.entry, width, renderedEntry));
			rendered[index] = rows;
			heights[index] = rows.length;
			if (rows.length > 0) total += rows.length + (visible++ > 0 ? 1 : 0);
		}
		const completingRetirement = live.some(
			({ entry }) => entry.state === "settled" && (entry.partial !== undefined || entry.snapshot !== undefined),
		);
		const overflowing = completingRetirement || total > room || this.#liveCount() >= MAX_LIVE_BLOCKS;
		if (policy === "pressure" && !overflowing) {
			this.#pinnedFrontier = undefined;
			return undefined;
		}

		const head = this.#entries[this.#frontier];
		if (
			policy === "pressure" &&
			total > room &&
			head?.mode === "appendOnly" &&
			!head.stableFrozen &&
			head.state !== "committed" &&
			allowsMidStreamRetirement(head.component) &&
			head.emitted < head.stableRows.length
		) {
			// Emit as many finished rows as the overflow needs, in one batch. A
			// fast stream adds finished rows quicker than one per pressure cycle,
			// and the live region has to fall back under `room` to stay readable:
			// rows left behind here are rows dropped from the top of the viewport.
			const overflow = total - room;
			const before = this.#renderStablePrefix(head, head.emitted, width);
			let emittedEnd = head.emitted;
			let rows: readonly string[] = EMPTY_ROWS;
			while (emittedEnd < head.stableRows.length && rows.length < overflow) {
				const after = this.#renderStablePrefix(head, emittedEnd + 1, width);
				if (!isRowPrefix(before, after) || after.length === before.length) {
					if (emittedEnd === head.emitted) {
						this.#freezeStableRows(head, EMPTY_ROWS, "semantic row render added no suffix");
					}
					break;
				}
				rows = after.slice(before.length);
				emittedEnd += 1;
			}
			if (emittedEnd > head.emitted) {
				const batch: HistoryBatch = {
					id: this.#nextBatchId++,
					rows,
					kind: "append",
				};
				this.#offered = { batch, kind: "append", entry: this.#frontier, emittedEnd };
				this.#recordTapeTail(head.component, batch.rows);
				this.#pinnedFrontier = undefined;
				return batch;
			}
		}

		const commitEntries: number[] = [];
		let freed = 0;
		let liveIndex = 0;
		for (const candidate of live) {
			const entry = candidate.entry;
			if (
				entry.state === "active" &&
				rendered[liveIndex]!.length === 0 &&
				(allowsSuccessorRetirement(entry.component) || entry.snapshot?.separator === true)
			) {
				liveIndex++;
				continue;
			}
			if (entry.state !== "settled") break;
			if (
				policy === "pressure" &&
				entry.partial === undefined &&
				entry.snapshot === undefined &&
				total - freed <= room &&
				this.#liveCount() - commitEntries.length < MAX_LIVE_BLOCKS
			)
				break;
			freed += heights[liveIndex]! > 0 ? heights[liveIndex]! + 1 : 0;
			commitEntries.push(candidate.index);
			liveIndex++;
		}
		if (commitEntries.length > 0) {
			const next = live.find(({ index }) => !commitEntries.includes(index));
			if (next !== undefined) {
				const nextRendered = rendered[live.indexOf(next)];
				if (nextRendered !== undefined) {
					const partial = this.#legacyPrefix(next.entry, width, nextRendered);
					if (partial !== undefined) {
						const rows = Array.from(this.#renderSelection(commitEntries, width, false));
						const prefix = this.#renderEntry(next.entry, width).slice(
							this.#retiredPrefixLength(next.entry, width, nextRendered),
							partial.rowCount,
						);
						if (prefix.length > 0) {
							const lastCommitted = this.#entries[commitEntries[commitEntries.length - 1]!]?.component;
							if (rows.length > 0 && this.#keepsBlankBetween(lastCommitted, next.entry.component)) {
								rows.push("");
							}
							rows.push(...prefix);
						}
						const batch: HistoryBatch = { id: this.#nextBatchId++, rows, kind: "append" };
						this.#offered = {
							batch,
							entries: commitEntries,
							kind: "commit",
							partial: { entry: next.index, watermark: partial },
						};
						this.#recordTapeTail(next.entry.component, rows);
						this.#pinnedFrontier = undefined;
						return batch;
					}
				}
			}
			const batch: HistoryBatch = {
				id: this.#nextBatchId++,
				rows: this.#renderSelection(commitEntries, width, true),
				kind: "append",
			};
			this.#offered = { batch, entries: commitEntries, kind: "commit" };
			this.#recordTapeTail(this.#entries[commitEntries.at(-1)!]?.component, batch.rows);
			this.#pinnedFrontier = undefined;
			return batch;
		}

		if (policy === "pressure" && total > room) {
			const candidate = live.find(({ entry }, index) => {
				return entry.partial === undefined && this.#legacyPrefix(entry, width, rendered[index]!) !== undefined;
			});
			if (candidate !== undefined) {
				const candidateIndex = live.indexOf(candidate);
				const watermark = this.#legacyPrefix(candidate.entry, width, rendered[candidateIndex]!)!;
				const rows = this.#renderEntry(candidate.entry, width).slice(
					this.#retiredPrefixLength(candidate.entry, width, rendered[candidateIndex]!),
					watermark.rowCount,
				);
				if (rows.length > 0) {
					const batch: HistoryBatch = { id: this.#nextBatchId++, rows, kind: "append" };
					this.#offered = {
						batch,
						entries: [],
						kind: "commit",
						partial: { entry: candidate.index, watermark },
					};
					this.#recordTapeTail(candidate.entry.component, rows);
					this.#pinnedFrontier = undefined;
					return batch;
				}
			}
		}

		if (policy === "pressure" && total > room) {
			// A transparent zero-row ordering gate cannot later contribute visible
			// content. Any other active zero-row predecessor remains a hard barrier.
			const activeCount = live.reduce(
				(count, { entry }, index) =>
					count +
					(entry.state === "active" && (rendered[index]!.length > 0 || !allowsSuccessorRetirement(entry.component))
						? 1
						: 0),
				0,
			);
			const visibleCount = rendered.filter(rows => rows.length > 0).length;
			const candidate = live.find(({ entry }, index) => {
				if (
					activeCount !== 1 ||
					entry.state !== "active" ||
					entry.stableFrozen ||
					!allowsMidStreamRetirement(entry.component) ||
					(!isToolActivityComponent(entry.component) && visibleCount !== 1)
				)
					return false;
				return rendered[index]!.length > 0;
			});
			if (candidate !== undefined) {
				const full = this.#renderEntry(candidate.entry, width);
				const start = this.#retiredPrefixLength(candidate.entry, width, full);
				const rowCount = Math.min(full.length, start + Math.max(1, total - room));
				if (rowCount > start) {
					const prefix =
						candidate.entry.snapshot?.width === width
							? [...candidate.entry.snapshot.prefix, ...full.slice(candidate.entry.snapshot.rowCount, rowCount)]
							: full.slice(0, rowCount);
					const watermark: SnapshotWatermark = {
						width,
						rowCount,
						prefix,
						// Trailing blanks are deferred past a folded row: its run may
						// continue with the next block.
						separator: rowCount === full.length && !this.#isFoldedToolRow(candidate.entry.component),
					};
					const rows = Array.from(full.slice(start, rowCount));
					if (watermark.separator) rows.push("");
					const batch: HistoryBatch = { id: this.#nextBatchId++, rows, kind: "append" };
					this.#offered = { batch, entry: candidate.index, kind: "snapshot", watermark };
					this.#recordTapeTail(candidate.entry.component, rows);
					this.#pinnedFrontier = undefined;
					return batch;
				}
			}
		}
		if (policy === "pressure") this.#notePinnedFrontier();
		return undefined;
	}

	/** Acknowledges exactly the most recently offered append, commit, or replay transaction. */
	acknowledgeFinalizedBatch(id: number): void {
		const offered = this.#offered;
		if (offered === undefined || offered.batch.id !== id) return;
		if (offered.kind === "append") {
			const entry = this.#entries[offered.entry];
			// The offered end must still extend this entry's emitted prefix: a
			// stale offer (already-advanced entry) or a retraction (entry reset to
			// zero with the offer still live) must not move it backwards.
			if (entry === undefined || offered.entry !== this.#frontier || offered.emittedEnd <= entry.emitted) return;
			entry.emitted = offered.emittedEnd;
		} else if (offered.kind === "snapshot") {
			const entry = this.#entries[offered.entry];
			if (entry === undefined) return;
			entry.snapshot = offered.watermark;
		} else if (offered.kind === "commit") {
			for (const index of offered.entries) {
				const entry = this.#entries[index];
				if (entry === undefined) continue;
				entry.state = "committed";
				entry.emitted = 0;
				entry.snapshot = undefined;
				entry.partial = undefined;
			}
			if (offered.partial !== undefined) {
				const entry = this.#entries[offered.partial.entry];
				if (entry !== undefined) entry.partial = offered.partial.watermark;
			}
			this.#frontier = this.#entries.findIndex(entry => entry.state !== "committed");
			if (this.#frontier < 0) this.#frontier = this.#entries.length;
		}
		this.#offered = undefined;
		if (this.#replayRequested) {
			for (const entry of this.#entries) {
				entry.snapshot = undefined;
				entry.partial = undefined;
			}
			this.#startReplay();
		}
	}

	/**
	 * Render only the trailing `maxRows` semantic rows, walking blocks bottom-up.
	 * Used by the transient resize-buffer repaint, which needs one viewport of
	 * tail rows per resize event — never the full committed ledger.
	 */
	renderTail(width: number, maxRows: number): readonly string[] {
		this.#syncEntries();
		const cap = Math.max(0, Math.trunc(maxRows));
		if (cap === 0) return EMPTY_ROWS;
		const rows: string[] = [];
		let next: Component | undefined;
		for (let index = this.#entries.length - 1; index >= 0; index--) {
			const entry = this.#entries[index]!;
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const block = trimBlankEdges(entry.component.render(width));
			if (block.length === 0) continue;
			if (rows.length > 0 && this.#keepsBlankBetween(entry.component, next)) rows.unshift("");
			rows.unshift(...block);
			next = entry.component;
			if (rows.length >= cap) break;
		}
		return rows.length > cap ? rows.slice(rows.length - cap) : rows;
	}

	/** Full semantic render used by exports and non-terminal commands. */
	override render(width: number): readonly string[] {
		this.#syncEntries();
		this.#childStartRows.clear();
		const rows: string[] = [];
		let previous: Component | undefined;
		for (const entry of this.#entries) {
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const block = this.#renderEntry(entry, width);
			if (block.length === 0) continue;
			if (rows.length > 0 && this.#keepsBlankBetween(previous, entry.component)) rows.push("");
			this.#childStartRows.set(entry.component, rows.length);
			rows.push(...block);
			previous = entry.component;
		}
		return rows;
	}

	/** Rendered row where a child's block begins in the last full render() (transcript deep-links). */
	getChildStartRow(child: Component): number | undefined {
		return this.#childStartRows.get(child);
	}

	#renderEntry(entry: TranscriptEntry, width: number): readonly string[] {
		const rendered = trimBlankEdges(entry.component.render(width));
		if (entry.mode === "mutable" || entry.stableFrozen) return rendered;
		const appendOnly = entry.component as Component & AppendOnlyTranscriptBlock;
		const stable = appendOnly.getTranscriptStableRows();
		if (!isStablePrefix(entry.stableRows, stable)) {
			return this.#freezeStableRows(entry, rendered, "publication retracted the published prefix");
		}
		if (entry.emitted > stable.length) {
			return this.#freezeStableRows(entry, rendered, "publication retracted emitted history");
		}
		const published =
			stable.length > entry.stableRows.length
				? [...entry.stableRows, ...stable.slice(entry.stableRows.length)]
				: entry.stableRows;
		const stableRendered = appendOnly.renderTranscriptStableRows(published.length, width);
		if (!isRowPrefix(stableRendered, rendered)) {
			return this.#freezeStableRows(entry, rendered, "stable rows no longer render as a prefix of the block");
		}
		const priorRender = entry.renderedStableByWidth.get(width);
		if (priorRender && !isRowPrefix(priorRender, stableRendered)) {
			return this.#freezeStableRows(entry, rendered, "stable rows changed within a width epoch");
		}
		entry.stableRows = published;
		// Slice only when the rendered rows actually changed: same length
		// plus prefix-equality in both directions means byte-identical, so
		// the stored array can be reused (callers only slice/read it).
		const priorRows = entry.renderedStableByWidth.get(width);
		if (
			priorRows === undefined ||
			priorRows.length !== stableRendered.length ||
			!isRowPrefix(priorRows, stableRendered)
		) {
			entry.renderedStableByWidth.set(width, stableRendered.slice());
		}
		let perCount = entry.stableRowCountByWidth.get(width);
		if (perCount === undefined) {
			perCount = new Map();
			entry.stableRowCountByWidth.set(width, perCount);
		}
		perCount.set(published.length, stableRendered.length);
		return rendered;
	}

	/**
	 * Demote a drifting append-only publication: rows already written to native
	 * scrollback cannot be retracted, so keep the last good stable state for
	 * emitted-row slicing and stop mid-stream emission for this block. The block
	 * still renders and retires whole on finalization; worst case is the old
	 * finalize-time behavior plus a possible stale-byte seam in scrollback.
	 */
	#freezeStableRows(entry: TranscriptEntry, rendered: readonly string[], reason: string): readonly string[] {
		entry.stableFrozen = true;
		logger.warn("Append-only transcript block frozen", { reason, emitted: entry.emitted });
		return rendered;
	}

	#renderStablePrefix(entry: TranscriptEntry, count: number, width: number): readonly string[] {
		if (count === 0) return EMPTY_ROWS;
		const appendOnly = entry.component as Component & AppendOnlyTranscriptBlock;
		return appendOnly.renderTranscriptStableRows(Math.min(count, entry.stableRows.length), width);
	}

	/**
	 * Length-only variant of `#renderStablePrefix`: answers the projected
	 * emitted row count without re-rendering the prefix. The container only
	 * needs the length for slicing; the render call it replaced existed
	 * purely to read `.length` off the result.
	 */
	#projectedEmittedRowCount(entry: TranscriptEntry, index: number, width: number): number {
		const offered = this.#offered;
		const count = offered?.kind === "append" && offered.entry === index ? offered.emittedEnd : entry.emitted;
		if (count === 0) return 0;
		const perCount = entry.stableRowCountByWidth.get(width);
		const memo = perCount?.get(Math.min(count, entry.stableRows.length));
		if (memo !== undefined) return memo;
		return this.#renderStablePrefix(entry, count, width).length;
	}
	/**
	 * Record that pressure retirement is blocked behind a not-yet-settled
	 * frontier block, and log its identity once the episode outlives the grace
	 * period. A block that never finalizes (a dropped terminal event) pins the
	 * whole live region here with no visible symptom other than degraded
	 * one-line layout, so the log line is the only forensic trail.
	 */
	#notePinnedFrontier(): void {
		const entry = this.#entries[this.#frontier];
		if (entry === undefined) return;
		const now = Date.now();
		if (this.#pinnedFrontier?.index !== this.#frontier) {
			this.#pinnedFrontier = { index: this.#frontier, since: now, logged: false };
			return;
		}
		if (this.#pinnedFrontier.logged || now - this.#pinnedFrontier.since < PINNED_FRONTIER_WARN_MS) return;
		this.#pinnedFrontier.logged = true;
		logger.warn("Transcript retirement pinned by unfinalized frontier block", {
			component: entry.component.constructor.name,
			state: entry.state,
			mode: entry.mode,
			liveBlocks: this.#liveCount(),
		});
	}

	#snapshotStart(
		snapshot: SnapshotWatermark | undefined,
		state: BlockState,
		width: number,
		rendered: readonly string[],
	): number {
		if (snapshot === undefined || snapshot.width !== width) return 0;
		const comparable = Math.min(snapshot.rowCount, rendered.length);
		if (state === "active") return comparable;
		for (let row = 0; row < comparable; row++) {
			if (Bun.stripANSI(snapshot.prefix[row]!) !== Bun.stripANSI(rendered[row]!)) return row;
		}
		return comparable;
	}

	#retiredPrefixLength(entry: TranscriptEntry, width: number, rendered: readonly string[]): number {
		return Math.max(
			this.#renderStablePrefix(entry, entry.emitted, width).length,
			this.#legacyPrefixLength(entry, width, rendered),
			this.#snapshotStart(entry.snapshot, entry.state, width, rendered),
		);
	}

	#legacyPrefix(entry: TranscriptEntry, width: number, rendered: readonly string[]): PartialWatermark | undefined {
		if (entry.partial !== undefined) return entry.partial;
		const block = entry.component as Component & FinalizableBlock;
		if (block.getTranscriptBlockSettledPrefix === undefined) return undefined;
		try {
			const result = block.getTranscriptBlockSettledPrefix(width, rendered);
			if (result === undefined || !Number.isSafeInteger(result.rowCount)) return undefined;
			if (result.rowCount <= 0 || result.rowCount > rendered.length) return undefined;
			return { cursor: result.cursor, width, rowCount: result.rowCount };
		} catch {
			return undefined;
		}
	}

	#legacyPrefixLength(entry: TranscriptEntry, width: number, rendered: readonly string[]): number {
		const partial = entry.partial;
		if (partial === undefined) return 0;
		return this.#resolvePartial(partial, entry, width, rendered);
	}

	#resolvePartial(
		partial: PartialWatermark,
		entry: TranscriptEntry,
		width: number,
		rendered: readonly string[],
	): number {
		if (partial.width === width) return Math.min(partial.rowCount, rendered.length);
		const block = entry.component as Component & FinalizableBlock;
		if (block.resolveTranscriptBlockSettledPrefix === undefined) return 0;
		try {
			const count = block.resolveTranscriptBlockSettledPrefix(partial.cursor, width, rendered);
			return count !== undefined && Number.isSafeInteger(count) ? Math.max(0, Math.min(count, rendered.length)) : 0;
		} catch {
			return 0;
		}
	}

	#renderSelection(indices: readonly number[], width: number, trailingBlank: boolean): readonly string[] {
		const rows: string[] = [];
		let terminalAlreadySeparated = false;
		// The batch continues the terminal tape, so its first block separates from
		// whatever the tape wrote last — unless that was this same block's own
		// emitted prefix, which continues without a gap.
		let previous: Component | undefined = this.#tapeTail.separated ? undefined : this.#tapeTail.component;
		for (const index of indices) {
			const entry = this.#entries[index];
			if (entry === undefined) continue;
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const rendered = this.#renderEntry(entry, width);
			const block = rendered.slice(this.#retiredPrefixLength(entry, width, rendered));
			if (block.length === 0) {
				terminalAlreadySeparated = entry.snapshot?.separator === true;
				continue;
			}
			if (
				previous !== undefined &&
				previous !== entry.component &&
				this.#keepsBlankBetween(previous, entry.component)
			) {
				rows.push("");
			}
			rows.push(...block);
			previous = entry.component;
			terminalAlreadySeparated = false;
		}
		// A trailing blank is written only when the block that follows can no
		// longer join the run: a folded tool row defers the whole decision to
		// whatever follows it.
		if (
			trailingBlank &&
			!terminalAlreadySeparated &&
			(rows.length > 0 || indices.length > 0) &&
			!this.#batchesEndWithFoldedRow(previous)
		) {
			rows.push("");
		}
		return rows;
	}

	#renderReplay(width: number): readonly string[] {
		const committed: number[] = [];
		for (let index = 0; index < this.#entries.length; index++) {
			if (this.#entries[index]!.state === "committed") committed.push(index);
		}
		const head = this.#entries.find(entry => entry.state !== "committed");
		// The replay replaces the whole tape: whatever the terminal held before is
		// gone, so the tail starts over with the rows this replay writes.
		this.#tapeTail = { component: undefined, separated: false };
		const rows = Array.from(this.#renderSelection(committed, width, true));
		let tail = committed.length > 0 ? this.#entries[committed.at(-1)!]?.component : undefined;
		if (head?.mode === "appendOnly" && head.emitted > 0) {
			this.#setAllocation(head.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			this.#renderEntry(head, width);
			rows.push(...this.#renderStablePrefix(head, head.emitted, width));
			tail = head.component;
		}
		this.#recordTapeTail(tail, rows);
		return rows;
	}

	#completeFullyEmittedHeads(width: number): void {
		while (this.#frontier < this.#entries.length) {
			const entry = this.#entries[this.#frontier]!;
			if (entry.mode !== "appendOnly" || entry.state !== "settled") return;
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const rendered = this.#renderEntry(entry, width);
			if (entry.emitted !== entry.stableRows.length) return;
			if (this.#renderStablePrefix(entry, entry.emitted, width).length !== rendered.length) return;
			entry.state = "committed";
			entry.emitted = 0;
			this.#frontier++;
		}
	}

	#startReplay(): void {
		const head = this.#entries.find(entry => entry.state !== "committed");
		this.#replayPending =
			this.#entries.some(entry => entry.state === "committed") || (head?.mode === "appendOnly" && head.emitted > 0);
		this.#replayRequested = false;
	}

	#projectedPrefixLength(entry: TranscriptEntry, index: number, width: number, rendered: readonly string[]): number {
		const offered = this.#offered;
		const snapshot = offered?.kind === "snapshot" && offered.entry === index ? offered.watermark : entry.snapshot;
		const partial =
			offered?.kind === "commit" && offered.partial?.entry === index ? offered.partial.watermark : entry.partial;
		let partialRows: number;
		if (partial === entry.partial) partialRows = this.#legacyPrefixLength(entry, width, rendered);
		else if (partial !== undefined) partialRows = this.#resolvePartial(partial, entry, width, rendered);
		else partialRows = 0;
		return Math.max(
			this.#projectedEmittedRowCount(entry, index, width),
			partialRows,
			this.#snapshotStart(snapshot, entry.state, width, rendered),
		);
	}

	#setAllocation(component: Component, rows: number, frame: AnimationFrame): void {
		(component as Component & TranscriptPresentationTarget).setTranscriptAllocation?.(rows, frame);
	}

	/** A tool block currently presented as its folded one-line row. */
	#isFoldedToolRow(component: Component): boolean {
		return this.#toolRowsFolded && isToolRowsFoldComponent(component);
	}

	/**
	 * Whether a blank row still separates two consecutive blocks. A run of
	 * folded tool rows drops it — that spacing is exactly what the fold exists
	 * to remove — while every boundary touching prose, a user message, or a
	 * full card keeps the transcript's standard block gap. A neighbour the
	 * caller cannot name (the ends of the transcript, a batch whose successor is
	 * unknown) keeps its blank, so those callers never change shape.
	 */
	#keepsBlankBetween(previous: Component | undefined, next: Component | undefined): boolean {
		if (previous === undefined || next === undefined) return true;
		return !(this.#isFoldedToolRow(previous) && this.#isFoldedToolRow(next));
	}

	/**
	 * Record the block and separator state the terminal holds after a batch.
	 * `component` is the block whose rows were written last; `separated` is
	 * whether a blank row already follows it.
	 */
	#recordTapeTail(component: Component | undefined, rows: readonly string[]): void {
		this.#tapeTail = {
			component: component ?? this.#tapeTail.component,
			separated: rows.at(-1) === "",
		};
	}

	/** A batch only end-runs a folded row when that row is its last visible block. */
	#batchesEndWithFoldedRow(last: Component | undefined): boolean {
		return last !== undefined && this.#isFoldedToolRow(last);
	}

	#settleFinalized(): void {
		for (let index = this.#frontier; index < this.#entries.length; index++) {
			const entry = this.#entries[index]!;
			if (entry.state === "active" && isFinalized(entry.component)) entry.state = "settled";
		}
	}

	#liveEntries(): Array<{ entry: TranscriptEntry; index: number }> {
		const offeredCommits = this.#offered?.kind === "commit" ? new Set(this.#offered.entries) : undefined;
		const live: Array<{ entry: TranscriptEntry; index: number }> = [];
		for (let index = this.#frontier; index < this.#entries.length; index++) {
			const entry = this.#entries[index]!;
			if (entry.state !== "committed" && !offeredCommits?.has(index)) live.push({ entry, index });
		}
		return live;
	}

	#liveCount(): number {
		let count = 0;
		for (const entry of this.#entries) if (entry.state !== "committed") count++;
		return count;
	}

	#syncEntries(): void {
		if (
			this.#entries.length === this.children.length &&
			this.#entries.every((entry, index) => entry.component === this.children[index])
		)
			return;
		const existing = new Map(this.#entries.map(entry => [entry.component, entry]));
		this.#entries = this.children.map(
			component =>
				existing.get(component) ?? {
					component,
					state: "active",
					mode: blockMode(component),
					stableRows: EMPTY_STABLE_ROWS,
					renderedStableByWidth: new Map(),
					stableRowCountByWidth: new Map(),
					emitted: 0,
					stableFrozen: false,
					snapshot: undefined,
					partial: undefined,
				},
		);
		this.#frontier = this.#entries.findIndex(entry => entry.state !== "committed");
		if (this.#frontier < 0) this.#frontier = this.#entries.length;
	}
}

/** Groups sibling rows into one conservative mutable semantic transcript block. */
export class TranscriptBlock extends Container {}
