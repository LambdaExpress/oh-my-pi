import type { ToolRenderer } from "./renderer";
import { type Component, padding, Text, visibleWidth } from "../index";
import { t } from "../i18n";
import type { RenderResultOptions } from "./renderer";
import type { Theme, ThemeColor } from "../theme/theme";
import { outputBlockContentWidth, renderStatusLine } from "../render";
import { framedToolCard } from "../render/tool-card";

import { formatShortSha, pushLine } from "./gh-format";
import {
	formatExpandHint,
	formatMoreItems,
	formatStatusIcon,
	PREVIEW_LIMITS,
	replaceTabs,
	type ToolUIColor,
	type ToolUIStatus,
	TRUNCATE_LENGTHS,
	truncateToWidth as truncateVisualWidth,
} from "../render/render-utils";

type GithubToolRenderArgs = {
	op?: string;
	run?: string;
	branch?: string;
	repo?: string;
	pr?: string | string[];
	query?: string;
};

const SUCCESS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
const RUNNING_STATUSES = new Set(["in_progress"]);
const PENDING_STATUSES = new Set(["queued", "requested", "waiting", "pending"]);
const FALLBACK_WIDTH = 80;

const OP_TITLES: Record<string, string> = {
	repo_view: "GitHub Repo",
	pr_checkout: "GitHub PR Checkout",
	pr_push: "GitHub PR Push",
	search_issues: "GitHub Search Issues",
	search_prs: "GitHub Search PRs",
	search_code: "GitHub Search Code",
	search_commits: "GitHub Search Commits",
	search_repos: "GitHub Search Repos",
	run_watch: "GitHub Run Watch",
};

function formatOpTitle(op: string | undefined): string {
	const title = op ? OP_TITLES[op] : undefined;
	if (title) return t(title);
	return "GitHub";
}

function extractIssueId(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (/^\d+$/.test(trimmed)) return `#${trimmed}`;
	const match = trimmed.match(/\/(?:issues|pull)\/(\d+)/);
	if (match) return `#${match[1]}`;
	return truncateVisualWidth(trimmed, TRUNCATE_LENGTHS.SHORT);
}

function formatPrIdentifier(pr: string | string[] | undefined): string | undefined {
	if (pr === undefined) return undefined;
	if (Array.isArray(pr)) {
		const parts = pr.map(p => extractIssueId(p)).filter((p): p is string => p !== undefined);
		if (parts.length === 0) return undefined;
		if (parts.length > 3) {
			return `${parts.slice(0, 3).join(", ")}, ${t("+{count} more", { count: parts.length - 3 })}`;
		}
		return parts.join(", ");
	}
	return extractIssueId(pr);
}

function buildOpMeta(args: GithubToolRenderArgs): string[] {
	const meta: string[] = [];
	const op = args.op;
	switch (op) {
		case "pr_checkout":
		case "pr_push": {
			const id = formatPrIdentifier(args.pr);
			if (id) meta.push(id);
			else if (args.branch) meta.push(args.branch);
			if (args.repo) meta.push(args.repo);
			break;
		}
		case "search_issues":
		case "search_prs":
		case "search_code":
		case "search_commits": {
			if (args.query) meta.push(truncateVisualWidth(args.query, TRUNCATE_LENGTHS.CONTENT));
			if (args.repo) meta.push(args.repo);
			break;
		}
		case "search_repos": {
			if (args.query) meta.push(truncateVisualWidth(args.query, TRUNCATE_LENGTHS.CONTENT));
			break;
		}
		case "repo_view": {
			if (args.repo) meta.push(args.repo);
			if (args.branch) meta.push(args.branch);
			break;
		}
		case "run_watch":
			break;
		default: {
			if (args.repo) meta.push(args.repo);
			break;
		}
	}
	return meta;
}

function getWatchHeader(watch: GhRunWatchViewDetails): string {
	if (watch.mode === "run" && watch.run) {
		if (watch.state === "watching") {
			return t("watching run #{id} on {repo}", { id: watch.run.id, repo: watch.repo });
		}

		return t("run #{id} on {repo}", { id: watch.run.id, repo: watch.repo });
	}

	const shortSha = formatShortSha(watch.headSha) ?? t("this commit");
	if (watch.state === "watching") {
		return t("watching {sha} on {repo}", { sha: shortSha, repo: watch.repo });
	}

	return t("workflow runs for {sha} on {repo}", { sha: shortSha, repo: watch.repo });
}

