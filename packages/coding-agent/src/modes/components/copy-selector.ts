import {
	type Component,
	matchesKey,
	padding,
	routeSelectListMouse,
	routeSgrMouseInput,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { replaceTabs } from "../../tools/render-utils";
import { highlightCode, theme } from "../theme/theme";
import type { CopyTarget } from "../utils/copy-targets";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import { keyHint, rawKeyHint } from "./keybinding-hints";
import { bottomBorder, divider, fit, row, topBorder } from "./overlay-box";

/** Minimum rows reserved for the tree even on short terminals. */
const MIN_TREE_ROWS = 3;
/** Fixed chrome rows: top border, two dividers, footer, bottom border. */
const CHROME_ROWS = 5;

export interface CopySelectorCallbacks {
	/** A copy target was chosen — copy its `content`. */
	onPick: (target: CopyTarget) => void;
	/** The picker was dismissed. */
	onCancel: () => void;
}

interface FlatNode {
	target: CopyTarget;
	depth: number;
	/** Last among its siblings (drives └─ vs ├─). */
	isLast: boolean;
	/** Per-ancestor flag: does ancestor at that level have a following sibling? */
	ancestorHasNext: boolean[];
}

/** Render one tree connector as exactly three cells (e.g. "├─ ", "└─ ", "|--"). */
function connectorCells(symbol: string): string {
	const chars = Array.from(symbol);
	return (chars[0] ?? " ") + (chars[1] ?? theme.tree.horizontal) + (chars[2] ?? " ");
}

/** The 3-cell ancestor gutter: a vertical guide when the ancestor continues. */
function gutterCells(hasNext: boolean): string {
	return `${hasNext ? theme.tree.vertical : " "}  `;
}

/**
 * Fullscreen `/copy` picker rendered as a `/tree`-style tree inside one
 * outlined box: a title, the tree of copy targets (recent assistant messages
 * with their code blocks nested beneath), a live preview of the hovered node
 * when present, otherwise the keyboard cursor node, and a keybinding footer.
 * Every node copies its `content` on Enter.
 */
export class CopySelectorComponent implements Component {
	#roots: CopyTarget[];
	#cursorId: string;
	#treeRows = MIN_TREE_ROWS;
	#hitRows: (number | undefined)[] = [];
	#hoveredIndex: number | null = null;
	#treeLineOffset = 1;
	// Reused across renders to wrap preview content to the pane width.
	#previewText = new Text("", 0, 0);

	constructor(
		roots: CopyTarget[],
		private readonly callbacks: CopySelectorCallbacks,
	) {
		this.#roots = roots;
		this.#cursorId = roots[0]?.id ?? "";
	}

	invalidate(): void {}

	#flatten(): FlatNode[] {
		const out: FlatNode[] = [];
		const walk = (nodes: CopyTarget[], depth: number, ancestorHasNext: boolean[]) => {
			nodes.forEach((target, i) => {
				const isLast = i === nodes.length - 1;
				out.push({ target, depth, isLast, ancestorHasNext });
				if (target.children?.length) walk(target.children, depth + 1, [...ancestorHasNext, !isLast]);
			});
		};
		walk(this.#roots, 0, []);
		return out;
	}

	#cursorIndex(flat: readonly FlatNode[]): number {
		const idx = flat.findIndex(n => n.target.id === this.#cursorId);
		return idx >= 0 ? idx : 0;
	}

	handleInput(keyData: string): void {
		if (keyData.startsWith("\x1b[<") && this.#handleMouse(keyData)) return;

		if (matchesSelectCancel(keyData)) {
			this.callbacks.onCancel();
			return;
		}

		const flat = this.#flatten();
		if (flat.length === 0) return;
		const idx = this.#cursorIndex(flat);
		if (matchesSelectUp(keyData)) {
			this.#cursorId = flat[idx === 0 ? flat.length - 1 : idx - 1]!.target.id;
			this.#hoveredIndex = null;
		} else if (matchesSelectDown(keyData)) {
			this.#cursorId = flat[idx === flat.length - 1 ? 0 : idx + 1]!.target.id;
			this.#hoveredIndex = null;
		} else if (matchesSelectPageUp(keyData)) {
			this.#cursorId = flat[Math.max(0, idx - this.#treeRows)]!.target.id;
			this.#hoveredIndex = null;
		} else if (matchesSelectPageDown(keyData)) {
			this.#cursorId = flat[Math.min(flat.length - 1, idx + this.#treeRows)]!.target.id;
			this.#hoveredIndex = null;
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const target = flat[idx]!.target;
			if (target.content !== undefined) this.callbacks.onPick(target);
		}
	}

	handleWheel(delta: -1 | 1): void {
		const flat = this.#flatten();
		if (flat.length === 0) return;
		const idx = this.#cursorIndex(flat);
		const nextIdx = Math.max(0, Math.min(flat.length - 1, idx + delta));
		this.#cursorId = flat[nextIdx]!.target.id;
		this.#hoveredIndex = null;
	}

	hitTest(line: number): number | undefined {
		return this.#hitRows[line];
	}

	setHoverIndex(index: number | null): void {
		const flat = this.#flatten();
		if (index === null || index < 0 || index >= flat.length) {
			this.#hoveredIndex = null;
			return;
		}
		this.#hoveredIndex = index;
	}

	clickItem(index: number): void {
		const target = this.#flatten()[index]?.target;
		if (!target) return;
		this.#cursorId = target.id;
		if (target.content !== undefined) this.callbacks.onPick(target);
	}

	#handleMouse(data: string): boolean {
		return routeSgrMouseInput(data, event => {
			routeSelectListMouse(this, event, event.row - this.#treeLineOffset);
			return true;
		});
	}

	#renderTree(width: number, flat: FlatNode[], cursorIdx: number, rows: number): string[] {
		const inner = Math.max(0, width - 4);
		const start = Math.max(0, Math.min(cursorIdx - Math.floor(rows / 2), Math.max(0, flat.length - rows)));
		const out: string[] = [];
		this.#hitRows = [];

		for (let r = 0; r < rows; r++) {
			const i = start + r;
			const node = flat[i];
			this.#hitRows[r] = node ? i : undefined;
			if (!node) {
				out.push(row("", width));
				continue;
			}

			const target = node.target;
			const isSelected = i === cursorIdx;
			const isHovered = i === this.#hoveredIndex && !isSelected;

			let prefix = "";
			for (let l = 0; l < node.depth - 1; l++) prefix += gutterCells(node.ancestorHasNext[l]!);
			if (node.depth > 0) prefix += connectorCells(node.isLast ? theme.tree.last : theme.tree.branch);

			const cursor = isSelected ? "❯ " : "  ";
			const hint = target.hint ?? "";
			const hintWidth = hint ? visibleWidth(hint) + 2 : 0;
			const used = visibleWidth(cursor) + visibleWidth(prefix);
			const labelPlain = truncateToWidth(target.label, Math.max(1, inner - used - hintWidth));
			const left = isSelected
				? theme.fg("accent", cursor) + theme.fg("dim", prefix) + theme.bold(theme.fg("accent", labelPlain))
				: cursor + theme.fg("dim", prefix) + labelPlain;
			const gap = Math.max(1, inner - used - visibleWidth(labelPlain) - visibleWidth(hint));
			const content = left + padding(gap) + (hint ? theme.fg("dim", hint) : "");
			out.push(row(isHovered ? theme.bg("selectedBg", fit(content, inner)) : content, width));
		}
		return out;
	}

	#renderPreview(width: number, target: CopyTarget | undefined, rows: number): string[] {
		const out: string[] = [];
		const hint = target?.hint;
		out.push(row(theme.fg("dim", `Preview${hint ? ` · ${hint}` : ""}`), width));

		const contentRows = rows - 1;
		if (!target || contentRows <= 0) {
			while (out.length < rows) out.push(row("", width));
			return out;
		}

		// Code/command previews are syntax-highlighted; everything else is shown
		// as plain text. Both are wrapped (not hard-truncated) to the pane width.
		const isCode = target.language !== undefined;
		const source = isCode
			? highlightCode(replaceTabs(target.preview), target.language).join("\n")
			: replaceTabs(target.preview);
		this.#previewText.setText(source);
		const wrapped = this.#previewText.render(Math.max(1, width - 4));

		const hasMore = wrapped.length > contentRows;
		const visibleCount = hasMore ? contentRows - 1 : Math.min(wrapped.length, contentRows);
		for (let k = 0; k < contentRows; k++) {
			if (k < visibleCount) {
				out.push(row(isCode ? wrapped[k]! : theme.fg("muted", wrapped[k]!), width));
			} else if (k === visibleCount && hasMore) {
				out.push(row(theme.fg("dim", `… ${wrapped.length - visibleCount} more lines`), width));
			} else {
				out.push(row("", width));
			}
		}
		return out;
	}

	render(width: number): readonly string[] {
		const height = process.stdout.rows || 40;
		const flat = this.#flatten();
		const cursorIdx = this.#cursorIndex(flat);
		const selected = flat[cursorIdx]?.target;
		const previewTarget =
			this.#hoveredIndex !== null && flat[this.#hoveredIndex] ? flat[this.#hoveredIndex]!.target : selected;
		const available = Math.max(MIN_TREE_ROWS + 1, height - CHROME_ROWS);
		const treeRows = Math.max(1, Math.min(flat.length, Math.floor(available / 2)));
		this.#treeRows = treeRows;
		const previewRows = Math.max(1, available - treeRows);

		const footer = [
			rawKeyHint("↑↓", "move"),
			keyHint("tui.select.confirm", "copy"),
			keyHint("tui.select.cancel", "quit"),
		].join(theme.fg("dim", " · "));

		const lines: string[] = [];
		lines.push(topBorder(width, "Copy to clipboard"));
		this.#treeLineOffset = lines.length;
		lines.push(...this.#renderTree(width, flat, cursorIdx, treeRows));
		lines.push(divider(width));
		lines.push(...this.#renderPreview(width, previewTarget, previewRows));
		lines.push(divider(width));
		lines.push(row(footer, width));
		lines.push(bottomBorder(width));
		return lines;
	}
}
