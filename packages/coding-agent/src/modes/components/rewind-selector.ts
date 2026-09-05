/**
 * Fullscreen esc-esc rewind selector.
 *
 * Replays the current session's branch with {@link ChatTranscriptBuilder} on
 * the alternate screen (`ui.showOverlay(..., { fullscreen: true })`) and moves
 * a dotted outline over the rendered transcript block the rewind would land
 * on, instead of listing user messages in a detached picker. Entries that
 * render nothing (notices, hidden custom messages, tool results folded into
 * their call cards) are never outlined: results fold into the turn that
 * rendered their call so rewinding a turn keeps its tool output, and the rest
 * are skipped entirely.
 *
 * When the outlined turn has sibling branches in the session tree, the region
 * below the divergence renders as a horizontal strip of half-width columns —
 * the current path first, each alternate branch beside it — and Left/Right
 * slide between them with an eased camera animation. Sibling columns are
 * fully rendered transcripts of that branch's most-recent path, built lazily
 * and cached per divergence.
 *
 * Keys: Up/Down step through rendered items in transcript order (within the
 * active column when a strip is open), Left/Right slide between branch
 * variants at a fork and jump between user turns elsewhere, Enter rewinds to
 * the outlined item, Esc cancels. Mouse hover moves the same outline without
 * moving the viewport; a left click rewinds to the item under the pointer.
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	type Component,
	matchesKey,
	padding,
	routeSgrMouseInput,
	ScrollView,
	sliceByColumn,
	type TUI,
	truncateToWidth,
} from "@oh-my-pi/pi-tui";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import type { SessionMessageEntry } from "../../session/session-entries";
import { theme } from "../theme/theme";
import {
	matchesAppToolsExpand,
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import { ChatTranscriptBuilder } from "./chat-transcript-builder";
import { DynamicBorder } from "./dynamic-border";
import { fit } from "./overlay-box";
import {
	appendOutlineEntries,
	type ComposedColumn,
	composeOutlineColumn,
	type OutlineTarget,
	outlineVisibility,
	positionRail,
	stripPromptZones,
	userMessageHasText,
	userMessageText,
} from "./transcript-outline";

/** One alternate branch at a divergence: its root and message path root → most-recent leaf. */
export interface BranchVariantPath {
	rootId: string;
	entries: SessionMessageEntry[];
}

export interface RewindSelectorDeps {
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	/** Whether the active registry entry came from a built-in factory. */
	isBuiltInTool?: (name: string) => boolean;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	linkTargets?: ReadonlyMap<string, string>;
	requestRender: () => void;
	/** Sibling branch paths of `entryId`'s turn (excluding the turn itself). */
	siblingPaths?: (entryId: string) => BranchVariantPath[];
	/** Rewind the session to `entryId` (a message entry anywhere in the tree). */
	onSelect: (entryId: string) => void;
	onCancel: () => void;
}

/** Lazily built transcript column for one alternate branch. */
interface SiblingColumn {
	rootId: string;
	builder: ChatTranscriptBuilder;
	targets: OutlineTarget[];
	/** Short label for the column header: the branch's first user prompt. */
	label: string;
}

/** Rendered content coordinates, before the vertical viewport crop. */
interface RewindHitTarget {
	target: OutlineTarget;
	start: number;
	end: number;
	left: number;
	right: number;
}

/** Rows the frame chrome occupies: top rule, header, rule, footer hint, bottom rule. */
const CHROME_ROWS = 5;
/** Blank columns between branch-strip columns. */
const STRIP_GAP = 2;
/** Duration of the branch-swap camera slide. */
const SLIDE_MS = 160;

export class RewindSelectorComponent implements Component {
	#builder: ChatTranscriptBuilder;
	#scrollView: ScrollView;
	#border = new DynamicBorder();
	#targets: OutlineTarget[] = [];
	#selected = 0;
	/** Per-main-target "renders at least one non-blank row", refreshed each frame. */
	#mainVisible: boolean[] | undefined;
	/** Same, for the active sibling column. */
	#siblingVisible: boolean[] | undefined;
	#scrollToSelection = true;
	#expanded = false;
	#hoveredTarget: OutlineTarget | undefined;
	#hitTargets: RewindHitTarget[] = [];
	#viewportTop = 0;
	#viewportHeight = 0;
	#renderedScrollOffset = 0;

