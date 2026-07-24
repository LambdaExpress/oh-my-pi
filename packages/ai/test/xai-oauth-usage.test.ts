import { describe, expect, it } from "bun:test";
import { buildXAICliBillingUrl } from "@oh-my-pi/pi-ai/oauth/xai-oauth";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import { xaiOauthUsageProvider } from "@oh-my-pi/pi-ai/usage/xai-oauth";

const USER_ID = "cf12ecb5-cca4-4ba0-9f02-298071a2d052";

const accessTokenFixture = (() => {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const body = Buffer.from(JSON.stringify({ sub: USER_ID })).toString("base64url");
	return `${header}.${body}.sig`;
})();

function makeBillingPayload(overrides?: Record<string, unknown>) {
	const periodEnd = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
	const periodStart = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
	return {
		config: {
			creditUsagePercent: 18,
			currentPeriod: {
				end: periodEnd,
				start: periodStart,
				type: "USAGE_PERIOD_TYPE_WEEKLY",
			},
			productUsage: [
				{ product: "GrokBuild", usagePercent: 16 },
				{ product: "Api", usagePercent: 2 },
			],
			...overrides,
		},
	};
}

function makeCredential(overrides?: Partial<UsageFetchParams["credential"]>): UsageFetchParams["credential"] {
	return {
		type: "oauth",
		accessToken: accessTokenFixture,
		refreshToken: "refresh-fixture",
		expiresAt: Date.now() + 3_600_000,
		...overrides,
	};
}

function capturingFetch(payload: unknown): {
	fetch: FetchImpl;
	calls: Array<{ url: string; headers: Record<string, string>; redirect?: RequestInit["redirect"] }>;
} {
	const calls: Array<{ url: string; headers: Record<string, string>; redirect?: RequestInit["redirect"] }> = [];
	const fetch: FetchImpl = async (input, init) => {
		const headers: Record<string, string> = {};
		const raw = init?.headers;
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			for (const [key, value] of Object.entries(raw as Record<string, string>)) {
				headers[key.toLowerCase()] = value;
			}
		}
		const url = String(input);
		calls.push({ url, headers, redirect: init?.redirect });
		if (url.includes("/oauth2/userinfo")) {
			return new Response(JSON.stringify({ sub: USER_ID, email: "user@example.com" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch, calls };
}

describe("xai-oauth usage provider", () => {
	it("accepts stored OAuth credentials but never shared API-key fallbacks", () => {
		expect(xaiOauthUsageProvider.supports?.({ provider: "xai-oauth", credential: makeCredential() })).toBe(true);
		expect(
			xaiOauthUsageProvider.supports?.({
				provider: "xai-oauth",
				credential: { type: "api_key", apiKey: accessTokenFixture },
			}),
		).toBe(false);
	});

	it("maps weekly credit and product usage with CLI-aligned billing headers", async () => {
		const { fetch, calls } = capturingFetch(makeBillingPayload());
		const report = await xaiOauthUsageProvider.fetchUsage(
			{ provider: "xai-oauth", credential: makeCredential() },
			{ fetch: fetch },
		);

		expect(report?.limits.map(limit => limit.id)).toEqual([
			"xai-oauth:credits:1w",
			"xai-oauth:product:grokbuild:1w",
			"xai-oauth:product:api:1w",
		]);
		expect(report?.limits[0]?.amount.usedFraction).toBeCloseTo(0.18, 5);
		expect(report?.metadata?.accountId).toBe(USER_ID);
		expect(report?.metadata?.email).toBe("user@example.com");

		const billingCall = calls.find(call => call.url.includes("/v1/billing"));
		expect(billingCall?.url).toBe(buildXAICliBillingUrl());
		expect(billingCall?.headers).toEqual({
			authorization: `Bearer ${accessTokenFixture}`,
			accept: "application/json",
			"x-xai-token-auth": "xai-grok-cli",
		});
		expect(billingCall?.redirect).toBe("error");
	});

	it("uses a stored email without an extra userinfo request", async () => {
		const { fetch, calls } = capturingFetch(makeBillingPayload());
		const report = await xaiOauthUsageProvider.fetchUsage(
			{
				provider: "xai-oauth",
				credential: makeCredential({ accountId: "stored-account", email: "stored@example.com" }),
			},
			{ fetch: fetch },
		);

		expect(report?.metadata?.accountId).toBe("stored-account");
		expect(report?.metadata?.email).toBe("stored@example.com");
		expect(calls.some(call => call.url.includes("/oauth2/userinfo"))).toBe(false);
	});

	it("maps a positive on-demand cap", async () => {
		const report = await xaiOauthUsageProvider.fetchUsage(
			{
				provider: "xai-oauth",
				credential: makeCredential(),
			},
			{ fetch: capturingFetch(makeBillingPayload({ onDemandCap: { val: 50 }, onDemandUsed: { val: 10 } })).fetch },
		);

		const onDemand = report?.limits.find(limit => limit.id === "xai-oauth:on-demand");
		expect(onDemand?.amount.used).toBe(10);
		expect(onDemand?.amount.limit).toBe(50);
		expect(onDemand?.amount.usedFraction).toBeCloseTo(0.2, 5);
	});

	it("still reports usage when the weekly period has just ended", async () => {
		const periodEnd = new Date(Date.now() - 60_000).toISOString();
		const periodStart = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
		const report = await xaiOauthUsageProvider.fetchUsage(
			{ provider: "xai-oauth", credential: makeCredential() },
			{
				fetch: capturingFetch(
					makeBillingPayload({
						currentPeriod: {
							end: periodEnd,
							start: periodStart,
							type: "USAGE_PERIOD_TYPE_WEEKLY",
						},
					}),
				).fetch,
			},
		);

		expect(report?.limits[0]?.id).toBe("xai-oauth:credits:1w");
		expect(report?.limits[0]?.window?.resetsAt).toBe(Date.parse(periodEnd));
	});

	it("skips expired OAuth tokens and returns null for rejected billing", async () => {
		const expired = await xaiOauthUsageProvider.fetchUsage(
			{ provider: "xai-oauth", credential: makeCredential({ expiresAt: Date.now() - 1 }) },
			{ fetch: capturingFetch(makeBillingPayload()).fetch },
		);
		expect(expired).toBeNull();

		const denied: FetchImpl = async () => new Response("denied", { status: 403 });
		const report = await xaiOauthUsageProvider.fetchUsage(
			{ provider: "xai-oauth", credential: makeCredential() },
			{ fetch: denied },
		);
		expect(report).toBeNull();
	});
});
