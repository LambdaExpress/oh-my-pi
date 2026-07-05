import {
	type Component,
	matchesKey,
	padding,
	routeSelectListMouse,
	routeSgrMouseInput,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { shortenPath } from "../../tools/render-utils";
import { theme } from "../theme/theme";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import { keyHint, rawKeyHint } from "./keybinding-hints";
import { bottomBorder, divider, fit, row, topBorder } from "./overlay-box";

export type WorktreeSelectorAction = "switch" | "move-current" | "merge" | "branch" | "remove" | "restore";

export interface WorktreeSelectorItem {
	id: string;
	name: string;
	state: string;
	mode?: string;
	baseRef: string;
	branch: string | null;
	detached: boolean;
	worktreeRoot: string;
	targetCwd: string;
	title?: string | null;
	sessionTitle?: string | null;
	sessionFile?: string | null;
	snapshotPath: string | null;
	appliedAt?: string | null;
	hasUnappliedChanges?: boolean;
	lastUsedAt?: string;
}

export interface WorktreeSelectorResult {
	action: WorktreeSelectorAction;
	id: string;
}

export interface WorktreeSelectorCallbacks {
	onPick: (result: WorktreeSelectorResult) => void;
	onCancel: () => void;
}

interface WorktreeActionRow {
	item: WorktreeSelectorItem;
	action: WorktreeSelectorAction;
	label: string;
	meta: string;
}

const MIN_ROWS = 6;

function actionRowsForItem(item: WorktreeSelectorItem): WorktreeActionRow[] {
	if (item.state === "snapshotted") {
		if (!item.snapshotPath) return [{ item, action: "remove", label: `Remove ${item.name}`, meta: "snapshotted" }];
		return [
			{ item, action: "restore", label: `Restore ${item.name} from snapshot`, meta: shortenPath(item.snapshotPath) },
			{ item, action: "remove", label: `Remove ${item.name}`, meta: "snapshotted" },
		];
	}
	if (item.state !== "ready") return [];
	const rows: WorktreeActionRow[] = [
		{ item, action: "switch", label: `Switch to ${item.name}`, meta: shortenPath(item.targetCwd) },
		{
			item,
			action: "move-current",
			label: `Move current session to ${item.name}`,
			meta: shortenPath(item.targetCwd),
		},
		{
			item,
			action: "merge",
			label: `Apply ${item.name} locally`,
			meta: item.appliedAt ? "already applied" : (item.branch ?? item.baseRef),
		},
	];
	if (item.detached)
		rows.push({ item, action: "branch", label: `Create branch for ${item.name}`, meta: item.baseRef });
	rows.push({ item, action: "remove", label: `Remove ${item.name}`, meta: item.branch ?? item.baseRef });
	return rows;
}

export class WorktreeSelectorComponent implements Component {
	#rows: WorktreeActionRow[];
	#selectedIndex = 0;
	#hitRows: (number | undefined)[] = [];
	#hoveredIndex: number | null = null;
	#listRows = MIN_ROWS;
	#listLineOffset = 2;

	constructor(
		items: WorktreeSelectorItem[],
		private readonly callbacks: WorktreeSelectorCallbacks,
	) {
		this.#rows = items.flatMap(actionRowsForItem);
	}

	invalidate(): void {}

	handleInput(keyData: string): void {
		if (keyData.startsWith("\x1b[<") && this.#handleMouse(keyData)) return;
		if (matchesSelectCancel(keyData)) {
			this.callbacks.onCancel();
			return;
		}
		if (this.#rows.length === 0) return;
		if (matchesSelectUp(keyData)) {
			this.#selectedIndex = this.#selectedIndex === 0 ? this.#rows.length - 1 : this.#selectedIndex - 1;
			this.#hoveredIndex = null;
		} else if (matchesSelectDown(keyData)) {
			this.#selectedIndex = this.#selectedIndex === this.#rows.length - 1 ? 0 : this.#selectedIndex + 1;
			this.#hoveredIndex = null;
		} else if (matchesSelectPageUp(keyData)) {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - this.#listRows);
			this.#hoveredIndex = null;
		} else if (matchesSelectPageDown(keyData)) {
			this.#selectedIndex = Math.min(this.#rows.length - 1, this.#selectedIndex + this.#listRows);
			this.#hoveredIndex = null;
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#pick(this.#selectedIndex);
		}
	}

	handleWheel(delta: -1 | 1): void {
		if (this.#rows.length === 0) return;
		this.#selectedIndex = Math.max(0, Math.min(this.#rows.length - 1, this.#selectedIndex + delta));
		this.#hoveredIndex = null;
	}

	hitTest(line: number): number | undefined {
		return this.#hitRows[line];
	}

	setHoverIndex(index: number | null): void {
		this.#hoveredIndex = index !== null && index >= 0 && index < this.#rows.length ? index : null;
	}

	clickItem(index: number): void {
		if (index < 0 || index >= this.#rows.length) return;
		this.#selectedIndex = index;
		this.#pick(index);
	}

	#pick(index: number): void {
		const row = this.#rows[index];
		if (!row) return;
		this.callbacks.onPick({ action: row.action, id: row.item.id });
	}

	#handleMouse(data: string): boolean {
		return routeSgrMouseInput(data, event => {
			routeSelectListMouse(this, event, event.row - this.#listLineOffset);
			return true;
		});
	}

	#renderRows(width: number, rows: number): string[] {
		const inner = Math.max(0, width - 4);
		const start = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(rows / 2), Math.max(0, this.#rows.length - rows)),
		);
		const out: string[] = [];
		this.#hitRows = [];
		for (let i = 0; i < rows; i++) {
			const rowIndex = start + i;
			const item = this.#rows[rowIndex];
			this.#hitRows[i] = item ? rowIndex : undefined;
			if (!item) {
				out.push(row("", width));
				continue;
			}
			const selected = rowIndex === this.#selectedIndex;
			const hovered = rowIndex === this.#hoveredIndex && !selected;
			const cursor = selected ? theme.fg("accent", "❯ ") : "  ";
			const label = selected ? theme.bold(theme.fg("accent", item.label)) : item.label;
			const title = item.item.title ?? item.item.sessionTitle;
			const details = title ? ` · ${title}` : "";
			const meta = theme.fg("dim", `${item.meta}${details}`);
			const gap = Math.max(1, inner - visibleWidth(cursor) - visibleWidth(item.label) - visibleWidth(meta));
			const content = cursor + label + padding(gap) + meta;
			out.push(row(hovered ? theme.bg("selectedBg", fit(content, inner)) : content, width));
		}
		return out;
	}

	render(width: number): readonly string[] {
		const safeWidth = Math.max(40, width);
		const listRows = Math.max(MIN_ROWS, Math.min(14, this.#rows.length || MIN_ROWS));
		this.#listRows = listRows;
		const lines: string[] = [topBorder(safeWidth, "Managed worktrees")];
		lines.push(row(theme.fg("dim", "Choose a managed worktree action"), safeWidth));
		if (this.#rows.length === 0) {
			this.#hitRows = [];
			lines.push(row("No managed worktree actions available.", safeWidth));
			while (lines.length < MIN_ROWS + 2) lines.push(row("", safeWidth));
		} else {
			lines.push(...this.#renderRows(safeWidth, listRows));
		}
		lines.push(divider(safeWidth));
		const help = [
			rawKeyHint("↑↓", "Select"),
			keyHint("tui.select.confirm", "Run"),
			keyHint("tui.select.cancel", "Close"),
		].join(theme.fg("dim", " · "));
		lines.push(row(truncateToWidth(help, Math.max(0, safeWidth - 4)), safeWidth));
		lines.push(bottomBorder(safeWidth));
		return lines;
	}
}
