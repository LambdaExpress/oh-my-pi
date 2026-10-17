import { formatKeyHint, formatKeyHints } from "../app-keybindings";
import { matchesKey } from "../keys";
import { replaceTabs, truncateToWidth, visibleWidth } from "../utils";
import { ScrollView } from "../components/scroll-view";
import { renderTableRow, type TableCell, type TableColumn } from "../components/table";
import { Text } from "../components/text";
import { t } from "../i18n";
import type { Component } from "../tui";
import type { Theme } from "../theme/theme";
import {
	currentResults,
	findBaselineMetric,
	findBaselineResult,
	findBaselineRunNumber,
	findBaselineSecondary,
	formatElapsed,
	isBetter,
} from "./autoresearch-data";
import { fmtNum, formatNum, type ExperimentResult, type ExperimentState } from "../tools/autoresearch";
import type { TspScrollBy, TspSpan, TspTableColumn, TspText } from "@oh-my-pi/pi-wire";
import { card, col, elapsed, keyed, node, row, span, text } from "../native/describe";
import type { DescribeContext, NativeNode, NativeScroll, NativeUiEvent } from "../native/node";
import { actionBar, actionButton, hintsRow } from "../native/overlay";
import { Memo } from "../native/memo";
import { isNativeRendering } from "../native/state";

/** The widget's ANSI `Text`, describing itself from the runtime instead of its pre-rendered lines. */
class DashboardWidget extends Text {
	readonly #build: (cx: DescribeContext) => NativeNode;
	#node: NativeNode | undefined;

	constructor(content: string, build: (cx: DescribeContext) => NativeNode) {
		super(content, 0, 0);
		this.#build = build;
	}

	override describe(cx: DescribeContext): NativeNode {
		this.#node ??= this.#build(cx);
		return this.#node;
	}
}

/** Experiment runtime fields rendered by the dashboard. */
export interface AutoresearchDashboardRuntime {
	autoresearchMode: boolean;
	dashboardExpanded: boolean;
	state: ExperimentState;
	lastRunSummary: { runNumber: number; passed: boolean; parsedPrimary: number | null } | null;
	runningExperiment: { startedAt: number; command: string } | null;
}

/** Widget and overlay capabilities supplied by an extension context. */
export interface AutoresearchDashboardHost {
	hasUI: boolean;
	ui: {
		setWidget(key: string, content: ((tui: { requestRender(): void }, theme: Theme) => Component) | undefined): void;
		custom<T>(
			factory: (
				tui: { requestRender(): void },
				theme: Theme,
				keybindings: unknown,
				done: (result: T) => void,
			) => Component,
			options?: { overlay: boolean },
		): Promise<T>;
	};
}

/** Dashboard lifecycle and rendering controls. */
export interface DashboardController {
	clear(ctx: AutoresearchDashboardHost): void;
	requestRender(): void;
	showOverlay(ctx: AutoresearchDashboardHost, runtime: AutoresearchDashboardRuntime): Promise<void>;
	updateWidget(ctx: AutoresearchDashboardHost, runtime: AutoresearchDashboardRuntime): void;
}

/** Create a dashboard backed by the host's widget and overlay surfaces. */
export function createDashboardController(): DashboardController {
	let overlayTui: { requestRender(): void } | null = null;
	let spinnerTimer: NodeJS.Timeout | undefined;
	let spinnerFrame = 0;

	const requestRender = (): void => {
		overlayTui?.requestRender();
	};

	const clear = (): void => {
		overlayTui = null;
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
	};

	return {
		clear(ctx): void {
			clear();
			if (ctx.hasUI) {
				ctx.ui.setWidget("autoresearch", undefined);
			}
		},
		requestRender,
		updateWidget(ctx, runtime): void {
			if (!ctx.hasUI) return;
			const state = runtime.state;
			if (!shouldShowDashboard(runtime, state)) {
				ctx.ui.setWidget("autoresearch", undefined);
				return;
			}

			ctx.ui.setWidget("autoresearch", (_tui, theme) => {
				if (state.results.length === 0 && runtime.runningExperiment) {
					return new DashboardWidget(renderRunningOnly(runtime, state, theme), () =>
						describeRunningOnly(runtime, state),
					);
				}
				if (runtime.dashboardExpanded) {
					const width = process.stdout.columns ?? 120;
					const lines = [
						renderExpandedHeader(runtime, width, theme),
						...renderDashboardLines(runtime, width, theme, 8),
					];
					return new DashboardWidget(lines.join("\n"), cx =>
						card({ role: "omp.widget.autoresearch", head: describeTitle(runtime) }, [
							...describeDashboard(runtime, 8, cx.supports("chart")),
							hintsRow([
								{ keys: ["ctrl+x"], label: t("collapse") },
								{ keys: ["ctrl+shift+x"], label: t("overlay") },
							]),
						]),
					);
				}
				return new DashboardWidget(renderCollapsedLine(runtime, state, theme), () =>
					describeCollapsed(runtime, state),
				);
			});
		},
		async showOverlay(ctx, runtime): Promise<void> {
			if (!ctx.hasUI || !shouldShowDashboard(runtime, runtime.state)) return;
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					overlayTui = tui;
					// Repaint-only: the native overlay declares a spinner and elapsed timer instead.
					if (!spinnerTimer && !isNativeRendering()) {
						spinnerTimer = setInterval(() => {
							spinnerFrame += 1;
							requestRender();
						}, 80);
					}

					let scrollView: ScrollView | undefined;
					/** Natively the terminal scrolls the sheet body: bumped per scroll key. */
					let scroll: NativeScroll | undefined;
					const native = new Memo();
					return {
						/** A glass sheet titled by the experiment; what it is follows, muted. */
						get nativeOverlay() {
							return { role: "omp.overlay.autoresearch", head: describeSheetHead(runtime), size: "lg" as const };
						},
						describe(cx: DescribeContext): NativeNode {
							const state = runtime.state;
							const chart = cx.supports("chart");
							return native.get(
								[
									chart,
									scroll,
									state,
									state.results.length,
									state.results.at(-1),
									state.bestMetric,
									state.confidence,
									state.currentSegment,
									state.name,
									runtime.autoresearchMode,
									runtime.lastRunSummary,
									runtime.runningExperiment,
								],
								() => {
									const children = describeSheet(runtime, chart);
									children.push(actionBar([null, actionButton(t("Close"), "close", { keys: "escape" })]));
									return { ...col(children, { gap: "md", role: "omp.app.autoresearch" }), scroll };
								},
							);
						},
						render(width: number): readonly string[] {
							const terminalRows = process.stdout.rows ?? 40;
							const header = renderExpandedHeader(runtime, width, theme);
							const body = renderDashboardLines(runtime, width, theme, 0);
							if (runtime.runningExperiment) {
								body.push(renderOverlayRunningLine(runtime, theme, width, spinnerFrame));
							}
							const viewportRows = Math.max(4, terminalRows - 4);
							scrollView ??= new ScrollView(body, {
								height: viewportRows,
								scrollbar: "auto",
								theme: { track: t => theme.fg("dim", t), thumb: t => theme.fg("accent", t) },
							});
							scrollView.setLines(body);
							scrollView.setHeight(viewportRows);
							return [header, ...scrollView.render(width), renderOverlayFooter(width, theme)];
						},
						/** The Close button runs Esc's path. */
						handleNativeEvent(event: NativeUiEvent): void {
							if (event.type === "action" && event.act === "close") done(undefined);
						},
						handleInput(data: string): void {
							if (matchesKey(data, "escape") || matchesKey(data, "esc") || data === "q") {
								done(undefined);
								return;
							}
							let by: TspScrollBy | undefined;
							if (matchesKey(data, "up") || matchesKey(data, "k")) {
								by = "line-up";
								scrollView?.scroll(-1);
							} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
								by = "line-down";
								scrollView?.scroll(1);
							} else if (matchesKey(data, "pageUp")) {
								by = "page-up";
								scrollView?.page(-1);
							} else if (matchesKey(data, "pageDown")) {
								by = "page-down";
								scrollView?.page(1);
							} else if (data === "g") {
								by = "start";
								scrollView?.scrollToTop();
							} else if (data === "G") {
								by = "end";
								scrollView?.scrollToBottom();
							}
							if (by) scroll = { by, n: (scroll?.n ?? 0) + 1 };
							tui.requestRender();
						},
						invalidate(): void {},
						dispose(): void {
							scrollView?.dispose();
							clear();
						},
					};
				},
				{ overlay: true },
			);
		},
	};
}

