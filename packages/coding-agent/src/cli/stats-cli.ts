/**
 * Stats CLI command handlers.
 *
 * Handles `omp stats` subcommand for viewing AI usage statistics.
 */

import { formatKeyHint } from "@oh-my-pi/pi-tui/key-hint-format";
import { formatCost } from "@oh-my-pi/pi-tui/overlays/agent-hub-renderer";
import { truncateToWidth } from "@oh-my-pi/pi-tui/utils";
import { formatDuration, formatNumber, formatPercent, normalizePremiumRequests } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { t } from "../i18n";
import { openStandaloneJudge } from "../judgment/standalone";
import { openPath } from "../utils/open";

/**
 * Single-line TTY progress bar. On a non-TTY stream we just stay quiet -
 * the final "Synced ..." summary still prints either way.
 */
function createSyncProgressReporter(): {
	onProgress: (event: { current: number; total: number; sessionFile: string }) => void;
	finish: () => void;
} {
	const stream = process.stderr;
	const isTty = stream.isTTY === true;
	let lastWidth = 0;
	let lastRender = 0;
	return {
		onProgress(event) {
			if (!isTty) return;
			const now = Date.now();
			// Throttle to ~30 fps and always force a render for the last file.
			if (event.current < event.total && now - lastRender < 33) return;
			lastRender = now;
			const label = chalk.dim(shortenSessionFile(event.sessionFile));
			const pct = ((event.current / event.total) * 100).toFixed(0).padStart(3, " ");
			const counter = chalk.cyan(`[${event.current}/${event.total}]`);
			const line = `${counter} ${pct}%  ${label}`;
			const columns = stream.columns ?? 120;
			const trimmed = truncateToWidth(line, columns - 1);
			stream.write(`\r${trimmed.padEnd(lastWidth)}`);
			lastWidth = trimmed.length;
		},
		finish() {
			if (!isTty || lastWidth === 0) return;
			stream.write(`\r${" ".repeat(lastWidth)}\r`);
			lastWidth = 0;
		},
	};
}

function shortenSessionFile(p: string): string {
	const marker = "/sessions/";
	const idx = p.indexOf(marker);
	return idx >= 0 ? p.slice(idx + marker.length) : p;
}

// =============================================================================
// Types
// =============================================================================

export interface StatsCommandArgs {
	port: number;
	host: string;
	json: boolean;
	summary: boolean;
}

// =============================================================================
// Command Handler
// =============================================================================

export async function runStatsCommand(cmd: StatsCommandArgs): Promise<void> {
	// Lazy import to avoid loading stats module when not needed
	const {
		closeDb,
		formatStatsDashboardUrl,
		getDashboardStats,
		getTotalMessageCount,
		refreshRollups,
		startServer,
		syncAllSessions,
	} = await import("@oh-my-pi/omp-stats");

	// One-shot reports need fully ingested, fully rolled-up data before printing.
	if (cmd.json || cmd.summary) {
		const progress = createSyncProgressReporter();
		process.stderr.write(`${t("Syncing session files...")}\n`);
		const { processed, files } = await syncAllSessions({ onProgress: progress.onProgress });
		progress.finish();
		await refreshRollups();
		const total = await getTotalMessageCount();
		process.stderr.write(
			`${t("Synced {processed} new entries from {files} files ({total} total)", { processed, files, total })}\n\n`,
		);
		if (cmd.json) {
			console.log(JSON.stringify(await getDashboardStats(), null, 2));
		} else {
			await printStatsSummary();
		}
		return;
	}

	// The dashboard starts immediately and ingests sessions in the background,
	// streaming progress to the page. The judge (settings, auth, registry)
	// resolves on the first Frustration estimate/run and lives until exit.
	const cwd = process.cwd();
	const { hostname, port } = await startServer(cmd.port, cmd.host, {
		judge: async () => (await openStandaloneJudge(cwd, "stats_frustration")).judge,
	});
	const url = formatStatsDashboardUrl(hostname, port);
	console.log(chalk.green(t("Dashboard available at: {url}", { url })));

	// Open browser
	openPath(url);

	console.log(`${t("Press {key} to stop", { key: formatKeyHint("ctrl+c") })}\n`);

	// Keep process running
	process.on("SIGINT", () => {
		console.log(`\n${t("Shutting down...")}`);
		closeDb();
		process.exit(0);
	});

	// Keep the process alive
	await new Promise(() => {});
}

