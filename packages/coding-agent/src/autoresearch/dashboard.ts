import { matchesKey, replaceTabs, ScrollView, Text, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { t } from "../i18n";
import type { Theme } from "../modes/theme/theme";
import { formatElapsed, formatNum, isBetter } from "./helpers";
import { currentResults, findBaselineMetric, findBaselineRunNumber, findBaselineSecondary } from "./state";
import type { AutoresearchRuntime, DashboardController, ExperimentResult, ExperimentState } from "./types";

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
					return new Text(renderRunningOnly(runtime, state, theme), 0, 0);
				}
				if (runtime.dashboardExpanded) {
					const width = process.stdout.columns ?? 120;
					const lines = [
						renderExpandedHeader(runtime, width, theme),
						...renderDashboardLines(runtime, width, theme, 8),
					];
					return new Text(lines.join("\n"), 0, 0);
				}
				return new Text(renderCollapsedLine(runtime, state, theme), 0, 0);
			});
		},
		async showOverlay(ctx, runtime): Promise<void> {
			if (!ctx.hasUI || !shouldShowDashboard(runtime, runtime.state)) return;
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					overlayTui = tui;
					if (!spinnerTimer) {
						spinnerTimer = setInterval(() => {
							spinnerFrame += 1;
							requestRender();
						}, 80);
					}

					let scrollOffset = 0;
					return {
						render(width: number): readonly string[] {
							const terminalRows = process.stdout.rows ?? 40;
							const header = renderExpandedHeader(runtime, width, theme);
							const body = renderDashboardLines(runtime, width, theme, 0);
							if (runtime.runningExperiment) {
								body.push(renderOverlayRunningLine(runtime, theme, width, spinnerFrame));
							}
							const viewportRows = Math.max(4, terminalRows - 4);
							const maxScroll = Math.max(0, body.length - viewportRows);
							if (scrollOffset > maxScroll) scrollOffset = maxScroll;
							const sv = new ScrollView(body.slice(scrollOffset, scrollOffset + viewportRows), {
								height: viewportRows,
								scrollbar: "auto",
								totalRows: body.length,
								theme: { track: t => theme.fg("dim", t), thumb: t => theme.fg("accent", t) },
							});
							sv.setScrollOffset(scrollOffset);
							return [header, ...sv.render(width), renderOverlayFooter(width, theme)];
						},
						handleInput(data: string): void {
							const totalRows =
								renderDashboardLines(runtime, process.stdout.columns ?? 120, theme, 0).length +
								(runtime.runningExperiment ? 1 : 0);
							const viewportRows = Math.max(4, (process.stdout.rows ?? 40) - 4);
							const maxScroll = Math.max(0, totalRows - viewportRows);
							if (matchesKey(data, "escape") || matchesKey(data, "esc") || data === "q") {
								done(undefined);
								return;
							}
							if (matchesKey(data, "up") || matchesKey(data, "k")) {
								scrollOffset = Math.max(0, scrollOffset - 1);
							} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
								scrollOffset = Math.min(maxScroll, scrollOffset + 1);
							} else if (matchesKey(data, "pageUp")) {
								scrollOffset = Math.max(0, scrollOffset - viewportRows);
							} else if (matchesKey(data, "pageDown")) {
								scrollOffset = Math.min(maxScroll, scrollOffset + viewportRows);
							} else if (data === "g") {
								scrollOffset = 0;
							} else if (data === "G") {
								scrollOffset = maxScroll;
							}
							tui.requestRender();
						},
						invalidate(): void {},
						dispose(): void {
							clear();
						},
					};
				},
				{ overlay: true },
			);
		},
	};
}

function renderRunningOnly(runtime: AutoresearchRuntime, state: ExperimentState, theme: Theme): string {
	const parts = [theme.fg("accent", t("autoresearch")), theme.fg("warning", t(" running..."))];
	if (state.name) {
		parts.push(theme.fg("dim", ` | ${replaceTabs(state.name)}`));
	}
	if (runtime.runningExperiment) {
		parts.push(theme.fg("dim", ` | ${replaceTabs(runtime.runningExperiment.command)}`));
	}
	return parts.join("");
}

function shouldShowDashboard(runtime: AutoresearchRuntime, state: ExperimentState): boolean {
	return (
		runtime.autoresearchMode ||
		state.results.length > 0 ||
		runtime.runningExperiment !== null ||
		runtime.lastRunSummary !== null
	);
}