// -- native ------------------------------------------------------------------

/** Card/overlay title: the experiment name plus its mode status. */
function describeTitle(runtime: AutoresearchDashboardRuntime): TspSpan[] {
	const state = runtime.state;
	const spans = [
		span(state.name ? t("autoresearch: {name}", { name: replaceTabs(state.name) }) : t("autoresearch"), "accent"),
	];
	const status = t(renderModeStatus(runtime, state));
	if (status) spans.push(span(` · ${status}`, "muted"));
	return spans;
}

/** Widget shown while the very first run is in flight. */
function describeRunningOnly(runtime: AutoresearchDashboardRuntime, state: ExperimentState): NativeNode {
	const children: NativeNode[] = [
		node("spinner", {
			label: [span(t("autoresearch"), "accent"), span(` ${t("running")}`, "warning")],
			tone: "warning",
		}),
	];
	if (runtime.runningExperiment) children.push(elapsed(Date.now() - runtime.runningExperiment.startedAt));
	const details: TspSpan[] = [];
	if (state.name) details.push(span(`| ${replaceTabs(state.name)}`, "dim"));
	if (runtime.runningExperiment) details.push(span(` | ${replaceTabs(runtime.runningExperiment.command)}`, "dim"));
	if (details.length > 0) children.push(text(details, { truncate: "end" }));
	return row(children, { gap: "sm", role: "omp.widget.autoresearch" });
}

/** One-line collapsed widget: run counts, best/baseline, confidence and mode. */
function describeCollapsed(runtime: AutoresearchDashboardRuntime, state: ExperimentState): NativeNode {
	const role = "omp.widget.autoresearch";
	const hint = hintsRow([{ keys: ["ctrl+x"], label: t("expand") }]);
	if (runtime.lastRunSummary) {
		const spans = [
			span(t("autoresearch"), "accent"),
			span(t(" pending run #{runNumber}", { runNumber: runtime.lastRunSummary.runNumber }), "warning"),
			span(t(runtime.lastRunSummary.passed ? " pass" : " fail"), "dim"),
		];
		if (runtime.lastRunSummary.parsedPrimary !== null) {
			spans.push(
				span(
					` | ${state.metricName}=${formatNum(runtime.lastRunSummary.parsedPrimary, state.metricUnit)}`,
					"muted",
				),
			);
		}
		spans.push(span(t(" | log_experiment required"), "warning"));
		if (!runtime.autoresearchMode) spans.push(span(t(" | mode off"), "dim"));
		return text(spans, { truncate: "end", role });
	}
	if (state.results.length === 0) {
		const spans = [
			span(t("autoresearch"), "accent"),
			span(` ${t(runtime.autoresearchMode ? "baseline pending" : "mode off")}`, "warning"),
		];
		if (state.name) spans.push(span(` | ${replaceTabs(state.name)}`, "dim"));
		if (runtime.autoresearchMode) spans.push(span(t(" | run the baseline"), "dim"));
		return text(spans, { truncate: "end", role });
	}
	const current = currentResults(state.results, state.currentSegment);
	const counts = statusCounts(current);
	const best = findBestResult(state);
	const archivedRuns = Math.max(0, state.results.length - current.length);
	const spans = [
		span(t("autoresearch"), "accent"),
		span(t(" {count} runs", { count: current.length }), "muted"),
		span(t(" {count} kept", { count: counts.keep }), "success"),
	];
	if (archivedRuns > 0) spans.push(span(t(" +{count} archived", { count: archivedRuns }), "dim"));
	if (counts.crash > 0) spans.push(span(t(" {count} crash", { count: counts.crash }), "error"));
	if (counts.checks_failed > 0)
		spans.push(span(t(" {count} checks_failed", { count: counts.checks_failed }), "error"));
	spans.push(span(" | ", "dim"));
	if (best && state.bestMetric !== null && best.result.metric !== state.bestMetric) {
		spans.push(span(t("best {value}", { value: formatNum(best.result.metric, state.metricUnit) }), "warning"));
		spans.push(span(t(" baseline {value}", { value: formatNum(state.bestMetric, state.metricUnit) }), "dim"));
	} else if (state.bestMetric !== null) {
		spans.push(span(t("baseline {value}", { value: formatNum(state.bestMetric, state.metricUnit) }), "warning"));
	} else {
		spans.push(span(t("no kept runs yet"), "warning"));
	}
	if (state.confidence !== null) {
		spans.push(span(" | ", "dim"));
		spans.push(span(t("conf {value}x", { value: state.confidence.toFixed(1) }), confidenceToken(state.confidence)));
	}
	const children: NativeNode[] = [text(spans, { truncate: "end" })];
	if (runtime.runningExperiment) {
		children.push(
			text([span(`| ${t("running")}`, "dim")]),
			elapsed(Date.now() - runtime.runningExperiment.startedAt),
		);
	} else if (!runtime.autoresearchMode) {
		children.push(text([span(`| ${t(renderModeStatus(runtime, state))}`, "dim")]));
	}
	children.push(hint);
	return row(children, { gap: "sm", role });
}

/**
 * Summary `kv`, the metric per run as a `bars` chart when the terminal draws
 * `chart` (`chart`), and the run `table`; `maxRows > 0` keeps only the latest runs.
 */
