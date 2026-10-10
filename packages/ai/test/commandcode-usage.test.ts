import { describe, expect, it } from "bun:test";

import { type } from "@oh-my-pi/omptype";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import {
	type UsageFetchContext,
	type UsageFetchParams,
	type UsageLimit,
	type UsageReport,
	type UsageStatus,
	usageReportSchema,
} from "@oh-my-pi/pi-ai/usage";
import { commandCodeRankingStrategy, commandCodeUsageProvider } from "@oh-my-pi/pi-ai/usage/commandcode";

type Route = { status?: number; body: unknown };
type SeenRequest = { url: string; headers?: Record<string, string> };

function makeCtx(routes: Record<string, Route>, seen: SeenRequest[] = []): UsageFetchContext {
	const fetch: FetchImpl = async (url, init) => {
		const key = String(url);
		seen.push({ url: key, headers: init?.headers as Record<string, string> | undefined });
		const route = routes[new URL(key).pathname];
		if (!route) return new Response("{}", { status: 404 });
		const body = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
		return new Response(body, { status: route.status ?? 200, headers: { "content-type": "application/json" } });
	};
	return { fetch };
}

function makeParams(overrides: Partial<UsageFetchParams> = {}): UsageFetchParams {
	return { provider: "commandcode", credential: { type: "api_key", apiKey: "user_test" }, ...overrides };
}

const FIVE_HOUR_RESET = 1_800_000_000_000;
const WEEKLY_RESET = 1_800_500_000_000;

const WINDOWED_ROUTES: Record<string, Route> = {
	"/alpha/whoami": {
		body: {
			success: true,
			data: {
				user: { id: "user_1", userName: "ada", email: "ada@example.com" },
				org: { id: "org_1", login: "acme" },
			},
		},
	},
	"/alpha/billing/credits": {
		body: {
			credits: { monthlyCredits: 12.5, purchasedCredits: 3, freeCredits: 0.5, planId: "individual-pro-v1" },
			windowLimits: {
				fiveHour: { used: 4, cap: 10, resetAt: FIVE_HOUR_RESET },
				weekly: { used: 3, cap: 100, exceeded: true, resetAt: WEEKLY_RESET },
			},
		},
	},
};

