import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ResetCreditAccountStatus, ResetCreditTarget, UsageReport } from "@oh-my-pi/pi-ai";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { createAcpExtensionUiContext } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type CodexAutoRedeemCoordinator,
	createCodexAutoRedeemCoordinator,
} from "@oh-my-pi/pi-coding-agent/session/codex-auto-reset";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { AgentSideConnection, CreateElicitationRequest } from "@oh-my-pi/pi-utils/acp";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";
import { getTestModel } from "./helpers/model-fixtures";

const EMAIL = "user@example.com";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CODEX_USAGE_LIMIT_ERROR =
	'429 {"type":"error","error":{"type":"rate_limit_error","message":"usage_limit_reached"}} retry-after-ms=259200000';

interface CodexAccount {
	accountId: string;
	credentialId: number;
	weeklyUsed: number;
	limitReached: boolean;
	creditExpiresInMs: number;
}

function codexReport(account: CodexAccount): UsageReport {
	const now = Date.now();
	const scope = { provider: "openai-codex", accountId: account.accountId };
	return {
		provider: "openai-codex",
		fetchedAt: now,
		limits: [
			{
				id: "openai-codex:primary",
				label: "5 Hour",
				scope,
				window: { id: "5h", label: "5 Hour", resetsAt: now + 2 * HOUR },
				amount: { usedFraction: 0.1, unit: "percent" },
			},
			{
				id: "openai-codex:secondary",
				label: "Weekly",
				scope,
				window: { id: "7d", label: "Weekly", resetsAt: now + 3 * 24 * HOUR },
				amount: { usedFraction: account.weeklyUsed, unit: "percent" },
			},
		],
		metadata: { accountId: account.accountId, email: EMAIL, limitReached: account.limitReached },
	};
}

function liveCreditStatus(account: CodexAccount, active: boolean): ResetCreditAccountStatus {
	return {
		provider: "openai-codex",
		credentialId: account.credentialId,
		accountId: account.accountId,
		email: EMAIL,
		active,
		availableCount: 1,
		credits: [
			{
				id: `credit-${account.credentialId}`,
				status: "available",
				expiresAt: new Date(Date.now() + account.creditExpiresInMs).toISOString(),
			},
		],
	};
}