function describeDashboard(runtime: AutoresearchDashboardRuntime, maxRows: number, chart: boolean): NativeNode[] {
	const state = runtime.state;
	if (state.results.length === 0) {
		const pending = runtime.lastRunSummary;
		if (pending) {
			const items: { k: string; v: TspText }[] = [
				{ k: t("Pending run"), v: `#${pending.runNumber}` },
				{
					k: t("Result"),
					v: `${t(pending.passed ? "passed" : "failed")}${pending.parsedPrimary !== null ? `  ${state.metricName} ${formatNum(pending.parsedPrimary, state.metricUnit)}` : ""}`,
				},
				{ k: t("Next action"), v: t("finish log_experiment before starting another run.") },
			];
			if (!runtime.autoresearchMode) items.push({ k: t("Mode"), v: t("off") });
			return [node("kv", { items, layout: "grid" }, undefined, "summary")];
		}
		if (runtime.autoresearchMode) {
			return [
				node(
					"kv",
					{
						items: [
							{ k: t("Current segment"), v: t("{count} runs", { count: 0 }) },
							{ k: t("Baseline"), v: t("pending") },
							{ k: t("Next action"), v: t("run and log the baseline experiment.") },
						],
						layout: "grid",
					},
					undefined,
					"summary",
				),
			];
		}
		return [keyed(text([span(t("No experiments logged yet."), "dim")]), "summary")];
	}

	const current = currentResults(state.results, state.currentSegment);
	const counts = statusCounts(current);
	const baseline = findBaselineMetric(state.results, state.currentSegment);
	const baselineRunNumber = findBaselineRunNumber(state.results, state.currentSegment);
	const baselineSecondary = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics);
	const best = findBestResult(state);
	const items: { k: string; v: TspText }[] = [
		{
			k: t("Current segment"),
			v: [
				span(`${t("{count} runs", { count: current.length })}  `),
				span(t("{count} kept", { count: counts.keep }), "success"),
				span(`  ${t("{count} discarded", { count: counts.discard })}`, "warning"),
				span(`  ${t("{count} crashed", { count: counts.crash })}`, counts.crash > 0 ? "error" : undefined),
				span(
					`  ${t("{count} checks_failed", { count: counts.checks_failed })}`,
					counts.checks_failed > 0 ? "error" : undefined,
				),
			],
		},
		{
			k: t("Baseline"),
			v: `${formatNum(baseline, state.metricUnit)}${baselineRunNumber ? ` (#${baselineRunNumber})` : ""}`,
		},
	];
	if (state.results.length > current.length) {
		items.push({
			k: t("Archived"),
			v: t("{count} runs from earlier segments", { count: state.results.length - current.length }),
		});
	}
	if (runtime.lastRunSummary) {
		items.push({
			k: t("Pending run"),
			v: [
				span(`#${runtime.lastRunSummary.runNumber} (${t(runtime.lastRunSummary.passed ? "passed" : "failed")})`),
				span(t(" — log_experiment required"), "warning"),
			],
		});
	}
	if (!runtime.autoresearchMode) items.push({ k: t("Mode"), v: t(renderModeStatus(runtime, state)) });
	if (best) {
		const bestRunNumber = best.result.runNumber ?? best.index + 1;
		const value: TspSpan[] = [
			span(`${formatNum(best.result.metric, state.metricUnit)} (#${bestRunNumber})`, "strong"),
		];
		if (baseline !== null && baseline !== 0 && best.result.metric !== baseline) {
			const delta = ((best.result.metric - baseline) / baseline) * 100;
			value.push(span(` ${delta > 0 ? "+" : ""}${delta.toFixed(1)}%`, "num"));
		}
		if (state.confidence !== null) {
			value.push(
				span(`  ${t("conf {value}x", { value: state.confidence.toFixed(1) })}`, confidenceToken(state.confidence)),
			);
		}
		items.push({ k: t("Best"), v: value });
		const details = state.secondaryMetrics
			.map(metric =>
				renderSecondarySummary(
					metric.name,
					best.result.metrics[metric.name],
					baselineSecondary[metric.name],
					metric.unit,
				),
			)
			.filter((detail): detail is string => Boolean(detail));
		if (details.length > 0) items.push({ k: t("Secondary"), v: details.join("  ") });
	}

	const cols: TspTableColumn[] = [
		{ id: "run", head: [span("#", "muted")], align: "end", priority: 3 },
		{ id: "commit", head: [span(t("commit"), "muted")], truncate: "end", priority: 2 },
		{ id: "metric", head: [span(state.metricName, "warning")], align: "end", priority: 5 },
		...state.secondaryMetrics.map((metric, index): TspTableColumn => ({
			id: `secondary${index}`,
			head: [span(metric.name, "muted")],
			align: "end",
			truncate: "end",
			priority: 1,
		})),
		{ id: "status", head: [span(t("status"), "muted")], priority: 4 },
		{ id: "description", head: [span(t("description"), "muted")], truncate: "end", grow: 1, priority: 2 },
	];
	const indexed = state.results
		.map((result, index) => ({ result, index }))
		.filter(({ result }) => result.segment === state.currentSegment);
	const visible = maxRows > 0 ? indexed.slice(-maxRows) : indexed;
	const rows = visible.map(({ result, index }) => {
		const token = result.status === "keep" ? "success" : result.status === "discard" ? "warning" : "error";
		const cells: Record<string, TspText> = {
			run: [span(String(result.runNumber ?? index + 1), "dim")],
			commit: [span(result.commit || "-", "accent")],
			metric: [span(formatNum(result.metric, state.metricUnit), token)],
			status: [span(t(result.status), token)],
			description: [span(replaceTabs(result.description), "muted")],
		};
		state.secondaryMetrics.forEach((metric, metricIndex) => {
			cells[`secondary${metricIndex}`] = renderSecondaryCell(
				result.metrics[metric.name],
				metric.unit,
				baselineSecondary[metric.name],
			);
		});
		return { id: String(index), cells };
	});
	const children: NativeNode[] = [node("kv", { items, layout: "grid" }, undefined, "summary")];
	if (chart && visible.length >= 2) {
		children.push(
			node(
				"chart",
				{
					kind: "bars",
					series: visible.map(({ result, index }) => {
						const run = result.runNumber ?? index + 1;
						return {
							label: `#${run}`,
							value: result.metric,
							title: `#${run} ${t(result.status)} · ${formatNum(result.metric, state.metricUnit)} · ${replaceTabs(result.description)}`,
						};
					}),
					token: "accent",
					summary: [
						span(t("{metric} per run", { metric: state.metricName }), "muted"),
						...(best
							? [
									span(
										` · ${t("best {value}", { value: formatNum(best.result.metric, state.metricUnit) })}`,
										"success",
									),
								]
							: []),
					],
					size: "md",
					role: "omp.autoresearch.trend",
				},
				undefined,
				"trend",
			),
		);
	}
	if (visible.length < indexed.length) {
		children.push(
			keyed(
				text([span(t("… {count} earlier runs hidden", { count: indexed.length - visible.length }), "dim")]),
				"hidden",
			),
		);
	}
	children.push(node("table", { cols, rows, role: "omp.autoresearch.runs" }, undefined, "runs"));
	return [keyed(col(children, { gap: "sm" }), "dashboard")];
}

