import type { Component, HistoryBatch } from "@oh-my-pi/pi-tui";
import { Container } from "@oh-my-pi/pi-tui";
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

interface FinalizableBlock {
	isTranscriptBlockFinalized?(): boolean;
	getTranscriptBlockSettledPrefix?(
		width: number,
		rendered: readonly string[],
	): { rowCount: number; cursor: unknown } | undefined;
	resolveTranscriptBlockSettledPrefix?(
		cursor: unknown,
		width: number,
		rendered: readonly string[],
	): number | undefined;
	/**
	 * Zero-row ordering markers may let finalized successors retire while the
	 * marker remains logically open. Real mutable content must never opt in.
	 */
	allowsTranscriptSuccessorRetirement?(): boolean;
}

/**
 * Block lifecycle:
 * - `active`: still mutating; renders live and counts against tool admission.
 * - `settled`: finalized but retained in the mutable viewport, re-rendering at
 *   the current width every frame (so resizes reflow it) until capacity
 *   pressure retires it.
 * - `committed`: appended to terminal history; immutable and never re-rendered.
 */
type BlockState = "active" | "settled" | "committed";

interface TranscriptEntry {
	component: Component;
	state: BlockState;
	partial?: PartialWatermark;
}

interface PartialWatermark {
	cursor: unknown;
	width: number;
	rowCount: number;
}

interface RenderedEntry {
	entry: TranscriptEntry;
	rendered: readonly string[];
	start: number;
	rows: readonly string[];
}

interface OfferedBatch {
	batch: HistoryBatch;
	end: number;
	partial?: {
		entry: TranscriptEntry;
		watermark: PartialWatermark;
	};
}

const MAX_LIVE_BLOCKS = 256;
const EMPTY_ROWS: readonly string[] = [];

function isFinalized(component: Component): boolean {
	const block = component as Component & FinalizableBlock;
	return block.isTranscriptBlockFinalized?.() ?? true;
}

function allowsSuccessorRetirement(component: Component): boolean {
	const block = component as Component & FinalizableBlock;
	return block.allowsTranscriptSuccessorRetirement?.() === true;
}

function validPrefixRowCount(rowCount: number | undefined, rendered: readonly string[]): number {
	if (rowCount === undefined || !Number.isSafeInteger(rowCount)) return 0;
	return rowCount >= 0 && rowCount <= rendered.length ? rowCount : 0;
}

function getSettledPrefix(
	component: Component,
	width: number,
	rendered: readonly string[],
): PartialWatermark | undefined {
	const block = component as Component & FinalizableBlock;
	if (block.getTranscriptBlockSettledPrefix === undefined) return undefined;
	try {
		const prefix = block.getTranscriptBlockSettledPrefix(width, rendered);
		if (prefix === undefined) return undefined;
		const rowCount = validPrefixRowCount(prefix.rowCount, rendered);
		if (rowCount === 0) return undefined;
		return { cursor: prefix.cursor, width, rowCount };
	} catch {
		return undefined;
	}
}

function resolveSettledPrefix(
	entry: TranscriptEntry,
	watermark: PartialWatermark | undefined,
	width: number,
	rendered: readonly string[],
): number {
	if (watermark === undefined) return 0;
	if (watermark.width === width) return validPrefixRowCount(watermark.rowCount, rendered);
	const block = entry.component as Component & FinalizableBlock;
	if (block.resolveTranscriptBlockSettledPrefix === undefined) return 0;
	try {
		return validPrefixRowCount(
			block.resolveTranscriptBlockSettledPrefix(watermark.cursor, width, rendered),
			rendered,
		);
	} catch {
		return 0;
	}
}

