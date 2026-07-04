import { describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import type { Component } from "@oh-my-pi/pi-tui";

class MutableLiveBlock implements Component {
	#lines: string[];
	#settledRows: number;

	constructor(lines: string[], settledRows: number) {
		this.#lines = [...lines];
		this.#settledRows = settledRows;
	}
	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}
	isTranscriptBlockFinalized(): boolean {
		return false;
	}
	getTranscriptBlockSettledRows(): number {
		return this.#settledRows;
	}
}

class StaticBlock implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
}

class MutableFinalizableBlock implements Component {
	#lines: string[];
	#finalized: boolean;
	renderCount = 0;

	constructor(lines: string[], finalized = false) {
		this.#lines = [...lines];
		this.#finalized = finalized;
	}

	render(width: number): string[] {
		this.renderCount++;
		return this.#lines.map(line => line.slice(0, width));
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	setFinalized(finalized: boolean): void {
		this.#finalized = finalized;
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}
}

describe("transcript streaming commit (assistant text)", () => {
	it("commits only the declared settled head while the trailing line grows", () => {
		const chat = new TranscriptContainer();
		// Models a streaming assistant reply: stable head rows plus a current
		// line that grows token-by-token without adding a new row. The head is
		// committable only because the block explicitly declares those rows settled.
		const block = new MutableLiveBlock(["para one", "para two", "the quick brown"], 2);
		chat.addChild(block);

		chat.render(80);
		expect(chat.getNativeScrollbackLiveRegionStart()).toBe(2);

		block.setLines(["para one", "para two", "the quick brown fox"]);
		chat.render(80);

		expect(chat.getNativeScrollbackLiveRegionStart()).toBe(2);
	});

	it("keeps finalized rows below a pending tool out of the native scrollback prefix", () => {
		const chat = new TranscriptContainer();
		const pendingTool = new MutableFinalizableBlock(["tool pending"]);
		chat.addChild(new StaticBlock(["user prompt"]));
		chat.addChild(pendingTool);
		chat.addChild(new StaticBlock(["answer row 0", "answer row 1"]));

		const rendered = chat.render(80);

		expect(rendered).toEqual(["user prompt", "", "tool pending", "", "answer row 0", "answer row 1"]);
		expect(chat.getNativeScrollbackLiveRegionStart()).toBe(rendered.indexOf("tool pending"));
	});

	it("renders the final tool result instead of replaying its committed pending snapshot", () => {
		const chat = new TranscriptContainer();
		const tool = new MutableFinalizableBlock(["tool pending top", "tool pending bottom"]);
		chat.addChild(tool);

		expect(chat.render(80)).toEqual(["tool pending top", "tool pending bottom"]);
		chat.setNativeScrollbackCommittedRows(2);

		tool.setLines(["tool done top", "tool done bottom"]);
		tool.setFinalized(true);

		expect(chat.render(80)).toEqual(["tool done top", "tool done bottom"]);
		expect(tool.renderCount).toBe(2);
	});
});