// -- native sheet --------------------------------------------------------------

/** Sheet head: the experiment's name, then what the sheet is. */
function describeSheetHead(runtime: AutoresearchDashboardRuntime): TspSpan[] {
	const name = runtime.state.name?.trim();
	return name ? [span(replaceTabs(name)), span(` · ${t("autoresearch")}`, "muted")] : [span(t("autoresearch"))];
}

const STATUS_LABEL: Record<ExperimentResult["status"], string> = {
	keep: "kept",
	discard: "discarded",
	crash: "crashed",
	checks_failed: "checks failed",
};

const STATUS_TOKEN: Record<ExperimentResult["status"], string> = {
	keep: "success",
	discard: "dim",
	crash: "error",
	checks_failed: "error",
};

/** Fraction digits (0–2) that show every value exactly, so numbers that sit together align. */
function fractionDigits(values: readonly number[]): number {
	let digits = 0;
	for (const value of values) {
		while (digits < 2 && Math.abs(Math.round(value * 10 ** digits) - value * 10 ** digits) > 1e-6) digits += 1;
	}
	return digits;
}

/** A metric split into its number and unit, so the unit can sit a step quieter. */
function metricSpans(value: number, unit: string, digits: number, numberStyle?: string): TspSpan[] {
	const spans = [span(fmtNum(value, digits), numberStyle)];
	if (unit) spans.push(span(unit, "muted"));
	return spans;
}

/** Signed change from `base` to `value` in percent (`−12.4%`), or null when there is nothing to compare. */
function percentChange(value: number, base: number | null | undefined): string | null {
	if (base === null || base === undefined || base === 0 || value === base) return null;
	const delta = ((value - base) / base) * 100;
	return `${delta > 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)}%`;
}

/** What the sheet's mode says, with the span token it reads in. */
function modeLabel(runtime: AutoresearchDashboardRuntime): [label: string, token: string] {
	const status = renderModeStatus(runtime, runtime.state);
	switch (status) {
		case "mode on":
			return [t(status), "success"];
		case "baseline pending":
			return [t(status), "warning"];
		case "segment complete":
			return [t(status), "muted"];
		default:
			return [t(status), "muted"];
	}
}

/**
 * The overlay's body: the goal and setup, the headline numbers (best,
 * baseline, confidence, runs), what is happening now, the metric per run and
 * the runs newest first. Empty segments explain what comes next instead.
 */
function describeSheet(runtime: AutoresearchDashboardRuntime, chart: boolean): NativeNode[] {
	const state = runtime.state;
	const current = currentResults(state.results, state.currentSegment);
	const archived = state.results.length - current.length;
	const children: NativeNode[] = [describeIntro(runtime, archived > 0)];
	const now = describeNow(runtime);
	if (now) children.push(now);
	if (current.length === 0) {
		children.push(describeEmpty(runtime, archived));
		return children;
	}
	children.push(describeStats(runtime, current));
	const indexed = state.results
		.map((result, index) => ({ result, index }))
		.filter(({ result }) => result.segment === state.currentSegment);
	if (chart && indexed.length >= 2) children.push(describeTrend(runtime, indexed));
	children.push(describeRuns(runtime, indexed));
	if (archived > 0) {
		children.push(
			keyed(
				text(
					[
						span(
							t("{count} run{s} archived from earlier segments", {
								count: archived,
								s: archived === 1 ? "" : "s",
							}),
						),
					],
					{
						role: "omp.autoresearch.note",
					},
				),
				"archived",
			),
		);
	}
	return children;
}

/** The goal as a sentence, then one quiet line of setup: mode, metric and direction, segment, branch. */
function describeIntro(runtime: AutoresearchDashboardRuntime, segmented: boolean): NativeNode {
	const state = runtime.state;
	const children: NativeNode[] = [];
	const goal = state.goal?.trim();
	if (goal) children.push(keyed(text(replaceTabs(goal), { wrap: "word", role: "omp.autoresearch.goal" }), "goal"));
	const [mode, modeToken] = modeLabel(runtime);
	const meta: TspSpan[] = [
		span("● ", modeToken),
		span(mode),
		span("  ·  "),
		span(state.metricName, "mono"),
		span(t(", {direction} is better", { direction: t(state.bestDirection) })),
	];
	if (segmented) meta.push(span("  ·  "), span(t("Segment {segment}", { segment: state.currentSegment + 1 })));
	if (state.maxExperiments !== null)
		meta.push(span("  ·  "), span(t("{count} runs per segment", { count: state.maxExperiments })));
	if (state.branch) meta.push(span("  ·  "), span(replaceTabs(state.branch), "mono"));
	children.push(keyed(text(meta, { truncate: "end", role: "omp.autoresearch.meta" }), "meta"));
	return keyed(col(children, { gap: "xs", role: "omp.autoresearch.intro" }), "intro");
}

/** What is happening right now: a benchmark running, or a finished run waiting to be logged. */
function describeNow(runtime: AutoresearchDashboardRuntime): NativeNode | undefined {
	const state = runtime.state;
	const running = runtime.runningExperiment;
	if (running) {
		return keyed(
			row(
				[
					node("spinner", { label: [span(t("running"))], tone: "pending" }),
					elapsed(Date.now() - running.startedAt),
					text([span(replaceTabs(running.command), "mono")], {
						truncate: "end",
						role: "omp.autoresearch.command",
					}),
				],
				{ gap: "sm", align: "center", role: "omp.autoresearch.running", tone: "pending" },
			),
			"now",
		);
	}
	const pending = runtime.lastRunSummary;
	if (!pending) return undefined;
	const result: TspSpan[] = [
		span(
			t("Run #{run} {status}", { run: pending.runNumber, status: t(pending.passed ? "passed" : "failed") }),
			"strong",
		),
	];
	if (pending.parsedPrimary !== null) {
		result.push(
			span(`  ·  ${state.metricName} `),
			...metricSpans(pending.parsedPrimary, state.metricUnit, fractionDigits([pending.parsedPrimary]), "mono"),
		);
	}
	return keyed(
		row(
			[
				text(result, { truncate: "end" }),
				text([span(t("Log it with ")), span("log_experiment", "mono"), span(t(" before the next run"))], {
					truncate: "end",
					role: "omp.autoresearch.next",
				}),
			],
			{ gap: "md", align: "center", role: "omp.autoresearch.pending", tone: "warning" },
		),
		"now",
	);
}

