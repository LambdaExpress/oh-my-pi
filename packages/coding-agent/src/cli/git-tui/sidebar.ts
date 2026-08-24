/**
 * Right sidebar of the git TUI.
 *
 * Dirty tree → file management: unstaged/staged sections with stage/unstage
 * actions plus a commit form (amend toggle, summary input, description
 * editor, commit button). Clean tree → HEAD commit view: subject, body,
 * author with avatar photo, parents, and the commit's file list.
 *
 * The sidebar is not a TUI component itself: the root composes its rendered
 * lines and forwards key/mouse input. Every rendered frame records a hit
 * target per row so mouse clicks resolve against what is actually visible.
 */
import {
	Editor,
	Image,
	type ImageBudget,
	Input,
	matchesKey,
	TERMINAL,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { getEditorTheme, theme } from "../../modes/theme/theme";
import { type AvatarLoader, identiconLines } from "./avatar";
import { pill, selectionBgAnsi, softPill, tintChip, withBg } from "./colors";
import type { ChangedFile, GitModel } from "./state";

/** Actions the sidebar raises to the root component. */
export type SidebarAction =
	| { type: "stage"; file?: ChangedFile }
	| { type: "unstage"; file?: ChangedFile }
	| { type: "commit"; message: string; amend: boolean; stageAll: boolean };

type Target =
	| { kind: "file"; file: ChangedFile }
	| { kind: "dir"; key: string }
	| { kind: "view-style"; style: "path" | "tree" }
	| { kind: "stage-all" }
	| { kind: "unstage-all" }
	| { kind: "amend" }
	| { kind: "summary" }
	| { kind: "description" }
	| { kind: "commit-button" };

interface Row {
	text: string;
	target?: Target;
	/** Column-scoped hit targets for rows carrying several buttons. */
	hits?: { from: number; to: number; target: Target }[];
}

const KIND_LETTER: Record<ChangedFile["kind"], string> = {
	modified: "M",
	added: "A",
	deleted: "D",
	renamed: "R",
	untracked: "?",
	conflicted: "U",
};

const KIND_COLOR: Record<ChangedFile["kind"], "warning" | "success" | "error" | "accent" | "muted"> = {
	modified: "warning",
	added: "success",
	deleted: "error",
	renamed: "accent",
	untracked: "muted",
	conflicted: "error",
};

const SUMMARY_LIMIT = 72;

function targetKey(target: Target): string {
	if (target.kind === "file") return `file:${target.file.area}:${target.file.path}`;
	if (target.kind === "dir") return `dir:${target.key}`;
	if (target.kind === "view-style") return `view:${target.style}`;
	return target.kind;
}
/** One rendered entry of a file section: nested dirs (tree mode) or flat files. */
interface FileEntry {
	target: Target;
	/** Tree indentation depth; omitted in flat path mode. */
	depth?: number;
	file?: ChangedFile;
	/** Dir entries: display name (compressed chain) + collapse state. */
	dirName?: string;
	collapsed?: boolean;
}

interface TreeDir {
	name: string;
	dirs: Map<string, TreeDir>;
	files: ChangedFile[];
}

/** File row: status letter, dimmed directory, bright basename, +/− counts. */
function fileRowText(file: ChangedFile, width: number, selected: boolean, focused: boolean, depth?: number): string {
	const letter = theme.fg(KIND_COLOR[file.kind], KIND_LETTER[file.kind]);
	const slash = file.path.lastIndexOf("/");
	const dir = depth === undefined && slash >= 0 ? file.path.slice(0, slash + 1) : "";
	const base = slash >= 0 ? file.path.slice(slash + 1) : file.path;
	const indent = depth === undefined ? "" : " ".repeat(depth);
	let counts = "";
	if (file.additions !== undefined || file.deletions !== undefined) {
		const added = file.additions ? theme.fg("success", `+${file.additions}`) : "";
		const removed = file.deletions ? theme.fg("error", `−${file.deletions}`) : "";
		counts = [added, removed].filter(Boolean).join(" ");
	}
	const countsWidth = visibleWidth(counts);
	const pathBudget = width - 4 - (countsWidth ? countsWidth + 1 : 0) - indent.length;
	let pathText: string;
	const full = dir + base;
	if (full.length <= pathBudget) {
		pathText = theme.fg("dim", dir) + base;
	} else {
		const tail = full.slice(Math.max(0, full.length - pathBudget + 1));
		pathText = theme.fg("dim", "…") + tail;
	}
	const pad = Math.max(0, width - 4 - visibleWidth(pathText) - (countsWidth ? countsWidth + 1 : 0) - indent.length);
	const bar = selected ? theme.fg("accent", "▎") : " ";
	const line = `${bar}${indent}${letter} ${pathText}${" ".repeat(pad)}${countsWidth ? ` ${counts}` : ""}`;
	return selected && focused ? `${withBg(line, selectionBgAnsi())}\x1b[0m` : line;
}
/** Directory row in tree mode: chevron + compressed dir-chain name. */
function dirRowText(entry: FileEntry, width: number, selected: boolean, focused: boolean): string {
	const bar = selected ? theme.fg("accent", "▎") : " ";
	const chevron = entry.collapsed ? "▸" : "▾";
	const indent = " ".repeat(entry.depth ?? 0);
	const text = `${bar}${indent}${theme.fg("muted", chevron)}${theme.fg("dim", `${entry.dirName}/`)}`;
	const line = truncateToWidth(text + " ".repeat(Math.max(0, width - visibleWidth(text))), width);
	return selected && focused ? `${withBg(line, selectionBgAnsi())}\x1b[0m` : line;
}

function sectionHeader(label: string, action: string, width: number, selected: boolean, focused: boolean): string {
	const left = theme.bold(label);
	const right = softPill(` ${action} `, { active: true });
	const pad = Math.max(1, width - 2 - visibleWidth(left) - visibleWidth(right));
	const line = ` ${left}${" ".repeat(pad)}${right} `;
	return selected && focused ? `${withBg(line, selectionBgAnsi())}\x1b[0m` : line;
}

/** Sidebar state machine + renderer. */
export class Sidebar {
	readonly #model: GitModel;
	readonly #avatars: AvatarLoader;
	readonly #onSelectFile: (file: ChangedFile | null) => void;
	readonly #onAction: (action: SidebarAction) => void;
	readonly #requestRender: () => void;
	readonly summary = new Input();
	readonly description = new Editor(getEditorTheme());
	readonly #imageBudget: ImageBudget | undefined;
	focused = false;
	amend = false;
	/** File-list presentation: flat paths or a collapsible directory tree. */
	viewStyle: "path" | "tree" = "tree";
	readonly #collapsed = new Set<string>();
	#targets: Target[] = [];
	#selectedKey: string | undefined;
	#scrollTop = 0;
	#visibleRows: (Row | undefined)[] = [];
	#lastWidth = 40;
	#lastHeight = 24;
	#avatarImage: { email: string; image: Image } | undefined;

	constructor(options: {
		model: GitModel;
		avatars: AvatarLoader;
		imageBudget?: ImageBudget;
		onSelectFile: (file: ChangedFile | null) => void;
		onAction: (action: SidebarAction) => void;
		requestRender: () => void;
	}) {
		this.#model = options.model;
		this.#avatars = options.avatars;
		this.#imageBudget = options.imageBudget;
		this.#onSelectFile = options.onSelectFile;
		this.#onAction = options.onAction;
		this.#requestRender = options.requestRender;
		this.summary.prompt = "";
		this.description.setBorderVisible(false);
		this.description.setMaxHeight(5);
	}

	/** Currently selected target, if any. */
	get selected(): Target | undefined {
		if (this.#selectedKey === undefined) return this.#targets[0];
		return this.#targets.find(target => targetKey(target) === this.#selectedKey) ?? this.#targets[0];
	}

	get selectedFile(): ChangedFile | null {
		const target = this.selected;
		return target?.kind === "file" ? target.file : null;
	}

	/** Re-sync selection after a model refresh; returns the file to show. */
	reconcile(): ChangedFile | null {
		this.#rebuildTargets();
		const target = this.selected;
		if (target) this.#selectedKey = targetKey(target);
		if (target?.kind === "file") return target.file;
		const firstFile = this.#targets.find(candidate => candidate.kind === "file");
		if (firstFile?.kind === "file" && (!target || target.kind === "stage-all" || target.kind === "unstage-all")) {
			return firstFile.file;
		}
		return firstFile?.kind === "file" ? firstFile.file : null;
	}

	/** Section entries in display order: tree dirs + files, or flat files. */
	#fileEntries(files: readonly ChangedFile[], section: string): FileEntry[] {
		if (this.viewStyle === "path") {
			return files.map(file => ({ target: { kind: "file", file } as const, file }));
		}
		const root: TreeDir = { name: "", dirs: new Map(), files: [] };
		for (const file of files) {
			const parts = file.path.split("/");
			let node = root;
			for (const part of parts.slice(0, -1)) {
				let next = node.dirs.get(part);
				if (!next) {
					next = { name: part, dirs: new Map(), files: [] };
					node.dirs.set(part, next);
				}
				node = next;
			}
			node.files.push(file);
		}
		// Compress single-child directory chains ("a/b/c" as one row).
		const compress = (node: TreeDir): void => {
			for (const [key, child] of [...node.dirs]) {
				let merged = child;
				while (merged.files.length === 0 && merged.dirs.size === 1) {
					const [only] = merged.dirs.values();
					merged = { name: `${merged.name}/${only.name}`, dirs: only.dirs, files: only.files };
				}
				if (merged !== child) {
					node.dirs.delete(key);
					node.dirs.set(key, merged);
				}
				compress(merged);
			}
		};
		compress(root);
		const entries: FileEntry[] = [];
		const walk = (node: TreeDir, depth: number, prefix: string): void => {
			for (const dir of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
				const key = `${section}:${prefix}${dir.name}`;
				const collapsed = this.#collapsed.has(key);
				entries.push({ target: { kind: "dir", key }, depth, dirName: dir.name, collapsed });
				if (!collapsed) walk(dir, depth + 1, `${prefix}${dir.name}/`);
			}
			for (const file of node.files) entries.push({ target: { kind: "file", file }, depth, file });
		};
		walk(root, 0, "");
		return entries;
	}

	#rebuildTargets(): void {
		const targets: Target[] = [];
		if (this.#model.clean) {
			for (const entry of this.#fileEntries(this.#model.headCommit?.files ?? [], "commit"))
				targets.push(entry.target);
		} else {
			targets.push({ kind: "stage-all" });
			for (const entry of this.#fileEntries(this.#model.unstaged, "unstaged")) targets.push(entry.target);
			targets.push({ kind: "unstage-all" });
			for (const entry of this.#fileEntries(this.#model.staged, "staged")) targets.push(entry.target);
			targets.push({ kind: "amend" }, { kind: "summary" }, { kind: "description" }, { kind: "commit-button" });
		}
		this.#targets = targets;
	}

	#select(target: Target): void {
		this.#selectedKey = targetKey(target);
		this.summary.focused = this.focused && target.kind === "summary";
		this.description.focused = this.focused && target.kind === "description";
		if (target.kind === "file") this.#onSelectFile(target.file);
		this.#requestRender();
	}

	/** Called by the root when pane focus changes. */
	setFocused(focused: boolean): void {
		this.focused = focused;
		const target = this.selected;
		this.summary.focused = focused && target?.kind === "summary";
		this.description.focused = focused && target?.kind === "description";
	}

	#moveSelection(delta: number): void {
		if (this.#targets.length === 0) return;
		const current = this.selected;
		const index = current ? this.#targets.findIndex(target => targetKey(target) === targetKey(current)) : -1;
		const next = Math.max(0, Math.min(this.#targets.length - 1, index + delta));
		this.#select(this.#targets[next]);
	}

	#activate(target: Target): void {
		switch (target.kind) {
			case "file": {
				if (target.file.area === "unstaged") this.#onAction({ type: "stage", file: target.file });
				else if (target.file.area === "staged") this.#onAction({ type: "unstage", file: target.file });
				break;
			}
			case "dir": {
				if (this.#collapsed.has(target.key)) this.#collapsed.delete(target.key);
				else this.#collapsed.add(target.key);
				this.#requestRender();
				break;
			}
			case "view-style":
				this.viewStyle = target.style;
				this.#requestRender();
				break;
			case "stage-all":
				this.#onAction({ type: "stage" });
				break;
			case "unstage-all":
				this.#onAction({ type: "unstage" });
				break;
			case "amend":
				this.#toggleAmend();
				break;
			case "summary":
			case "description":
				break;
			case "commit-button":
				this.#submitCommit();
				break;
		}
	}

	#toggleAmend(): void {
		this.amend = !this.amend;
		const head = this.#model.headCommit;
		if (this.amend && head && this.summary.getValue().length === 0 && this.description.getText().length === 0) {
			this.summary.setValue(head.subject);
			this.description.setText(head.body);
		}
		this.#requestRender();
	}

	#submitCommit(): void {
		const summary = this.summary.getValue().trim();
		if (!summary) return;
		const body = this.description.getText().trim();
		const message = body ? `${summary}\n\n${body}` : summary;
		const stageAll = this.#model.staged.length === 0;
		if (stageAll && this.#model.unstaged.length === 0 && !this.amend) return;
		this.#onAction({ type: "commit", message, amend: this.amend, stageAll });
	}

	/** Clear the commit form after a successful commit. */
	clearForm(): void {
		this.summary.setValue("");
		this.description.setText("");
		this.amend = false;
	}
	/** Escape while the sidebar has focus: blur a text input first. True when consumed. */
	handleEscape(): boolean {
		const target = this.selected;
		if (target?.kind === "summary" || target?.kind === "description") {
			this.#select({ kind: "commit-button" });
			return true;
		}
		return false;
	}

	handleInput(data: string): void {
		this.#rebuildTargets();
		const target = this.selected;

		if (target?.kind === "summary" && this.focused) {
			if (matchesKey(data, "up")) return this.#moveSelection(-1);
			if (matchesKey(data, "down") || matchesKey(data, "enter")) return this.#moveSelection(1);
			if (!matchesKey(data, "pageUp") && !matchesKey(data, "pageDown")) {
				this.summary.handleInput(data);
				this.#requestRender();
				return;
			}
		}
		if (target?.kind === "description" && this.focused) {
			const cursor = this.description.getCursor();
			const lineCount = this.description.getLines().length;
			if (matchesKey(data, "up") && cursor.line === 0) return this.#moveSelection(-1);
			if (matchesKey(data, "down") && cursor.line >= lineCount - 1) return this.#moveSelection(1);
			if (!matchesKey(data, "pageUp") && !matchesKey(data, "pageDown")) {
				this.description.handleInput(data);
				this.#requestRender();
				return;
			}
		}

		if (matchesKey(data, "up")) this.#moveSelection(-1);
		else if (matchesKey(data, "down")) this.#moveSelection(1);
		else if (matchesKey(data, "pageUp")) this.#moveSelection(-Math.max(1, this.#lastHeight - 4));
		else if (matchesKey(data, "pageDown")) this.#moveSelection(Math.max(1, this.#lastHeight - 4));
		else if (matchesKey(data, "enter") && target) this.#activate(target);
		else if (data === " " && target?.kind !== undefined && (target.kind === "file" || target.kind === "dir"))
			this.#activate(target);
		else if (data === "t") {
			this.viewStyle = this.viewStyle === "path" ? "tree" : "path";
			this.#requestRender();
		}
	}

	/** Wheel scroll over the sidebar. */
	handleWheel(delta: number): void {
		this.#scrollTop = Math.max(0, this.#scrollTop + delta * 3);
		this.#requestRender();
	}

	/** Left click at sidebar-local coordinates. */
	handleClick(row: number, col: number): void {
		const visible = this.#visibleRows[row];
		if (!visible) return;
		const hit = visible.hits?.find(candidate => col >= candidate.from && col < candidate.to);
		const target = hit?.target ?? visible.target;
		if (!target) return;
		const wasSelected = this.selected && targetKey(this.selected) === targetKey(target);
		this.#select(target);
		if (target.kind !== "file" && target.kind !== "summary" && target.kind !== "description") {
			this.#activate(target);
		} else if (target.kind === "file" && wasSelected) {
			this.#activate(target);
		}
	}

	render(width: number, height: number): string[] {
		this.#lastWidth = width;
		this.#lastHeight = height;
		this.#rebuildTargets();
		const selected = this.selected;
		const selectedKey = selected ? targetKey(selected) : undefined;
		const isSelected = (target: Target): boolean => selectedKey === targetKey(target);

		const rows: Row[] = [];
		let pinned: Row[] = [];
		if (this.#model.clean) {
			rows.push(...this.#commitViewRows(width, isSelected));
		} else {
			rows.push(...this.#changesHeaderRows(width));
			rows.push(...this.#fileListRows(width, isSelected));
			pinned = this.#commitFormRows(width, isSelected);
		}

		const listHeight = Math.max(1, height - pinned.length);
		// Keep the selected row inside the scrollable window.
		const selectedRow = rows.findIndex(row => row.target && selectedKey === targetKey(row.target));
		if (selectedRow >= 0) {
			if (selectedRow < this.#scrollTop) this.#scrollTop = selectedRow;
			if (selectedRow >= this.#scrollTop + listHeight) this.#scrollTop = selectedRow - listHeight + 1;
		}
		this.#scrollTop = Math.max(0, Math.min(this.#scrollTop, Math.max(0, rows.length - listHeight)));

		const lines: string[] = [];
		this.#visibleRows = [];
		for (let i = 0; i < listHeight; i++) {
			const row = rows[this.#scrollTop + i];
			lines.push(row ? truncateToWidth(row.text, width) : "");
			this.#visibleRows.push(row);
		}
		for (const row of pinned) {
			lines.push(truncateToWidth(row.text, width));
			this.#visibleRows.push(row);
		}
		return lines.slice(0, height);
	}
	/** Centered `Path | Tree` toggle row with column-scoped hit targets. */
	#viewToggleRow(width: number): Row {
		const nerd = theme.getSymbolPreset() === "nerd";
		const pathPill = softPill(` ${nerd ? "" : "☰"} Path `, { active: this.viewStyle === "path" });
		const treePill = softPill(` ${nerd ? "" : "└"} Tree `, { active: this.viewStyle === "tree" });
		const total = visibleWidth(pathPill) + 1 + visibleWidth(treePill);
		const left = Math.max(1, Math.floor((width - total) / 2));
		return {
			text: `${" ".repeat(left)}${pathPill} ${treePill}`,
			hits: [
				{ from: left, to: left + visibleWidth(pathPill), target: { kind: "view-style", style: "path" } },
				{
					from: left + visibleWidth(pathPill) + 1,
					to: left + total,
					target: { kind: "view-style", style: "tree" },
				},
			],
		};
	}

	#entryRows(
		files: readonly ChangedFile[],
		section: string,
		width: number,
		isSelected: (target: Target) => boolean,
	): Row[] {
		const treeMode = this.viewStyle === "tree";
		return this.#fileEntries(files, section).map(entry => {
			if (entry.target.kind === "dir") {
				return { text: dirRowText(entry, width, isSelected(entry.target), this.focused), target: entry.target };
			}
			const file = entry.file as ChangedFile;
			return {
				text: fileRowText(file, width, isSelected(entry.target), this.focused, treeMode ? entry.depth : undefined),
				target: entry.target,
			};
		});
	}

	#changesHeaderRows(width: number): Row[] {
		const total = this.#model.unstaged.length + this.#model.staged.length;
		const branch = this.#model.branch ? tintChip(` ${this.#model.branch} `, theme.getColorHex("accent")) : "";
		const label = theme.bold(`${total} file change${total === 1 ? "" : "s"} on `);
		return [
			{ text: ` ${label}${branch}` },
			this.#viewToggleRow(width),
			{ text: theme.fg("borderMuted", "─".repeat(Math.max(0, width))) },
		];
	}

	#fileListRows(width: number, isSelected: (target: Target) => boolean): Row[] {
		const rows: Row[] = [];
		const stageAll: Target = { kind: "stage-all" };
		rows.push({
			text: sectionHeader(
				`▾ Unstaged Files (${this.#model.unstaged.length})`,
				"Stage All",
				width,
				isSelected(stageAll),
				this.focused,
			),
			target: stageAll,
		});
		rows.push(...this.#entryRows(this.#model.unstaged, "unstaged", width, isSelected));
		if (this.#model.unstaged.length === 0) rows.push({ text: theme.fg("dim", "   no unstaged files") });
		rows.push({ text: "" });
		const unstageAll: Target = { kind: "unstage-all" };
		rows.push({
			text: sectionHeader(
				`▾ Staged Files (${this.#model.staged.length})`,
				"Unstage All",
				width,
				isSelected(unstageAll),
				this.focused,
			),
			target: unstageAll,
		});
		rows.push(...this.#entryRows(this.#model.staged, "staged", width, isSelected));
		if (this.#model.staged.length === 0) rows.push({ text: theme.fg("dim", "   no staged files") });
		return rows;
	}

	#commitFormRows(width: number, isSelected: (target: Target) => boolean): Row[] {
		const rows: Row[] = [];
		rows.push({ text: theme.fg("borderMuted", "─".repeat(Math.max(0, width))) });

		const amendTarget: Target = { kind: "amend" };
		const amendBox = this.amend ? theme.fg("accent", "▣") : theme.fg("muted", "☐");
		const amendLine = ` ${amendBox} Amend previous commit`;
		rows.push({
			text: isSelected(amendTarget) && this.focused ? `${withBg(amendLine, selectionBgAnsi())}\x1b[0m` : amendLine,
			target: amendTarget,
		});

		const summaryTarget: Target = { kind: "summary" };
		const summaryLen = this.summary.getValue().length;
		const counter = theme.fg(summaryLen > SUMMARY_LIMIT ? "warning" : "dim", String(SUMMARY_LIMIT - summaryLen));
		const summaryLabel = theme.fg("muted", "Commit summary");
		rows.push({
			text: ` ${summaryLabel}${" ".repeat(Math.max(1, width - 2 - visibleWidth(summaryLabel) - visibleWidth(counter)))}${counter}`,
		});
		const summaryLine = this.summary.render(width - 4)[0] ?? "";
		const summaryBar = isSelected(summaryTarget) ? theme.fg("accent", "▎") : theme.fg("borderMuted", "▏");
		rows.push({ text: ` ${summaryBar}${summaryLine}`, target: summaryTarget });

		const descriptionTarget: Target = { kind: "description" };
		const descriptionLines = this.description.render(width - 4);
		const descriptionBar = isSelected(descriptionTarget) ? theme.fg("accent", "▎") : theme.fg("borderMuted", "▏");
		if (this.description.getText().length === 0 && !this.description.focused) {
			rows.push({ text: ` ${descriptionBar}${theme.fg("dim", "Description")}`, target: descriptionTarget });
		} else {
			for (const line of descriptionLines.length > 0 ? descriptionLines : [""]) {
				rows.push({ text: ` ${descriptionBar}${line}`, target: descriptionTarget });
			}
		}
		rows.push({ text: "" });

		const commitTarget: Target = { kind: "commit-button" };
		const canCommit =
			this.summary.getValue().trim().length > 0 &&
			(this.#model.staged.length > 0 || this.#model.unstaged.length > 0 || this.amend);
		const label = this.#model.staged.length > 0 ? "-○- Commit staged changes" : "-○- Stage all & commit";
		const pad = Math.max(0, Math.floor((width - 4 - visibleWidth(label)) / 2));
		const inner = `${" ".repeat(pad)}${label}${" ".repeat(pad)}`;
		const button = pill(inner, theme.getColorHex("accent"), {
			dim: !canCommit,
			selected: canCommit && isSelected(commitTarget) && this.focused,
		});
		rows.push({ text: ` ${button}`, target: commitTarget });
		return rows;
	}

	#commitViewRows(width: number, isSelected: (target: Target) => boolean): Row[] {
		const rows: Row[] = [];
		const head = this.#model.headCommit;
		if (!head) {
			rows.push({ text: "" }, { text: theme.fg("dim", " No commits yet") });
			return rows;
		}
		for (const line of Bun.wrapAnsi(theme.bold(head.subject), width - 2).split("\n")) {
			rows.push({ text: ` ${line}` });
		}
		if (head.body) {
			rows.push({ text: "" });
			const bodyLines = Bun.wrapAnsi(head.body, width - 2)
				.split("\n")
				.slice(0, 8);
			for (const line of bodyLines) rows.push({ text: theme.fg("muted", ` ${line}`) });
		}
		rows.push({ text: "" });

		for (const line of this.#avatarRows(head.authorEmail)) rows.push({ text: ` ${line}` });
		rows.push({ text: ` ${theme.bold(head.authorName)} ${theme.fg("dim", `<${head.authorEmail}>`)}` });
		const when = head.authorDate ? new Date(head.authorDate) : null;
		if (when && !Number.isNaN(when.getTime())) {
			rows.push({ text: theme.fg("dim", ` authored ${when.toLocaleString()}`) });
		}
		if (head.parents.length > 0) {
			rows.push({
				text: ` ${theme.fg("dim", "parent:")} ${theme.fg("accent", head.parents.map(sha => sha.slice(0, 8)).join(" "))}`,
			});
		}
		rows.push({ text: theme.fg("borderMuted", "─".repeat(Math.max(0, width))) });

		const additions = head.files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
		const deletions = head.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
		rows.push({
			text: ` ${theme.bold(`${head.files.length} modified`)}  ${theme.fg("success", `+${additions}`)} ${theme.fg("error", `−${deletions}`)} ${theme.fg("dim", `· ${head.shortSha}`)}`,
		});
		rows.push(this.#viewToggleRow(width));
		rows.push(...this.#entryRows(head.files, "commit", width, isSelected));
		return rows;
	}

	#avatarRows(email: string): string[] {
		const identicon = (): string[] =>
			identiconLines(email, (hex, text) => {
				const value = Number.parseInt(hex.replace("#", ""), 16);
				return `\x1b[38;2;${(value >> 16) & 0xff};${(value >> 8) & 0xff};${value & 0xff}m${text}\x1b[0m`;
			});
		if (!TERMINAL.imageProtocol) return identicon();
		const png = this.#avatars.get(email, this.#model.cwd);
		if (png === null || png === undefined) return identicon();
		if (this.#avatarImage?.email !== email) {
			this.#avatarImage = {
				email,
				image: new Image(
					png,
					"image/png",
					{ fallbackColor: text => theme.fg("dim", text) },
					{ maxHeightCells: 3, budget: this.#imageBudget, imageKey: `git-avatar:${email}` },
				),
			};
		}
		return [...this.#avatarImage.image.render(this.#lastWidth - 2)];
	}
}
