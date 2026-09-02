import type { Component, HistoryBatch } from "@oh-my-pi/pi-tui";
import { Container } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { isToolActivityComponent } from "./tool-activity";

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

/** Strip leading/trailing all-blank rows; the viewport allocator measures blocks by this trimmed height. */
export function trimBlankEdges(rows: readonly string[]): readonly string[] {
	let start = 0;
	let end = rows.length;
	while (start < end && isPlainBlank(rows[start]!)) start++;
	while (end > start && isPlainBlank(rows[end - 1]!)) end--;
	return start === 0 && end === rows.length ? rows : rows.slice(start, end);
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
	#lastFrame: AnimationFrame = { tick: 0, now: 0 };

	override addChild(component: Component): void {
		if (isToolActivityComponent(component)) component.setToolActivityVisible(this.#toolActivityVisible);
		super.addChild(component);
		this.#entries.push({
			component,
			state: "active",
			mode: blockMode(component),
			stableRows: EMPTY_STABLE_ROWS,
			renderedStableByWidth: new Map(),
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
	}

	override clear(): void {
		super.clear();
		this.#entries = [];
		this.#frontier = 0;
		this.#offered = undefined;
		this.#replayPending = false;
		this.#replayRequested = false;
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#toolActivityVisible === visible) return;
		this.#toolActivityVisible = visible;
		for (const child of this.children) {
			if (isToolActivityComponent(child)) child.setToolActivityVisible(visible);
		}
		this.invalidate();
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

	/** Render the live tail, constrained to the supplied transcript height. */
	renderViewport(width: number, rows: number, frame: AnimationFrame = this.#lastFrame): readonly string[] {
		this.#lastFrame = frame;
		this.#syncEntries();
		this.#settleFinalized();
		const live = this.#liveEntries();
		const capacity = Math.max(0, Math.trunc(rows));
		if (live.length === 0) return EMPTY_ROWS;

		const output: string[] = [];
		for (const candidate of live) {
			this.#setAllocation(candidate.entry.component, Number.MAX_SAFE_INTEGER, frame);
			const rendered = this.#renderEntry(candidate.entry, width);
			const block = rendered.slice(this.#projectedPrefixLength(candidate.entry, candidate.index, width, rendered));
			if (block.length === 0) continue;
			if (output.length > 0) output.push("");
			output.push(...block);
		}
		return output.length > capacity ? output.slice(output.length - capacity) : output;
	}

	/** Offers stable-head emission or the shortest finalized prefix needed under pressure. */
	peekFinalizedBatch(width: number, capacity: number): HistoryBatch | undefined {
		return this.#peekBatch(width, capacity, "pressure");
	}

	/** Returns only a prepared complete replay, never a normal retirement offer. */
	peekReplayBatch(width: number): HistoryBatch | undefined {
		this.#syncEntries();
		this.#settleFinalized();
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

	#peekBatch(width: number, capacity: number, policy: RetirementPolicy): HistoryBatch | undefined {
		this.#syncEntries();
		this.#settleFinalized();
		if (this.#offered !== undefined) return this.#offered.batch;
		const replay = this.peekReplayBatch(width);
		if (replay !== undefined) return replay;

		this.#completeFullyEmittedHeads(width);
		const room = Math.max(0, Math.trunc(capacity));
		const live = this.#liveEntries();
		if (live.length === 0) return undefined;
		const rendered: (readonly string[])[] = new Array(live.length);
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
		if (policy === "pressure" && !overflowing) return undefined;

		const head = this.#entries[this.#frontier];
		if (
			policy === "pressure" &&
			total > room &&
			head?.mode === "appendOnly" &&
			!head.stableFrozen &&
			head.state !== "committed" &&
			head.emitted < head.stableRows.length
		) {
			const emittedEnd = head.emitted + 1;
			const before = this.#renderStablePrefix(head, head.emitted, width);
			const after = this.#renderStablePrefix(head, emittedEnd, width);
			if (!isRowPrefix(before, after) || after.length === before.length) {
				this.#freezeStableRows(head, EMPTY_ROWS, "semantic row render added no suffix");
				return undefined;
			}
			const batch: HistoryBatch = {
				id: this.#nextBatchId++,
				rows: after.slice(before.length),
				kind: "append",
			};
			this.#offered = { batch, kind: "append", entry: this.#frontier, emittedEnd };
			return batch;
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
							if (rows.length > 0) rows.push("");
							rows.push(...prefix);
						}
						const batch: HistoryBatch = { id: this.#nextBatchId++, rows, kind: "append" };
						this.#offered = {
							batch,
							entries: commitEntries,
							kind: "commit",
							partial: { entry: next.index, watermark: partial },
						};
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
			return batch;
		}

		if (policy === "pressure" && total > room) {
			const candidate = live.find(({ entry }, index) => {
				return entry.partial === undefined && this.#legacyPrefix(entry, width, rendered[index]!) !== undefined;
			});
			if (candidate !== undefined) {
				const liveIndex = live.indexOf(candidate);
				const watermark = this.#legacyPrefix(candidate.entry, width, rendered[liveIndex]!)!;
				const rows = this.#renderEntry(candidate.entry, width).slice(
					this.#retiredPrefixLength(candidate.entry, width, rendered[liveIndex]!),
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
						separator: rowCount === full.length,
					};
					const rows = Array.from(full.slice(start, rowCount));
					if (watermark.separator) rows.push("");
					const batch: HistoryBatch = { id: this.#nextBatchId++, rows, kind: "append" };
					this.#offered = { batch, entry: candidate.index, kind: "snapshot", watermark };
					return batch;
				}
			}
		}
		return undefined;
	}

	/** Acknowledges exactly the most recently offered append, commit, or replay transaction. */
	acknowledgeFinalizedBatch(id: number): void {
		const offered = this.#offered;
		if (offered === undefined || offered.batch.id !== id) return;
		if (offered.kind === "append") {
			const entry = this.#entries[offered.entry];
			if (entry === undefined || offered.entry !== this.#frontier || offered.emittedEnd !== entry.emitted + 1)
				return;
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
		for (let index = this.#entries.length - 1; index >= 0; index--) {
			const entry = this.#entries[index]!;
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const block = trimBlankEdges(entry.component.render(width));
			if (block.length === 0) continue;
			if (rows.length > 0) rows.unshift("");
			rows.unshift(...block);
			if (rows.length >= cap) break;
		}
		return rows.length > cap ? rows.slice(rows.length - cap) : rows;
	}

	/** Full semantic render used by exports and non-terminal commands. */
	override render(width: number): readonly string[] {
		this.#syncEntries();
		const rows: string[] = [];
		for (const entry of this.#entries) {
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const block = this.#renderEntry(entry, width);
			if (block.length === 0) continue;
			if (rows.length > 0) rows.push("");
			rows.push(...block);
		}
		return rows;
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
		entry.renderedStableByWidth.set(width, stableRendered.slice());
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
			if (rows.length > 0) rows.push("");
			rows.push(...block);
			terminalAlreadySeparated = false;
		}
		if (trailingBlank && !terminalAlreadySeparated && (rows.length > 0 || indices.length > 0)) rows.push("");
		return rows;
	}

	#renderReplay(width: number): readonly string[] {
		const committed: number[] = [];
		for (let index = 0; index < this.#entries.length; index++) {
			if (this.#entries[index]!.state === "committed") committed.push(index);
		}
		const rows = Array.from(this.#renderSelection(committed, width, true));
		const head = this.#entries.find(entry => entry.state !== "committed");
		if (head?.mode === "appendOnly" && head.emitted > 0) {
			this.#setAllocation(head.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			this.#renderEntry(head, width);
			rows.push(...this.#renderStablePrefix(head, head.emitted, width));
		}
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
		const count = offered?.kind === "append" && offered.entry === index ? offered.emittedEnd : entry.emitted;
		const stable = this.#renderStablePrefix(entry, count, width).length;
		const snapshot = offered?.kind === "snapshot" && offered.entry === index ? offered.watermark : entry.snapshot;
		const partial =
			offered?.kind === "commit" && offered.partial?.entry === index ? offered.partial.watermark : entry.partial;
		let partialRows: number;
		if (partial === entry.partial) partialRows = this.#legacyPrefixLength(entry, width, rendered);
		else if (partial !== undefined) partialRows = this.#resolvePartial(partial, entry, width, rendered);
		else partialRows = 0;
		return Math.max(stable, partialRows, this.#snapshotStart(snapshot, entry.state, width, rendered));
	}

	#setAllocation(component: Component, rows: number, frame: AnimationFrame): void {
		(component as Component & TranscriptPresentationTarget).setTranscriptAllocation?.(rows, frame);
	}
	#settleFinalized(): void {
		for (const entry of this.#entries) {
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