function renderExpandedHeader(runtime: AutoresearchRuntime, width: number, theme: Theme): string {
	const state = runtime.state;
	const status = renderModeStatus(runtime, state);
	const label = state.name ? t(" autoresearch: {name} ", { name: replaceTabs(state.name) }) : t(" autoresearch ");
	const hint = theme.fg("dim", `${t(" ctrl+x collapse  ctrl+shift+x overlay ")}${status ? `  ${status}` : ""}`);
	const fillWidth = Math.max(0, width - visibleWidth(label) - visibleWidth(hint));
	return truncateToWidth(theme.fg("accent", label) + theme.fg("borderMuted", "-".repeat(fillWidth)) + hint, width);
}

function renderCollapsedLine(runtime: AutoresearchRuntime, state: ExperimentState, theme: Theme): string {
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
		parts.push(theme.fg("dim", ` | ${renderModeStatus(runtime, state)}`));
	}
	parts.push(theme.fg("dim", t(" | ctrl+x expand")));
	return parts.join("");
}

export function renderDashboardLines(
	runtime: AutoresearchRuntime,
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
		lines.push(truncateToWidth(t("Mode: {status}", { status: renderModeStatus(runtime, state) }), width));
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
	lines.push(renderTableHeader(state, width, theme));
	lines.push(theme.fg("borderMuted", "-".repeat(Math.max(0, width - 1))));

	const visible = maxRows > 0 ? current.slice(-maxRows) : current;
	if (visible.length < current.length) {
		lines.push(theme.fg("dim", t("... {count} earlier runs hidden ...", { count: current.length - visible.length })));
	}
	for (const result of visible) {
		lines.push(renderResultRow(result, state, baselineSecondary, width, theme));
	}
	return lines;
}

function renderTableHeader(state: ExperimentState, width: number, theme: Theme): string {
	const secondaryHeader = state.secondaryMetrics.map(metric => truncateToWidth(metric.name, 10)).join(" ");
	return truncateToWidth(
		`${theme.fg("muted", "#".padEnd(4))}${theme.fg("muted", t("commit").padEnd(10))}${theme.fg("warning", state.metricName.padEnd(12))}${secondaryHeader ? `${theme.fg("muted", secondaryHeader)} ` : ""}${theme.fg("muted", t("status").padEnd(14))}${theme.fg("muted", t("description"))}`,
		width,
	);
}

function renderResultRow(
	result: ExperimentResult,
	state: ExperimentState,
	baselineSecondary: { [key: string]: number },
	width: number,
	theme: Theme,
): string {
	const runNumber = result.runNumber ?? state.results.indexOf(result) + 1;
	const secondary = state.secondaryMetrics
		.map(metric =>
			truncateToWidth(
				renderSecondaryCell(result.metrics[metric.name], metric.unit, baselineSecondary[metric.name]),
				10,
			).padEnd(11),
		)
		.join("");
	const statusColor = result.status === "keep" ? "success" : result.status === "discard" ? "warning" : "error";
	const line =
		`${theme.fg("dim", String(runNumber).padEnd(4))}` +
		`${theme.fg("accent", (result.commit || "-").padEnd(10))}` +
		`${theme.fg(statusColor, formatNum(result.metric, state.metricUnit).padEnd(12))}` +
		`${secondary}` +
		`${theme.fg(statusColor, t(result.status).padEnd(14))}` +
		`${theme.fg("muted", replaceTabs(result.description))}`;
	return truncateToWidth(line, width);
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
	runtime: AutoresearchRuntime,
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
	const hint = theme.fg("dim", t(" up/down j/k pageup pagedown g G esc "));
	const fill = Math.max(0, width - visibleWidth(hint));
	return theme.fg("borderMuted", "-".repeat(fill)) + hint;
}

function renderModeStatus(runtime: AutoresearchRuntime, state: ExperimentState): string {
	if (runtime.autoresearchMode) {
		return state.results.length === 0 ? t("baseline pending") : t("mode on");
	}
	const current = currentResults(state.results, state.currentSegment);
	if (state.maxExperiments !== null && current.length >= state.maxExperiments) {
		return t("segment complete");
	}
	return t("mode off");
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