/** No runs in this segment yet: what the dashboard is waiting for. */
function describeEmpty(runtime: AutoresearchDashboardRuntime, archived: number): NativeNode {
	const [title, detail] = runtime.lastRunSummary
		? ["Waiting for the first log", "Log the finished run to set this segment's baseline."]
		: runtime.runningExperiment
			? ["Measuring the baseline", "Every later run is compared with this first one."]
			: runtime.autoresearchMode
				? [
						"No baseline yet",
						"Run the benchmark once and log it as the baseline. Every later run is compared with it.",
					]
				: ["No experiments logged yet", "Turn autoresearch mode on to start measuring."];
	const children: NativeNode[] = [
		text([span(t(title))], { role: "omp.autoresearch.empty.title" }),
		text([span(t(detail))], { wrap: "word", role: "omp.autoresearch.empty.detail" }),
	];
	if (archived > 0) {
		children.push(
			text(
				[
					span(
						t("{count} run{s} archived from earlier segments", { count: archived, s: archived === 1 ? "" : "s" }),
					),
				],
				{
					role: "omp.autoresearch.note",
				},
			),
		);
	}
	return keyed(col(children, { gap: "xs", align: "center", role: "omp.autoresearch.empty" }), "empty");
}

/** One headline number: a label, the value, and one line saying what it means. */
function stat(key: string, label: string, value: TspSpan[], detail: NativeNode[]): NativeNode {
	return keyed(
		col(
			[
				text(t(label), { role: "omp.autoresearch.stat.k" }),
				text(value, { wrap: "none", truncate: "end", role: "omp.autoresearch.stat.v" }),
				...detail,
			],
			{ role: "omp.autoresearch.stat" },
		),
		key,
	);
}

function statDetail(spans: TspSpan[]): NativeNode {
	return text(spans, { truncate: "end", role: "omp.autoresearch.stat.sub" });
}

/** Best, baseline, confidence and the run tally, then the secondary metrics at the best run. */
function describeStats(runtime: AutoresearchDashboardRuntime, current: readonly ExperimentResult[]): NativeNode {
	const state = runtime.state;
	const unit = state.metricUnit;
	const best = findBestResult(state);
	const baseline = findBaselineMetric(state.results, state.currentSegment);
	const baselineRun = findBaselineRunNumber(state.results, state.currentSegment);
	const baselineResult = current.find(result => result.status === "keep" && !result.flagged);
	const counts = statusCounts(current);
	const digits = fractionDigits(
		[best?.result.metric, baseline].filter((value): value is number => value !== undefined && value !== null),
	);
	const tiles: NativeNode[] = [];

	if (best) {
		const run = best.result.runNumber ?? best.index + 1;
		const change = percentChange(best.result.metric, baseline);
		const better = baseline !== null && isBetter(best.result.metric, baseline, state.bestDirection);
		tiles.push(
			stat("best", "Best", metricSpans(best.result.metric, unit, digits), [
				statDetail(
					change
						? [span(change, better ? "success" : "error"), span(t(" vs baseline · run #{run}", { run }))]
						: [span(t("The baseline · run #{run}", { run }))],
				),
			]),
		);
	} else {
		tiles.push(stat("best", "Best", [span("—", "muted")], [statDetail([span(t("No kept run yet"))])]));
	}

	const baselineDetail: TspSpan[] = [];
	if (baselineRun !== null) baselineDetail.push(span(t("Run #{run}", { run: baselineRun })));
	if (baselineResult?.commit) baselineDetail.push(span(" · "), span(baselineResult.commit.slice(0, 7), "mono"));
	tiles.push(
		stat("baseline", "Baseline", baseline === null ? [span("—", "muted")] : metricSpans(baseline, unit, digits), [
			statDetail(baselineDetail.length > 0 ? baselineDetail : [span(t("Not logged yet"))]),
		]),
	);

	const confidence = state.confidence;
	tiles.push(
		stat(
			"confidence",
			"Confidence",
			confidence === null
				? [span("—", "muted")]
				: [span(confidence.toFixed(1), confidenceToken(confidence)), span("×", "muted")],
			[
				statDetail([
					span(
						t(
							confidence === null
								? "Needs three runs and a gain"
								: confidence >= 2
									? "Gain is clear of run noise"
									: confidence >= 1
										? "Gain is near run noise"
										: "Gain is within run noise",
						),
					),
				]),
			],
		),
	);

	const total = Math.max(state.maxExperiments ?? 0, current.length);
	const failed = counts.crash + counts.checks_failed;
	const tally: TspSpan[] = [
		span(t("{kept} kept · {discarded} discarded", { kept: counts.keep, discarded: counts.discard })),
	];
	if (failed > 0) tally.push(span(" · "), span(t("{count} failed", { count: failed }), "error"));
	tiles.push(
		stat(
			"runs",
			"Runs",
			state.maxExperiments !== null
				? [span(String(current.length)), span(` / ${state.maxExperiments}`, "muted")]
				: [span(String(current.length))],
			[
				node("meter", {
					value: current.length / total,
					parts: [
						{ value: counts.keep / total, token: "success", label: t("{count} kept", { count: counts.keep }) },
						{
							value: counts.discard / total,
							token: "muted",
							label: t("{count} discarded", { count: counts.discard }),
						},
						{
							value: failed / total,
							token: "error",
							label: t("{crashed} crashed · {failed} checks failed", {
								crashed: counts.crash,
								failed: counts.checks_failed,
							}),
						},
					],
					size: "sm",
					role: "omp.autoresearch.tally",
				}),
				statDetail(tally),
			],
		),
	);

	const children: NativeNode[] = [row(tiles, { role: "omp.autoresearch.stats" })];
	if (best && state.secondaryMetrics.length > 0) {
		const baselineSecondary = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics);
		const spans: TspSpan[] = [];
		for (const metric of state.secondaryMetrics) {
			const value = best.result.metrics[metric.name];
			if (value === undefined) continue;
			spans.push(span(spans.length === 0 ? t("At best  ") : "   ·   "));
			spans.push(
				span(`${metric.name} `, "mono muted"),
				...metricSpans(value, metric.unit, fractionDigits([value]), "mono"),
			);
			const change = percentChange(value, baselineSecondary[metric.name]);
			if (change) spans.push(span(` ${change}`, "mono"));
		}
		if (spans.length > 0) {
			children.push(keyed(text(spans, { truncate: "end", role: "omp.autoresearch.secondary" }), "secondary"));
		}
	}
	return keyed(col(children, { role: "omp.autoresearch.summary" }), "summary");
}