function getRunLabel(run: GhRunWatchRunDetails): string {
	return replaceTabs(run.workflowName ?? run.displayTitle ?? "GitHub Actions");
}

function getRunMeta(run: GhRunWatchRunDetails): string[] {
	const parts: string[] = [];
	if (run.branch) {
		parts.push(replaceTabs(run.branch));
	} else if (run.headSha) {
		parts.push(formatShortSha(run.headSha) ?? run.headSha);
	}
	parts.push(`#${run.id}`);
	return parts;
}

function formatRunLine(run: GhRunWatchRunDetails, theme: Theme): string {
	const title = theme.fg("accent", getRunLabel(run));
	const metaParts = getRunMeta(run);
	const meta = metaParts.map((part, index) =>
		index === metaParts.length - 1 ? theme.fg("muted", part) : theme.fg("text", part),
	);
	return [title, ...meta].join("  ");
}

function getJobStateVisual(
	job: GhRunWatchJobDetails,
	theme: Theme,
): { iconRaw: string; iconColor: ToolUIColor; textColor: ThemeColor } {
	if (job.conclusion && SUCCESS_CONCLUSIONS.has(job.conclusion)) {
		return {
			iconRaw: theme.status.success,
			iconColor: "accent",
			textColor: "success",
		};
	}

	if (job.conclusion && FAILURE_CONCLUSIONS.has(job.conclusion)) {
		return {
			iconRaw: theme.status.error,
			iconColor: "error",
			textColor: "error",
		};
	}

	if (job.status && RUNNING_STATUSES.has(job.status)) {
		return {
			iconRaw: theme.status.enabled,
			iconColor: "warning",
			textColor: "warning",
		};
	}

	if (job.status && PENDING_STATUSES.has(job.status)) {
		return {
			iconRaw: theme.status.shadowed,
			iconColor: "muted",
			textColor: "muted",
		};
	}

	return {
		iconRaw: theme.status.shadowed,
		iconColor: "muted",
		textColor: "muted",
	};
}

function liveDurationSeconds(
	durationSeconds: number | undefined,
	status: string | undefined,
	observedAtMs: number | undefined,
	renderedAtMs: number,
): number | undefined {
	if (durationSeconds === undefined || status !== "in_progress" || observedAtMs === undefined) return durationSeconds;
	return durationSeconds + Math.max(0, Math.floor((renderedAtMs - observedAtMs) / 1000));
}

function renderJobLine(
	job: GhRunWatchJobDetails,
	width: number,
	theme: Theme,
	observedAtMs: number | undefined,
	renderedAtMs: number,
): string {
	const visual = getJobStateVisual(job, theme);
	const prefix = theme.fg(visual.iconColor, `${visual.iconRaw} `);
	const completedSteps = job.steps.filter(step => step.status === "completed").length;
	const metaParts: string[] = [];
	if (job.steps.length > 0) {
		metaParts.push(t("{done}/{total} steps", { done: completedSteps, total: job.steps.length }));
	}
	const durationSeconds = liveDurationSeconds(job.durationSeconds, job.status, observedAtMs, renderedAtMs);
	if (durationSeconds !== undefined) metaParts.push(t("{seconds}s", { seconds: durationSeconds }));
	const styledMeta = metaParts.length > 0 ? theme.fg(visual.textColor, metaParts.join(theme.sep.dot)) : undefined;
	const reservedWidth = visibleWidth(prefix) + (styledMeta ? 1 + visibleWidth(styledMeta) : 0);
	const nameWidth = Math.max(8, width - reservedWidth);
	const jobName = theme.fg(visual.textColor, truncateVisualWidth(replaceTabs(job.name), nameWidth));
	let line = `${prefix}${jobName}`;
	if (styledMeta) {
		line += padding(Math.max(1, width - visibleWidth(line) - visibleWidth(styledMeta)));
		line += styledMeta;
	}
	return line;
}

