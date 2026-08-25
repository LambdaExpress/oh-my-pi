import type { Component, HistoryBatch } from "@oh-my-pi/pi-tui";
import { Container } from "@oh-my-pi/pi-tui";
import { isToolActivityComponent } from "./tool-activity";

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
	snapshot?: SnapshotWatermark;
}

interface PartialWatermark {
	cursor: unknown;
	width: number;
	rowCount: number;
}

/**
 * Rows already written exactly as they appeared while a block was active.
 * Unlike a semantic partial cursor, a visual snapshot may later diverge. Active
 * blocks keep using its row count so growing output never disappears; once the
 * block settles, a dirty snapshot replays the complete final block below the
 * stale visual copy (duplication is preferable to content loss).
 */
interface SnapshotWatermark {
	width: number;
	rowCount: number;
	prefix: readonly string[];
	separator: boolean;
	dirty: boolean;
}

interface RenderedEntry {
	entry: TranscriptEntry;
	rendered: readonly string[];
	start: number;
	rows: readonly string[];
}

type OfferedAction =
	| { kind: "commit"; entry: TranscriptEntry }
	| { kind: "partial"; entry: TranscriptEntry; watermark: PartialWatermark }
	| { kind: "snapshot"; entry: TranscriptEntry; watermark: SnapshotWatermark };

