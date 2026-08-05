import { beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "../../../../src/config/settings";
import { StatusLineComponent } from "../../../../src/modes/components/status-line/component";
import { getThemeByName, setThemeInstance } from "../../../../src/modes/theme/theme";
import type { AgentSession } from "../../../../src/session/agent-session";

function makeSessionWithLastMessage(
	lastMessage: unknown,
	prewalkArmed: boolean = false,
	{
		cost = 0,
		advisorCost = 0,
		usingSubscription = false,
	}: { cost?: number; advisorCost?: number; usingSubscription?: boolean } = {},
) {
	return {
		messages: lastMessage ? [lastMessage] : [],
		model: { contextWindow: 128000 },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => ({ tokens: 42, contextWindow: 128000 }),
		state: {
			messages: lastMessage ? [lastMessage] : [],
			model: { contextWindow: 128000 },
		},
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost,
				tokensPerSecond: null,
			}),
			getSessionName: () => "test-session",
		},
		getPrewalkState: () => (prewalkArmed ? { target: { id: "cheap-model", provider: "openai" } } : undefined),
		getAsyncJobSnapshot: () => undefined,
		isAdvisorActive: () => false,
		getAdvisorStatusOverview: () => ({
			configured: advisorCost > 0,
			advisors: advisorCost > 0 ? [{ name: "test", status: "running" as const }] : [],
		}),
		getAdvisorCost: () => advisorCost,
		isFastModeActive: () => false,
		configuredThinkingLevel: () => undefined,
		modelRegistry: {
			isUsingOAuth: () => usingSubscription,
		},
	};
}

function makeProviderStatusLine(provider: string, modelName: string) {
	const session = makeSessionWithLastMessage(null);
	const model = { provider, name: modelName, contextWindow: 128000 };
	session.model = model;
	session.state.model = model;
	const statusLine = new StatusLineComponent(session as unknown as AgentSession);
	statusLine.updateSettings({
		preset: "custom",
		leftSegments: ["provider", "model"],
		rightSegments: [],
		separator: "ascii",
		segmentOptions: {},
		transparent: true,
		sessionAccent: false,
	});
	return statusLine;
}

function makeUsageReport(fiveHourFraction: number) {
	return [
		{
			provider: "openai-codex",
			limits: [
				{
					id: "codex-5h",
					label: "Codex 5h",
					scope: { windowId: "5h" },
					amount: { usedFraction: fiveHourFraction },
					window: { resetsAt: Date.now() + 30 * 60_000 },
				},
			],
		},
	];
}

function makeOpenCodeGoUsageReport() {
	const now = Date.now();
	return [
		{
			provider: "opencode-go",
			fetchedAt: now,
			limits: [
				{
					id: "rolling-5h",
					label: "5 Hour limit",
					scope: { provider: "opencode-go", windowId: "rolling-5h" },
					window: {
						id: "rolling-5h",
						label: "5 Hour",
						durationMs: 5 * 60 * 60_000,
						resetsAt: now + 4 * 60 * 60_000 + 43 * 60_000,
					},
					amount: { usedFraction: 0.25 },
				},
				{
					id: "weekly",
					label: "Weekly limit",
					scope: { provider: "opencode-go", windowId: "weekly" },
					window: {
						id: "weekly",
						label: "Weekly",
						durationMs: 7 * 24 * 60 * 60_000,
						resetsAt: now + 5 * 24 * 60 * 60_000 + 16 * 60 * 60_000,
					},
					amount: { usedFraction: 0.5 },
				},
				{
					id: "monthly",
					label: "Monthly limit",
					scope: { provider: "opencode-go", windowId: "monthly" },
					window: {
						id: "monthly",
						label: "Monthly",
						durationMs: 31 * 24 * 60 * 60_000,
						resetsAt: now + 30 * 24 * 60 * 60_000 + 23 * 60 * 60_000,
					},
					amount: { usedFraction: 0.75 },
				},
			],
			metadata: { planType: "OpenCode Go" },
		},
	];
}

function makeSessionWithUsageFetcher(
	fetchUsageReports: (signal?: AbortSignal) => Promise<unknown>,
	provider: string = "openai-codex",
) {
	const messages: unknown[] = [];
	return {
		messages,
		state: {
			messages,
			model: { provider, contextWindow: 128000 },
		},
		model: { provider, contextWindow: 128000 },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		sessionId: "test-session",
		getAsyncJobSnapshot: () => undefined,
		getContextUsage: () => ({ tokens: 42, contextWindow: 128000 }),
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0.0084,
				tokensPerSecond: null,
			}),
		},
		modelRegistry: {
			isUsingOAuth: () => false,
			authStorage: { getOAuthAccountIdentity: () => undefined },
		},
		fetchUsageReports,
	};
}