function renderCurrentStepLine(
	job: GhRunWatchJobDetails,
	width: number,
	theme: Theme,
	observedAtMs: number | undefined,
	renderedAtMs: number,
): string | undefined {
	const currentStepIndex = job.steps.findIndex(step => step.status === "in_progress");
	const currentStep = job.steps[currentStepIndex];
	if (!currentStep) return undefined;
	const durationSeconds = liveDurationSeconds(
		currentStep.durationSeconds,
		currentStep.status,
		observedAtMs,
		renderedAtMs,
	);
	const duration =
		durationSeconds !== undefined ? ` ${theme.sep.dot} ${t("{seconds}s", { seconds: durationSeconds })}` : "";
	const prefix = `  ${theme.status.enabled} ${t("step {index}/{total}", {
		index: currentStepIndex + 1,
		total: job.steps.length,
	})} `;
	const availableWidth = Math.max(8, width - visibleWidth(prefix) - visibleWidth(duration));
	return theme.fg(
		"warning",
		`${prefix}${truncateVisualWidth(replaceTabs(currentStep.name), availableWidth)}${duration}`,
	);
}

function renderRunProgressLine(run: GhRunWatchRunDetails, theme: Theme): string {
	let completed = 0;
	let running = 0;
	for (const job of run.jobs) {
		if (job.status === "completed") completed += 1;
		if (job.status === "in_progress") running += 1;
	}
	const queued = Math.max(0, run.jobs.length - completed - running);
	const parts = [t("{done}/{total} jobs complete", { done: completed, total: run.jobs.length })];
	if (running > 0) parts.push(t("{count} running", { count: running }));
	if (queued > 0) parts.push(t("{count} queued", { count: queued }));
	return theme.fg("dim", parts.join(theme.sep.dot));
}

function renderRunBlock(
	run: GhRunWatchRunDetails,
	width: number,
	theme: Theme,
	observedAtMs: number | undefined,
	renderedAtMs: number,
): string[] {
	const lines = [formatRunLine(run, theme)];
	if (run.jobs.length === 0) {
		lines.push(theme.fg("dim", t("waiting for workflow jobs...")));
		return lines;
	}

	lines.push(renderRunProgressLine(run, theme));
	for (const job of run.jobs) {
		lines.push(renderJobLine(job, width, theme, observedAtMs, renderedAtMs));
		const stepLine = renderCurrentStepLine(job, width, theme, observedAtMs, renderedAtMs);
		if (stepLine) lines.push(stepLine);
	}
	return lines;
}

function renderJobLogPreview(
	job: GhRunWatchJobDetails,
	run: GhRunWatchRunDetails,
	width: number,
	theme: Theme,
	expanded: boolean,
): string[] {
	const context = `${getRunLabel(run)}  #${run.id}`;
	const visual = getJobStateVisual(job, theme);
	const lines = [
		theme.fg(
			visual.textColor,
			`${theme.fg(visual.iconColor, visual.iconRaw)} ${replaceTabs(job.name)}  ${theme.fg("muted", context)}`,
		),
	];
	if (!job.logTail) {
		lines.push(theme.fg("dim", `  ${t("live log unavailable; GitHub publishes it after the job completes")}`));
		return lines;
	}

	const logLines = replaceTabs(job.logTail)
		.split("\n")
		.filter(line => line.length > 0);
	const previewLimit = expanded ? logLines.length : Math.min(PREVIEW_LIMITS.OUTPUT_COLLAPSED, logLines.length);
	for (const line of logLines.slice(-previewLimit)) {
		lines.push(theme.fg("dim", `  ${truncateVisualWidth(line, Math.max(8, width - 2))}`));
	}
	if (!expanded && logLines.length > previewLimit) {
		const remaining = logLines.length - previewLimit;
		const more = t("… {count} more log lines", { count: remaining });
		lines.push(theme.fg("dim", `  ${more} ${formatExpandHint(theme, false, true)}`));
	}
	return lines;
}

