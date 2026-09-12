import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { ProviderHttpError } from "../src/error";
import { commandCodeUsageProvider } from "../src/usage/commandcode";

const CREDITS_URL = "https://api.commandcode.ai/alpha/billing/credits";
const WHOAMI_URL = "https://api.commandcode.ai/alpha/whoami";

/** Live capture from `GET /alpha/billing/credits`, 2026-09-10. */
function creditsPayload(windowLimits: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		credits: {
			belowThreshold: false,
			creditThreshold: 0,
			monthlyCredits: 69.09,
			purchasedCredits: 0,
			freeCredits: 0,
		},
		windowLimits: {
			limited: true,
			exceeded: null,
			fiveHour: { used: 0.79, cap: 14, exceeded: false, resetAt: 1789065302472 },
			weekly: { used: 0.79, cap: 35, exceeded: false, resetAt: 1789652102472 },
			...windowLimits,
		},
	};
}

const WHOAMI_PAYLOAD = {
	success: true,
	user: { id: "u-1", name: "LambdaExpress", email: "owner@example.com", userName: "LambdaExpress" },
	org: null,
};

/** Routes whoami and credits to canned payloads, recording every request. */
function routedFetch(
	calls: Array<{ url: string; headers: Record<string, string> }>,
	options: { credits?: unknown; creditsStatus?: number } = {},
): FetchImpl {
	const fn = async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
		if (url.startsWith(WHOAMI_URL)) {
			return new Response(JSON.stringify(WHOAMI_PAYLOAD), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify(options.credits ?? creditsPayload()), {
			status: options.creditsStatus ?? 200,
			headers: { "content-type": "application/json" },
		});
	};
	return fn as unknown as typeof fetch;
}

function usageParams(overrides: Record<string, unknown> = {}) {
	return {
		provider: "commandcode",
		credential: { type: "oauth", accessToken: "user_test_token" },
		baseUrl: "https://api.commandcode.ai/provider/v1",
		...overrides,
	} as Parameters<typeof commandCodeUsageProvider.fetchUsage>[0];
}

describe("commandcode usage provider", () => {
	it("maps the five-hour and weekly windows onto the status line's subscription slots", async () => {
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		const report = await commandCodeUsageProvider.fetchUsage(usageParams(), { fetch: routedFetch(calls) });

		expect(report?.limits.map(limit => [limit.id, limit.scope.windowId, limit.amount.usedFraction])).toEqual([
			["five-hour", "5h", 0.79 / 14],
			["weekly", "7d", 0.79 / 35],
		]);
		const fiveHour = report?.limits.find(limit => limit.id === "five-hour");
		expect(fiveHour?.window?.durationMs).toBe(5 * 3_600_000);
		expect(fiveHour?.window?.resetsAt).toBe(1789065302472);
		expect(fiveHour?.amount.remainingFraction).toBeCloseTo(1 - 0.79 / 14, 10);
		expect(report?.limits.find(limit => limit.id === "weekly")?.window?.resetsAt).toBe(1789652102472);
	});

	it("strips the provider-API suffix so the alpha routes resolve at the deployment root", async () => {
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		await commandCodeUsageProvider.fetchUsage(usageParams(), { fetch: routedFetch(calls) });

		expect(calls.map(call => call.url)).toEqual([WHOAMI_URL, CREDITS_URL]);
		expect(calls[1]?.headers.authorization).toBe("Bearer user_test_token");
	});

	it("scopes the credits request to the org when whoami reports one", async () => {
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		const orgFetch = (async (input: string | URL | Request) => {
			const url = String(input);
			calls.push({ url, headers: {} });
			const payload = url.startsWith(WHOAMI_URL)
				? { success: true, user: { id: "u-1" }, org: { id: "org-team", name: "Team" } }
				: creditsPayload();
			return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
		}) as unknown as typeof fetch;

		await commandCodeUsageProvider.fetchUsage(usageParams(), { fetch: orgFetch });

		expect(calls[1]?.url).toBe(`${CREDITS_URL}?orgId=org-team`);
	});

	it("reports exhausted windows from the payload flag and drops unmetered ones", async () => {
		const report = await commandCodeUsageProvider.fetchUsage(usageParams(), {
			fetch: routedFetch([], {
				credits: creditsPayload({
					fiveHour: { used: 14, cap: 14, exceeded: true, resetAt: 1789065302472 },
					weekly: { used: 0, cap: 0, exceeded: false, resetAt: null },
				}),
			}),
		});

		expect(report?.limits.map(limit => [limit.id, limit.status])).toEqual([["five-hour", "exhausted"]]);
	});

	it("warns near the cap and reports no limits for an unmetered account", async () => {
		const nearCap = await commandCodeUsageProvider.fetchUsage(usageParams(), {
			fetch: routedFetch([], { credits: creditsPayload({ fiveHour: { used: 13.5, cap: 14, resetAt: null } }) }),
		});
		expect(nearCap?.limits.find(limit => limit.id === "five-hour")?.status).toBe("warning");

		const payAsYouGo = await commandCodeUsageProvider.fetchUsage(usageParams(), {
			fetch: routedFetch([], { credits: { credits: { monthlyCredits: 0 }, windowLimits: { limited: false } } }),
		});
		expect(payAsYouGo).not.toBeNull();
		expect(payAsYouGo?.limits).toEqual([]);
	});

	it("throws on a rejected bearer so credential health flags it, and stays quiet on transient failures", async () => {
		await expect(
			commandCodeUsageProvider.fetchUsage(usageParams(), {
				fetch: routedFetch([], { credits: { error: "unauthorized" }, creditsStatus: 401 }),
			}),
		).rejects.toBeInstanceOf(ProviderHttpError);

		const transient = await commandCodeUsageProvider.fetchUsage(usageParams(), {
			fetch: routedFetch([], { credits: { error: "boom" }, creditsStatus: 500 }),
		});
		expect(transient).toBeNull();
	});

	it("accepts only commandcode credentials that carry a bearer", () => {
		expect(commandCodeUsageProvider.supports?.(usageParams())).toBe(true);
		expect(
			commandCodeUsageProvider.supports?.(
				usageParams({ provider: "deepseek", credential: { type: "api_key", apiKey: "k" } }),
			),
		).toBe(false);
		expect(commandCodeUsageProvider.supports?.(usageParams({ credential: { type: "oauth" } }))).toBe(false);
	});
});