/** The primary metric per run, in run order. */
function describeTrend(
	runtime: AutoresearchDashboardRuntime,
	indexed: readonly { result: ExperimentResult; index: number }[],
): NativeNode {
	const state = runtime.state;
	return node(
		"chart",
		{
			kind: "bars",
			series: indexed.map(({ result, index }) => {
				const run = result.runNumber ?? index + 1;
				return {
					label: `#${run}`,
					value: result.metric,
					title: `#${run} ${t(STATUS_LABEL[result.status])} · ${formatNum(result.metric, state.metricUnit)} · ${replaceTabs(result.description)}`,
				};
			}),
			token: "accent",
			summary: [
				span(
					t("{metric} per run, {direction} is better", {
						metric: state.metricName,
						direction: t(state.bestDirection),
					}),
				),
			],
			size: "md",
			role: "omp.autoresearch.trend",
		},
		undefined,
		"trend",
	);
}

/** Every run of the segment, newest first: outcome, metric and its change from the baseline, commit, what changed. */
function describeRuns(
	runtime: AutoresearchDashboardRuntime,
	indexed: readonly { result: ExperimentResult; index: number }[],
): NativeNode {
	const state = runtime.state;
	const baseline = findBaselineResult(state.results, state.currentSegment);
	const best = findBestResult(state);
	// Cells carry bare numbers at one precision per column; the unit goes in the head unless the name says it.
	const head = (name: string, unit: string): TspSpan[] =>
		unit && !name.toLowerCase().endsWith(`_${unit.toLowerCase()}`)
			? [span(name, "mono"), span(` ${unit}`, "muted")]
			: [span(name, "mono")];
	const measured = indexed.filter(({ result }) => result.status !== "crash").map(({ result }) => result);
	const metricDigits = fractionDigits(measured.map(result => result.metric));
	const secondaryDigits = state.secondaryMetrics.map(metric =>
		fractionDigits(
			measured.map(result => result.metrics[metric.name]).filter((value): value is number => value !== undefined),
		),
	);
	const cols: TspTableColumn[] = [
		{ id: "run", head: "#", align: "end", priority: 3 },
		{ id: "status", head: t("Outcome"), priority: 4 },
		{ id: "metric", head: head(state.metricName, state.metricUnit), align: "end", priority: 5 },
		{ id: "change", head: t("vs baseline"), align: "end", priority: 4 },
		...state.secondaryMetrics.map((metric, index): TspTableColumn => ({
			id: `secondary${index}`,
			head: head(metric.name, metric.unit),
			align: "end",
			priority: 1,
		})),
		{ id: "commit", head: t("Commit"), priority: 2 },
		{ id: "description", head: t("Change"), truncate: "end", grow: 1, priority: 3 },
	];
	const rows = indexed
		.slice()
		.reverse()
		.map(({ result, index }) => {
			const isBest = best?.index === index;
			const isBaseline = result === baseline;
			const crashed = result.status === "crash";
			const change = isBaseline || crashed ? null : percentChange(result.metric, baseline?.metric);
			const better = baseline !== null && isBetter(result.metric, baseline.metric, state.bestDirection);
			const cells: Record<string, TspText> = {
				run: [span(String(result.runNumber ?? index + 1), "mono")],
				status: isBest
					? [span("● ", "success"), span(t("best"), "strong")]
					: [span("● ", STATUS_TOKEN[result.status]), span(t(STATUS_LABEL[result.status]))],
				metric: crashed
					? [span("—", "muted")]
					: [span(fmtNum(result.metric, metricDigits), isBest ? "mono strong" : "mono")],
				change: isBaseline
					? [span(t("baseline"), "muted")]
					: change
						? [span(change, `mono ${result.status === "keep" ? (better ? "success" : "error") : "muted"}`)]
						: [span("—", "muted")],
				commit: [span(result.commit ? result.commit.slice(0, 7) : "—", result.commit ? "mono" : "muted")],
				description: [span(replaceTabs(result.description))],
			};
			state.secondaryMetrics.forEach((metric, metricIndex) => {
				const value = result.metrics[metric.name];
				cells[`secondary${metricIndex}`] =
					value === undefined
						? [span("—", "muted")]
						: [span(fmtNum(value, secondaryDigits[metricIndex] ?? 0), "mono")];
			});
			return { id: String(index), cells };
		});
	return node("table", { cols, rows, role: "omp.autoresearch.runs" }, undefined, "runs");
}

function statusCounts(results: readonly ExperimentResult[]): Record<ExperimentResult["status"], number> {
	const counts: Record<ExperimentResult["status"], number> = { keep: 0, discard: 0, crash: 0, checks_failed: 0 };
	for (const result of results) counts[result.status] += 1;
	return counts;
}

function confidenceToken(confidence: number): string {
	return confidence >= 2 ? "success" : confidence >= 1 ? "warning" : "error";
}

// -- ANSI --------------------------------------------------------------------

function renderRunningOnly(runtime: AutoresearchDashboardRuntime, state: ExperimentState, theme: Theme): string {
	const parts = [theme.fg("accent", t("autoresearch")), theme.fg("warning", t(" running..."))];
	if (state.name) {
		parts.push(theme.fg("dim", ` | ${replaceTabs(state.name)}`));
	}
	if (runtime.runningExperiment) {
		parts.push(theme.fg("dim", ` | ${replaceTabs(runtime.runningExperiment.command)}`));
	}
	return parts.join("");
}

function shouldShowDashboard(runtime: AutoresearchDashboardRuntime, state: ExperimentState): boolean {
	return (
		runtime.autoresearchMode ||
		state.results.length > 0 ||
		runtime.runningExperiment !== null ||
		runtime.lastRunSummary !== null
	);
}

function renderExpandedHeader(runtime: AutoresearchDashboardRuntime, width: number, theme: Theme): string {
	const state = runtime.state;
	const status = t(renderModeStatus(runtime, state));
	const label = state.name ? t(" autoresearch: {name} ", { name: replaceTabs(state.name) }) : t(" autoresearch ");
	const hint = theme.fg(
		"dim",
		`${t(" {collapse} collapse  {overlay} overlay", {
			collapse: formatKeyHint("ctrl+x"),
			overlay: formatKeyHint("ctrl+shift+x"),
		})}${status ? `  ${status}` : ""} `,
	);
	const fillWidth = Math.max(0, width - visibleWidth(label) - visibleWidth(hint));
	return truncateToWidth(theme.fg("accent", label) + theme.fg("borderMuted", "-".repeat(fillWidth)) + hint, width);
}