function renderRecentLogs(runs: GhRunWatchRunDetails[], width: number, theme: Theme, expanded: boolean): string[] {
	const lines: string[] = [];
	for (const run of runs) {
		const selected: GhRunWatchJobDetails[] = [];
		let activeLogAvailable = false;
		for (const job of run.jobs) {
			if (job.status !== "in_progress") continue;
			selected.push(job);
			if (job.logTail) activeLogAvailable = true;
		}

		if (expanded) {
			for (const job of run.jobs) {
				if (job.status !== "in_progress" && job.logTail) selected.push(job);
			}
		} else if (!activeLogAvailable) {
			for (let index = run.jobs.length - 1; index >= 0; index -= 1) {
				const job = run.jobs[index];
				if (!job || job.status === "in_progress" || !job.logTail) continue;
				selected.push(job);
				break;
			}
		}

		for (const job of selected) {
			if (lines.length > 0) lines.push("");
			lines.push(...renderJobLogPreview(job, run, width, theme, expanded));
		}
	}
	return lines;
}

function renderFailedLogs(
	failedLogs: GhRunWatchFailedLogDetails[],
	width: number,
	theme: Theme,
	expanded: boolean,
): string[] {
	if (failedLogs.length === 0) {
		return [];
	}

	const lines: string[] = [];
	for (const entry of failedLogs) {
		const context = entry.workflowName
			? `${entry.workflowName}  #${entry.runId}`
			: t("run #{id}", { id: entry.runId });
		lines.push(
			theme.fg("error", `${theme.status.error} ${replaceTabs(entry.jobName)}  ${theme.fg("muted", context)}`),
		);

		if (!entry.available || !entry.tail) {
			lines.push(theme.fg("dim", `  ${t("log tail unavailable")}`));
			continue;
		}

		const tailLines = replaceTabs(entry.tail)
			.split("\n")
			.filter(line => line.length > 0);
		const previewLimit = expanded ? tailLines.length : Math.min(PREVIEW_LIMITS.OUTPUT_COLLAPSED, tailLines.length);
		for (const line of tailLines.slice(-previewLimit)) {
			lines.push(theme.fg("dim", `  ${truncateVisualWidth(line, Math.max(8, width - 2))}`));
		}

		if (!expanded && tailLines.length > previewLimit) {
			const remaining = tailLines.length - previewLimit;
			const more = t("… {count} more log lines", { count: remaining });
			lines.push(theme.fg("dim", `  ${more} ${formatExpandHint(theme, false, true)}`));
		}
	}

	return lines;
}

function buildWatchSections(
	watch: GhRunWatchViewDetails,
	theme: Theme,
	options: RenderResultOptions,
	width: number,
): Array<{ label?: string; content: string[] }> {
	const main: string[] = [];
	const renderedAtMs = Date.now();

	if (watch.note) {
		main.push(theme.fg("dim", replaceTabs(watch.note)));
	}

	if (watch.mode === "run" && watch.run) {
		main.push(...renderRunBlock(watch.run, width, theme, watch.observedAtMs, renderedAtMs));
	} else if (watch.mode === "commit") {
		const runs = watch.runs ?? [];
		if (runs.length === 0) {
			main.push(theme.fg("dim", t("waiting for workflow runs...")));
		} else {
			runs.forEach((run, index) => {
				if (index > 0) {
					main.push("");
				}
				main.push(...renderRunBlock(run, width, theme, watch.observedAtMs, renderedAtMs));
			});
		}
	}

	const sections: Array<{ label?: string; content: string[] }> = [];
	if (main.length > 0) {
		sections.push({ content: main });
	}

	const runs = watch.mode === "run" && watch.run ? [watch.run] : (watch.runs ?? []);
	const recentLogs = renderRecentLogs(runs, width, theme, options.expanded);
	if (recentLogs.length > 0) {
		sections.push({ label: t("recent logs"), content: recentLogs });
	}

	const failed = renderFailedLogs(watch.failedLogs ?? [], width, theme, options.expanded);
	if (failed.length > 0) {
		sections.push({ label: t("failed logs"), content: failed });
	}

	return sections;
}

function extractText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.join("\n");
}

