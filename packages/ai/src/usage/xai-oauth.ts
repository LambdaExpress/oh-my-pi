/**
 * SuperGrok (`xai-oauth`) subscription usage provider.
 *
 * Reads weekly credit and product utilization from the Grok CLI billing
 * endpoint. Only OAuth access credentials are accepted; paid API keys are a
 * separate product and must never be sent here.
 */

import {
	buildXAICliBillingUrl,
	extractXAIAccessTokenSubject,
	fetchXAIOAuthIdentity,
	getXAICliBillingHeaders,
} from "../registry/oauth/xai-oauth";
import type {
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageWindow,
} from "../usage";
import { isRecord } from "../utils";
import { toNumber } from "./shared";

const PROVIDER_ID = "xai-oauth";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface XaiBillingPeriod {
	start: string;
	end: string;
	type: string;
}

interface XaiProductUsage {
	product: string;
	usagePercent: number;
}

interface XaiBillingConfig {
	currentPeriod: XaiBillingPeriod;
	creditUsagePercent: number;
	productUsage: XaiProductUsage[];
	onDemandCap?: number;
	onDemandUsed?: number;
}

function parseIsoMs(value: string): number | undefined {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parsePercent(value: unknown): number | undefined {
	const percent = toNumber(value);
	return percent !== undefined && percent >= 0 && percent <= 100 ? percent : undefined;
}

function parseOnDemandAmount(value: unknown): number | undefined {
	if (!isRecord(value)) return undefined;
	const amount = toNumber(value.val);
	return amount !== undefined && amount >= 0 ? amount : undefined;
}

function buildPercentAmount(usagePercent: number): UsageAmount {
	const usedFraction = usagePercent / 100;
	return {
		used: usagePercent,
		limit: 100,
		remaining: 100 - usagePercent,
		usedFraction,
		remainingFraction: 1 - usedFraction,
		unit: "percent",
	};
}

function buildUsageStatus(usedFraction: number): UsageStatus {
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.9) return "warning";
	return "ok";
}

