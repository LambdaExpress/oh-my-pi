import { ProviderHttpError } from "../error";
import type {
	CredentialRankingStrategy,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
} from "../usage";
import { isRecord } from "../utils";
import { HOUR_MS, parsePositiveTimestamp, usageStatus, WEEK_MS } from "./shared";

const PROVIDER = "commandcode";
const DEFAULT_ORIGIN = "https://api.commandcode.ai";
const WHOAMI_PATH = "/alpha/whoami";
const CREDITS_PATH = "/alpha/billing/credits";

/** Account routes live at the origin, not the inference `/provider/v1` base. */
function resolveOrigin(baseUrl: string | undefined): string {
	const trimmed = baseUrl?.trim();
	if (!trimmed) return DEFAULT_ORIGIN;
	try {
		return new URL(trimmed).origin;
	} catch {
		return DEFAULT_ORIGIN;
	}
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A 401 invalidates the bearer; 403 can mean no access to a usage-only route. */
async function getJson(
	url: string,
	token: string,
	signal: AbortSignal | undefined,
	ctx: UsageFetchContext,
): Promise<Record<string, unknown> | null> {
	try {
		const response = await ctx.fetch(url, {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
			signal,
		});
		if (!response.ok) {
			if (response.status === 401) {
				throw new ProviderHttpError(
					`Command Code usage endpoint returned ${response.status} ${response.statusText}`.trim(),
					response.status,
				);
			}
			ctx.logger?.warn("Command Code usage fetch failed", {
				url,
				status: response.status,
				statusText: response.statusText,
			});
			return null;
		}
		const json: unknown = await response.json();
		if (!isRecord(json)) return null;
		return isRecord(json.data) ? json.data : json;
	} catch (error) {
		if (error instanceof ProviderHttpError) throw error;
		ctx.logger?.warn("Command Code usage fetch error", { url, error: String(error) });
		return null;
	}
}

interface WindowSpec {
	key: "fiveHour" | "weekly";
	id: "5h" | "7d";
	limitLabel: string;
	windowLabel: string;
	durationMs: number;
}

const WINDOWS: readonly WindowSpec[] = [
	{ key: "fiveHour", id: "5h", limitLabel: "5-hour limit", windowLabel: "5-hour", durationMs: 5 * HOUR_MS },
	{ key: "weekly", id: "7d", limitLabel: "Weekly limit", windowLabel: "Weekly", durationMs: WEEK_MS },
];

function buildWindowLimit(
	spec: WindowSpec,
	raw: unknown,
	accountId: string | undefined,
	orgId: string | undefined,
): UsageLimit | undefined {
	if (!isRecord(raw)) return undefined;
	const used = finiteNumber(raw.used);
	if (used === undefined || used < 0) return undefined;
	const cap = finiteNumber(raw.cap);
	// Zero caps mean unmetered, not exhausted. An absent cap can still report
	// absolute usage, but an explicitly malformed/negative cap cannot.
	if (raw.cap !== undefined && (cap === undefined || cap <= 0)) return undefined;
	const usedFraction = cap !== undefined ? Math.min(1, used / cap) : undefined;
	const resetsAt = parsePositiveTimestamp(raw.resetAt);
	return {
		id: `${PROVIDER}:${spec.id}`,
		label: spec.limitLabel,
		scope: {
			provider: PROVIDER,
			...(accountId ? { accountId } : {}),
			...(orgId ? { orgId } : {}),
			windowId: spec.id,
			shared: true,
		},
		window: {
			id: spec.id,
			label: spec.windowLabel,
			durationMs: spec.durationMs,
			...(resetsAt !== undefined ? { resetsAt } : {}),
		},
		amount: {
			used,
			...(cap !== undefined ? { limit: cap } : {}),
			...(usedFraction !== undefined ? { usedFraction, remainingFraction: Math.max(0, 1 - usedFraction) } : {}),
			unit: "credits",
		},
		// The API flag accounts for plan rounding that a raw fraction cannot see.
		status: raw.exceeded === true ? "exhausted" : usageStatus(usedFraction),
	};
}

/** Reports subscription windows and the spendable balance for either bearer type. */
async function fetchCommandCodeUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== PROVIDER) return null;
	const token = nonEmptyString(params.credential.accessToken) ?? nonEmptyString(params.credential.apiKey);
	if (!token) return null;
	const origin = resolveOrigin(params.baseUrl);

	// Identity is optional: transient lookup failures must not hide credits.
	// A rejected bearer still throws from getJson for credential health.
	const whoami = await getJson(`${origin}${WHOAMI_PATH}`, token, params.signal, ctx);
	const userData = whoami?.user;
	const orgData = whoami?.org;
	const user = isRecord(userData) ? userData : undefined;
	const org = isRecord(orgData) ? orgData : undefined;
	const userId = nonEmptyString(user?.id) ?? nonEmptyString(params.credential.accountId);
	const orgId =
		nonEmptyString(org?.id) ??
		nonEmptyString(whoami?.org) ??
		nonEmptyString(whoami?.orgId) ??
		nonEmptyString(params.credential.orgId);
	const orgName = nonEmptyString(org?.login) ?? nonEmptyString(org?.name) ?? nonEmptyString(params.credential.orgName);

	const creditsUrl = `${origin}${CREDITS_PATH}${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`;
	const creditsBody = await getJson(creditsUrl, token, params.signal, ctx);
	if (!creditsBody) return null;
	if (creditsBody.windowLimits !== undefined && !isRecord(creditsBody.windowLimits)) {
		ctx.logger?.warn("Command Code credits response had a malformed windowLimits block");
		return null;
	}
	const credits = isRecord(creditsBody.credits) ? creditsBody.credits : undefined;
	const monthly = finiteNumber(credits?.monthlyCredits);
	const purchased = finiteNumber(credits?.purchasedCredits);
	const free = finiteNumber(credits?.freeCredits);
	const limits: UsageLimit[] = [];
	const windowLimits = isRecord(creditsBody.windowLimits) ? creditsBody.windowLimits : undefined;
	for (const spec of WINDOWS) {
		const limit = buildWindowLimit(spec, windowLimits?.[spec.key], userId, orgId);
		if (limit) limits.push(limit);
	}
	if (monthly !== undefined || purchased !== undefined || free !== undefined) {
		limits.push({
			id: `${PROVIDER}:balance`,
			label: "Credit balance",
			scope: {
				provider: PROVIDER,
				...(userId ? { accountId: userId } : {}),
				...(orgId ? { orgId } : {}),
				windowId: "balance",
				shared: true,
			},
			amount: { remaining: (monthly ?? 0) + (purchased ?? 0) + (free ?? 0), unit: "credits" },
		});
	} else if (!windowLimits) {
		return null;
	}

	const email = nonEmptyString(user?.email) ?? nonEmptyString(params.credential.email);
	const displayName = nonEmptyString(user?.name) ?? nonEmptyString(user?.userName);
	const planType = nonEmptyString(credits?.planId);
	return {
		provider: PROVIDER,
		fetchedAt: Date.now(),
		limits,
		metadata: {
			...(userId ? { accountId: userId } : {}),
			...(email ? { email } : {}),
			...(displayName ? { user: displayName } : {}),
			...(orgId ? { orgId } : {}),
			...(orgName ? { orgName } : {}),
			...(planType ? { planType } : {}),
			endpoint: creditsUrl,
		},
		raw: { whoami, credits: creditsBody },
	};
}

export const commandCodeUsageProvider: UsageProvider = {
	id: PROVIDER,
	fetchUsage: fetchCommandCodeUsage,
	supports: params =>
		params.provider === PROVIDER &&
		(nonEmptyString(params.credential.accessToken) ?? nonEmptyString(params.credential.apiKey)) !== undefined,
	validatesCredentials: true,
};

/** Ranks Command Code accounts by the 5-hour and weekly credit windows. */
export const commandCodeRankingStrategy: CredentialRankingStrategy = {
	findWindowLimits: report => ({
		primary: report.limits.find(limit => limit.window?.id === "5h"),
		secondary: report.limits.find(limit => limit.window?.id === "7d"),
	}),
	windowDefaults: {
		primaryMs: 5 * HOUR_MS,
		secondaryMs: WEEK_MS,
	},
};