function renderFallbackComponent(
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	options: RenderResultOptions,
	theme: Theme,
	args: GithubToolRenderArgs,
): Component {
	const text = extractText(result.content);
	const title = formatOpTitle(args.op);
	const meta = buildOpMeta(args);
	const isError = result.isError === true;
	const success = !isError && Boolean(text);
	const header = renderStatusLine(
		success
			? {
					iconOverride: theme.styledSymbol("tool.gh", "accent"),
					title,
					titleColor: "accent",
					meta,
				}
			: {
					icon: isError ? "error" : "warning",
					title,
					titleColor: isError ? "error" : "accent",
					meta,
				},
		theme,
	);

	if (!text) {
		const empty = isError ? t("request failed") : t("no output");
		return new Text(`${header}\n${theme.fg("dim", empty)}`, 0, 0);
	}

	const allLines = replaceTabs(text).split("\n");
	while (allLines.length > 0 && allLines[0].trim() === "") allLines.shift();
	while (allLines.length > 0 && allLines[allLines.length - 1].trim() === "") allLines.pop();

	// Trivial one-line *success* result: a clean status line beats an almost-empty box.
	// Errors always frame so the message reads as a structured block, never a raw red wrap.
	if (allLines.length <= 1 && !isError) {
		const body = allLines[0];
		if (!body) return new Text(header, 0, 0);
		const colored = isError ? theme.fg("error", body) : theme.fg("toolOutput", body);
		return new Text(`${header}\n${colored}`, 0, 0);
	}

	return framedToolCard(theme, ({ width }) => {
		const lineWidth = outputBlockContentWidth(width || FALLBACK_WIDTH);
		const expanded = options.expanded;
		const limit = expanded ? allLines.length : Math.min(allLines.length, PREVIEW_LIMITS.OUTPUT_EXPANDED);
		const visible = allLines.slice(0, limit);
		const remaining = allLines.length - visible.length;

		const out: string[] = [];
		for (const line of visible) {
			const colored = isError ? theme.fg("error", line) : theme.fg("toolOutput", line);
			out.push(truncateVisualWidth(colored, lineWidth));
		}
		if (!expanded && remaining > 0) {
			const hint = formatExpandHint(theme, expanded, true);
			const more = `${formatMoreItems(remaining, "line")}${hint ? ` ${hint}` : ""}`;
			out.push(theme.fg("dim", more));
		}
		return {
			header,
			sections: out.length > 0 ? [{ content: out }] : [],
			phase: isError ? "error" : "success",
			borderColor: isError ? "error" : "borderMuted",
			applyBg: false,
		};
	});
}

function renderWatchCall(args: GithubToolRenderArgs, options: RenderResultOptions, theme: Theme): Component {
	const icon =
		options.spinnerFrame !== undefined
			? formatStatusIcon("running", theme, options.spinnerFrame)
			: formatStatusIcon("pending", theme);

	const runId = typeof args.run === "string" && args.run.trim().length > 0 ? args.run.trim() : undefined;
	const branch = typeof args.branch === "string" && args.branch.trim().length > 0 ? args.branch.trim() : undefined;

	const titleText = theme.fg("accent", t("GitHub Run Watch"));
	let metaText: string;
	if (runId) {
		metaText = theme.fg("muted", `#${runId}`);
	} else if (branch) {
		metaText = theme.fg("text", branch);
	} else {
		metaText = theme.fg("muted", t("current HEAD"));
	}

	const header = `${icon} ${titleText}  ${metaText}`;
	const wait = theme.fg("dim", t("waiting for workflow data..."));
	return new Text(`${header}\n${wait}`, 0, 0);
}