function makeUsageOnlyStatusLine(
	fetchUsageReports: (signal?: AbortSignal) => Promise<unknown>,
	onUsageRefresh?: () => void,
	provider?: string,
	segment: "usage" | "cost" = "usage",
) {
	const statusLine = new StatusLineComponent(
		makeSessionWithUsageFetcher(fetchUsageReports, provider) as unknown as AgentSession,
		{ onUsageRefresh },
	);
	statusLine.updateSettings({
		preset: "custom",
		leftSegments: [segment],
		rightSegments: [],
		separator: "none",
		segmentOptions: {},
		transparent: true,
		sessionAccent: false,
	});
	return statusLine;
}

function nextRefresh(waiters: Array<() => void>) {
	const refresh = Promise.withResolvers<void>();
	waiters.push(refresh.resolve);
	return refresh.promise;
}

async function startScheduledUsageFetch() {
	vi.advanceTimersByTime(0);
	await Promise.resolve();
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

describe("StatusLineComponent", () => {
	it("renders the subscription provider as a separate segment before the model", () => {
		const cases = [
			{ provider: "openai-codex", providerLabel: "OpenAI", modelName: "GPT-5.3 Codex" },
			{ provider: "opencode-go", providerLabel: "OpenCode", modelName: "DeepSeek V4 Flash" },
			{ provider: "deepseek", providerLabel: "DeepSeek", modelName: "DeepSeek Chat" },
		];

		for (const testCase of cases) {
			const statusLine = makeProviderStatusLine(testCase.provider, testCase.modelName);
			try {
				const rendered = Bun.stripANSI(statusLine.getTopBorder(160).content);
				expect(rendered).toContain(testCase.providerLabel);
				expect(rendered).toContain(testCase.modelName);
				expect(rendered.indexOf(testCase.providerLabel)).toBeLessThan(rendered.indexOf(testCase.modelName));
			} finally {
				statusLine.dispose();
			}
		}
	});

	it("fingerprints tool-call arguments containing bigint values", () => {
		const statusLine = new StatusLineComponent(
			makeSessionWithLastMessage({
				role: "assistant",
				timestamp: 1,
				content: [
					{
						type: "toolCall",
						name: "read",
						arguments: { offset: 1n, nested: { limit: 2n } },
					},
				],
			}) as unknown as AgentSession,
		);

		expect(statusLine.getCachedContextBreakdown()).toEqual({ usedTokens: 42, contextWindow: 128000 });
	});
	it("refreshUsage bypasses the normal usage TTL and renders the newly fetched report", async () => {
		vi.useFakeTimers();
		const waiters: Array<() => void> = [];
		let report = makeUsageReport(0.11);
		const fetchUsageReports = vi.fn(async () => report);
		const statusLine = makeUsageOnlyStatusLine(fetchUsageReports, () => waiters.shift()?.());

		try {
			const initialRefresh = nextRefresh(waiters);
			statusLine.getTopBorder(120);
			await startScheduledUsageFetch();
			await initialRefresh;

			expect(statusLine.getTopBorder(120).content).toContain("11%");

			report = makeUsageReport(0.73);
			expect(statusLine.getTopBorder(120).content).toContain("11%");
			expect(fetchUsageReports).toHaveBeenCalledTimes(1);

			const manualRefresh = nextRefresh(waiters);
			statusLine.refreshUsage();
			await startScheduledUsageFetch();
			await manualRefresh;

			expect(fetchUsageReports).toHaveBeenCalledTimes(2);
			const refreshed = statusLine.getTopBorder(120).content;
			expect(refreshed).toContain("73%");
			expect(refreshed).not.toContain("11%");
		} finally {
			statusLine.dispose();
			vi.useRealTimers();
		}
	});

	it("renders rounded OpenCode Go reset countdowns without the provider name", async () => {
		vi.useFakeTimers();
		const waiters: Array<() => void> = [];
		const report = makeOpenCodeGoUsageReport();
		const statusLine = makeUsageOnlyStatusLine(
			async () => report,
			() => waiters.shift()?.(),
			"opencode-go",
		);

		try {
			const refreshed = nextRefresh(waiters);
			statusLine.getTopBorder(160);
			await startScheduledUsageFetch();
			await refreshed;

			const rendered = Bun.stripANSI(statusLine.getTopBorder(160).content);
			expect(rendered).not.toContain("OpenCode Go");
			expect(rendered).toContain("5h 25%");
			expect(rendered).toContain("6d 50%");
			expect(rendered).toContain("31d 75%");

			vi.advanceTimersByTime(4 * 60 * 60_000 + 13 * 60_000);
			const later = Bun.stripANSI(statusLine.getTopBorder(160).content);
			expect(later).toContain("30m 25%");
		} finally {
			statusLine.dispose();
			vi.useRealTimers();
		}
	});

	it("shows OpenCode Go quota instead of API-key request cost in the default cost segment", async () => {
		vi.useFakeTimers();
		const waiters: Array<() => void> = [];
		const report = makeOpenCodeGoUsageReport();
		const statusLine = makeUsageOnlyStatusLine(
			async () => report,
			() => waiters.shift()?.(),
			"opencode-go",
			"cost",
		);

		try {
			const refreshed = nextRefresh(waiters);
			statusLine.getTopBorder(160);
			await startScheduledUsageFetch();
			await refreshed;

			const rendered = Bun.stripANSI(statusLine.getTopBorder(160).content);
			expect(rendered).not.toContain("OpenCode Go");
			expect(rendered).toContain("5h 75%");
			expect(rendered).toContain("6d 50%");
			expect(rendered).toContain("31d 25%");
			expect(rendered).not.toContain("$0.01");
		} finally {
			statusLine.dispose();
			vi.useRealTimers();
		}
	});

	it("ignores an older in-flight usage response after refreshUsage has fetched a newer report", async () => {
		vi.useFakeTimers();
		const firstReport = Promise.withResolvers<unknown>();
		const firstFetchStarted = Promise.withResolvers<void>();
		const firstFetchReturned = Promise.withResolvers<void>();
		const waiters: Array<() => void> = [];
		const fetchUsageReports = vi.fn(() => {
			if (fetchUsageReports.mock.calls.length === 1) {
				firstFetchStarted.resolve();
				return firstReport.promise.then(report => {
					firstFetchReturned.resolve();
					return report;
				});
			}
			return Promise.resolve(makeUsageReport(0.8));
		});
		const statusLine = makeUsageOnlyStatusLine(fetchUsageReports, () => waiters.shift()?.());

		try {
			statusLine.getTopBorder(120);
			await startScheduledUsageFetch();
			await firstFetchStarted.promise;

			const manualRefresh = nextRefresh(waiters);
			statusLine.refreshUsage();
			await startScheduledUsageFetch();
			await manualRefresh;

			expect(statusLine.getTopBorder(120).content).toContain("80%");

			firstReport.resolve(makeUsageReport(0.12));
			await firstFetchReturned.promise;
			await Promise.resolve();

			const afterStaleResponse = statusLine.getTopBorder(120).content;
			expect(afterStaleResponse).toContain("80%");
			expect(afterStaleResponse).not.toContain("12%");
			expect(waiters).toHaveLength(0);
		} finally {
			statusLine.dispose();
			vi.useRealTimers();
		}
	});

	it("renders Prewalk annotation when prewalk is armed", () => {
		const statusLine = new StatusLineComponent(makeSessionWithLastMessage(null, true) as unknown as AgentSession);

		// By default preset, 'mode' segment is included in left/right segments.
		// Let's get the border and see if Prewalk is rendered.
		const border = statusLine.getTopBorder(100);
		// SGR codes might be included, so we check if the stripped content contains "Prewalk"
		const stripped = border.content.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("Prewalk");
	});
	it("renders primary and advisor costs separately", () => {
		const statusLine = new StatusLineComponent(
			makeSessionWithLastMessage(null, false, {
				cost: 2.67,
				advisorCost: 0.41,
				usingSubscription: true,
			}) as unknown as AgentSession,
		);

		const stripped = statusLine.getTopBorder(120).content.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("$2.67 (sub) + $0.41 (adv)");
	});

	it("omits advisor cost when the advisor has never been active", () => {
		const statusLine = new StatusLineComponent(
			makeSessionWithLastMessage(null, false, {
				cost: 2.67,
				usingSubscription: true,
			}) as unknown as AgentSession,
		);

		const stripped = statusLine.getTopBorder(120).content.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("$2.67 (sub)");
		expect(stripped).not.toContain("(adv)");
	});
});