describe("command code usage provider", () => {
	it("maps a windowed plan to 5-hour, weekly, and balance limits", async () => {
		const seen: SeenRequest[] = [];
		const report = await commandCodeUsageProvider.fetchUsage(makeParams(), makeCtx(WINDOWED_ROUTES, seen));

		expect(seen.map(request => request.url)).toEqual([
			"https://api.commandcode.ai/alpha/whoami",
			"https://api.commandcode.ai/alpha/billing/credits?orgId=org_1",
		]);
		for (const request of seen) {
			expect(request.headers?.Authorization).toBe("Bearer user_test");
			expect(request.headers?.Accept).toBe("application/json");
		}

		expect(report).not.toBeNull();
		expect(report!.limits.map(limit => limit.id)).toEqual([
			"commandcode:5h",
			"commandcode:7d",
			"commandcode:balance",
		]);

		const [fiveHour, weekly, balance] = report!.limits;
		expect(fiveHour).toMatchObject({
			scope: { provider: "commandcode", accountId: "user_1", orgId: "org_1", windowId: "5h", shared: true },
			window: { id: "5h", durationMs: 18_000_000, resetsAt: FIVE_HOUR_RESET },
			amount: { used: 4, limit: 10, usedFraction: 0.4, unit: "credits" },
			status: "ok",
		});
		expect(weekly).toMatchObject({
			scope: { orgId: "org_1", windowId: "7d" },
			window: { id: "7d", durationMs: 604_800_000, resetsAt: WEEKLY_RESET },
			amount: { used: 3, limit: 100, usedFraction: 0.03, unit: "credits" },
			status: "exhausted",
		});
		expect(balance).toMatchObject({
			scope: { provider: "commandcode", accountId: "user_1", orgId: "org_1", windowId: "balance", shared: true },
			amount: { remaining: 16, unit: "credits" },
		});
		expect(balance!.window).toBeUndefined();
		expect(report!.metadata).toMatchObject({
			accountId: "user_1",
			email: "ada@example.com",
			orgId: "org_1",
			orgName: "acme",
			planType: "individual-pro-v1",
		});
	});

	it("grades a window by used fraction when the API does not flag it exceeded", async () => {
		const cases: [used: number, expected: UsageStatus][] = [
			[8.9, "ok"],
			[9, "warning"],
			[10, "exhausted"],
		];
		for (const [used, expected] of cases) {
			const report = await commandCodeUsageProvider.fetchUsage(
				makeParams(),
				makeCtx({
					...WINDOWED_ROUTES,
					"/alpha/billing/credits": {
						body: {
							credits: { monthlyCredits: 1 },
							windowLimits: { fiveHour: { used, cap: 10 } },
						},
					},
				}),
			);
			expect(report!.limits[0]!.status, String(used)).toBe(expected);
		}
	});

	it("normalizes a seconds-precision reset timestamp to milliseconds", async () => {
		const report = await commandCodeUsageProvider.fetchUsage(
			makeParams(),
			makeCtx({
				...WINDOWED_ROUTES,
				"/alpha/billing/credits": {
					body: {
						credits: { monthlyCredits: 1 },
						windowLimits: { fiveHour: { used: 1, cap: 10, resetAt: 1_790_000_000 } },
					},
				},
			}),
		);
		expect(report!.limits[0]!.window?.resetsAt).toBe(1_790_000_000_000);
	});

	it("emits a report the usage wire schema accepts when a window has no cap or reset time", async () => {
		const report = await commandCodeUsageProvider.fetchUsage(
			makeParams(),
			makeCtx({
				...WINDOWED_ROUTES,
				"/alpha/billing/credits": {
					body: { credits: { monthlyCredits: 1 }, windowLimits: { fiveHour: { used: 1 } } },
				},
			}),
		);
		expect(report!.limits.map(limit => limit.id)).toEqual(["commandcode:5h", "commandcode:balance"]);
		const validated = usageReportSchema(report);
		expect(validated instanceof type.errors ? validated.summary : "valid").toBe("valid");
	});

	it("reports only the balance for a pay-as-you-go account", async () => {
		const seen: SeenRequest[] = [];
		const report = await commandCodeUsageProvider.fetchUsage(
			makeParams(),
			makeCtx(
				{
					"/alpha/whoami": { body: { user: { id: "user_2" } } },
					"/alpha/billing/credits": { body: { credits: { purchasedCredits: 5 } } },
				},
				seen,
			),
		);

		expect(seen[1]!.url).toBe("https://api.commandcode.ai/alpha/billing/credits");
		expect(report!.limits).toHaveLength(1);
		expect(report!.limits[0]).toMatchObject({
			id: "commandcode:balance",
			amount: { remaining: 5, unit: "credits" },
		});
		expect(report!.metadata).toMatchObject({ accountId: "user_2" });
		expect(report!.limits[0]!.scope).not.toHaveProperty("orgId");
	});

	it("throws on a revoked key so the cached report is purged", async () => {
		for (const path of ["/alpha/whoami", "/alpha/billing/credits"]) {
			await expect(
				commandCodeUsageProvider.fetchUsage(
					makeParams(),
					makeCtx({ ...WINDOWED_ROUTES, [path]: { status: 401, body: { success: false } } }),
				),
			).rejects.toMatchObject({ status: 401 });
		}
	});

	it("keeps a key usable when a usage route answers 403", async () => {
		const report = await commandCodeUsageProvider.fetchUsage(
			makeParams(),
			makeCtx({ ...WINDOWED_ROUTES, "/alpha/billing/credits": { status: 403, body: { success: false } } }),
		);
		expect(report).toBeNull();
	});

	it("returns null when the credits endpoint fails transiently", async () => {
		const report = await commandCodeUsageProvider.fetchUsage(
			makeParams(),
			makeCtx({ ...WINDOWED_ROUTES, "/alpha/billing/credits": { status: 500, body: "{}" } }),
		);
		expect(report).toBeNull();
	});

	it("returns null when there is neither a credit balance nor window data", async () => {
		const report = await commandCodeUsageProvider.fetchUsage(
			makeParams(),
			makeCtx({ ...WINDOWED_ROUTES, "/alpha/billing/credits": { body: { credits: {} } } }),
		);
		expect(report).toBeNull();
	});

	it("parses the direct OAuth account capture and rolling subscription fractions", async () => {
		const seen: SeenRequest[] = [];
		const report = await commandCodeUsageProvider.fetchUsage(
			makeParams({
				baseUrl: "https://api.commandcode.ai/provider/v1/",
				credential: { type: "oauth", accessToken: " user_test_token " },
			}),
			makeCtx(
				{
					"/alpha/whoami": {
						body: { success: true, user: { name: "LambdaExpress", email: "owner@example.com" }, org: null },
					},
					"/alpha/billing/credits": {
						body: {
							credits: { monthlyCredits: 69.09, purchasedCredits: 0, freeCredits: 0 },
							windowLimits: {
								limited: true,
								fiveHour: { used: 0.79, cap: 14, exceeded: false, resetAt: 1789065302472 },
								weekly: { used: 0.79, cap: 35, exceeded: false, resetAt: 1789652102472 },
							},
						},
					},
				},
				seen,
			),
		);
		expect(seen.map(request => request.url)).toEqual([
			"https://api.commandcode.ai/alpha/whoami",
			"https://api.commandcode.ai/alpha/billing/credits",
		]);
		expect(seen[1]?.headers?.Authorization).toBe("Bearer user_test_token");
		const [fiveHour, weekly, balance] = report!.limits;
		expect(fiveHour?.amount.usedFraction).toBeCloseTo(0.79 / 14, 10);
		expect(fiveHour?.amount.remainingFraction).toBeCloseTo(1 - 0.79 / 14, 10);
		expect(fiveHour?.window?.resetsAt).toBe(1789065302472);
		expect(weekly?.amount.usedFraction).toBeCloseTo(0.79 / 35, 10);
		expect(weekly?.window?.resetsAt).toBe(1789652102472);
		expect(balance?.amount.remaining).toBe(69.09);
		expect(fiveHour?.scope).not.toHaveProperty("accountId");
		expect(report?.metadata).toMatchObject({ email: "owner@example.com", user: "LambdaExpress" });
	});

	it("keeps credits visible when identity lookup fails and uses the credential org", async () => {
		for (const status of [403, 500]) {
			const seen: SeenRequest[] = [];
			const report = await commandCodeUsageProvider.fetchUsage(
				makeParams({ credential: { type: "oauth", accessToken: "user_test", orgId: " org/team " } }),
				makeCtx({ ...WINDOWED_ROUTES, "/alpha/whoami": { status, body: {} } }, seen),
			);
			expect(seen[1]?.url).toBe("https://api.commandcode.ai/alpha/billing/credits?orgId=org%2Fteam");
			expect(report?.limits.find(limit => limit.window?.id === "5h")?.amount.usedFraction).toBe(0.4);
			expect(report?.limits[0]?.scope.orgId).toBe("org/team");
		}
	});

	it("recognizes direct org identities and prefers identity scope over the credential", async () => {
		for (const identity of [
			{ org: " team/id " },
			{ orgId: " team/id " },
			{ org: { id: " team/id ", name: "Team" } },
		]) {
			const seen: SeenRequest[] = [];
			const report = await commandCodeUsageProvider.fetchUsage(
				makeParams({ credential: { type: "api_key", apiKey: "key", orgId: "stale" } }),
				makeCtx({ ...WINDOWED_ROUTES, "/alpha/whoami": { body: identity } }, seen),
			);
			expect(seen[1]?.url).toBe("https://api.commandcode.ai/alpha/billing/credits?orgId=team%2Fid");
			expect(report?.limits[0]?.scope.orgId).toBe("team/id");
		}
	});

	it("drops unmetered and malformed windows without losing the balance", async () => {
		for (const window of [
			{ used: 0, cap: 0, exceeded: true },
			{ used: 1, cap: -10 },
			{ used: 1, cap: "10" },
			{ used: 1, cap: null },
			{ used: -1, cap: 10 },
			{ used: "1", cap: 10 },
			{ cap: 10 },
		]) {
			const report = await commandCodeUsageProvider.fetchUsage(
				makeParams(),
				makeCtx({
					...WINDOWED_ROUTES,
					"/alpha/billing/credits": {
						body: { credits: { monthlyCredits: 2 }, windowLimits: { fiveHour: window } },
					},
				}),
			);
			expect(report?.limits).toMatchObject([{ id: "commandcode:balance", amount: { remaining: 2 } }]);
			expect(report?.limits.some(limit => limit.window)).toBe(false);
		}
	});

	it("rejects malformed window containers rather than replacing cached quota with a balance-only report", async () => {
		for (const windowLimits of [null, [], "invalid"]) {
			const report = await commandCodeUsageProvider.fetchUsage(
				makeParams(),
				makeCtx({
					...WINDOWED_ROUTES,
					"/alpha/billing/credits": { body: { credits: { monthlyCredits: 2 }, windowLimits } },
				}),
			);
			expect(report).toBeNull();
		}
	});

	it("bounds utilization and omits invalid reset times while retaining raw spend", async () => {
		const report = await commandCodeUsageProvider.fetchUsage(
			makeParams(),
			makeCtx({
				...WINDOWED_ROUTES,
				"/alpha/billing/credits": {
					body: { windowLimits: { fiveHour: { used: 15, cap: 10, resetAt: null } } },
				},
			}),
		);
		expect(report?.limits[0]?.amount).toMatchObject({
			used: 15,
			limit: 10,
			usedFraction: 1,
			remainingFraction: 0,
		});
		expect(report?.limits[0]?.status).toBe("exhausted");
		expect(report?.limits[0]?.window).not.toHaveProperty("resetsAt");
		const validated = usageReportSchema(report);
		expect(validated instanceof type.errors ? validated.summary : "valid").toBe("valid");
	});

	it("reports no subscription windows for an explicitly unmetered account", async () => {
		const report = await commandCodeUsageProvider.fetchUsage(
			makeParams(),
			makeCtx({
				...WINDOWED_ROUTES,
				"/alpha/billing/credits": { body: { windowLimits: { limited: false } } },
			}),
		);
		expect(report?.limits).toEqual([]);
	});

	it("sends both probes to the configured origin instead of the canonical host", async () => {
		const seen: SeenRequest[] = [];
		await commandCodeUsageProvider.fetchUsage(
			makeParams({ baseUrl: "https://proxy.example/provider/v1" }),
			makeCtx(WINDOWED_ROUTES, seen),
		);
		expect(seen.map(request => request.url)).toEqual([
			"https://proxy.example/alpha/whoami",
			"https://proxy.example/alpha/billing/credits?orgId=org_1",
		]);
	});

	it("returns null for credentials it has no bearer key for", async () => {
		const seen: SeenRequest[] = [];
		const oauth = await commandCodeUsageProvider.fetchUsage(
			makeParams({ credential: { type: "oauth" } }),
			makeCtx(WINDOWED_ROUTES, seen),
		);
		const keyless = await commandCodeUsageProvider.fetchUsage(
			makeParams({ credential: { type: "api_key" } }),
			makeCtx(WINDOWED_ROUTES, seen),
		);
		expect(oauth).toBeNull();
		expect(keyless).toBeNull();
		expect(seen).toHaveLength(0);
	});
});

describe("command code credential ranking", () => {
	it("picks the 5-hour and weekly limits by window id, not by position", () => {
		const limit = (windowId: string): UsageLimit => ({
			id: `commandcode:${windowId}`,
			label: windowId,
			scope: { provider: "commandcode", windowId },
			window: { id: windowId, label: windowId },
			amount: { unit: "credits" },
		});
		const report: UsageReport = {
			provider: "commandcode",
			fetchedAt: 0,
			limits: [limit("balance"), limit("7d"), limit("5h")],
		};
		const windows = commandCodeRankingStrategy.findWindowLimits(report);
		expect(windows.primary?.id).toBe("commandcode:5h");
		expect(windows.secondary?.id).toBe("commandcode:7d");
	});
});