interface OfferedBatch {
	batch: HistoryBatch;
	actions: readonly OfferedAction[];
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
		// An unsnapshotted active/settled block still lives only in the mutable
		// viewport and can disappear without a trace. Semantic/visual prefixes,
		// committed blocks, and offered actions already own terminal history and
		// must remain in the transcript ledger.
		this.#syncEntries();
		const index = this.#entries.findIndex(entry => entry.component === component);
		if (index < 0) return false;
		const entry = this.#entries[index]!;
		if (entry.state === "committed" || entry.partial !== undefined || entry.snapshot !== undefined) return false;
		if (this.#offered === undefined) return true;
		return !this.#offered.actions.some(action => action.entry === entry);
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
			entry.snapshot = undefined;
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

	/**
	 * Render the bottom of the live transcript at full semantic fidelity.
	 * Whole components always use their normal renderer; viewport pressure may
	 * move older rows above the visible fold, but never substitutes compact tool
	 * summaries or per-block tail fragments.
	 */
	renderViewport(width: number, rows: number): readonly string[] {
		this.#syncEntries();
		this.#settleFinalized();
		const live = this.#liveRenderedEntries(width);
		const capacity = Math.max(0, Math.trunc(rows));
		if (live.length === 0 || capacity === 0) return EMPTY_ROWS;

		// Walk newest to oldest and render only enough complete semantic blocks to
		// cover the visible tail. Empty blocks consume no capacity.
		const collected: (readonly string[])[] = [];
		let total = 0;
		for (let index = live.length - 1; index >= 0 && total < capacity; index--) {
			const block = live[index]!.rows;
			if (block.length === 0) continue;
			if (collected.length > 0) total++;
			collected.push(block);
			total += block.length;
		}
		if (collected.length === 0) return EMPTY_ROWS;
		const output: string[] = [];
		for (let index = collected.length - 1; index >= 0; index--) {
			if (output.length > 0) output.push("");
			output.push(...collected[index]!);
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
		const completingRetirement = live.some(
			rendered =>
				rendered.entry.state === "settled" &&
				(rendered.entry.partial !== undefined || rendered.entry.snapshot !== undefined),
		);
		const overflowing = completingRetirement || total > room || this.#liveCount() >= MAX_LIVE_BLOCKS;
		if (!overflowing) return undefined;
		// Retire exact settled blocks first. An active block may contribute either
		// a provider-declared semantic prefix or, as a last resort, the exact rows
		// that would otherwise be clipped from the top of the viewport. Once all
		// current rows of an active block are on the visual tape, later blocks may
		// drain too; the block remains active and any newly appended rows still
		// render normally.
		let index = 0;
		const actions: OfferedAction[] = [];
		const rows: string[] = [];
		while (index < live.length) {
			const rendered = live[index]!;
			const entry = rendered.entry;
			const settled = entry.state === "settled";
			const transparentMarker =
				entry.state === "active" && rendered.rows.length === 0 && allowsSuccessorRetirement(entry.component);
			const closesWatermark = settled && (entry.partial !== undefined || entry.snapshot !== undefined);
			if (!closesWatermark && total <= room && this.#liveCount() - actions.length < MAX_LIVE_BLOCKS) break;
			if (settled) {
				if (rendered.rows.length > 0) rows.push(...rendered.rows);
				const snapshotAlreadySeparated =
					entry.snapshot !== undefined &&
					!entry.snapshot.dirty &&
					entry.snapshot.separator &&
					rendered.start === rendered.rendered.length;
				if (!snapshotAlreadySeparated && (rendered.rendered.length > 0 || entry.partial || entry.snapshot)) {
					rows.push("");
				}
				actions.push({ kind: "commit", entry });
				index++;
				total = this.#rowCount(live, index);
				continue;
			}
			if (transparentMarker || rendered.rows.length === 0) {
				index++;
				total = this.#rowCount(live, index);
				continue;
			}

			if (entry.snapshot === undefined) {
				const watermark = getSettledPrefix(entry.component, width, rendered.rendered);
				if (watermark !== undefined && watermark.rowCount > rendered.start) {
					rows.push(...rendered.rendered.slice(rendered.start, watermark.rowCount));
					actions.push({ kind: "partial", entry, watermark });
					break;
				}
			}
			// Keep exact retirement and provisional visual snapshots in separate
			// terminal transactions. Exact semantic prefixes may share the batch;
			// only the fallback snapshot waits for the next acknowledgement.
			if (actions.length > 0) break;

			const needed = Math.max(1, total - room);
			const rowCount = Math.min(rendered.rendered.length, rendered.start + needed);
			if (rowCount <= rendered.start) break;
			rows.push(...rendered.rendered.slice(rendered.start, rowCount));
			const previous = entry.snapshot;
			let dirty = previous?.dirty ?? false;
			let prefix: string[];
			if (previous !== undefined && previous.width === width) {
				prefix = Array.from(previous.prefix);
				const comparable = Math.min(previous.rowCount, rendered.rendered.length);
				for (let row = 0; row < comparable; row++) {
					if (prefix[row] !== rendered.rendered[row]) {
						dirty = true;
						break;
					}
				}
				if (
					previous.rowCount > rendered.rendered.length ||
					(previous.separator && rendered.rendered.length > previous.rowCount)
				) {
					dirty = true;
				}
				for (let row = prefix.length; row < rowCount; row++) prefix.push(rendered.rendered[row]!);
			} else {
				dirty ||= previous !== undefined;
				prefix = rendered.rendered.slice(0, rowCount);
			}
			const separator = rowCount === rendered.rendered.length;
			if (separator) rows.push("");
			actions.push({
				kind: "snapshot",
				entry,
				watermark: { width, rowCount, prefix, separator, dirty },
			});
			break;
		}
		if (actions.length === 0) return undefined;
		const batch: HistoryBatch = { id: this.#nextBatchId++, rows };
		this.#offered = { batch, actions };
		return batch;
	}

	/** Retire exactly the history batch most recently offered by this container. */
	acknowledgeFinalizedBatch(id: number): void {
		const offered = this.#offered;
		if (offered === undefined || offered.batch.id !== id) return;
		for (const action of offered.actions) {
			if (action.kind === "commit") {
				action.entry.state = "committed";
				action.entry.partial = undefined;
				action.entry.snapshot = undefined;
			} else if (action.kind === "partial") {
				action.entry.partial = action.watermark;
				action.entry.snapshot = undefined;
			} else {
				action.entry.snapshot = action.watermark;
				action.entry.partial = undefined;
			}
		}
		this.#frontier = this.#entries.findIndex(entry => entry.state !== "committed");
		if (this.#frontier < 0) this.#frontier = this.#entries.length;
		this.#offered = undefined;
	}

	/** Full semantic render used by exports and non-terminal commands. */
	override render(width: number): readonly string[] {
		this.#syncEntries();
		const rows: string[] = [];
		for (const entry of this.#entries) {
			const block = trimBlankEdges(entry.component.render(width));
			if (block.length === 0) continue;
			if (rows.length > 0) rows.push("");
			rows.push(...block);
		}
		return rows;
	}

	#settleFinalized(): void {
		for (const entry of this.#entries) {
			if (entry.state === "active" && isFinalized(entry.component)) entry.state = "settled";
		}
	}

	/** Live entries, excluding settled blocks committed by the in-flight offer. */
	#liveEntries(): TranscriptEntry[] {
		return this.#entries
			.slice(this.#frontier)
			.filter(
				entry =>
					entry.state !== "committed" &&
					!this.#offered?.actions.some(action => action.kind === "commit" && action.entry === entry),
			);
	}

	#liveRenderedEntries(width: number): RenderedEntry[] {
		const renderedEntries: RenderedEntry[] = [];
		for (const entry of this.#liveEntries()) {
			const rendered = trimBlankEdges(entry.component.render(width));
			const offered = this.#offered?.actions.find(action => action.entry === entry);
			const partial = offered?.kind === "partial" ? offered.watermark : entry.partial;
			const snapshot = offered?.kind === "snapshot" ? offered.watermark : entry.snapshot;
			const start = Math.max(
				resolveSettledPrefix(entry, partial, width, rendered),
				this.#resolveSnapshotStart(entry, snapshot, width, rendered),
			);
			renderedEntries.push({ entry, rendered, start, rows: rendered.slice(start) });
		}
		return renderedEntries;
	}

	#resolveSnapshotStart(
		entry: TranscriptEntry,
		snapshot: SnapshotWatermark | undefined,
		width: number,
		rendered: readonly string[],
	): number {
		if (snapshot === undefined) return 0;
		if (snapshot.width !== width) {
			snapshot.dirty = true;
			return 0;
		}
		const comparable = Math.min(snapshot.rowCount, rendered.length);
		for (let row = 0; row < comparable; row++) {
			if (snapshot.prefix[row] !== rendered[row]) {
				snapshot.dirty = true;
				break;
			}
		}
		if (snapshot.rowCount > rendered.length || (snapshot.separator && rendered.length > snapshot.rowCount)) {
			snapshot.dirty = true;
		}
		if (entry.state === "settled" && snapshot.dirty) return 0;
		return comparable;
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
		this.#entries = this.children.map(component => existing.get(component) ?? { component, state: "active" });
		this.#frontier = this.#entries.findIndex(entry => entry.state !== "committed");
		if (this.#frontier < 0) this.#frontier = this.#entries.length;
	}
}

/** Groups sibling rows into one semantic transcript block. */
export class TranscriptBlock extends Container {}
