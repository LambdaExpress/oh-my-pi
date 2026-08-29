import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import {
	TranscriptContainer,
	type TranscriptStableRow,
} from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
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
		return { rowCount: width <= 40 ? 2 : 1, cursor: this.#cursor };
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

/** A live block the container recognizes as dynamic tool-activity. */
class ToolBlock extends Block {
	setToolActivityVisible(): void {}
}

function literalStableRow(row: string): TranscriptStableRow {
	return { key: row };
}

class AppendBlock extends Block {
	readonly transcriptBlockMode = "appendOnly" as const;
	#stable: readonly TranscriptStableRow[];
	#stableRender: readonly string[];

	constructor(rows: string[], stable: readonly string[], finalized = false) {
		super(rows, finalized);
		this.#stable = stable.map(literalStableRow);
		this.#stableRender = stable;
	}

	publish(rows: readonly string[]): void {
		this.#stable = rows.map(literalStableRow);
		this.#stableRender = rows;
	}

	publishStable(rows: readonly TranscriptStableRow[], rendered: readonly string[]): void {
		this.#stable = rows;
		this.#stableRender = rendered;
	}

	getTranscriptStableRows(): readonly TranscriptStableRow[] {
		return this.#stable;
	}

	renderTranscriptStableRows(count: number, _width: number): readonly string[] {
		return this.#stableRender.slice(0, count);
	}
}

class ReflowingAppendBlock implements Component {
	readonly transcriptBlockMode = "appendOnly" as const;
	#finalized = false;
	readonly #stable: TranscriptStableRow = { key: "abcdefgh" };

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	finalize(): void {
		this.#finalized = true;
	}

	getTranscriptStableRows(): readonly TranscriptStableRow[] {
		return [this.#stable];
	}

	renderTranscriptStableRows(count: number, width: number): readonly string[] {
		if (count <= 0) return [];
		const rows: string[] = [];
		for (let offset = 0; offset < 8; offset += width) rows.push("abcdefgh".slice(offset, offset + width));
		return rows;
	}

	render(width: number): readonly string[] {
		return [...this.renderTranscriptStableRows(1, width), this.#finalized ? "final" : "partial"];
	}
}
const finalAnswer: AssistantMessage = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "Reasoning first" },
		{ type: "text", text: "## Implemented" },
	],
	api: "openai-codex-responses",
	provider: "openai-codex",
	model: "gpt-5.6-sol",
	stopReason: "stop",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	timestamp: 1,
};

const frame = { tick: 0, now: 0 };

