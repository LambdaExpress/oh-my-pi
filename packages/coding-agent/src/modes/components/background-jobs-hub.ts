import {
	matchesKey,
	padding,
	routeSelectListMouse,
	routeSgrMouseInput,
	type SelectListMouseTarget,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { formatDuration, sanitizeText } from "@oh-my-pi/pi-utils";
import { t } from "../../i18n";
import type { AsyncJobSnapshot, AsyncJobSnapshotItem } from "../../session/agent-session-types";
import { replaceTabs, truncateToWidth } from "../../tools/render-utils";
import { formatSshTransferSummary, isSshTransferToolDetails } from "../../tools/ssh-transfer";
import { formatLocalDateTimeWithOffset } from "../../utils/local-date";
import { theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { clampHubLine, sanitizeDisplayText } from "./agent-hub-renderer";
import {
	bottomBorder,
	divider,
	dividerSplit,
	row,
	splitBodyWidth,
	splitRow,
	topBorder,
	topBorderSplit,
} from "./overlay-box";

const REFRESH_INTERVAL_MS = 500;
const SPLIT_MIN_WIDTH = 96;
const DETAIL_MIN_WIDTH = 38;
const ROSTER_MIN_WIDTH = 42;
const DETAIL_SCROLL_ROWS = 5;

export interface BackgroundJobsHubDeps {
	ui: TUI;
	getSnapshot: () => AsyncJobSnapshot | null;
	onDone: () => void;
	requestRender: () => void;
}

function isActive(job: AsyncJobSnapshotItem): boolean {
	return job.status === "running" || (job.status === "cancelled" && job.settledAt === undefined);
}

function statusLabel(job: AsyncJobSnapshotItem): string {
	if (job.queued && isActive(job)) return t("queued");
	if (isActive(job)) return t("running");
	if (job.status === "completed") return t("completed");
	if (job.status === "failed") return t("failed");
	return t("cancelled");
}

function statusGlyph(job: AsyncJobSnapshotItem): string {
	if (job.queued && isActive(job)) return theme.fg("muted", theme.status.shadowed);
	if (isActive(job)) return theme.fg("accent", theme.status.running);
	if (job.status === "completed") return theme.fg("success", theme.status.enabled);
	if (job.status === "failed") return theme.fg("error", theme.status.aborted);
	return theme.fg("muted", theme.status.shadowed);
}

function statusText(job: AsyncJobSnapshotItem, text: string): string {
	if (job.queued && isActive(job)) return theme.fg("muted", text);
	if (isActive(job)) return theme.fg("accent", text);
	if (job.status === "completed") return theme.fg("success", text);
	if (job.status === "failed") return theme.fg("error", text);
	return theme.fg("muted", text);
}

function cleanText(text: string): string {
	return replaceTabs(sanitizeText(text)).replaceAll("\r", "");
}

function jobDuration(job: AsyncJobSnapshotItem, now: number): string {
	return formatDuration(Math.max(0, (job.settledAt ?? now) - job.startTime));
}

/** Fullscreen inspector for live and retained asynchronous jobs in one session scope. */
export class BackgroundJobsHubComponent implements SelectListMouseTarget {
	#ui: TUI;
	#getSnapshot: () => AsyncJobSnapshot | null;
	#onDone: () => void;
	#requestRender: () => void;
	#rows: AsyncJobSnapshotItem[] = [];
	#selectedRow = 0;
	#hoveredRow: number | null = null;
	#hitRows: Array<number | undefined> = [];
	#detailScrollOffset = 0;
	#selectedJobId: string | undefined;
	#narrowDetailsOpen = false;
	#lastSplitRosterWidth: number | undefined;
	#refreshTimer: NodeJS.Timeout | undefined;
	#disposed = false;

	constructor(deps: BackgroundJobsHubDeps) {
		this.#ui = deps.ui;
		this.#getSnapshot = deps.getSnapshot;
		this.#onDone = deps.onDone;
		this.#requestRender = deps.requestRender;
		this.#refreshRows();
		this.#refreshTimer = setInterval(() => {
			this.#refreshRows();
			this.#requestRender();
		}, REFRESH_INTERVAL_MS);
		this.#refreshTimer.unref();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#refreshTimer) {
			clearInterval(this.#refreshTimer);
			this.#refreshTimer = undefined;
		}
	}

	render(width: number): readonly string[] {
		this.#refreshRows();
		const termHeight = this.#ui.terminal?.rows || process.stdout.rows || 40;
		const contentRows = Math.max(1, termHeight - 4);
		const split = this.#splitRosterWidth(width);
		this.#lastSplitRosterWidth = split;
		this.#hitRows.length = 0;
		const selected = this.#rows[this.#selectedRow];
		const lines: string[] = [];

		if (split !== undefined) {
			const detailWidth = splitBodyWidth(width, split);
			const roster = this.#renderRosterPanel(split, contentRows);
			const details = this.#renderDetailPanel(selected, detailWidth, contentRows);
			lines.push(topBorderSplit(width, t("Background Jobs Hub"), split));
			for (let index = 0; index < contentRows; index++) {
				const hit = roster.hitRows[index];
				if (hit !== undefined) this.#hitRows[lines.length] = hit;
				lines.push(splitRow(roster.lines[index] ?? "", details[index] ?? "", width, split));
			}
			lines.push(dividerSplit(width, split));
			lines.push(row(theme.fg("dim", t("j/k/wheel:select  PgUp/PgDn:output  Esc:close")), width));
			lines.push(bottomBorder(width));
			return lines.map(line => clampHubLine(line, width));
		}

		const innerWidth = Math.max(1, width - 4);
		if (this.#narrowDetailsOpen && selected) {
			lines.push(topBorder(width, t("Background Jobs · {id}", { id: selected.id })));
			for (const detail of this.#renderDetailPanel(selected, innerWidth, contentRows))
				lines.push(row(detail, width));
		} else {
			const roster = this.#renderRosterPanel(innerWidth, contentRows);
			lines.push(topBorder(width, t("Background Jobs Hub")));
			for (let index = 0; index < contentRows; index++) {
				const hit = roster.hitRows[index];
				if (hit !== undefined) this.#hitRows[lines.length] = hit;
				lines.push(row(roster.lines[index] ?? "", width));
			}
		}
		lines.push(divider(width));
		lines.push(
			row(
				theme.fg(
					"dim",
					this.#narrowDetailsOpen
						? t("Tab:list  PgUp/PgDn:output  Esc:list")
						: t("j/k/wheel:select  Enter/Tab:details  Esc:close"),
				),
				width,
			),
		);
		lines.push(bottomBorder(width));
		return lines.map(line => clampHubLine(line, width));
	}

	handleInput(keyData: string): void {
		if (
			routeSgrMouseInput(keyData, event => {
				const split = this.#lastSplitRosterWidth;
				if (split !== undefined && event.col > split + 2) {
					if (event.wheel !== null) {
						this.#scrollDetails(event.wheel);
						return true;
					}
					return false;
				}
				return routeSelectListMouse(this, event, event.row);
			})
		) {
			return;
		}
		if (matchesKey(keyData, "escape")) {
			if (this.#narrowDetailsOpen && this.#lastSplitRosterWidth === undefined) {
				this.#narrowDetailsOpen = false;
				this.#requestRender();
			} else {
				this.#onDone();
			}
			return;
		}
		if ((matchesKey(keyData, "tab") || keyData === "\t") && this.#lastSplitRosterWidth === undefined) {
			if (this.#rows.length > 0) this.#narrowDetailsOpen = !this.#narrowDetailsOpen;
			this.#requestRender();
			return;
		}
		if (
			(matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") &&
			this.#lastSplitRosterWidth === undefined
		) {
			if (this.#rows.length > 0) this.#narrowDetailsOpen = true;
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "pageUp")) {
			this.#scrollDetails(-1);
			return;
		}
		if (matchesKey(keyData, "pageDown")) {
			this.#scrollDetails(1);
			return;
		}
		this.#hoveredRow = null;
		if (matchesKey(keyData, "j") || matchesSelectDown(keyData)) {
			this.#selectRow(Math.min(this.#selectedRow + 1, Math.max(0, this.#rows.length - 1)));
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "k") || matchesSelectUp(keyData)) {
			this.#selectRow(Math.max(0, this.#selectedRow - 1));
			this.#requestRender();
		}
	}

	handleWheel(delta: -1 | 1): void {
		this.#hoveredRow = null;
		this.#selectRow(Math.max(0, Math.min(this.#selectedRow + delta, this.#rows.length - 1)));
		this.#requestRender();
	}

	hitTest(line: number): number | undefined {
		return this.#hitRows[line];
	}

	setHoverIndex(index: number | null): void {
		if (this.#hoveredRow === index) return;
		this.#hoveredRow = index;
		this.#requestRender();
	}

	clickItem(index: number): void {
		if (!this.#rows[index]) return;
		this.#hoveredRow = index;
		this.#selectRow(index);
		this.#requestRender();
	}

	#refreshRows(): void {
		const selectedId = this.#rows[this.#selectedRow]?.id ?? this.#selectedJobId;
		const snapshot = this.#getSnapshot();
		const running = [...(snapshot?.running ?? [])].sort((left, right) => left.startTime - right.startTime);
		const recent = [...(snapshot?.recent ?? [])].sort((left, right) => right.startTime - left.startTime);
		this.#rows = [...running, ...recent];
		const retainedIndex = selectedId ? this.#rows.findIndex(job => job.id === selectedId) : -1;
		this.#selectedRow =
			retainedIndex >= 0 ? retainedIndex : Math.min(this.#selectedRow, Math.max(0, this.#rows.length - 1));
		const nextSelectedId = this.#rows[this.#selectedRow]?.id;
		if (nextSelectedId !== this.#selectedJobId) {
			this.#selectedJobId = nextSelectedId;
			this.#detailScrollOffset = 0;
		}
	}

	#splitRosterWidth(width: number): number | undefined {
		if (width < SPLIT_MIN_WIDTH) return undefined;
		const rosterWidth = Math.max(ROSTER_MIN_WIDTH, Math.min(Math.floor(width * 0.48), width - DETAIL_MIN_WIDTH - 7));
		return splitBodyWidth(width, rosterWidth) >= DETAIL_MIN_WIDTH ? rosterWidth : undefined;
	}

	#renderRosterPanel(width: number, rows: number): { lines: string[]; hitRows: Array<number | undefined> } {
		const lines: string[] = [];
		const hitRows: Array<number | undefined> = [];
		const runningCount = this.#rows.filter(isActive).length;
		const completedCount = this.#rows.length - runningCount;
		lines.push(
			`${theme.bold(t("Jobs"))}${theme.fg("dim", ` · ${runningCount} ${t("running")} · ${completedCount} ${t("finished")}`)}`,
		);
		hitRows.push(undefined);
		if (rows > 3) {
			lines.push("");
			hitRows.push(undefined);
		}
		if (this.#rows.length === 0) {
			lines.push(theme.fg("dim", t("No background jobs in this session.")));
			hitRows.push(undefined);
		} else {
			const availableRows = Math.max(0, rows - lines.length);
			const visibleJobs = Math.max(1, Math.floor(availableRows / 2));
			const maxStart = Math.max(0, this.#rows.length - visibleJobs);
			const start = Math.max(0, Math.min(this.#selectedRow - Math.floor(visibleJobs / 2), maxStart));
			const end = Math.min(this.#rows.length, start + visibleJobs);
			const now = Date.now();
			for (let index = start; index < end; index++) {
				const job = this.#rows[index]!;
				const selected = index === this.#selectedRow;
				const owner = sanitizeDisplayText(job.ownerId ?? t("unknown agent"));
				const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ";
				const first = `${cursor} ${statusGlyph(job)} ${theme.bold(`[${job.type}]`)} ${sanitizeDisplayText(job.id)} ${theme.fg("dim", jobDuration(job, now))}`;
				const second = `    ${theme.fg("muted", owner)}${theme.fg("dim", " · ")}${theme.fg("dim", sanitizeDisplayText(job.label))}`;
				for (const value of [first, second]) {
					const line = truncateToWidth(value, width);
					const highlighted = selected || index === this.#hoveredRow;
					const lineWidth = visibleWidth(line);
					lines.push(highlighted ? theme.bg("selectedBg", line + padding(Math.max(0, width - lineWidth))) : line);
					hitRows.push(index);
				}
			}
		}
		while (lines.length < rows) {
			lines.push("");
			hitRows.push(undefined);
		}
		return { lines: lines.slice(0, rows), hitRows: hitRows.slice(0, rows) };
	}

	#renderDetailPanel(job: AsyncJobSnapshotItem | undefined, width: number, rows: number): string[] {
		if (!job)
			return [
				theme.fg("dim", t("Select a background job to inspect")),
				...Array.from({ length: rows - 1 }, () => ""),
			];
		const lines: string[] = [];
		const add = (value = ""): void => {
			lines.push(truncateToWidth(value, width));
		};
		const addWrapped = (value: string): void => {
			const sanitized = cleanText(value);
			for (const sourceLine of sanitized.split("\n")) {
				if (!sourceLine) {
					add();
					continue;
				}
				for (const wrapped of wrapTextWithAnsi(sourceLine, Math.max(1, width))) add(wrapped);
			}
		};
		const section = (title: string): void => {
			if (lines.length > 0) add();
			add(theme.bold(theme.fg("accent", title)));
		};
		const now = Date.now();
		add(`${statusGlyph(job)} ${theme.bold(sanitizeDisplayText(job.id))}`);
		add(`${statusText(job, statusLabel(job))}${theme.fg("dim", ` · ${job.type} · ${jobDuration(job, now)}`)}`);
		add(`${theme.fg("dim", t("Agent:"))} ${sanitizeDisplayText(job.ownerId ?? t("unknown agent"))}`);
		if (job.agentId && job.agentId !== job.ownerId) {
			add(`${theme.fg("dim", t("Worker:"))} ${sanitizeDisplayText(job.agentId)}`);
		}
		add(`${theme.fg("dim", t("Started:"))} ${formatLocalDateTimeWithOffset(new Date(job.startTime))}`);
		if (job.settledAt !== undefined) {
			add(`${theme.fg("dim", t("Finished:"))} ${formatLocalDateTimeWithOffset(new Date(job.settledAt))}`);
		}
		if (job.deadlineAt !== undefined && isActive(job)) {
			add(`${theme.fg("dim", t("Deadline:"))} ${formatLocalDateTimeWithOffset(new Date(job.deadlineAt))}`);
		}
		if (job.toolCallId) add(`${theme.fg("dim", t("Tool call:"))} ${sanitizeDisplayText(job.toolCallId)}`);

		section(job.type === "eval" ? t("Code") : job.type === "task" ? t("Task") : t("Command"));
		addWrapped(job.input ?? job.label);

		const transfer = job.progress?.details;
		if (isSshTransferToolDetails(transfer)) {
			section(t("Transfer"));
			addWrapped(formatSshTransferSummary(transfer, { width: Math.max(1, width) }));
		}

		const output = isActive(job) ? job.progress?.text : (job.errorText ?? job.resultText ?? job.progress?.text);
		if (output && !(isSshTransferToolDetails(transfer) && output === job.progress?.text)) {
			section(job.status === "failed" ? t("Error") : t("Output"));
			addWrapped(output);
		} else if (!output && !isSshTransferToolDetails(transfer)) {
			section(t("Output"));
			add(theme.fg("dim", isActive(job) ? t("Waiting for output…") : t("No output recorded.")));
		}

		const maxOffset = Math.max(0, lines.length - rows);
		this.#detailScrollOffset = Math.min(this.#detailScrollOffset, maxOffset);
		const visible = lines.slice(this.#detailScrollOffset, this.#detailScrollOffset + rows);
		while (visible.length < rows) visible.push("");
		return visible;
	}

	#selectRow(index: number): void {
		if (index !== this.#selectedRow) this.#detailScrollOffset = 0;
		this.#selectedRow = index;
		this.#selectedJobId = this.#rows[index]?.id;
	}

	#scrollDetails(direction: -1 | 1): void {
		this.#detailScrollOffset = Math.max(0, this.#detailScrollOffset + direction * DETAIL_SCROLL_ROWS);
		this.#requestRender();
	}
}