function renderCollapsedLine(runtime: AutoresearchDashboardRuntime, state: ExperimentState, theme: Theme): string {
	if (runtime.lastRunSummary) {
		const parts = [
			theme.fg("accent", t("autoresearch")),
			theme.fg("warning", t(" pending run #{runNumber}", { runNumber: runtime.lastRunSummary.runNumber })),
			theme.fg("dim", runtime.lastRunSummary.passed ? t(" pass") : t(" fail")),
		];
		if (runtime.lastRunSummary.parsedPrimary !== null) {
			parts.push(
				theme.fg(
					"muted",
					` | ${state.metricName}=${formatNum(runtime.lastRunSummary.parsedPrimary, state.metricUnit)}`,
				),
			);
		}
		parts.push(theme.fg("warning", t(" | log_experiment required")));
		if (!runtime.autoresearchMode) {
			parts.push(theme.fg("dim", t(" | mode off")));
		}
		return parts.join("");
	}
	if (state.results.length === 0) {
		const modeStatus = runtime.autoresearchMode ? "baseline pending" : "mode off";
		const parts = [theme.fg("accent", t("autoresearch")), theme.fg("warning", ` ${t(modeStatus)}`)];
		if (state.name) {
			parts.push(theme.fg("dim", ` | ${replaceTabs(state.name)}`));
		}
		if (runtime.autoresearchMode) {
			parts.push(theme.fg("dim", t(" | run the baseline")));
		}
		return parts.join("");
	}
	const current = currentResults(state.results, state.currentSegment);
	const kept = current.filter(result => result.status === "keep").length;
	const crashed = current.filter(result => result.status === "crash").length;
	const checksFailed = current.filter(result => result.status === "checks_failed").length;
	const best = findBestResult(state);
	const archivedRuns = Math.max(0, state.results.length - current.length);
	const parts = [
		theme.fg("accent", t("autoresearch")),
		theme.fg("muted", t(" {count} runs", { count: current.length })),
		theme.fg("success", t(" {count} kept", { count: kept })),
	];
	if (archivedRuns > 0) parts.push(theme.fg("dim", t(" +{count} archived", { count: archivedRuns })));
	if (crashed > 0) parts.push(theme.fg("error", t(" {count} crash", { count: crashed })));
	if (checksFailed > 0) parts.push(theme.fg("error", t(" {count} checks_failed", { count: checksFailed })));
	parts.push(theme.fg("dim", t(" | ")));
	if (best && state.bestMetric !== null && best.result.metric !== state.bestMetric) {
		parts.push(theme.fg("warning", t("best {value}", { value: formatNum(best.result.metric, state.metricUnit) })));
		parts.push(theme.fg("dim", t(" baseline {value}", { value: formatNum(state.bestMetric, state.metricUnit) })));
	} else if (state.bestMetric !== null) {
		parts.push(theme.fg("warning", t("baseline {value}", { value: formatNum(state.bestMetric, state.metricUnit) })));
	} else {
		parts.push(theme.fg("warning", t("no kept runs yet")));
	}
	if (state.confidence !== null) {
		const confidenceColor = state.confidence >= 2 ? "success" : state.confidence >= 1 ? "warning" : "error";
		parts.push(theme.fg("dim", t(" | ")));
		parts.push(theme.fg(confidenceColor, t("conf {value}x", { value: state.confidence.toFixed(1) })));
	}
	if (runtime.runningExperiment) {
		parts.push(
			theme.fg(
				"dim",
				t(" | running {duration}", { duration: formatElapsed(Date.now() - runtime.runningExperiment.startedAt) }),
			),
		);
	} else if (!runtime.autoresearchMode) {
		parts.push(theme.fg("dim", ` | ${t(renderModeStatus(runtime, state))}`));
	}
	parts.push(theme.fg("dim", t(" | {key} expand", { key: formatKeyHint("ctrl+x") })));
	return parts.join("");
}

/** Render experiment progress and result rows at the requested width. */
export function renderDashboardLines(
	runtime: AutoresearchDashboardRuntime,
	width: number,
	theme: Theme,
	maxRows: number,
): string[] {
	const state = runtime.state;
	if (state.results.length === 0) {
		if (runtime.lastRunSummary) {
			const lines = [
				truncateToWidth(t("Pending run: #{runNumber}", { runNumber: runtime.lastRunSummary.runNumber }), width),
				truncateToWidth(
					t("Result: {status}{metric}", {
						status: t(runtime.lastRunSummary.passed ? "passed" : "failed"),
						metric:
							runtime.lastRunSummary.parsedPrimary !== null
								? `  ${state.metricName} ${formatNum(runtime.lastRunSummary.parsedPrimary, state.metricUnit)}`
								: "",
					}),
					width,
				),
				truncateToWidth(t("Next action: finish log_experiment before starting another run."), width),
			];
			if (!runtime.autoresearchMode) {
				lines.push(truncateToWidth(t("Mode: off"), width));
			}
			return lines;
		}
		if (runtime.autoresearchMode) {
			return [
				truncateToWidth(t("Current segment: {count} runs", { count: 0 }), width),
				truncateToWidth(t("Baseline: pending"), width),
				truncateToWidth(t("Next action: run and log the baseline experiment."), width),
			];
		}
		return [theme.fg("dim", t("No experiments logged yet."))];
	}

	const current = currentResults(state.results, state.currentSegment);
	const kept = current.filter(result => result.status === "keep").length;
	const discarded = current.filter(result => result.status === "discard").length;
	const crashed = current.filter(result => result.status === "crash").length;
	const checksFailed = current.filter(result => result.status === "checks_failed").length;
	const baseline = findBaselineMetric(state.results, state.currentSegment);
	const baselineRunNumber = findBaselineRunNumber(state.results, state.currentSegment);
	const baselineSecondary = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics);
	const best = findBestResult(state);
	const columns = experimentColumns(state, width);
	const lines = [
		truncateToWidth(
			t(
				"Current segment: {count} runs  {kept} kept  {discarded} discarded  {crashed} crashed  {checksFailed} checks_failed",
				{
					count: current.length,
					kept,
					discarded,
					crashed,
					checksFailed,
				},
			),
			width,
		),
		truncateToWidth(
			t("Baseline: {value}{run}", {
				value: formatNum(baseline, state.metricUnit),
				run: baselineRunNumber ? t(" (#{runNumber})", { runNumber: baselineRunNumber }) : "",
			}),
			width,
		),
	];
	if (state.results.length > current.length) {
		lines.push(
			truncateToWidth(
				t("Archived from earlier segments: {count} runs", { count: state.results.length - current.length }),
				width,
			),
		);
	}
	if (runtime.lastRunSummary) {
		lines.push(
			truncateToWidth(
				t("Pending run: #{runNumber} ({status}) — log_experiment required", {
					runNumber: runtime.lastRunSummary.runNumber,
					status: t(runtime.lastRunSummary.passed ? "passed" : "failed"),
				}),
				width,
			),
		);
	}
	if (!runtime.autoresearchMode) {
		lines.push(truncateToWidth(t("Mode: {status}", { status: t(renderModeStatus(runtime, state)) }), width));
	}
	if (best) {
		const bestRunNumber = best.result.runNumber ?? best.index + 1;
		let progress = t("Best: {value} (#{runNumber})", {
			value: formatNum(best.result.metric, state.metricUnit),
			runNumber: bestRunNumber,
		});
		if (baseline !== null && baseline !== 0 && best.result.metric !== baseline) {
			const delta = ((best.result.metric - baseline) / baseline) * 100;
			const sign = delta > 0 ? "+" : "";
			progress += ` ${sign}${delta.toFixed(1)}%`;
		}
		if (state.confidence !== null) {
			progress += `  ${t("conf {value}x", { value: state.confidence.toFixed(1) })}`;
		}
		lines.push(truncateToWidth(progress, width));
		if (state.secondaryMetrics.length > 0) {
			const details = state.secondaryMetrics
				.map(metric =>
					renderSecondarySummary(
						metric.name,
						best.result.metrics[metric.name],
						baselineSecondary[metric.name],
						metric.unit,
					),
				)
				.filter((value): value is string => Boolean(value));
			if (details.length > 0) {
				lines.push(truncateToWidth(t("Secondary: {details}", { details: details.join("  ") }), width));
			}
		}
	}
	lines.push("");
	lines.push(renderTableHeader(state, columns, width, theme));
	lines.push(theme.fg("borderMuted", "-".repeat(Math.max(0, width - 1))));

	const visible = maxRows > 0 ? current.slice(-maxRows) : current;
	if (visible.length < current.length) {
		lines.push(theme.fg("dim", t("... {count} earlier runs hidden ...", { count: current.length - visible.length })));
	}
	for (const result of visible) {
		lines.push(renderResultRow(result, state, baselineSecondary, columns, width, theme));
	}
	return lines;
}

