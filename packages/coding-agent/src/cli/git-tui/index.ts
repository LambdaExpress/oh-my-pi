/**
 * `omp git` — fullscreen repository TUI.
 *
 * Layout: header (file path, encoding, stage-file button, close), toolbar
 * (scope chip, file/diff toggle, hunk navigation, hunk/inline/split view
 * buttons, whitespace + word-wrap toggles), center diff pane with a minimap
 * scrollbar, right sidebar (file management + commit form while dirty, HEAD
 * commit details with author avatar when clean), and a footer with key hints.
 *
 * `tab` moves focus between the diff and the sidebar; both panes take
 * arrows/PgUp/PgDn and mouse clicks/wheel. All toolbar buttons are clickable
 * and mirrored by keys: `v` cycles the view, `n`/`p` jump hunks, `s`/`u`
 * stage/unstage (hunk-aware), `x` discards a hunk, `w` wraps, `b` toggles
 * whitespace-insensitive alignment.
 */
import {
	type Component,
	matchesKey,
	ProcessTerminal,
	routeSgrMouseInput,
	TUI,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { theme } from "../../modes/theme/theme";
import * as git from "../../utils/git";
import { AvatarLoader } from "./avatar";
import { pill, softPill, tintChip } from "./colors";
import {
	buildDiffDocument,
	buildLineSelectionPatch,
	DiffPane,
	type HunkAction,
	type HunkBlock,
	type ViewMode,
} from "./diff-pane";
import { Sidebar, type SidebarAction } from "./sidebar";
import type { FileContents } from "./state";
import { type ChangedFile, GitModel } from "./state";

const REFRESH_MS = 2_000;
const STATUS_TTL_MS = 6_000;

type Focus = "diff" | "sidebar";

interface UiHit {
	from: number;
	to: number;
	action: () => void;
}

/** Toolbar/header icon set: codicons under the nerd symbol preset, unicode otherwise. */
function icons(): Record<"close" | "hunk" | "inline" | "split" | "file" | "ws" | "wrap" | "up" | "down", string> {
	if (theme.getSymbolPreset() === "nerd") {
		return {
			close: "",
			hunk: "",
			inline: "",
			split: "",
			file: "",
			ws: "",
			wrap: "",
			up: "",
			down: "",
		};
	}
	return { close: "✕", hunk: "⊟", inline: "≡", split: "◫", file: "▤", ws: "¶", wrap: "⏎", up: "↑", down: "↓" };
}

/** Accumulates one chrome row: appended text plus clickable column ranges. */
class HitRow {
	text = "";
	width = 0;
	hits: UiHit[] = [];

	add(text: string): this {
		this.text += text;
		this.width += visibleWidth(text);
		return this;
	}

	button(text: string, action: () => void): this {
		const from = this.width;
		this.add(text);
		this.hits.push({ from, to: this.width, action });
		return this;
	}
}

/** Toggle chip: accent-on-selected background when active, dim otherwise. */
function chip(label: string, active: boolean): string {
	const text = ` ${label} `;
	return softPill(text, { active });
}

class GitTuiComponent implements Component {
	readonly #ui: TUI;
	readonly #model: GitModel;
	readonly #pane = new DiffPane();
	readonly #sidebar: Sidebar;
	readonly #done = Promise.withResolvers<void>();
	#focus: Focus = "sidebar";
	#currentFile: ChangedFile | null = null;
	#contents: FileContents | null = null;
	#ignoreWhitespace = false;
	#loadSeq = 0;
	#refreshTimer: NodeJS.Timeout | undefined;
	#busy = false;
	#status = "";
	#statusAt = 0;
	#centerWidth = 0;
	#contentHeight = 20;
	#headerHits: UiHit[] = [];
	#toolbarHits: UiHit[] = [];
	#pendingDiscard: string | null = null;
	#disposed = false;

	constructor(ui: TUI, cwd: string, pinnedSha?: string) {
		this.#ui = ui;
		this.#model = new GitModel(cwd, { pinnedSha });
		const avatars = new AvatarLoader(() => this.#ui.requestRender());
		this.#sidebar = new Sidebar({
			model: this.#model,
			avatars,
			imageBudget: ui.imageBudget,
			onSelectFile: file => this.#showFile(file),
			onAction: action => void this.#runAction(action),
			requestRender: () => this.#ui.requestRender(),
		});
		this.#sidebar.setFocused(true);
	}

	async run(): Promise<void> {
		await this.#refresh(true);
		this.#refreshTimer = setInterval(() => void this.#refresh(false), REFRESH_MS);
		return this.#done.promise;
	}

	dispose(): void {
		this.#disposed = true;
		clearInterval(this.#refreshTimer);
	}

	// ── data ───────────────────────────────────────────────────────────────

	async #refresh(force: boolean): Promise<void> {
		if (this.#disposed) return;
		try {
			const changed = await this.#model.refresh();
			if (!changed && !force) return;
			const file = this.#sidebar.reconcile();
			// Keep showing the same file when it still exists; otherwise fall back
			// to the sidebar's suggestion.
			const stillExists =
				this.#currentFile &&
				[...this.#model.unstaged, ...this.#model.staged, ...(this.#model.headCommit?.files ?? [])].some(
					candidate => candidate.path === this.#currentFile?.path && candidate.area === this.#currentFile?.area,
				);
			this.#showFile(stillExists ? this.#currentFile : file);
			this.#ui.requestRender();
		} catch (error) {
			this.#setStatus(theme.fg("error", error instanceof Error ? error.message : String(error)));
		}
	}

	#patchTargetFor(file: ChangedFile | null): "stage" | "unstage" | null {
		if (!file) return null;
		if (file.area === "unstaged") return file.kind === "untracked" || file.kind === "conflicted" ? null : "stage";
		if (file.area === "staged") return "unstage";
		return null;
	}

	#showFile(file: ChangedFile | null): void {
		this.#currentFile = file;
		this.#contents = null;
		this.#pane.patchTarget = this.#patchTargetFor(file);
		const seq = ++this.#loadSeq;
		if (!file) {
			this.#pane.emptyMessage = this.#model.clean && !this.#model.headCommit ? "No commits yet" : "No changes";
			this.#pane.setDocument(null, "empty");
			this.#ui.requestRender();
			return;
		}
		this.#pane.setDocument(null, "loading");
		this.#ui.requestRender();
		void this.#model
			.contents(file)
			.then(contents => {
				if (seq !== this.#loadSeq || this.#disposed) return;
				this.#contents = contents;
				this.#rebuildDocument();
			})
			.catch(error => {
				if (seq !== this.#loadSeq) return;
				this.#pane.setDocument(null, "empty");
				this.#setStatus(theme.fg("error", error instanceof Error ? error.message : String(error)));
			});
	}

	/** Build the pane document from the cached contents (view toggles re-run this). */
	#rebuildDocument(): void {
		const file = this.#currentFile;
		const contents = this.#contents;
		if (!file || !contents) return;
		if (contents.tooLarge) this.#pane.setDocument(null, "tooLarge");
		else if (contents.binary) this.#pane.setDocument(null, "binary");
		else {
			this.#pane.setDocument(
				buildDiffDocument(contents.oldText, contents.newText, file.path, {
					ignoreWhitespace: this.#ignoreWhitespace,
				}),
				"ready",
			);
		}
		this.#ui.requestRender();
	}

	async #runAction(action: SidebarAction): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		try {
			switch (action.type) {
				case "stage":
					await this.#model.stage(action.file);
					this.#setStatus(theme.fg("success", action.file ? `Staged ${action.file.path}` : "Staged all changes"));
					break;
				case "unstage":
					await this.#model.unstage(action.file);
					this.#setStatus(
						theme.fg("success", action.file ? `Unstaged ${action.file.path}` : "Unstaged all changes"),
					);
					break;
				case "commit": {
					if (action.stageAll) await this.#model.stage();
					await this.#model.commit(action.message, { amend: action.amend });
					this.#sidebar.clearForm();
					this.#setStatus(theme.fg("success", action.amend ? "Amended commit" : "Created commit"));
					break;
				}
			}
			await this.#refresh(true);
		} catch (error) {
			this.#setStatus(theme.fg("error", error instanceof Error ? error.message : String(error)));
		} finally {
			this.#busy = false;
		}
	}

	async #hunkAction(hunk: HunkBlock, action: HunkAction): Promise<void> {
		if (!hunk.patch) return;
		if (action === "discard" && this.#pendingDiscard !== hunk.patch) {
			this.#pendingDiscard = hunk.patch;
			this.#setStatus(theme.fg("warning", "Discard hunk? Press x (or click) again to confirm"));
			return;
		}
		this.#pendingDiscard = null;
		if (this.#busy) return;
		this.#busy = true;
		try {
			if (action === "stage") await this.#model.applyPatch(hunk.patch, { cached: true });
			else if (action === "unstage") await this.#model.applyPatch(hunk.patch, { cached: true, reverse: true });
			else await this.#model.applyPatch(hunk.patch, { reverse: true });
			this.#setStatus(
				theme.fg(
					"success",
					action === "stage" ? "Staged hunk" : action === "unstage" ? "Unstaged hunk" : "Discarded hunk",
				),
			);
			await this.#refresh(true);
		} catch (error) {
			this.#setStatus(theme.fg("error", error instanceof Error ? error.message : String(error)));
		} finally {
			this.#busy = false;
		}
	}
	/** Stage/unstage/discard the shift-selected lines of the current file. */
	async #lineAction(action: HunkAction): Promise<void> {
		const doc = this.#pane.doc;
		const span = this.#pane.selection;
		if (!doc || !span) return;
		const intent = action === "stage" ? "apply" : "revert";
		const patch = buildLineSelectionPatch(doc, span.from, span.to, intent);
		if (!patch) {
			this.#setStatus(theme.fg("warning", "Selection contains no changes"));
			return;
		}
		if (action === "discard" && this.#pendingDiscard !== patch) {
			this.#pendingDiscard = patch;
			this.#setStatus(theme.fg("warning", "Discard selected lines? Press x again to confirm"));
			return;
		}
		this.#pendingDiscard = null;
		if (this.#busy) return;
		this.#busy = true;
		try {
			// stage: apply-intent patch into the index. unstage: revert-intent
			// patch into the index. discard: revert-intent patch onto the worktree.
			await this.#model.applyPatch(patch, { cached: action !== "discard" });
			this.#pane.clearSelection();
			this.#setStatus(
				theme.fg(
					"success",
					action === "stage"
						? "Staged selection"
						: action === "unstage"
							? "Unstaged selection"
							: "Discarded selection",
				),
			);
			await this.#refresh(true);
		} catch (error) {
			this.#setStatus(theme.fg("error", error instanceof Error ? error.message : String(error)));
		} finally {
			this.#busy = false;
		}
	}

	#setStatus(text: string): void {
		this.#status = text;
		this.#statusAt = Date.now();
		this.#ui.requestRender();
	}

	// ── input ──────────────────────────────────────────────────────────────

	#setFocus(focus: Focus): void {
		this.#focus = focus;
		this.#sidebar.setFocused(focus === "sidebar");
		this.#pane.focused = focus === "diff";
		this.#ui.requestRender();
	}

	#stageCurrentFile(): void {
		const file = this.#currentFile;
		if (!file) return;
		if (file.area === "unstaged") void this.#runAction({ type: "stage", file });
		else if (file.area === "staged") void this.#runAction({ type: "unstage", file });
	}

	#setMode(mode: ViewMode): void {
		this.#pane.setMode(mode);
		this.#ui.requestRender();
	}

	#toggleWhitespace(): void {
		this.#ignoreWhitespace = !this.#ignoreWhitespace;
		this.#rebuildDocument();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.#done.resolve();
			return;
		}
		if (this.#handleMouse(data)) return;
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#setFocus(this.#focus === "diff" ? "sidebar" : "diff");
			return;
		}
		if (matchesKey(data, "escape")) {
			if (this.#focus === "sidebar" && this.#sidebar.handleEscape()) return;
			if (this.#focus === "diff" && this.#pane.clearSelection()) {
				this.#ui.requestRender();
				return;
			}
			this.#done.resolve();
			return;
		}
		if (this.#focus === "diff") {
			if (data === "q") {
				this.#done.resolve();
				return;
			}
			if (matchesKey(data, "shift+up")) this.#pane.moveCursor(-1, true);
			else if (matchesKey(data, "shift+down")) this.#pane.moveCursor(1, true);
			else if (matchesKey(data, "up")) this.#pane.moveCursor(-1, false);
			else if (matchesKey(data, "down")) this.#pane.moveCursor(1, false);
			else if (matchesKey(data, "pageUp")) this.#pane.moveCursor(-Math.max(1, this.#contentHeight - 2), false);
			else if (matchesKey(data, "pageDown")) this.#pane.moveCursor(Math.max(1, this.#contentHeight - 2), false);
			else if (matchesKey(data, "left")) this.#pane.scrollLeftBy(-8);
			else if (matchesKey(data, "right")) this.#pane.scrollLeftBy(8);
			else if (matchesKey(data, "home")) this.#pane.seekTo(0);
			else if (matchesKey(data, "end")) this.#pane.seekTo(Number.MAX_SAFE_INTEGER);
			else if (data === "v") this.#pane.cycleMode();
			else if (data === "n") this.#pane.jumpHunk(1);
			else if (data === "p") this.#pane.jumpHunk(-1);
			else if (data === "w") this.#pane.toggleWrap();
			else if (data === "b") return this.#toggleWhitespace();
			else if (data === "s" || data === "u") {
				if (this.#pane.selection?.explicit && this.#pane.patchTarget) {
					void this.#lineAction(this.#pane.patchTarget);
					return;
				}
				const hunk = this.#pane.mode === "hunk" ? this.#pane.currentHunk : null;
				if (hunk && this.#pane.patchTarget) void this.#hunkAction(hunk, this.#pane.patchTarget);
				else this.#stageCurrentFile();
				return;
			} else if (data === "x") {
				if (this.#pane.selection?.explicit && this.#pane.patchTarget === "stage") {
					void this.#lineAction("discard");
					return;
				}
				const hunk = this.#pane.mode === "hunk" ? this.#pane.currentHunk : null;
				if (hunk && this.#pane.patchTarget === "stage") void this.#hunkAction(hunk, "discard");
				return;
			} else return;
			this.#ui.requestRender();
			return;
		}
		this.#sidebar.handleInput(data);
	}

	#handleMouse(data: string): boolean {
		if (!data.startsWith("\x1b[<")) return false;
		return routeSgrMouseInput(data, event => {
			const contentRow = event.row - 2;
			const inSidebar = event.col > this.#centerWidth;
			if (event.wheel !== null) {
				if (event.row < 2) return true;
				if (inSidebar) this.#sidebar.handleWheel(event.wheel);
				else {
					this.#pane.scrollBy(event.wheel * 3);
					this.#ui.requestRender();
				}
				return true;
			}
			if (event.leftClick) {
				if (event.row === 0 || event.row === 1) {
					const hits = event.row === 0 ? this.#headerHits : this.#toolbarHits;
					hits.find(hit => event.col >= hit.from && event.col < hit.to)?.action();
					return true;
				}
				if (contentRow < 0) return true;
				if (inSidebar) {
					if (this.#focus !== "sidebar") this.#setFocus("sidebar");
					this.#sidebar.handleClick(contentRow, event.col - this.#centerWidth - 1);
				} else {
					if (this.#focus !== "diff") this.#setFocus("diff");
					const click = this.#pane.clickAt(event.col, contentRow, (event.button & 4) !== 0);
					if (click?.type === "hunk-action") void this.#hunkAction(click.hunk, click.action);
				}
				this.#ui.requestRender();
				return true;
			}
			return true;
		});
	}

	// ── render ─────────────────────────────────────────────────────────────

	render(width: number): readonly string[] {
		const height = Math.max(10, this.#ui.terminal.rows);
		const sidebarWidth = Math.max(30, Math.min(48, Math.floor(width * 0.3)));
		this.#centerWidth = width - sidebarWidth - 1;
		const contentHeight = height - 2;
		this.#contentHeight = contentHeight;

		const paneLines = this.#pane.render(this.#centerWidth, contentHeight);
		const sidebarLines = this.#sidebar.render(sidebarWidth, contentHeight);
		const separator = this.#focus === "sidebar" ? theme.fg("accent", "│") : theme.fg("borderMuted", "│");

		const lines: string[] = [this.#header(width), this.#toolbar(width)];
		for (let i = 0; i < contentHeight; i++) {
			const left = paneLines[i] ?? "";
			const leftPad = " ".repeat(Math.max(0, this.#centerWidth - visibleWidth(left)));
			lines.push(`${truncateToWidth(left, this.#centerWidth)}${leftPad}${separator}${sidebarLines[i] ?? ""}`);
		}
		return lines;
	}

	#header(width: number): string {
		const glyphs = icons();
		const row = new HitRow();
		const file = this.#currentFile;
		row.add(" ");
		if (file) {
			const slash = file.path.lastIndexOf("/");
			const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
			const base = slash >= 0 ? file.path.slice(slash + 1) : file.path;
			row.add(`${theme.fg("dim", dir)}${theme.bold(base)}`);
			const doc = this.#pane.doc;
			if (doc) row.add(`  ${theme.fg("success", `+${doc.additions}`)} ${theme.fg("error", `−${doc.deletions}`)}`);
		} else {
			row.add(theme.fg("dim", "no file selected"));
		}

		const right = new HitRow();
		right.add(theme.fg("dim", "UTF-8")).add("  ");
		if (file?.area === "unstaged")
			right.button(pill(" Stage File ", theme.getColorHex("toolDiffAdded")), () => this.#stageCurrentFile());
		else if (file?.area === "staged")
			right.button(pill(" Unstage File ", theme.getColorHex("warning")), () => this.#stageCurrentFile());
		right.add(" ").button(softPill(` ${glyphs.close} `), () => this.#done.resolve());

		// The empty middle carries the key hints (or a fresh status message).
		const status = Date.now() - this.#statusAt < STATUS_TTL_MS ? this.#status : "";
		const middle =
			status ||
			theme.fg(
				"dim",
				this.#focus === "diff"
					? "tab focus · shift+↑/↓ select · s/u stage · x discard · v view · n/p hunk · w wrap · b ws · q quit"
					: "tab focus · ↑/↓ move · enter stage/unstage · space toggle · t tree · esc quit",
			);
		const free = width - row.width - right.width - 1;
		const middleText = free > visibleWidth(middle) + 4 ? middle : truncateToWidth(middle, Math.max(0, free - 4));
		const leftPad = Math.max(1, Math.floor((free - visibleWidth(middleText)) / 2));
		const pad = Math.max(1, free - leftPad - visibleWidth(middleText));
		this.#headerHits = [
			...row.hits,
			...right.hits.map(hit => ({
				...hit,
				from: hit.from + row.width + leftPad + visibleWidth(middleText) + pad,
				to: hit.to + row.width + leftPad + visibleWidth(middleText) + pad,
			})),
		];
		return truncateToWidth(`${row.text}${" ".repeat(leftPad)}${middleText}${" ".repeat(pad)}${right.text}`, width);
	}

	#toolbar(width: number): string {
		const glyphs = icons();
		const file = this.#currentFile;
		const mode = this.#pane.mode;
		const row = new HitRow();
		row.add(" ");
		const scope =
			file?.area === "staged"
				? tintChip(" Staged ", theme.getColorHex("success"))
				: file?.area === "unstaged"
					? tintChip(file.kind === "untracked" ? " Untracked " : " Unstaged ", theme.getColorHex("warning"))
					: file
						? tintChip(` ${this.#model.headCommit?.shortSha ?? "commit"} `, theme.getColorHex("accent"))
						: theme.fg("dim", ` ${this.#model.branch ?? "detached"} `);
		row.add(scope);

		// Hunk nav + one segmented view control ⟨file│split│inline│hunk⟩,
		// centered on the diff pane so it reads as the pane's own control.
		const segments: { label: string; mode: ViewMode }[] = [
			{ label: ` ${glyphs.file} `, mode: "file" },
			{ label: ` ${glyphs.split} `, mode: "split" },
			{ label: ` ${glyphs.inline} `, mode: "inline" },
			{ label: ` ${glyphs.hunk} `, mode: "hunk" },
		];
		const navUp = theme.fg("muted", ` ${glyphs.up} `);
		const navDown = theme.fg("muted", ` ${glyphs.down} `);
		const segmentsWidth = segments.reduce((sum, segment) => sum + visibleWidth(segment.label), 0);
		const groupWidth = visibleWidth(navUp) + visibleWidth(navDown) + 2 + segmentsWidth;
		const groupStart = Math.max(row.width + 2, Math.floor((this.#centerWidth - groupWidth) / 2));
		row.add(" ".repeat(Math.max(0, groupStart - row.width)));
		row.button(navUp, () => {
			this.#pane.jumpHunk(-1);
			this.#ui.requestRender();
		});
		row.button(navDown, () => {
			this.#pane.jumpHunk(1);
			this.#ui.requestRender();
		});
		row.add("  ");
		for (const segment of segments) {
			row.button(softPill(segment.label, { active: mode === segment.mode }), () => this.#setMode(segment.mode));
		}

		const right = new HitRow();
		right.button(chip(glyphs.ws, this.#ignoreWhitespace), () => this.#toggleWhitespace());
		right.add(" ");
		right.button(chip(glyphs.wrap, this.#pane.wrap), () => {
			this.#pane.toggleWrap();
			this.#ui.requestRender();
		});
		right.add(" ");

		const pad = Math.max(1, width - row.width - right.width);
		this.#toolbarHits = [
			...row.hits,
			...right.hits.map(hit => ({ ...hit, from: hit.from + row.width + pad, to: hit.to + row.width + pad })),
		];
		return truncateToWidth(`${row.text}${" ".repeat(pad)}${right.text}`, width);
	}

	quit(): void {
		this.#done.resolve();
	}
}

/** Options for {@link runGitTui}. */
export interface GitTuiOptions {
	cwd?: string;
	/** Pin the view to one commit (any rev-parse-able revision). */
	revision?: string;
}

/**
 * Mount the git TUI as a fullscreen overlay on an existing TUI (the `/git`
 * slash command). Resolves when the user closes it; the caller restores focus.
 */
export async function showGitOverlay(ui: TUI, options: GitTuiOptions = {}): Promise<void> {
	const cwd = options.cwd ?? process.cwd();
	const root = await git.repo.root(cwd);
	if (!root) throw new Error(`Not a git repository: ${cwd}`);
	let pinnedSha: string | undefined;
	if (options.revision) {
		pinnedSha = (await git.ref.resolve(root, options.revision)) ?? undefined;
		if (!pinnedSha) throw new Error(`Cannot resolve revision: ${options.revision}`);
	}
	const component = new GitTuiComponent(ui, root, pinnedSha);
	const overlay = ui.showOverlay(component, {
		anchor: "top-left",
		width: "100%",
		maxHeight: "100%",
		margin: 0,
		fullscreen: true,
		mouseTracking: true,
	});
	ui.setFocus(component);
	ui.requestRender();
	try {
		await component.run();
	} finally {
		component.dispose();
		// overlay.hide() restores focus to the pre-overlay component.
		overlay.hide();
	}
}

/** Run the fullscreen git TUI standalone (`omp git`) until the user quits. */
export async function runGitTui(options: GitTuiOptions = {}): Promise<void> {
	const ui = new TUI(new ProcessTerminal());
	ui.start();
	try {
		await showGitOverlay(ui, options);
	} finally {
		ui.stop();
	}
}