describe("TranscriptContainer", () => {
	it("captures mutable by default and append-only declarations permanently", () => {
		const transcript = new TranscriptContainer();
		const mutable = new Block(["mutable"], false) as Block & {
			transcriptBlockMode?: "appendOnly";
			getTranscriptStableRows?: () => readonly TranscriptStableRow[];
		};
		transcript.addChild(mutable);
		mutable.transcriptBlockMode = "appendOnly";
		mutable.getTranscriptStableRows = () => [literalStableRow("mutable")];
		transcript.addChild(new AppendBlock(["stable", "partial"], ["stable"]));

		expect(transcript.blockModes()).toEqual(["mutable", "appendOnly"]);
	});

	it("freezes a retracting publication and keeps rendering the block", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["one", "two"], ["one"]);
		transcript.addChild(block);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["one", "two"]);

		// Retraction cannot be honored (rows may already sit in scrollback):
		// the block demotes to finalize-time retirement but never fails a render.
		block.publish(["changed"]);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["one", "two"]);
		expect(transcript.blockModes()).toEqual(["appendOnly"]);
	});

	it("freezes drifted stable bytes, keeps the emitted slice, and retires the remainder once", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["one", "two"], ["one"]);
		transcript.addChild(block);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["one", "two"]);

		const emitted = transcript.peekFinalizedBatch(80, 0)!;
		expect(emitted.rows).toEqual(["one"]);
		transcript.acknowledgeFinalizedBatch(emitted.id);

		// Published bytes drift (e.g. a mid-stream theme change): the emitted
		// slice stays retired, the live tail keeps rendering, and no further
		// mid-stream row is offered.
		block.publishStable([literalStableRow("one"), literalStableRow("two")], ["one", "changed physical row"]);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["two"]);
		expect(transcript.peekFinalizedBatch(80, 0)).toBeUndefined();

		// Finalization retires exactly the un-emitted suffix.
		block.finalize(["one", "two"]);
		expect(transcript.peekFinalizedBatch(80, 0)?.rows).toEqual(["two", ""]);
	});

	it("emits only the stable current head under row pressure", () => {
		const transcript = new TranscriptContainer();
		const head = new Block(["mutable head"], false);
		const later = new AppendBlock(["later stable", "later partial"], ["later stable"]);
		transcript.addChild(head);
		transcript.addChild(later);

		expect(transcript.peekFinalizedBatch(80, 1)).toBeUndefined();

		head.finalize(["mutable head"]);
		const retired = transcript.peekFinalizedBatch(80, 1);
		expect(retired?.rows).toEqual(["mutable head", ""]);
		transcript.acknowledgeFinalizedBatch(retired!.id);

		const emitted = transcript.peekFinalizedBatch(80, 1);
		expect(emitted?.rows).toEqual(["later stable"]);
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["later partial"]);
	});

	it("retires only the un-emitted final suffix", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["one", "two", "partial"], ["one", "two"]);
		transcript.addChild(block);

		const first = transcript.peekFinalizedBatch(80, 2)!;
		expect(first.rows).toEqual(["one"]);
		transcript.acknowledgeFinalizedBatch(first.id);
		const second = transcript.peekFinalizedBatch(80, 1)!;
		expect(second.rows).toEqual(["two"]);
		transcript.acknowledgeFinalizedBatch(second.id);

		block.finalize(["one", "two", "final"]);
		const suffix = transcript.peekFinalizedBatch(80, 0)!;
		expect(suffix.rows).toEqual(["final", ""]);
	});

	it("advances a fully emitted finalized head without a physical write", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["complete"], ["complete"]);
		transcript.addChild(block);
		const emitted = transcript.peekFinalizedBatch(80, 0)!;
		transcript.acknowledgeFinalizedBatch(emitted.id);

		block.finalize(["complete"]);
		expect(transcript.peekFinalizedBatch(80, 0)).toBeUndefined();
		expect(transcript.blockStates()).toEqual(["committed"]);
	});

	it("replays and retires semantic stable rows after they reflow at a new width", () => {
		const transcript = new TranscriptContainer();
		const block = new ReflowingAppendBlock();
		transcript.addChild(block);

		const emitted = transcript.peekFinalizedBatch(4, 2)!;
		expect(emitted.rows).toEqual(["abcd", "efgh"]);
		transcript.acknowledgeFinalizedBatch(emitted.id);
		expect(transcript.renderViewport(8, 1, frame)).toEqual(["partial"]);

		transcript.beginReplay();
		const replay = transcript.peekReplayBatch(8)!;
		expect(replay.rows).toEqual(["abcdefgh"]);
		transcript.acknowledgeFinalizedBatch(replay.id);

		block.finalize();
		const suffix = transcript.peekFinalizedBatch(8, 0)!;
		expect(suffix.rows).toEqual(["final", ""]);
	});

	beforeAll(async () => {
		await initTheme(false);
	});

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

	it("never retires a finalized successor past an ordinary active predecessor", () => {
		const transcript = new TranscriptContainer();
		const active = new Block(["active live"], false);
		const settled = new Block(["settled final"], true);
		transcript.addChild(active);
		transcript.addChild(settled);

		expect(transcript.peekFinalizedBatch(80, 1)).toBeUndefined();
		expect(transcript.renderViewport(80, 10)).toEqual(["active live", "", "settled final"]);

		active.finalize(["active final"]);
		// Capacity 1 fits the remaining settled block, so only the predecessor retires.
		expect(transcript.peekFinalizedBatch(80, 1)?.rows).toEqual(["active final", ""]);
	});

	it("does not duplicate overflowing tool rows when settlement restyles and extends them", () => {
		const transcript = new TranscriptContainer();
		const active = new ToolBlock(["\x1b[44mcommand\x1b[0m", "\x1b[44mbody\x1b[0m"], false);
		transcript.addChild(active);

		const first = transcript.peekFinalizedBatch(80, 0);
		expect(first?.rows).toEqual(["\x1b[44mcommand\x1b[0m", "\x1b[44mbody\x1b[0m", ""]);
		if (!first) throw new Error("expected active visual snapshot");
		transcript.acknowledgeFinalizedBatch(first.id);

		active.finalize(["\x1b[41mcommand\x1b[0m", "\x1b[41mbody\x1b[0m", "\x1b[41mtail\x1b[0m"]);
		const second = transcript.peekFinalizedBatch(80, 0);
		expect(second).toBeDefined();
		const tape = [...first.rows, ...(second?.rows ?? [])].map(row => Bun.stripANSI(row)).filter(Boolean);
		expect(tape).toEqual(["command", "body", "tail"]);
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

	it("allocates one row per live block before distributing surplus", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["first top", "first bottom"], false));
		transcript.addChild(new Block(["second top", "second bottom"], false));

		expect(transcript.renderViewport(80, 3, frame)).toEqual(["first bottom", "second top", "second bottom"]);
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["1 more transcript blocks active"]);
		expect(transcript.canAdmit(2)).toBe(false);
	});
	it("moves overflowing full-fidelity active rows into visual history instead of clipping them", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new ToolBlock(["ACTIVE-0", "ACTIVE-1", "ACTIVE-2"], false));
		transcript.addChild(new Block(["SETTLED-0", "SETTLED-1", "SETTLED-2"], true));

		const tape: string[] = [];
		for (let frame = 0; frame < 8; frame++) {
			const batch = transcript.peekFinalizedBatch(80, 2);
			if (!batch) break;
			tape.push(...batch.rows);
			transcript.acknowledgeFinalizedBatch(batch.id);
		}
		tape.push(...transcript.renderViewport(80, 2));

		expect(tape.filter(Boolean)).toEqual(["ACTIVE-0", "ACTIVE-1", "ACTIVE-2", "SETTLED-0", "SETTLED-1", "SETTLED-2"]);
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
	it("excludes empty blocks from semantic viewport capacity (issue 9483)", () => {
		const transcript = new TranscriptContainer();
		// Text blocks interleaved with empty (hidden tool-activity) blocks that
		// render nothing but stay live until retired.
		for (let i = 0; i < 6; i++) {
			transcript.addChild(new Block([`t${i}a`, `t${i}b`, `t${i}c`], true));
			for (let j = 0; j < 8; j++) transcript.addChild(new Block([], true));
		}
		// Empty blocks consume no rows, including in the emergency path.
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
		const out = transcript.renderViewport(80, 10, frame);
		expect(out).toEqual(["A3", "A4", "B1", "B2", "B3", "B4", "C1", "C2", "C3", "C4"]);
	});

	it("keeps a completed assistant answer visible behind an active prefix", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["stale active"], false));
		transcript.addChild(new AssistantMessageComponent(finalAnswer));
		transcript.addChild(new Block(["continued turn"], false));
		transcript.addChild(new Block(["task running"], false));

		expect(transcript.peekFinalizedBatch(80, 3)).toBeUndefined();
		const rows = transcript.renderViewport(80, 3, frame);
		expect(rows[0]).toBe("2 more transcript blocks active");
		expect(Bun.stripANSI(rows[1] ?? "").trim()).toBe("Implemented");
		expect(rows[2]).toBe("task running");
	});

	it("gives surplus rows to assistant text before a growing tool card (issue 9718)", () => {
		const transcript = new TranscriptContainer();
		const assistant = new Block(["A1", "A2", "A3", "A4"], false);
		const tool = new ToolBlock(["T1", "T2", "T3", "T4"], false);
		transcript.addChild(assistant);
		transcript.addChild(tool);
		// Capacity 5 cannot fit both blocks in full. Surplus (3 rows) goes to the
		// assistant block first; the tool card collapses to its one-row minimum
		// instead of clipping already-visible assistant text.
		const out = transcript.renderViewport(80, 5, frame);
		expect(out).toEqual(["A1", "A2", "A3", "A4", "T4"]);
		expect(assistant.allocations.at(-1)).toBe(4);
		expect(tool.allocations.at(-1)).toBe(1);
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

	it("replays committed history without rewinding lifecycle state", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["final"], true));
		const first = transcript.peekFinalizedBatch(80, 0);
		if (first === undefined) throw new Error("expected initial batch");
		transcript.acknowledgeFinalizedBatch(first.id);
		expect(transcript.blockStates()).toEqual(["committed"]);

		transcript.beginReplay();
		expect(transcript.renderViewport(80, 10, frame)).toEqual([]);
		const replay = transcript.peekFinalizedBatch(80, 10);
		expect(replay?.id).toBeGreaterThan(first.id);
		expect(replay?.rows).toEqual(["final", ""]);
		transcript.acknowledgeFinalizedBatch(replay!.id);
		expect(transcript.blockStates()).toEqual(["committed"]);
		expect(transcript.peekFinalizedBatch(80, 0)).toBeUndefined();
	});

	it("flushes a finalized prefix without viewport pressure", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["fits"], true));

		expect(transcript.peekFinalizedBatch(80, 10)).toBeUndefined();
		expect(transcript.peekFlushBatch(80)?.rows).toEqual(["fits", ""]);
	});

	it("keeps the live viewport while an independent replay is offered", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["committed"], true));
		const committed = transcript.peekFinalizedBatch(80, 0)!;
		transcript.acknowledgeFinalizedBatch(committed.id);
		transcript.addChild(new Block(["active"], false));

		transcript.beginReplay();
		expect(transcript.peekFinalizedBatch(80, 10)?.rows).toEqual(["committed", ""]);
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["active"]);
	});
	it("renders exactly the trailing semantic rows without walking the full ledger", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["a1", "a2"], true));
		transcript.addChild(new Block([], true));
		transcript.addChild(new AppendBlock(["b1", "b2"], ["b1"], true));
		transcript.addChild(new Block(["c1"], false));

		const full = transcript.render(80);
		for (const cap of [1, 3, 4, full.length, full.length + 5]) {
			expect(transcript.renderTail(80, cap)).toEqual(full.slice(-Math.min(cap, full.length)));
		}
		expect(transcript.renderTail(80, 0)).toEqual([]);
	});

	it("cancels a pending replay so shutdown flush emits only un-retired rows", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["committed"], true));
		const committed = transcript.peekFinalizedBatch(80, 0)!;
		transcript.acknowledgeFinalizedBatch(committed.id);
		transcript.addChild(new Block(["tail"], true));

		transcript.beginReplay();
		transcript.cancelReplay();
		expect(transcript.peekFlushBatch(80)?.rows).toEqual(["tail", ""]);
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

	it("does not reuse a visual snapshot row count after width reflow", () => {
		const transcript = new TranscriptContainer();
		const active = {
			render: (width: number): readonly string[] =>
				width <= 40 ? ["narrow-0", "narrow-1", "narrow-2"] : ["wide-0", "wide-1"],
			isTranscriptBlockFinalized: () => false,
			setToolActivityVisible: () => {},
		};
		transcript.addChild(active);

		const wide = transcript.peekFinalizedBatch(80, 1);
		expect(wide?.rows).toEqual(["wide-0"]);
		if (!wide) throw new Error("expected wide visual snapshot");
		transcript.acknowledgeFinalizedBatch(wide.id);

		// The old one-row watermark belongs to the 80-column projection. At the
		// new width, all three current rows must be eligible for display/retirement;
		// reusing the old row count would silently hide narrow-0.
		expect(transcript.renderViewport(40, 10)).toEqual(["narrow-0", "narrow-1", "narrow-2"]);
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

	it("snapshots only the overflowing rows of a dynamic tool block", () => {
		const transcript = new TranscriptContainer();
		const active = new ToolBlock(["T0", "T1", "T2", "T3"], false);
		transcript.addChild(active);

		const snapshot = transcript.peekFinalizedBatch(80, 3);
		expect(snapshot?.rows).toEqual(["T0"]);
		if (!snapshot) throw new Error("expected overflowing visual row");
		transcript.acknowledgeFinalizedBatch(snapshot.id);
		expect(transcript.renderViewport(80, 3)).toEqual(["T1", "T2", "T3"]);

		active.finalize(["T0", "T1", "T2", "T3"]);
		expect(transcript.peekFinalizedBatch(80, 0)?.rows).toEqual(["T1", "T2", "T3", ""]);
	});
});