/** Render GitHub operations and live workflow status. */
export const githubToolRenderer = {
	// No animatedPendingPreview: renderCall materializes plain Text components
	// once per display rebuild (no render closure), so a live spinner interval
	// would request 30fps repaints while the visible glyph stays frozen.
	animatedPartialResult: (args: unknown): boolean => (args as GithubToolRenderArgs | undefined)?.op === "run_watch",
	renderCall(args: GithubToolRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const op = typeof args.op === "string" && args.op.trim().length > 0 ? args.op.trim() : undefined;
		if (op === "run_watch") {
			return renderWatchCall({ ...args, op }, options, uiTheme);
		}

		const status: ToolUIStatus = options.spinnerFrame !== undefined ? "running" : "pending";
		const header = renderStatusLine(
			{
				icon: status,
				spinnerFrame: options.spinnerFrame,
				title: formatOpTitle(op),
				meta: buildOpMeta({ ...args, op }),
			},
			uiTheme,
		);
		return new Text(header, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GhToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: GithubToolRenderArgs,
	): Component {
		const watch = result.details?.watch;
		if (watch) {
			const isError = result.isError === true;
			const isPartial = options.isPartial === true;
			const header = renderStatusLine(
				isPartial
					? {
							icon: options.spinnerFrame !== undefined ? "running" : "pending",
							spinnerFrame: options.spinnerFrame,
							title: t("GitHub Run Watch"),
							meta: [getWatchHeader(watch)],
						}
					: isError
						? {
								icon: "error",
								title: t("GitHub Run Watch"),
								titleColor: "error",
								meta: [getWatchHeader(watch)],
							}
						: {
								iconOverride: uiTheme.styledSymbol("tool.gh", "accent"),
								title: t("GitHub Run Watch"),
								titleColor: "accent",
								meta: [getWatchHeader(watch)],
							},
				uiTheme,
			);
			return framedToolCard(uiTheme, ({ width }) => {
				const innerWidth = outputBlockContentWidth(width || FALLBACK_WIDTH);
				const sections = buildWatchSections(watch, uiTheme, options, innerWidth);
				return {
					header,
					sections,
					phase: isPartial ? "partial" : isError ? "error" : "success",
					borderColor: isError ? "error" : "borderMuted",
					applyBg: false,
				};
			});
		}

		return renderFallbackComponent(result, options, uiTheme, args ?? {});
	},

	mergeCallAndResult: true,
} satisfies ToolRenderer<GithubToolRenderArgs, GhToolDetails>;

import type { OutputMeta } from "./output-meta";
import type { IsoBackendKind } from "@oh-my-pi/pi-natives";
/** Display metadata for GitHub operations. */
export interface GhToolDetails {
	meta?: OutputMeta;
	artifactId?: string;
	repo?: string;
	branch?: string;
	worktreePath?: string;
	remote?: string;
	remoteBranch?: string;
	headSha?: string;
	runId?: number;
	runIds?: number[];
	status?: string;
	conclusion?: string;
	failedJobs?: string[];
	watch?: GhRunWatchViewDetails;
	checkouts?: GhPrCheckoutSummary[];
}

/** Checkout location and branch metadata for a pull request. */
export interface GhPrCheckoutSummary {
	prNumber?: number;
	url?: string;
	branch: string;
	worktreePath: string;
	remote: string;
	remoteBranch: string;
	reused: boolean;
	clonedWith?: IsoBackendKind;
}

/** Display state of one step in a watched workflow job. */
export interface GhRunWatchStepDetails {
	number: number;
	name: string;
	status?: string;
	conclusion?: string;
	durationSeconds?: number;
}

/** Display state of a watched workflow job. */
export interface GhRunWatchJobDetails {
	id: number;
	name: string;
	status?: string;
	conclusion?: string;
	durationSeconds?: number;
	url?: string;
	steps: GhRunWatchStepDetails[];
	logTail?: string;
	logAvailable?: boolean;
}

/** Display state of a watched workflow run. */
export interface GhRunWatchRunDetails {
	id: number;
	workflowName?: string;
	displayTitle?: string;
	status?: string;
	conclusion?: string;
	branch?: string;
	headSha?: string;
	url?: string;
	jobs: GhRunWatchJobDetails[];
}

/** Captured log preview for a failed job. */
export interface GhRunWatchFailedLogDetails {
	runId: number;
	workflowName?: string;
	jobName: string;
	conclusion?: string;
	tail?: string;
	available: boolean;
}

/** Live workflow watcher display snapshot. */
export interface GhRunWatchViewDetails {
	mode: "run" | "commit";
	state: "watching" | "completed";
	/**
	 * Wall-clock instant the snapshot was observed. Local field: live job/step
	 * durations are projected forward from it, so a snapshot whose jobs are
	 * still `in_progress` keeps counting up between polls.
	 */
	observedAtMs?: number;
	repo: string;
	branch?: string;
	headSha?: string;
	pollCount?: number;
	note?: string;
	run?: GhRunWatchRunDetails;
	runs?: GhRunWatchRunDetails[];
	failedLogs?: GhRunWatchFailedLogDetails[];
}

/** Normalized status and timestamps of one workflow job step. */
export interface GhRunJobStepSnapshot {
	number: number;
	name: string;
	status?: string;
	conclusion?: string;
	startedAt?: string;
	completedAt?: string;
}

/** Normalized status and timestamps of a workflow job. */
export interface GhRunJobSnapshot {
	id: number;
	name: string;
	status?: string;
	conclusion?: string;
	startedAt?: string;
	completedAt?: string;
	url?: string;
	steps: GhRunJobStepSnapshot[];
	logTail?: string;
	logAvailable?: boolean;
}

/** Normalized workflow run and job snapshot. */
export interface GhRunSnapshot {
	id: number;
	workflowName?: string;
	displayTitle?: string;
	status?: string;
	conclusion?: string;
	branch?: string;
	headSha?: string;
	createdAt?: string;
	updatedAt?: string;
	url?: string;
	jobs: GhRunJobSnapshot[];
}

/** Captured failure logs associated with a run and job. */
export interface GhFailedJobLog {
	run: GhRunSnapshot;
	job: GhRunJobSnapshot;
	full?: string;
	tail?: string;
	available: boolean;
}

/** Choose the terminal conclusion or current job state. */
export function formatJobState(job: GhRunJobSnapshot): string {
	return job.conclusion ?? job.status ?? "unknown";
}

/** Format workflow jobs as a Markdown section. */
export function renderJobsSection(jobs: GhRunJobSnapshot[]): string[] {
	if (jobs.length === 0) {
		return ["## Jobs", "", "No jobs reported yet."];
	}

	const lines: string[] = [`## Jobs (${jobs.length})`, ""];
	for (const job of jobs) {
		lines.push(`- [${formatJobState(job)}] ${job.name}`);
		if (job.startedAt) {
			pushLine(lines, "  Started", job.startedAt);
		}
		if (job.completedAt) {
			pushLine(lines, "  Completed", job.completedAt);
		}
		if (job.url) {
			pushLine(lines, "  URL", job.url);
		}
	}

	return lines;
}

/** Format failed workflow logs as Markdown sections. */
export function renderFailedJobLogs(
	failedJobLogs: GhFailedJobLog[],
	options: { mode: "tail"; tail: number } | { mode: "full" },
): string[] {
	if (failedJobLogs.length === 0) {
		return [];
	}

	const lines: string[] = ["## Failed Jobs", ""];
	for (const entry of failedJobLogs) {
		lines.push(`### ${entry.job.name} [${entry.job.conclusion ?? "failed"}]`);
		pushLine(lines, "Run", `#${entry.run.id}`);
		pushLine(lines, "Workflow", entry.run.workflowName ?? undefined);
		if (entry.job.startedAt) {
			pushLine(lines, "Started", entry.job.startedAt);
		}
		if (entry.job.completedAt) {
			pushLine(lines, "Completed", entry.job.completedAt);
		}
		if (entry.job.url) {
			pushLine(lines, "URL", entry.job.url);
		}
		lines.push("");
		const logText = options.mode === "full" ? entry.full : entry.tail;
		if (entry.available && logText) {
			lines.push(options.mode === "full" ? "Full log:" : `Last ${options.tail} log lines:`);
			lines.push("```text");
			lines.push(logText);
			lines.push("```");
		} else {
			lines.push(options.mode === "full" ? "Full log unavailable." : "Log tail unavailable.");
		}
		lines.push("");
	}

	return lines;
}

/** Format a workflow run and its jobs as Markdown. */
export function renderRunSection(run: GhRunSnapshot): string[] {
	const label = run.workflowName ? `### Run #${run.id} - ${run.workflowName}` : `### Run #${run.id}`;
	const lines: string[] = [label, ""];
	pushLine(lines, "Title", run.displayTitle ?? undefined);
	pushLine(lines, "Branch", run.branch ?? undefined);
	pushLine(lines, "Commit", formatShortSha(run.headSha));
	pushLine(lines, "Status", run.status);
	pushLine(lines, "Conclusion", run.conclusion ?? undefined);
	pushLine(lines, "Created", run.createdAt);
	pushLine(lines, "Updated", run.updatedAt);
	pushLine(lines, "URL", run.url);
	lines.push("");
	lines.push(...renderJobsSection(run.jobs));
	return lines;
}