function experimentColumns(state: ExperimentState, width: number): TableColumn[] {
	const fixed = 4 + 10 + 12 + 11 * state.secondaryMetrics.length + 14;
	return [
		{ width: 4, align: "left", overflow: "truncate" },
		{ width: 10, align: "left", overflow: "truncate" },
		{ width: 12, align: "left", overflow: "truncate" },
		...state.secondaryMetrics.map((): TableColumn => ({ width: 11, align: "left", overflow: "truncate" })),
		{ width: 14, align: "left", overflow: "truncate" },
		{ width: Math.max(8, width - fixed), align: "left", overflow: "truncate", minWidth: 8 },
	];
}

function renderTableHeader(
	state: ExperimentState,
	columns: readonly TableColumn[],
	width: number,
	theme: Theme,
): string {
	const muted = (text: string): string => theme.fg("muted", text);
	const cells: TableCell[] = [
		{ text: "#", style: muted },
		{ text: t("commit"), style: muted },
		{ text: state.metricName, style: text => theme.fg("warning", text) },
		...state.secondaryMetrics.map((metric): TableCell => ({ text: truncateToWidth(metric.name, 10), style: muted })),
		{ text: t("status"), style: muted },
		{ text: t("description"), style: muted },
	];
	return truncateToWidth(renderTableRow(cells, columns, width, { gap: "" }), width);
}

function renderResultRow(
	result: ExperimentResult,
	state: ExperimentState,
	baselineSecondary: { [key: string]: number },
	columns: readonly TableColumn[],
	width: number,
	theme: Theme,
): string {
	const runNumber = result.runNumber ?? state.results.indexOf(result) + 1;
	const statusColor = result.status === "keep" ? "success" : result.status === "discard" ? "warning" : "error";
	const statusStyle = (text: string): string => theme.fg(statusColor, text);
	const cells: TableCell[] = [
		{ text: String(runNumber), style: text => theme.fg("dim", text) },
		{ text: result.commit || "-", style: text => theme.fg("accent", text) },
		{ text: formatNum(result.metric, state.metricUnit), style: statusStyle },
		...state.secondaryMetrics.map((metric): TableCell => ({
			text: truncateToWidth(
				renderSecondaryCell(result.metrics[metric.name], metric.unit, baselineSecondary[metric.name]),
				10,
			),
		})),
		{ text: t(result.status), style: statusStyle },
		{ text: replaceTabs(result.description), style: text => theme.fg("muted", text) },
	];
	return truncateToWidth(renderTableRow(cells, columns, width, { gap: "" }), width);
}

function renderSecondaryCell(value: number | undefined, unit: string, baseline: number | undefined): string {
	if (value === undefined) return "-";
	const formatted = formatNum(value, unit);
	if (baseline === undefined || baseline === 0 || baseline === value) return formatted;
	const delta = ((value - baseline) / baseline) * 100;
	const sign = delta > 0 ? "+" : "";
	return `${formatted} ${sign}${delta.toFixed(1)}%`;
}

function renderSecondarySummary(
	name: string,
	value: number | undefined,
	baseline: number | undefined,
	unit: string,
): string | null {
	if (value === undefined) return null;
	if (baseline === undefined || baseline === 0 || baseline === value) {
		return `${name} ${formatNum(value, unit)}`;
	}
	const delta = ((value - baseline) / baseline) * 100;
	const sign = delta > 0 ? "+" : "";
	return `${name} ${formatNum(value, unit)} ${sign}${delta.toFixed(1)}%`;
}

function renderOverlayRunningLine(
	runtime: AutoresearchDashboardRuntime,
	theme: Theme,
	width: number,
	spinnerFrame: number,
): string {
	const spinner = theme.spinnerFrames[spinnerFrame % theme.spinnerFrames.length] ?? "*";
	return truncateToWidth(
		theme.fg(
			"warning",
			t("{spinner} running {duration} {command}", {
				spinner,
				duration: formatElapsed(Date.now() - (runtime.runningExperiment?.startedAt ?? Date.now())),
				command: replaceTabs(runtime.runningExperiment?.command ?? ""),
			}),
		),
		width,
	);
}

function renderOverlayFooter(width: number, theme: Theme): string {
	const hint = theme.fg(
		"dim",
		` ${formatKeyHints(["up", "down"])} ${formatKeyHints(["j", "k"])} ${formatKeyHint("pageUp")} ${formatKeyHint("pageDown")} ${formatKeyHint("g")} ${formatKeyHint("shift+g")} ${formatKeyHint("escape")} `,
	);
	const fill = Math.max(0, width - visibleWidth(hint));
	return theme.fg("borderMuted", "-".repeat(fill)) + hint;
}

function renderModeStatus(runtime: AutoresearchDashboardRuntime, state: ExperimentState): string {
	if (runtime.autoresearchMode) {
		return state.results.length === 0 ? "baseline pending" : "mode on";
	}
	const current = currentResults(state.results, state.currentSegment);
	if (state.maxExperiments !== null && current.length >= state.maxExperiments) {
		return "segment complete";
	}
	return "mode off";
}

function findBestResult(state: ExperimentState): { index: number; result: ExperimentResult } | null {
	let best: { index: number; result: ExperimentResult } | null = null;
	for (let index = 0; index < state.results.length; index += 1) {
		const result = state.results[index];
		if (result.segment !== state.currentSegment || result.status !== "keep" || result.metric <= 0) continue;
		if (!best || isBetter(result.metric, best.result.metric, state.bestDirection)) {
			best = { index, result };
		}
	}
	return best;
}