async function printStatsSummary(): Promise<void> {
	const { getDashboardStats } = await import("@oh-my-pi/omp-stats");
	const stats = await getDashboardStats();
	const { overall, byModel, byFolder } = stats;

	console.log(chalk.bold(`\n${t("=== AI Usage Statistics ===")}\n`));

	console.log(chalk.bold(t("Overall:")));
	console.log(
		`  ${t("Requests: {requests} ({errors} errors)", {
			requests: formatNumber(overall.totalRequests),
			errors: formatNumber(overall.failedRequests),
		})}`,
	);
	console.log(`  ${t("Error Rate: {rate}", { rate: formatPercent(overall.errorRate) })}`);
	console.log(
		`  ${t("Total Tokens: {count}", { count: formatNumber(overall.totalInputTokens + overall.totalOutputTokens) })}`,
	);
	console.log(`  ${t("Input Tokens: {count}", { count: formatNumber(overall.totalInputTokens) })}`);
	console.log(`  ${t("Output Tokens: {count}", { count: formatNumber(overall.totalOutputTokens) })}`);
	console.log(`  ${t("Cache Rate: {rate}", { rate: formatPercent(overall.cacheRate) })}`);
	console.log(`  ${t("Cache Savings: {rate}", { rate: formatPercent(overall.cacheSavings) })}`);
	console.log(
		`  ${t("API-equivalent estimate: {cost}", {
			cost: overall.totalCost === 0 && overall.unpricedRequests > 0 ? t("N/A") : formatCost(overall.totalCost),
		})}`,
	);
	console.log(
		`  ${t("Premium Requests: {count}", {
			count: formatNumber(normalizePremiumRequests(overall.totalPremiumRequests ?? 0)),
		})}`,
	);
	console.log(
		`  ${t("Avg Duration: {value}", {
			value: overall.avgDuration !== null ? formatDuration(overall.avgDuration) : "-",
		})}`,
	);
	console.log(
		`  ${t("Avg TTFT: {value}", { value: overall.avgTtft !== null ? formatDuration(overall.avgTtft) : "-" })}`,
	);
	if (overall.avgTokensPerSecond !== null) {
		console.log(`  ${t("Avg Tokens/s: {value}", { value: overall.avgTokensPerSecond.toFixed(1) })}`);
	}

	if (byModel.length > 0) {
		console.log(chalk.bold(`\n${t("By Model (API-equivalent estimates):")}`));
		for (const m of byModel.slice(0, 10)) {
			console.log(
				`  ${t("{model}: {requests} reqs, {cost}, {cacheRate} cache rate, {cacheSavings} cache savings", {
					model: m.model,
					requests: formatNumber(m.totalRequests),
					cost: m.totalCost === 0 && m.unpricedRequests > 0 ? t("N/A") : formatCost(m.totalCost),
					cacheRate: formatPercent(m.cacheRate),
					cacheSavings: formatPercent(m.cacheSavings),
				})}`,
			);
		}
	}

	if (byFolder.length > 0) {
		console.log(chalk.bold(`\n${t("By Folder (API-equivalent estimates):")}`));
		for (const f of byFolder.slice(0, 10)) {
			console.log(
				`  ${t("{folder}: {requests} reqs, {cost}", {
					folder: f.folder,
					requests: formatNumber(f.totalRequests),
					cost: f.totalCost === 0 && f.unpricedRequests > 0 ? t("N/A") : formatCost(f.totalCost),
				})}`,
			);
		}
	}

	console.log("");
}
