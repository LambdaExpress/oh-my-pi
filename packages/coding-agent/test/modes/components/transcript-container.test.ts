import { describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import type { Component } from "@oh-my-pi/pi-tui";

class Block implements Component {
	#rows: string[];
	#finalized: boolean;
	allocations: number[] = [];

	constructor(rows: string[], finalized: boolean) {
		this.#rows = rows;
		this.#finalized = finalized;
	}

	finalize(rows: string[]): void {
		this.#rows = rows;
		this.#finalized = true;
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	setTranscriptAllocation(rows: number): void {
		this.allocations.push(rows);
	}

	render(): readonly string[] {
		return this.#rows;
	}
}

const frame = { tick: 0, now: 0 };

class TransparentGate extends Block {
	constructor() {
		super([], false);
	}

	allowsTranscriptSuccessorRetirement(): boolean {
		return true;
	}
}

class PrefixBlock extends Block {
	readonly #cursor = {};

	getTranscriptBlockSettledPrefix(
		_width: number,
		rendered: readonly string[],
	): { rowCount: number; cursor: unknown } | undefined {
		return rendered.length === 0 ? undefined : { rowCount: 1, cursor: this.#cursor };
	}

	resolveTranscriptBlockSettledPrefix(
		cursor: unknown,
		_width: number,
		rendered: readonly string[],
	): number | undefined {
		return cursor === this.#cursor && rendered.length > 0 ? 1 : undefined;
	}
}

class ReflowingPrefixBlock implements Component {
	readonly #cursor = {};
	#finalized = false;

	finalize(): void {
		this.#finalized = true;
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	getTranscriptBlockSettledPrefix(
		width: number,
		_rendered: readonly string[],
	): { rowCount: number; cursor: unknown } | undefined {
		return {
			rowCount: width <= 40 ? 2 : 1,
			cursor: this.#cursor,
		};
	}

	resolveTranscriptBlockSettledPrefix(
		cursor: unknown,
		width: number,
		rendered: readonly string[],
	): number | undefined {
		if (cursor !== this.#cursor) return undefined;
		return Math.min(width <= 40 ? 2 : 1, rendered.length);
	}

	render(width: number): readonly string[] {
		return width <= 40 ? ["stable narrow 0", "stable narrow 1", "tail"] : ["stable wide", "tail"];
	}
}

describe("TranscriptContainer", () => {
	it("keeps settled blocks live while the viewport has room", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["settled"], true));
		transcript.addChild(new Block(["streaming"], false));

		// Both fit: nothing retires, the settled block still renders live.
		expect(transcript.peekFinalizedBatch(80, 10)).toBeUndefined();
		expect(transcript.renderViewport(80, 10)).toEqual(["settled", "", "streaming"]);
	});

	it("retires the settled prefix only under capacity pressure, in order", () => {
		const transcript = new TranscriptContainer();
		const first = new Block(["first final"], true);
		const second = new Block(["second live", "row", "row"], false);
		transcript.addChild(first);
		transcript.addChild(second);

		// 5 rows fit everything (1 + separator + 3).
		expect(transcript.peekFinalizedBatch(80, 5)).toBeUndefined();
		// 3 rows force the settled prefix out.
		expect(transcript.peekFinalizedBatch(80, 3)?.rows).toEqual(["first final", ""]);
	});

	it("retires complete assistant text instead of reducing it to a tail fragment", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["assistant first", "assistant middle", "assistant last"], true));
		transcript.addChild(new Block(["tool header", "tool detail", "tool body"], false));

		// Under pressure the complete settled reply becomes immutable history.
		// Only the still-mutating tool remains in the bounded viewport.
		expect(transcript.peekFinalizedBatch(80, 2)?.rows).toEqual([
			"assistant first",
			"assistant middle",
			"assistant last",
			"",
		]);
		expect(transcript.renderViewport(80, 2)).toEqual(["tool detail", "tool body"]);
	});

	it("never retires a finalized successor past an active predecessor", () => {
		const transcript = new TranscriptContainer();
		const active = new Block(["active live"], false);
		const settled = new Block(["settled final"], true);
		transcript.addChild(active);
		transcript.addChild(settled);

		// Pressure exists but the prefix starts with an active block: no batch,
		// and both blocks still render (clipped by the viewport).
		expect(transcript.peekFinalizedBatch(80, 1)).toBeUndefined();
		expect(transcript.renderViewport(80, 10)).toEqual(["active live", "", "settled final"]);

		active.finalize(["active final"]);
		// Capacity 1 fits the remaining settled block, so only the first retires.
		expect(transcript.peekFinalizedBatch(80, 1)?.rows).toEqual(["active final", ""]);
	});

	it("retires finalized content past a zero-row completed-run gate", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["user request"], true));
		transcript.addChild(new TransparentGate());
		transcript.addChild(new Block(["assistant explanation"], true));
		transcript.addChild(new Block(["active tool"], false));

		expect(transcript.peekFinalizedBatch(80, 1)?.rows).toEqual(["user request", "", "assistant explanation", ""]);
		expect(transcript.renderViewport(80, 1)).toEqual(["active tool"]);
	});

	it("reoffers an unacknowledged batch and retires it exactly once", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["final one"], true));
		transcript.addChild(new Block(["final two"], true));
		const first = transcript.peekFinalizedBatch(80, 0);
		const second = transcript.peekFinalizedBatch(80, 50);

		expect(second).toEqual(first);
		if (first === undefined) throw new Error("expected a batch under zero capacity");
		transcript.acknowledgeFinalizedBatch(first.id);
		// Committed blocks leave the live tail and never render again.
		expect(transcript.renderViewport(80, 10)).toEqual([]);
		expect(transcript.peekFinalizedBatch(80, 10)).toBeUndefined();
	});

	it("excludes an offered batch from the live viewport in the same frame", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["old settled"], true));
		transcript.addChild(new Block(["fresh live"], false));

		const batch = transcript.peekFinalizedBatch(80, 1);
		expect(batch?.rows).toEqual(["old settled", ""]);
		expect(transcript.renderViewport(80, 1)).toEqual(["fresh live"]);
	});

	it("assigns one row per live block until pressure requires aggregation", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["first"], false));
		transcript.addChild(new Block(["second"], false));

		expect(transcript.renderViewport(80, 2, frame)).toEqual(["first", "second"]);
		expect(transcript.canAdmit(2)).toBe(false);
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["1 more transcript blocks active"]);
	});
	it("does not report settled resume backlog as active", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["settled one"], true));
		transcript.addChild(new Block(["settled two"], true));
		transcript.addChild(new Block(["current tool"], false));

		// The welcome header can consume the first history offer, leaving the
		// settled transcript prefix live for one frame while it drains next.
		expect(transcript.renderViewport(80, 1)).toEqual(["current tool"]);
	});
	it("excludes empty blocks so pressure never emits blank rows (issue 9483)", () => {
		const transcript = new TranscriptContainer();
		// Text blocks interleaved with empty (hidden tool-activity) blocks that
		// render nothing but stay live until retired.
		for (let i = 0; i < 6; i++) {
			transcript.addChild(new Block([`t${i}a`, `t${i}b`, `t${i}c`], true));
			for (let j = 0; j < 8; j++) transcript.addChild(new Block([], true));
		}
		// Emergency path: more non-empty blocks than rows. Every row carries real
		// text — no block's tail is dropped as blank padding.
		const out = transcript.renderViewport(80, 12, frame);
		expect(out).toHaveLength(12);
		expect(out.every(row => /\S/.test(row))).toBe(true);
	});

	it("empty blocks do not reserve capacity from real text under pressure (issue 9483)", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["A1", "A2", "A3", "A4"], true));
		transcript.addChild(new Block([], true));
		transcript.addChild(new Block(["B1", "B2", "B3", "B4"], true));
		transcript.addChild(new Block([], true));
		transcript.addChild(new Block(["C1", "C2", "C3", "C4"], true));
		// Capacity 10 fits all real content once the two empty blocks stop
		// stealing a base row each; the older block keeps its tail rows.
		const out = transcript.renderViewport(80, 10, frame);
		expect(out).toEqual(["A3", "A4", "B1", "B2", "B3", "B4", "C1", "C2", "C3", "C4"]);
	});

	it("permits removing settled blocks until they are offered or committed", () => {
		const transcript = new TranscriptContainer();
		const settled = new Block(["settled snapshot"], true);
		const live = new Block(["live", "live", "live"], false);
		transcript.addChild(settled);
		transcript.addChild(live);

		// Settled but still in the mutable viewport: removable without a trace,
		// so a follow-up displaceable snapshot can retract it.
		expect(transcript.canRemoveBlock(settled)).toBe(true);

		// Offered to the terminal: mid-write, no longer removable.
		const batch = transcript.peekFinalizedBatch(80, 2);
		expect(batch?.rows).toEqual(["settled snapshot", ""]);
		expect(transcript.canRemoveBlock(settled)).toBe(false);

		// Committed: immutable history; removal must be refused outright.
		transcript.acknowledgeFinalizedBatch(batch!.id);
		expect(transcript.canRemoveBlock(settled)).toBe(false);
		transcript.removeChild(settled);
		expect(transcript.blockStates()).toEqual(["committed", "active"]);
	});

	it("reoffers committed history after an explicit destructive reset", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["final"], true));
		const first = transcript.peekFinalizedBatch(80, 0);
		if (first === undefined) throw new Error("expected initial batch");
		transcript.acknowledgeFinalizedBatch(first.id);

		transcript.resetRetirement();
		// Fits again after the reset: stays live until pressure returns.
		expect(transcript.renderViewport(80, 10)).toEqual(["final"]);
		const replay = transcript.peekFinalizedBatch(80, 0);
		expect(replay?.id).toBeGreaterThan(first.id);
		expect(replay?.rows).toEqual(["final", ""]);
	});

	it("retires an active block's declared stable prefix without dropping or duplicating tape rows", () => {
		const transcript = new TranscriptContainer();
		const settled = new Block(["S"], true);
		const active = new PrefixBlock(["T0", "T1", "T2", "T3"], false);
		transcript.addChild(settled);
		transcript.addChild(active);

		const first = transcript.peekFinalizedBatch(80, 3);
		expect(first?.rows).toEqual(["S", "", "T0"]);
		expect(transcript.peekFinalizedBatch(80, 50)).toBe(first);
		expect(transcript.renderViewport(80, 3)).toEqual(["T1", "T2", "T3"]);

		if (first === undefined) throw new Error("expected a partial history batch");
		transcript.acknowledgeFinalizedBatch(first.id);
		expect(transcript.canRemoveBlock(active)).toBe(false);
		transcript.removeChild(active);
		expect(transcript.blockStates()).toEqual(["committed", "active"]);

		active.finalize(["T0", "T1", "T2", "T3"]);
		const second = transcript.peekFinalizedBatch(80, 3);
		expect(second?.rows).toEqual(["T1", "T2", "T3", ""]);

		const tape = [...first.rows, ...(second?.rows ?? [])];
		expect(tape).toEqual(["S", "", "T0", "T1", "T2", "T3", ""]);
		for (const marker of ["S", "T0", "T1", "T2", "T3"]) {
			expect(tape.filter(row => row === marker)).toHaveLength(1);
		}
	});

	it("projects an acknowledged logical prefix through a preserve resize", () => {
		const transcript = new TranscriptContainer();
		const active = new ReflowingPrefixBlock();
		transcript.addChild(active);

		const first = transcript.peekFinalizedBatch(80, 1);
		expect(first?.rows).toEqual(["stable wide"]);
		// The pending offer and its acknowledged watermark both resolve the
		// provider-owned cursor instead of reusing the one-row wide projection.
		expect(transcript.renderViewport(40, 10)).toEqual(["tail"]);
		if (first === undefined) throw new Error("expected a partial history batch");
		transcript.acknowledgeFinalizedBatch(first.id);
		expect(transcript.liveRowCount(40)).toBe(1);
		expect(transcript.renderViewport(40, 10)).toEqual(["tail"]);

		active.finalize();
		expect(transcript.peekFinalizedBatch(40, 10)?.rows).toEqual(["tail", ""]);
	});

	it("clears an acknowledged partial watermark on destructive reset", () => {
		const transcript = new TranscriptContainer();
		const active = new PrefixBlock(["T0", "T1"], false);
		transcript.addChild(active);

		const partial = transcript.peekFinalizedBatch(80, 1);
		if (partial === undefined) throw new Error("expected a partial history batch");
		transcript.acknowledgeFinalizedBatch(partial.id);
		expect(transcript.renderViewport(80, 10)).toEqual(["T1"]);
		expect(transcript.canRemoveBlock(active)).toBe(false);

		transcript.resetRetirement();
		expect(transcript.renderViewport(80, 10)).toEqual(["T0", "T1"]);
		expect(transcript.canRemoveBlock(active)).toBe(true);
	});

	it("keeps an undeclared active prefix behind the mutable barrier", () => {
		const transcript = new TranscriptContainer();
		const active = new Block(["T0", "T1", "T2", "T3"], false);
		transcript.addChild(active);

		expect(transcript.peekFinalizedBatch(80, 3)).toBeUndefined();
		expect(transcript.renderViewport(80, 3)).toEqual(["T1", "T2", "T3"]);

		active.finalize(["T0", "T1", "T2", "T3"]);
		expect(transcript.peekFinalizedBatch(80, 0)?.rows).toEqual(["T0", "T1", "T2", "T3", ""]);
	});
});