function isPlainBlank(line: string): boolean {
	return !/\S/.test(line);
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
	#offered: OfferedBatch | undefined;
	#toolActivityVisible = true;
	#lastFrame: AnimationFrame = { tick: 0, now: 0 };

	override addChild(component: Component): void {
		if (isToolActivityComponent(component)) component.setToolActivityVisible(this.#toolActivityVisible);
		super.addChild(component);
		this.#entries.push({ component, state: "active" });
	}

	override removeChild(component: Component): void {
		if (this.children.indexOf(component) < 0) return;
		if (!this.canRemoveBlock(component)) return;
		super.removeChild(component);
		this.#entries = this.#entries.filter(candidate => candidate.component !== component);
		this.#frontier = Math.min(this.#frontier, this.#entries.length);
	}

	override clear(): void {
		super.clear();
		this.#entries = [];
		this.#frontier = 0;
		this.#offered = undefined;
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
		// Active and settled blocks only live in the mutable viewport, so removing
		// them leaves no trace. Committed blocks are immutable terminal history,
		// and blocks inside the offered-but-unacknowledged batch are mid-write —
		// removing one would desync the offer's entry range.
		this.#syncEntries();
		const index = this.#entries.findIndex(entry => entry.component === component);
		if (index < 0) return false;
		const entry = this.#entries[index]!;
		if (entry.state === "committed" || entry.partial !== undefined) return false;
		if (this.#offered === undefined) return true;
		return index >= this.#offered.end && this.#offered.partial?.entry !== entry;
	}
	/** Lifecycle state per block in transcript order (diagnostics and tests). */
	blockStates(): readonly BlockState[] {
		this.#syncEntries();
		return this.#entries.map(entry => entry.state);
	}

	/** Whether visible active capacity and live-block memory permit another admission. */
	canAdmit(rows: number): boolean {
		const active = this.#entries.filter(entry => entry.state === "active").length;
		return Math.max(0, Math.trunc(rows)) > active && this.#liveCount() < MAX_LIVE_BLOCKS;
	}

	/** Rebuild retirement state before replaying the complete transcript history. */
	resetRetirement(): void {
		this.#frontier = 0;
		this.#offered = undefined;
		for (const entry of this.#entries) {
			entry.partial = undefined;
			if (entry.state === "committed") entry.state = isFinalized(entry.component) ? "settled" : "active";
		}
	}

	/** Total rows the live (non-committed, non-offered) tail occupies at `width`. */
	liveRowCount(width: number): number {
		this.#syncEntries();
		this.#settleFinalized();
		let total = 0;
		for (const rendered of this.#liveRenderedEntries(width)) {
			if (rendered.rows.length > 0) total += rendered.rows.length + (total > 0 ? 1 : 0);
		}
		return total;
	}

	/** Render the live tail, constrained to the supplied transcript height. */
	renderViewport(width: number, rows: number, frame: AnimationFrame = this.#lastFrame): readonly string[] {
		this.#lastFrame = frame;
		this.#syncEntries();
		this.#settleFinalized();
		const live = this.#liveRenderedEntries(width);
		const capacity = Math.max(0, Math.trunc(rows));
		if (live.length === 0 || capacity === 0) return EMPTY_ROWS;

		// Full-height pass first: measure every live block whole. Empty blocks
		// (hidden tool activity under display.hideToolActivity, content-less
		// streaming blocks) occupy no viewport rows, so they are dropped here and
		// never reach the pressure/emergency paths — otherwise they would reserve
		// a base row (over-truncating real text) or emit a blank row per block.
		const shown: RenderedEntry[] = [];
		const blocks: (readonly string[])[] = [];
		let total = 0;
		for (const entry of live) {
			const rendered = entry.rows;
			if (rendered.length === 0) continue;
			total += rendered.length + (shown.length > 0 ? 1 : 0);
			shown.push(entry);
			blocks.push(rendered);
		}
		if (shown.length === 0) return EMPTY_ROWS;
		if (shown.length > capacity) return this.#renderEmergency(shown, width, capacity, frame);
		if (total <= capacity) {
			const output: string[] = [];
			for (const rendered of blocks) {
				if (output.length > 0) output.push("");
				output.push(...rendered);
			}
			return output;
		}

		// Pressure: one row minimum per block, surplus to the newest blocks first,
		// separators dropped. Tool blocks re-render compact below three rows; text
		// blocks keep their latest rows visible.
		const allocation: number[] = new Array(shown.length).fill(1);
		let surplus = capacity - shown.length;
		for (let index = shown.length - 1; index >= 0 && surplus > 0; index--) {
			const extra = Math.min(Math.max(0, blocks[index]!.length - 1), surplus);
			allocation[index] += extra;
			surplus -= extra;
		}
		const output: string[] = [];
		for (let index = 0; index < shown.length; index++) {
			const allocated = allocation[index]!;
			const shownEntry = shown[index]!;
			this.#setAllocation(shownEntry.entry.component, allocated, frame);
			const rendered = trimBlankEdges(shownEntry.entry.component.render(width)).slice(shownEntry.start);
			if (rendered.length <= allocated) output.push(...rendered);
			else output.push(...rendered.slice(rendered.length - allocated));
		}
		return output.length > capacity ? output.slice(output.length - capacity) : output;
	}

	/**
	 * Offer the settled prefix that must retire for the live tail to fit
	 * `capacity` rows. Blocks stay live (re-rendering at the current width)
	 * while room remains; the offer stands until the terminal acknowledges it.
	 */
	peekFinalizedBatch(width: number, capacity: number): HistoryBatch | undefined {
		this.#syncEntries();
		this.#settleFinalized();
		if (this.#offered !== undefined) return this.#offered.batch;
		const room = Math.max(0, Math.trunc(capacity));
		const live = this.#liveRenderedEntries(width);
		if (live.length === 0) return undefined;
		let total = this.#rowCount(live);
		const completingPartial = live[0]!.entry.state === "settled" && live[0]!.entry.partial !== undefined;
		const overflowing = completingPartial || total > room || this.#liveCount() >= MAX_LIVE_BLOCKS;
		if (!overflowing) return undefined;
		// Retire the longest settled prefix needed to fit. Real mutable content
		// remains an absolute ordering barrier. A zero-row logical marker may
		// explicitly permit finalized successors to cross it: the completed-run
		// collapse anchor uses this to preserve its metadata without swallowing
		// the live run above the terminal scrollback seam.
		let end = this.#frontier;
		let index = 0;
		let partial: OfferedBatch["partial"];
		while (end < this.#entries.length) {
			const rendered = live[index]!;
			const entry = rendered.entry;
			const settled = entry.state === "settled";
			const transparentMarker =
				entry.state === "active" && rendered.rows.length === 0 && allowsSuccessorRetirement(entry.component);
			const closesPartial = settled && entry.partial !== undefined;
			if (!closesPartial && total <= room && this.#liveCount() - (end - this.#frontier) < MAX_LIVE_BLOCKS) break;
			if (settled || transparentMarker) {
				end++;
				index++;
				total = this.#rowCount(live, index);
				continue;
			}

			const watermark = getSettledPrefix(entry.component, width, rendered.rendered);
			if (watermark !== undefined && watermark.rowCount > rendered.start) {
				partial = { entry, watermark };
			}
			break;
		}
		if (end === this.#frontier && partial === undefined) return undefined;
		const rows: string[] = [];
		for (let retire = this.#frontier; retire < end; retire++) {
			const rendered = live[retire - this.#frontier]!;
			if (rendered.rows.length > 0) rows.push(...rendered.rows);
			if (rendered.rendered.length > 0 || rendered.entry.partial !== undefined) rows.push("");
		}
		if (partial !== undefined) {
			const rendered = live[end - this.#frontier]!;
			rows.push(...rendered.rendered.slice(rendered.start, partial.watermark.rowCount));
		}
		const batch: HistoryBatch = { id: this.#nextBatchId++, rows };
		this.#offered = { batch, end, partial };
		return batch;
	}

	/** Retire exactly the history batch most recently offered by this container. */
	acknowledgeFinalizedBatch(id: number): void {
		const offered = this.#offered;
		if (offered === undefined || offered.batch.id !== id) return;
		for (let index = this.#frontier; index < offered.end; index++) {
			const entry = this.#entries[index]!;
			entry.state = "committed";
			entry.partial = undefined;
		}
		this.#frontier = offered.end;
		if (offered.partial !== undefined) {
			offered.partial.entry.partial = offered.partial.watermark;
		}
		this.#offered = undefined;
	}

	/** Full semantic render used by exports and non-terminal commands. */
	override render(width: number): readonly string[] {
		this.#syncEntries();
		const rows: string[] = [];
		for (const entry of this.#entries) {
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const block = trimBlankEdges(entry.component.render(width));
			if (block.length === 0) continue;
			if (rows.length > 0) rows.push("");
			rows.push(...block);
		}
		return rows;
	}

	#renderEmergency(
		shown: readonly RenderedEntry[],
		width: number,
		rows: number,
		frame: AnimationFrame,
	): readonly string[] {
		const output: string[] = [];
		const hiddenCount = Math.max(0, shown.length - rows);
		let hiddenActive = 0;
		for (let index = 0; index < hiddenCount; index++) {
			if (shown[index]!.entry.state === "active") hiddenActive++;
		}
		if (hiddenActive > 0) output.push(`${hiddenActive} more transcript blocks active`);
		const visibleRows = rows - output.length;
		const visible = visibleRows > 0 ? shown.slice(-visibleRows) : [];
		// Callers pass only non-empty blocks; trim residual edge blanks so each
		// block contributes its first real row instead of a reserved blank.
		for (const renderedEntry of visible) {
			this.#setAllocation(renderedEntry.entry.component, 1, frame);
			output.push(trimBlankEdges(renderedEntry.entry.component.render(width)).slice(renderedEntry.start)[0] ?? "");
		}
		return output.slice(0, rows);
	}

	#setAllocation(component: Component, rows: number, frame: AnimationFrame): void {
		(component as Component & TranscriptPresentationTarget).setTranscriptAllocation?.(rows, frame);
	}
	#settleFinalized(): void {
		for (const entry of this.#entries) {
			if (entry.state === "active" && isFinalized(entry.component)) entry.state = "settled";
		}
	}

	/** Live entries: past the committed frontier and not wholly in the offered batch. */
	#liveEntries(): TranscriptEntry[] {
		const start = this.#offered?.end ?? this.#frontier;
		return this.#entries.slice(start);
	}

	#liveRenderedEntries(width: number): RenderedEntry[] {
		const renderedEntries: RenderedEntry[] = [];
		for (const entry of this.#liveEntries()) {
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const rendered = trimBlankEdges(entry.component.render(width));
			const pending = this.#offered?.partial?.entry === entry ? this.#offered.partial.watermark : undefined;
			const start = resolveSettledPrefix(entry, pending ?? entry.partial, width, rendered);
			renderedEntries.push({ entry, rendered, start, rows: rendered.slice(start) });
		}
		return renderedEntries;
	}

	#rowCount(rendered: readonly RenderedEntry[], start = 0): number {
		let total = 0;
		for (let index = start; index < rendered.length; index++) {
			const rows = rendered[index]!.rows;
			if (rows.length > 0) total += rows.length + (total > 0 ? 1 : 0);
		}
		return total;
	}

	#liveCount(): number {
		return this.#entries.length - this.#frontier;
	}

	#syncEntries(): void {
		if (
			this.#entries.length === this.children.length &&
			this.#entries.every((entry, index) => entry.component === this.children[index])
		)
			return;
		const existing = new Map(this.#entries.map(entry => [entry.component, entry]));
		this.#entries = this.children.map(component => existing.get(component) ?? { component, state: "active" });
		this.#frontier = this.#entries.findIndex(entry => entry.state !== "committed");
		if (this.#frontier < 0) this.#frontier = this.#entries.length;
	}
}

/** Groups sibling rows into one semantic transcript block. */
export class TranscriptBlock extends Container {}
