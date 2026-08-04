import type { UsageCostHistoryEntry, UsageLimit, UsageProvider, UsageWindow } from "../usage";

const OPENCODE_GO_PROVIDER = "opencode-go";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FIVE_HOUR_MS = 5 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_HISTORY_LOOKBACK_MS = 32 * DAY_MS;
const OPENCODE_GO_LIMITS = [
	{ id: "rolling-5h", label: "5 Hour", limitUsd: 12 },
	{ id: "weekly", label: "Weekly", limitUsd: 30 },
	{ id: "monthly", label: "Monthly", limitUsd: 60 },
] as const;

interface WindowUsage {
	durationMs: number;
	resetsAt: number;
	used: number;
}

function sumWindowCosts(entries: UsageCostHistoryEntry[], startMs: number, nowMs: number): number {
	let used = 0;
	for (const entry of entries) {
		if (entry.recordedAt < startMs || entry.recordedAt > nowMs) continue;
		used += entry.costUsd;
	}
	return used;
}

function rollingWindowUsage(entries: UsageCostHistoryEntry[], nowMs: number): WindowUsage {
	let windowStartedAt: number | undefined;
	let used = 0;
	for (const entry of entries) {
		if (entry.recordedAt > nowMs) continue;
		if (windowStartedAt === undefined || entry.recordedAt - windowStartedAt > FIVE_HOUR_MS) {
			windowStartedAt = entry.recordedAt;
			used = entry.costUsd;
			continue;
		}
		used += entry.costUsd;
	}
	if (windowStartedAt === undefined || windowStartedAt < nowMs - FIVE_HOUR_MS) {
		return { durationMs: FIVE_HOUR_MS, resetsAt: nowMs + FIVE_HOUR_MS, used: 0 };
	}
	return { durationMs: FIVE_HOUR_MS, resetsAt: windowStartedAt + FIVE_HOUR_MS, used };
}

function weeklyWindowUsage(entries: UsageCostHistoryEntry[], nowMs: number): WindowUsage {
	const now = new Date(nowMs);
	const offset = (now.getUTCDay() + 6) % 7;
	const start = new Date(now);
	start.setUTCDate(now.getUTCDate() - offset);
	start.setUTCHours(0, 0, 0, 0);
	const resetsAt = start.getTime() + WEEK_MS;
	return {
		durationMs: WEEK_MS,
		resetsAt,
		used: sumWindowCosts(entries, start.getTime(), nowMs),
	};
}

function monthlyBounds(nowMs: number, anchorMs: number): { startMs: number; endMs: number } {
	const now = new Date(nowMs);
	const anchor = new Date(anchorMs);
	const day = anchor.getUTCDate();
	const hours = anchor.getUTCHours();
	const minutes = anchor.getUTCMinutes();
	const seconds = anchor.getUTCSeconds();
	const milliseconds = anchor.getUTCMilliseconds();
	const atMonth = (year: number, month: number): number => {
		const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
		return Date.UTC(year, month, Math.min(day, lastDay), hours, minutes, seconds, milliseconds);
	};
	let year = now.getUTCFullYear();
	let month = now.getUTCMonth();
	let startMs = atMonth(year, month);
	if (startMs > nowMs) {
		month -= 1;
		if (month < 0) {
			month = 11;
			year -= 1;
		}
		startMs = atMonth(year, month);
	}
	month += 1;
	if (month > 11) {
		month = 0;
		year += 1;
	}
	return { startMs, endMs: atMonth(year, month) };
}

function monthlyWindowUsage(entries: UsageCostHistoryEntry[], nowMs: number): WindowUsage {
	// OpenCode anchors this period to the subscription creation timestamp, which
	// its API key does not expose. The first locally observed request is the only
	// stable proxy available without scraping an authenticated console session.
	const anchorMs = entries.find(entry => entry.recordedAt <= nowMs)?.recordedAt ?? nowMs;
	const bounds = monthlyBounds(nowMs, anchorMs);
	return {
		durationMs: bounds.endMs - bounds.startMs,
		resetsAt: bounds.endMs,
		used: sumWindowCosts(entries, bounds.startMs, nowMs),
	};
}

function resolveStatus(usedFraction: number): UsageLimit["status"] {
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.8) return "warning";
	return "ok";
}

function buildWindowLimit(
	limit: (typeof OPENCODE_GO_LIMITS)[number],
	entries: UsageCostHistoryEntry[],
	nowMs: number,
): UsageLimit {
	const usage =
		limit.id === "rolling-5h"
			? rollingWindowUsage(entries, nowMs)
			: limit.id === "weekly"
				? weeklyWindowUsage(entries, nowMs)
				: monthlyWindowUsage(entries, nowMs);
	const used = Number(usage.used.toFixed(6));
	const usedFraction = used / limit.limitUsd;
	const window: UsageWindow = {
		id: limit.id,
		label: limit.label,
		durationMs: usage.durationMs,
		resetsAt: usage.resetsAt,
	};
	return {
		id: limit.id,
		label: `${limit.label} limit`,
		scope: {
			provider: OPENCODE_GO_PROVIDER,
			windowId: limit.id,
		},
		window,
		amount: {
			used,
			limit: limit.limitUsd,
			remaining: Math.max(0, limit.limitUsd - used),
			usedFraction,
			remainingFraction: Math.max(0, 1 - usedFraction),
			unit: "usd",
		},
		status: resolveStatus(usedFraction),
	};
}

export const opencodeGoUsageProvider: UsageProvider = {
	id: OPENCODE_GO_PROVIDER,
	supports: params => params.provider === OPENCODE_GO_PROVIDER && params.credential.type === "api_key",
	validatesCredentials: false,
	async fetchUsage(params, ctx) {
		if (params.provider !== OPENCODE_GO_PROVIDER || params.credential.type !== "api_key") return null;
		const nowMs = Date.now();
		const entries =
			ctx.listUsageCosts?.({
				provider: OPENCODE_GO_PROVIDER,
				accountKey: params.accountKey,
				sinceMs: nowMs - MONTH_HISTORY_LOOKBACK_MS,
			}) ?? [];
		return {
			provider: OPENCODE_GO_PROVIDER,
			fetchedAt: nowMs,
			limits: OPENCODE_GO_LIMITS.map(limit => buildWindowLimit(limit, entries, nowMs)),
			notes: [
				"OMP-observed spend only; OpenCode usage outside OMP is not included.",
				"Monthly reset is estimated from the first OMP-observed request because the API key does not expose the subscription timestamp.",
			],
			metadata: {
				planType: "OpenCode Go",
				source: "omp-observed-request-costs",
			},
		};
	},
};