	// Branch strip: present when the selected turn has sibling branches.
	// Column 0 is the current path; siblings follow in tree order.
	#variantCache = new Map<string, SiblingColumn[]>();
	/** 0 = current path column; 1..n = sibling column index + 1. */
	#activeVariant = 0;
	/** Selected target within the active sibling column. */
	#siblingSelected = 0;
	/** Camera slide between variant positions (fractional column index). */
	#slide: { from: number; to: number; startedAt: number } | undefined;
	#slideTimer: NodeJS.Timeout | undefined;

	constructor(
		entries: SessionMessageEntry[],
		private readonly deps: RewindSelectorDeps,
	) {
		this.#builder = this.#newBuilder();
		this.#targets = appendOutlineEntries(this.#builder, entries);
		this.#selected = Math.max(0, this.#targets.length - 1);
		this.#scrollView = new ScrollView([], {
			height: 10,
			scrollbar: "auto",
			theme: { track: t => theme.fg("dim", t), thumb: t => theme.fg("accent", t) },
		});
	}

	/** Number of selectable rewind points on the current path; hosts skip mounting when zero. */
	get targetCount(): number {
		return this.#targets.length;
	}

	#newBuilder(): ChatTranscriptBuilder {
		return new ChatTranscriptBuilder({
			ui: this.deps.ui,
			getTool: this.deps.getTool,
			isBuiltInTool: this.deps.isBuiltInTool,
			getMessageRenderer: this.deps.getMessageRenderer,
			cwd: this.deps.cwd,
			hideThinkingBlock: this.deps.hideThinkingBlock,
			proseOnlyThinking: this.deps.proseOnlyThinking,
			linkTargets: this.deps.linkTargets,
			requestRender: this.deps.requestRender,
		});
	}

	invalidate(): void {
		this.#builder.container.invalidate();
		for (const columns of this.#variantCache.values()) {
			for (const column of columns) column.builder.container.invalidate();
		}
	}

	dispose(): void {
		this.#stopSlide();
		this.#builder.dispose();
		for (const columns of this.#variantCache.values()) {
			for (const column of columns) column.builder.dispose();
		}
		this.#variantCache.clear();
	}

	// ========================================================================
	// Branch strip
	// ========================================================================

	/** Sibling columns for the selected turn, built lazily and cached per divergence. */
	#stripColumns(): SiblingColumn[] {
		const target = this.#targets[this.#selected];
		if (!target || !this.deps.siblingPaths) return [];
		const cached = this.#variantCache.get(target.turnId);
		if (cached) return cached;
		const columns: SiblingColumn[] = [];
		for (const sibling of this.deps.siblingPaths(target.turnId)) {
			if (sibling.entries.length === 0) continue;
			const builder = this.#newBuilder();
			builder.setExpanded(this.#expanded);
			const targets = appendOutlineEntries(builder, sibling.entries);
			const firstUser = sibling.entries.find(
				entry => entry.message.role === "user" && userMessageHasText(entry.message),
			);
			const label =
				firstUser && firstUser.message.role === "user" ? userMessageText(firstUser.message) : sibling.rootId;
			columns.push({ rootId: sibling.rootId, builder, targets, label });
		}
		this.#variantCache.set(target.turnId, columns);
		return columns;
	}

	/** The target the dotted outline currently rests on. */
	#outlinedTarget(): OutlineTarget | undefined {
		if (this.#hoveredTarget) return this.#hoveredTarget;
		if (this.#activeVariant > 0) {
			return this.#stripColumns()[this.#activeVariant - 1]?.targets[this.#siblingSelected];
		}
		return this.#targets[this.#selected];
	}

	#slideTo(variant: number): void {
		const now = Date.now();
		const from = this.#slidePosition(now);
		this.#slide = { from, to: variant, startedAt: now };
		this.#activeVariant = variant;
		this.#scrollToSelection = true;
		this.#slideTimer ??= setInterval(() => {
			if (!this.#slide || Date.now() - this.#slide.startedAt >= SLIDE_MS) this.#stopSlide();
			this.deps.requestRender();
		}, 16);
		this.deps.requestRender();
	}

	#stopSlide(): void {
		this.#slide = undefined;
		if (this.#slideTimer !== undefined) {
			clearInterval(this.#slideTimer);
			this.#slideTimer = undefined;
		}
	}

	/** Fractional variant position of the camera at `now` (eased). */
	#slidePosition(now: number): number {
		if (!this.#slide) return this.#activeVariant;
		const t = Math.min(1, (now - this.#slide.startedAt) / SLIDE_MS);
		const eased = 1 - (1 - t) ** 3;
		return this.#slide.from + (this.#slide.to - this.#slide.from) * eased;
	}

	// ========================================================================
	// Input
	// ========================================================================

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				if (event.wheel !== null) {
					this.#hoveredTarget = undefined;
					this.#scrollToSelection = false;
					this.#scrollView.scroll(event.wheel * 3);
					this.deps.requestRender();
				} else if (event.motion || event.leftClick) {
					const row = event.row - this.#viewportTop;
					const contentRow = row + this.#renderedScrollOffset;
					const target =
						row >= 0 && row < this.#viewportHeight
							? this.#hitTargets.find(
									hit =>
										contentRow >= hit.start &&
										contentRow < hit.end &&
										event.col >= hit.left &&
										event.col < hit.right,
								)?.target
							: undefined;
					if (event.leftClick) {
						if (target) this.deps.onSelect(target.entryId);
					} else if (target !== this.#hoveredTarget) {
						this.#hoveredTarget = target;
						this.#scrollToSelection = false;
						this.deps.requestRender();
					}
				}
				return true;
			});
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			const target = this.#outlinedTarget();
			if (target) this.deps.onSelect(target.entryId);
			return;
		}
		if (this.#hoveredTarget) {
			this.#hoveredTarget = undefined;
			this.deps.requestRender();
		}
		if (matchesSelectCancel(data) || matchesKey(data, "escape")) {
			this.deps.onCancel();
			return;
		}
		if (matchesAppToolsExpand(data)) {
			this.#expanded = !this.#expanded;
			this.#builder.setExpanded(this.#expanded);
			for (const columns of this.#variantCache.values()) {
				for (const column of columns) column.builder.setExpanded(this.#expanded);
			}
			this.deps.requestRender();
			return;
		}
		if (matchesSelectUp(data)) {
			this.#moveVertical(-1);
			return;
		}
		if (matchesSelectDown(data)) {
			this.#moveVertical(1);
			return;
		}
		if (matchesKey(data, "left")) {
			if (this.#activeVariant > 0) this.#slideTo(this.#activeVariant - 1);
			else this.#move(-1, target => target.isUserTurn);
			return;
		}
		if (matchesKey(data, "right")) {
			const columns = this.#stripColumns();
			if (this.#activeVariant < columns.length) {
				this.#siblingSelected = 0;
				this.#slideTo(this.#activeVariant + 1);
			} else if (this.#activeVariant === 0) {
				this.#move(1, target => target.isUserTurn);
			}
			return;
		}
		// Page/home/end/shift+arrow scrolling without moving the selection.
		if (this.#scrollView.handleScrollKey(data)) {
			this.deps.requestRender();
		}
	}

	/** Up/Down: step within the active column; leaving a sibling column's top exits the strip. */
	#moveVertical(delta: -1 | 1): void {
		if (this.#activeVariant > 0) {
			const targets = this.#stripColumns()[this.#activeVariant - 1]?.targets ?? [];
			let index = this.#siblingSelected + delta;
			while (index >= 0 && index < targets.length && this.#siblingVisible?.[index] === false) index += delta;
			if (index >= 0 && index < targets.length) {
				this.#siblingSelected = index;
				this.#scrollToSelection = true;
				this.deps.requestRender();
			} else if (delta === -1) {
				// Off the top of an alternate: return to the current path above the fork.
				this.#activeVariant = 0;
				this.#siblingSelected = 0;
				this.#stopSlide();
				this.#move(-1, () => true);
			}
			return;
		}
		this.#move(delta, () => true);
	}

	/** Step the main selection by `delta` to the nearest visible target passing `accept`. */
	#move(delta: -1 | 1, accept: (target: OutlineTarget) => boolean): void {
		let index = this.#selected + delta;
		while (index >= 0 && index < this.#targets.length) {
			if (this.#isMainSelectable(index) && accept(this.#targets[index]!)) {
				this.#selected = index;
				this.#activeVariant = 0;
				this.#siblingSelected = 0;
				this.#stopSlide();
				this.#scrollToSelection = true;
				this.deps.requestRender();
				return;
			}
			index += delta;
		}
	}

	#isMainSelectable(index: number): boolean {
		return this.#mainVisible?.[index] ?? true;
	}

	// ========================================================================
	// Render
	// ========================================================================

	render(width: number): readonly string[] {
		this.#hitTargets.length = 0;
		const termHeight = process.stdout.rows || 40;
		// ScrollView reserves the last column for the scrollbar; the outline
		// consumes two columns each side ("┆ " / " ┆"), unselected rows a
		// matching two-column left gutter so blocks never shift while stepping.
		const contentWidth = Math.max(1, width - 1);
		const children = this.#builder.container.children;
		const mainInner = Math.max(10, contentWidth - 4);
		const childRows = children.map(child => stripPromptZones(child.render(mainInner)));

		this.#mainVisible = outlineVisibility(childRows, this.#targets);
		if (!this.#isMainSelectable(this.#selected)) {
			// The current target collapsed (e.g. expansion toggle): rest on the
			// nearest visible one above, falling back to the nearest below.
			let above = this.#selected - 1;
			while (above >= 0 && !this.#isMainSelectable(above)) above--;
			let below = this.#selected + 1;
			while (below < this.#targets.length && !this.#isMainSelectable(below)) below++;
			if (above >= 0) this.#selected = above;
			else if (below < this.#targets.length) this.#selected = below;
			this.#activeVariant = 0;
			this.#siblingSelected = 0;
		}

		const columns = this.#stripColumns();
		const composed =
			columns.length > 0
				? this.#renderStrip(childRows, columns, contentWidth)
				: composeOutlineColumn(
						childRows,
						0,
						children.length,
						this.#targets,
						this.#hoveredTarget ? this.#targets.indexOf(this.#hoveredTarget) : this.#selected,
						contentWidth,
						undefined,
						{},
						(target, start, end) => this.#hitTargets.push({ target, start, end, left: 0, right: contentWidth }),
					);
		const lines = composed.lines;

		const viewportHeight = Math.max(3, termHeight - CHROME_ROWS);
		// Moving the outline to a shorter column can shrink the document by
		// two rows. Keep the visible tail padded while hovering so ScrollView
		// does not clamp upward and move the clicked region out from under it.
		if (this.#hoveredTarget) {
			const visibleEnd = this.#renderedScrollOffset + viewportHeight;
			while (lines.length < visibleEnd) lines.push("");
		}
		this.#scrollView.setLines(lines);
		this.#scrollView.setHeight(viewportHeight);
		if (this.#scrollToSelection && composed.selStart >= 0) {
			const offset = this.#scrollView.getScrollOffset();
			const top = Math.max(0, composed.selStart - 1);
			const bottom = Math.min(lines.length, composed.selEnd + 1);
			if (top < offset) this.#scrollView.setScrollOffset(top);
			else if (bottom > offset + viewportHeight) this.#scrollView.setScrollOffset(bottom - viewportHeight);
			this.#scrollToSelection = false;
		}

		const output: string[] = [];
		output.push(...this.#border.render(width));
		output.push(
			` ${theme.icon.rewind} ${theme.bold("Rewind")}${theme.sep.dot}${theme.fg("dim", "pick the point to continue from")}`,
		);
		output.push(...this.#border.render(width));
		this.#viewportTop = output.length;
		this.#viewportHeight = viewportHeight;
		output.push(...this.#scrollView.render(width));
		this.#renderedScrollOffset = this.#scrollView.getScrollOffset();
		const position = this.#targets.length > 0 ? `${this.#selected + 1}/${this.#targets.length}  ` : "";
		const lateral = columns.length > 0 ? "←/→ branches" : "←/→ user turns";
		output.push(
			truncateToWidth(
				` ${theme.fg("dim", `${position}↑/↓ step  ${lateral}  hover outline  click/enter rewind  ctrl+o expand  esc cancel`)}`,
				width,
			),
		);
		output.push(...this.#border.render(width));
		return output;
	}

	/**
	 * Shared prefix at full width, then the divergence as a camera-positioned
	 * strip of half-width branch columns (current path first, siblings after).
	 */
	#renderStrip(mainRows: (readonly string[])[], columns: SiblingColumn[], contentWidth: number): ComposedColumn {
		const anchor = this.#targets[this.#selected]!;
		const colWidth = Math.max(24, Math.floor((contentWidth - STRIP_GAP) / 2));
		const colInner = Math.max(10, colWidth - 4);
		const count = columns.length + 1;
		const hoveredMain = this.#hoveredTarget ? this.#targets.indexOf(this.#hoveredTarget) : -1;

		// Hover can outline shared history without changing the fork or camera.
		const prefix = composeOutlineColumn(
			mainRows,
			0,
			anchor.start,
			this.#targets,
			hoveredMain,
			contentWidth,
			undefined,
			{},
			(target, start, end) => this.#hitTargets.push({ target, start, end, left: 0, right: contentWidth }),
		);
		const lines = prefix.lines;
		const stride = colWidth + STRIP_GAP;
		const totalWidth = count * colWidth + (count - 1) * STRIP_GAP;
		const cameraAt = (position: number) =>
			Math.max(
				0,
				Math.min(position * stride - (contentWidth - colWidth) / 2, Math.max(0, totalWidth - contentWidth)),
			);
		const camera = Math.round(cameraAt(this.#slidePosition(Date.now())));
		if (count > 2) {
			const settled = cameraAt(this.#activeVariant);
			lines.push(
				positionRail(
					count,
					this.#activeVariant,
					settled > 0.5,
					settled + contentWidth < totalWidth - 0.5,
					contentWidth,
				),
				"",
			);
		}
		const stripTop = lines.length;
		const recordHit = (column: number, target: OutlineTarget, start: number, end: number) => {
			const left = Math.max(0, column * stride - camera);
			const right = Math.min(contentWidth, column * stride - camera + colWidth);
			if (left < right) {
				this.#hitTargets.push({ target, start: stripTop + start, end: stripTop + end, left, right });
			}
		};

		// The full-width prefix is already composed; reuse its row array for
		// the narrow suffix so hit targets retain their original identity.
		for (let index = anchor.start; index < this.#builder.container.children.length; index++) {
			mainRows[index] = stripPromptZones(this.#builder.container.children[index]!.render(colInner));
		}
		const composedColumns: ComposedColumn[] = [
			composeOutlineColumn(
				mainRows,
				anchor.start,
				mainRows.length,
				this.#targets,
				this.#hoveredTarget ? hoveredMain : this.#activeVariant === 0 ? this.#selected : -1,
				colWidth,
				this.#columnHeader(0, count, "current", colWidth),
				{},
				(target, start, end) => recordHit(0, target, start, end),
			),
		];
		for (let index = 0; index < columns.length; index++) {
			const column = columns[index]!;
			const rows = column.builder.container.children.map(child => stripPromptZones(child.render(colInner)));
			if (this.#activeVariant === index + 1) {
				this.#siblingVisible = outlineVisibility(rows, column.targets);
			}
			composedColumns.push(
				composeOutlineColumn(
					rows,
					0,
					rows.length,
					column.targets,
					this.#hoveredTarget
						? column.targets.indexOf(this.#hoveredTarget)
						: this.#activeVariant === index + 1
							? this.#siblingSelected
							: -1,
					colWidth,
					this.#columnHeader(index + 1, count, column.label, colWidth),
					{},
					(target, start, end) => recordHit(index + 1, target, start, end),
				),
			);
		}

		const height = Math.max(...composedColumns.map(column => column.lines.length));
		const active = composedColumns[this.#activeVariant]!;
		const selStart = active.selStart >= 0 ? lines.length + active.selStart : -1;
		const selEnd = active.selEnd >= 0 ? lines.length + active.selEnd : -1;
		for (let row = 0; row < height; row++) {
			let line = "";
			let filled = 0;
			for (let index = 0; index < count; index++) {
				const x0 = index * stride - camera;
				const x1 = x0 + colWidth;
				const visible0 = Math.max(0, x0);
				const visible1 = Math.min(contentWidth, x1);
				if (visible1 <= visible0) continue;
				const source = fit(composedColumns[index]!.lines[row] ?? "", colWidth);
				const slice = sliceByColumn(source, visible0 - x0, visible1 - visible0, true);
				line += padding(Math.max(0, visible0 - filled)) + fit(slice, visible1 - visible0);
				filled = visible1;
			}
			lines.push(line);
		}
		return { lines, selStart, selEnd };
	}

	/** Two caption rows leading a strip column: `⎇ i/n · label` plus a spacer. */
	#columnHeader(index: number, count: number, label: string, columnWidth: number): string[] {
		const caption = truncateToWidth(
			`${theme.icon.branch} ${index + 1}/${count} ${theme.sep.dot} ${label}`,
			columnWidth - 2,
		);
		const active = index === this.#activeVariant;
		return [` ${theme.fg(active ? "accent" : "dim", caption)}`, ""];
	}
}
