import { beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "../../../config/settings";
import type { AgentSession } from "../../../session/agent-session";
import { getThemeByName, setThemeInstance } from "../../theme/theme";
import { StatusLineComponent } from "./component";

function makeSessionWithLastMessage(lastMessage: unknown, prewalkArmed: boolean = false) {
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
				cost: 0,
				tokensPerSecond: null,
			}),
			getSessionName: () => "test-session",
		},
		getPrewalkState: () => (prewalkArmed ? { target: { id: "cheap-model", provider: "openai" } } : undefined),
		getAsyncJobSnapshot: () => undefined,
		isAdvisorActive: () => false,
		isFastModeActive: () => false,
		configuredThinkingLevel: () => undefined,
		modelRegistry: {
			isUsingOAuth: () => false,
		},
	};
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

function makeSessionWithUsageFetcher(fetchUsageReports: (signal?: AbortSignal) => Promise<unknown>) {
	const messages: unknown[] = [];
	return {
		messages,
		state: {
			messages,
			model: { provider: "openai-codex", contextWindow: 128000 },
		},
		model: { provider: "openai-codex", contextWindow: 128000 },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		getAsyncJobSnapshot: () => undefined,
		getContextUsage: () => ({ tokens: 42, contextWindow: 128000 }),
		fetchUsageReports,
	};
}

function makeUsageOnlyStatusLine(
	fetchUsageReports: (signal?: AbortSignal) => Promise<unknown>,
	onUsageRefresh?: () => void,
) {
	const statusLine = new StatusLineComponent(
		makeSessionWithUsageFetcher(fetchUsageReports) as unknown as AgentSession,
		{ onUsageRefresh },
	);
	statusLine.updateSettings({
		preset: "custom",
		leftSegments: ["usage"],
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
});