describe("Codex saved-reset consent without a prompt UI", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let sessions: AgentSession[];
	let managers: SessionManager[];
	let tempDir: TempDir;
	let extraStorages: AuthStorage[];

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
	});

	beforeEach(() => {
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
		sessions = [];
		managers = [];
		extraStorages = [];
		tempDir = TempDir.createSync("@pi-codex-reset-");
	});

	afterEach(async () => {
		for (const session of sessions.splice(0).reverse()) {
			await session.dispose();
		}
		for (const manager of managers.splice(0).reverse()) {
			await manager.close();
		}
		for (const storage of extraStorages.splice(0)) storage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
	});

	function buildSession(options: {
		accounts: CodexAccount[];
		streamErrorFirst?: boolean;
		storage?: AuthStorage;
		autoRedeem?: "unset" | "yes";
		salvageHorizonHours?: number;
		/** Builds the session the way ACP does for a client with or without form elicitation. */
		acpForm?: boolean;
	}): {
		session: AgentSession;
		coordinator: CodexAutoRedeemCoordinator;
		targets: ResetCreditTarget[];
		notices: string[];
	} {
		const storage = options.storage ?? authStorage;
		const model = getTestModel("openai-codex", candidate => !candidate.id.includes("-spark"));
		const [active] = options.accounts;
		storage.keys.setRuntime("openai-codex", "test-key");
		vi.spyOn(storage.oauth, "identity").mockReturnValue({ accountId: active.accountId, email: EMAIL });
		vi.spyOn(storage.usage, "reports").mockImplementation(async () => options.accounts.map(codexReport));
		vi.spyOn(storage.resets, "list").mockImplementation(async () =>
			options.accounts.map(account => liveCreditStatus(account, account === active)),
		);
		const targets: ResetCreditTarget[] = [];
		vi.spyOn(storage.resets, "redeem").mockImplementation(async request => {
			targets.push(request.target);
			return { ok: true, code: "reset", provider: "openai-codex", email: EMAIL, creditId: "credit" };
		});

		const mock = createMockModel();
		let calls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, streamOptions) => {
				calls++;
				if (options.streamErrorFirst && calls === 1) mock.push({ throw: CODEX_USAGE_LIMIT_ERROR });
				else mock.push({ content: ["recovered after reset redemption"], stopReason: "stop" });
				return mock.stream(requestedModel, context, streamOptions);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.maxRetries": 1,
			"codexResets.autoRedeem": options.autoRedeem ?? "unset",
			"claudeResets.autoRedeem": "no",
			...(options.salvageHorizonHours === undefined
				? {}
				: { "codexResets.salvageHorizonHours": options.salvageHorizonHours }),
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const sessionManager = SessionManager.inMemory();
		managers.push(sessionManager);
		const coordinator = createCodexAutoRedeemCoordinator();
		coordinator.resetLockPath = `${tempDir.path()}/agent.db`;
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: options.storage
				? new ModelRegistry(storage, undefined, { ignoreLocalModelConfig: true })
				: modelRegistry,
			codexResetCoordinator: coordinator,
			extensionRunner:
				options.acpForm === undefined
					? undefined
					: new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry),
			interactivePrompts: options.acpForm,
		});
		sessions.push(session);
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
		});
		return { session, coordinator, targets, notices };
	}

	/** Initializes extensions with ACP's elicitation-bridged UI context, installed whether or not the client can show forms. */
	async function attachAcpClient(session: AgentSession, form: boolean): Promise<string[]> {
		const elicitations: string[] = [];
		const connection = {
			unstable_createElicitation: async (request: CreateElicitationRequest) => {
				elicitations.push(request.message);
				return { action: "decline" };
			},
		} as unknown as AgentSideConnection;
		await initializeExtensions(session, {
			mode: "rpc",
			reportSendError: () => {},
			reportRuntimeError: () => {},
			uiContext: createAcpExtensionUiContext(
				connection,
				() => session.sessionId,
				form ? { elicitation: { form: {} } } : {},
			),
		});
		return elicitations;
	}

	it("restores a blocked turn with a reset expiring within five minutes and continues", async () => {
		const account = {
			accountId: "acct-a",
			credentialId: 1,
			weeklyUsed: 1,
			limitReached: true,
			creditExpiresInMs: 4 * MINUTE,
		};
		const { session, targets, notices } = buildSession({ accounts: [account], streamErrorFirst: true });
		mockSchedulerWaitWithClock();

		await session.prompt("trigger a codex usage limit");
		await session.waitForIdle();

		expect(targets).toEqual([
			{ provider: "openai-codex", credentialId: 1, accountId: "acct-a", email: EMAIL, creditId: "credit-1" },
		]);
		expect(notices).toContainEqual(expect.stringContaining(`Spending a saved Codex reset for ${EMAIL}`));
		expect(session.agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "recovered after reset redemption" }],
		});
	});

	it("spends one credit when independent sessions encounter the same blocked account together", async () => {
		const account: CodexAccount = {
			accountId: "acct-a",
			credentialId: 1,
			weeklyUsed: 1,
			limitReached: true,
			creditExpiresInMs: 6 * HOUR,
		};
		const options = {
			accounts: [account],
			streamErrorFirst: true,
			autoRedeem: "yes" as const,
			salvageHorizonHours: 0,
		};
		const first = buildSession(options);
		const secondStorage = await AuthStorage.create(":memory:");
		extraStorages.push(secondStorage);
		const second = buildSession({ ...options, storage: secondStorage });
		const listed = new Set<AuthStorage>();
		const bothListed = Promise.withResolvers<void>();
		const firstRedeemed = Promise.withResolvers<void>();
		let redeemed = false;
		let spends = 0;
		const creditStatus = (count: number): ResetCreditAccountStatus => ({
			...liveCreditStatus(account, true),
			availableCount: count,
			credits: Array.from({ length: count }, (_, index) => ({
				id: `credit-${index + 1}`,
				status: "available" as const,
				expiresAt: new Date(Date.now() + account.creditExpiresInMs).toISOString(),
			})),
		});
		for (const [index, storage] of [authStorage, secondStorage].entries()) {
			vi.spyOn(storage.usage, "reports").mockImplementation(async () => [
				codexReport(redeemed ? { ...account, weeklyUsed: 0, limitReached: false } : account),
			]);
			vi.spyOn(storage.resets, "list").mockImplementation(async () => {
				listed.add(storage);
				if (listed.size === 2) bothListed.resolve();
				if (index === 1) await firstRedeemed.promise;
				return [creditStatus(redeemed ? 1 : 2)];
			});
			vi.spyOn(storage.resets, "redeem").mockImplementation(async () => {
				await bothListed.promise;
				spends++;
				redeemed = true;
				firstRedeemed.resolve();
				return {
					ok: true,
					code: "reset",
					provider: "openai-codex",
					accountId: account.accountId,
					creditId: `credit-${spends}`,
				};
			});
		}
		// Real file-lock acquisition and marker writes need an I/O turn. Keep
		// real scheduler waits; the barriers above determine the account race.
		await Promise.all([
			first.session.prompt("trigger first blocked turn"),
			second.session.prompt("trigger second blocked turn"),
		]);
		await Promise.all([first.session.waitForIdle(), second.session.waitForIdle()]);

		const lastCreditStorage = await AuthStorage.create(":memory:");
		extraStorages.push(lastCreditStorage);
		const lastCredit = buildSession({
			...options,
			storage: lastCreditStorage,
			accounts: [{ ...account, weeklyUsed: 0, limitReached: false }],
		});
		vi.spyOn(lastCreditStorage.resets, "list").mockResolvedValue([creditStatus(0)]);
		await lastCredit.session.prompt("retry a stale 429 after the final credit was spent");
		await lastCredit.session.waitForIdle();

		expect(lastCredit.targets).toEqual([]);
		expect(spends).toBe(1);
		for (const { session } of [first, second, lastCredit]) {
			expect(session.agent.state.messages.at(-1)).toMatchObject({
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "recovered after reset redemption" }],
			});
		}
	});

	it("still needs consent to restore a blocked turn with a reset that has more time left", async () => {
		const account = {
			accountId: "acct-a",
			credentialId: 1,
			weeklyUsed: 1,
			limitReached: true,
			creditExpiresInMs: 6 * HOUR,
		};
		const { session, targets, notices } = buildSession({ accounts: [account], streamErrorFirst: true });
		mockSchedulerWaitWithClock();

		await session.prompt("trigger a codex usage limit");
		await session.waitForIdle();

		expect(targets).toEqual([]);
		expect(notices).toContainEqual(expect.stringContaining("auto-redeem is unset and no prompt UI is available"));
		expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
	});

	it("spends only the reset about to expire from a mixed salvage batch", async () => {
		const expiring = {
			accountId: "acct-a",
			credentialId: 1,
			weeklyUsed: 0.1,
			limitReached: false,
			creditExpiresInMs: 4 * MINUTE,
		};
		const salvageable = {
			accountId: "acct-b",
			credentialId: 2,
			weeklyUsed: 0.8,
			limitReached: false,
			creditExpiresInMs: 2 * HOUR,
		};
		const { session, coordinator, targets, notices } = buildSession({ accounts: [expiring, salvageable] });

		await session.fetchUsageReports();
		await coordinator.sweepPromise;

		expect(targets).toEqual([
			{ provider: "openai-codex", credentialId: 1, accountId: "acct-a", email: EMAIL, creditId: "credit-1" },
		]);
		expect(notices).toContainEqual(expect.stringContaining("auto-redeem is unset and no prompt UI is available"));
		expect([...coordinator.attemptedKeys]).toEqual([expect.stringContaining("openai-codex|-|1|")]);
	});

	it("spends a reset about to expire for an ACP client without form elicitation", async () => {
		const account = {
			accountId: "acct-a",
			credentialId: 1,
			weeklyUsed: 1,
			limitReached: true,
			creditExpiresInMs: 4 * MINUTE,
		};
		const { session, targets, notices } = buildSession({
			accounts: [account],
			streamErrorFirst: true,
			acpForm: false,
		});
		const elicitations = await attachAcpClient(session, false);
		mockSchedulerWaitWithClock();

		await session.prompt("trigger a codex usage limit");
		await session.waitForIdle();

		// Extensions keep ACP's UI context; only the consent prompt knows it cannot reach anyone.
		expect(session.extensionRunner?.hasUI()).toBe(true);
		expect(elicitations).toEqual([]);
		expect(targets).toEqual([
			{ provider: "openai-codex", credentialId: 1, accountId: "acct-a", email: EMAIL, creditId: "credit-1" },
		]);
		expect(notices).toContainEqual(expect.stringContaining(`Spending a saved Codex reset for ${EMAIL}`));
		expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("still asks an ACP client with form elicitation about a reset about to expire", async () => {
		const account = {
			accountId: "acct-a",
			credentialId: 1,
			weeklyUsed: 1,
			limitReached: true,
			creditExpiresInMs: 4 * MINUTE,
		};
		const { session, targets } = buildSession({ accounts: [account], streamErrorFirst: true, acpForm: true });
		const elicitations = await attachAcpClient(session, true);
		mockSchedulerWaitWithClock();

		await session.prompt("trigger a codex usage limit");
		await session.waitForIdle();

		expect(elicitations).toEqual([expect.stringContaining("Spend a saved Codex rate-limit reset?")]);
		expect(targets).toEqual([]);
		expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
	});
});