function slugifyProduct(product: string): string {
	return product
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function buildPeriodWindow(period: XaiBillingPeriod): UsageWindow {
	return {
		id: "1w",
		label: "Weekly",
		durationMs: WEEK_MS,
		resetsAt: parseIsoMs(period.end),
	};
}

function parseBillingConfig(payload: unknown): XaiBillingConfig | null {
	if (!isRecord(payload) || !isRecord(payload.config)) return null;
	const raw = payload.config;
	if (!isRecord(raw.currentPeriod)) return null;

	const start = typeof raw.currentPeriod.start === "string" ? parseIsoMs(raw.currentPeriod.start) : undefined;
	const end = typeof raw.currentPeriod.end === "string" ? parseIsoMs(raw.currentPeriod.end) : undefined;
	const type = typeof raw.currentPeriod.type === "string" ? raw.currentPeriod.type : "";
	// Keep recently-ended weekly windows so /usage still renders across period
	// rollover while the billing API is mid-refresh. Reject only inverted ranges
	// and non-weekly period types.
	if (start === undefined || end === undefined || end <= start || !type.toUpperCase().includes("WEEK")) {
		return null;
	}

	const creditUsagePercent = parsePercent(raw.creditUsagePercent);
	if (creditUsagePercent === undefined) return null;

	const productUsage: XaiProductUsage[] = [];
	if (raw.productUsage !== undefined) {
		if (!Array.isArray(raw.productUsage)) return null;
		for (const item of raw.productUsage) {
			if (!isRecord(item)) continue;
			const product = typeof item.product === "string" ? item.product.trim() : "";
			const usagePercent = parsePercent(item.usagePercent);
			if (!product || usagePercent === undefined) continue;
			productUsage.push({ product, usagePercent });
		}
	}

	return {
		currentPeriod: {
			start: raw.currentPeriod.start as string,
			end: raw.currentPeriod.end as string,
			type,
		},
		creditUsagePercent,
		productUsage,
		onDemandCap: parseOnDemandAmount(raw.onDemandCap),
		onDemandUsed: parseOnDemandAmount(raw.onDemandUsed),
	};
}

function buildLimits(config: XaiBillingConfig, accountId: string | undefined): UsageLimit[] {
	const window = buildPeriodWindow(config.currentPeriod);
	const scope = {
		provider: PROVIDER_ID,
		...(accountId ? { accountId } : {}),
		windowId: window.id,
		shared: true as const,
	};
	const overall = buildPercentAmount(config.creditUsagePercent);
	const limits: UsageLimit[] = [
		{
			id: `${PROVIDER_ID}:credits:1w`,
			label: "SuperGrok Weekly Credits",
			scope,
			window,
			amount: overall,
			status: buildUsageStatus(overall.usedFraction ?? 0),
		},
	];

	for (const item of config.productUsage) {
		const amount = buildPercentAmount(item.usagePercent);
		const slug = slugifyProduct(item.product);
		if (!slug) continue;
		limits.push({
			id: `${PROVIDER_ID}:product:${slug}:1w`,
			label: `${item.product === "GrokBuild" ? "Grok Build" : item.product === "Api" ? "API" : item.product} (Weekly)`,
			scope,
			window,
			amount,
			status: buildUsageStatus(amount.usedFraction ?? 0),
		});
	}
	if (config.onDemandCap !== undefined && config.onDemandCap > 0 && config.onDemandUsed !== undefined) {
		const usedFraction = Math.min(config.onDemandUsed / config.onDemandCap, 1);
		limits.push({
			id: `${PROVIDER_ID}:on-demand`,
			label: "On-demand",
			scope: {
				provider: PROVIDER_ID,
				...(accountId ? { accountId } : {}),
				shared: true,
			},
			amount: {
				used: config.onDemandUsed,
				limit: config.onDemandCap,
				remaining: Math.max(0, config.onDemandCap - config.onDemandUsed),
				usedFraction,
				remainingFraction: 1 - usedFraction,
				unit: "unknown",
			},
			status: buildUsageStatus(usedFraction),
		});
	}

	return limits;
}

export const xaiOauthUsageProvider: UsageProvider = {
	id: PROVIDER_ID,

	supports(params: UsageFetchParams): boolean {
		return params.provider === PROVIDER_ID && params.credential.type === "oauth" && !!params.credential.accessToken;
	},

	async fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
		if (params.provider !== PROVIDER_ID || params.credential.type !== "oauth") return null;
		const accessToken = params.credential.accessToken?.trim();
		if (!accessToken) return null;
		if (params.credential.expiresAt !== undefined && params.credential.expiresAt <= Date.now()) return null;

		let accountId = params.credential.accountId?.trim() || extractXAIAccessTokenSubject(accessToken);
		let email = params.credential.email?.trim().toLowerCase();
		if (!email) {
			try {
				const identity = await fetchXAIOAuthIdentity(accessToken, ctx.fetch, params.signal);
				email = identity?.email?.trim().toLowerCase() || undefined;
				accountId ??= identity?.accountId?.trim() || undefined;
			} catch {
				// Identity enrichment is best effort; billing remains authoritative.
			}
		}

		const url = buildXAICliBillingUrl();
		let payload: unknown;
		try {
			const response = await ctx.fetch(url, {
				headers: getXAICliBillingHeaders({ accessToken }),
				redirect: "error",
				signal: params.signal,
			});
			if (!response.ok) return null;
			payload = await response.json();
		} catch {
			return null;
		}

		const config = parseBillingConfig(payload);
		if (!config) return null;
		return {
			provider: PROVIDER_ID,
			fetchedAt: Date.now(),
			limits: buildLimits(config, accountId),
			metadata: {
				endpoint: url,
				source: "cli-chat-proxy.grok.com/v1/billing",
				...(accountId ? { accountId } : {}),
				...(email ? { email } : {}),
			},
			raw: payload,
		};
	},
};
