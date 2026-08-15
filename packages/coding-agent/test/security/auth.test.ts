import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { ApiKeyResolver } from "@oh-my-pi/pi-ai/auth-retry";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { setLocale } from "../../src/i18n";
import { createExactSecurityOAuthResolver, selectSecurityAccount } from "../../src/security";
import type { AuthStorage } from "../../src/session/auth-storage";

beforeEach(() => {
	setLocale("en");
});

afterEach(() => {
	setLocale(null);
});

function model() {
	const value = getBundledModel("openai-codex", "gpt-5.6-sol");
	if (!value) throw new Error("Expected bundled Codex model");
	return value;
}

describe("exact security OAuth resolver", () => {
	test("selects an explicit credential without account rotation", () => {
		const listOAuthAccounts = vi.fn(() => [
			{ credentialId: 11, position: 0, active: true, accountId: "workspace-a" },
			{ credentialId: 42, position: 1, active: false, accountId: "workspace-b" },
		]);
		const selected = selectSecurityAccount(
			{ listOAuthAccounts } as unknown as AuthStorage,
			"openai-codex",
			42,
			"session-a",
		);
		expect(selected).toEqual({ provider: "openai-codex", credentialId: 42, accountId: "workspace-b" });
		expect(listOAuthAccounts).toHaveBeenCalledWith("openai-codex", "session-a");
	});

	test("returns null for key mode when no OAuth accounts exist and no credential is requested", () => {
		const listOAuthAccounts = vi.fn(() => []);
		const selected = selectSecurityAccount(
			{ listOAuthAccounts } as unknown as AuthStorage,
			"opencode-go",
			undefined,
			"session-a",
		);
		expect(selected).toBeNull();
		expect(listOAuthAccounts).toHaveBeenCalledWith("opencode-go", "session-a");
	});

	test("throws the stored-account requirement when a credential is pinned without accounts", () => {
		const listOAuthAccounts = vi.fn(() => []);
		expect(() =>
			selectSecurityAccount({ listOAuthAccounts } as unknown as AuthStorage, "opencode-go", 42, "session-a"),
		).toThrow("Security scans require a stored OAuth account for opencode-go");
		expect(listOAuthAccounts).toHaveBeenCalledWith("opencode-go", "session-a");
	});

	test("resolves and refreshes only the pinned durable row", async () => {
		const getOAuthAccessByCredentialId = vi.fn(async (_provider, credentialId, options) => ({
			ok: true as const,
			accessToken: options?.forceRefresh ? "refreshed" : "initial",
			credentialId,
			accountId: "workspace-a",
		}));
		const authStorage = { getOAuthAccessByCredentialId } as unknown as AuthStorage;
		const resolver = createExactSecurityOAuthResolver({
			authStorage,
			account: { provider: "openai-codex", credentialId: 42, accountId: "workspace-a" },
		});
		const apiKey = resolver(model());
		expect(typeof apiKey).toBe("function");
		const exact = apiKey as ApiKeyResolver;
		expect(await exact({ lastChance: false, error: undefined })).toBe("initial");
		expect(await exact({ lastChance: false, error: new Error("401") })).toBe("refreshed");
		expect(await exact({ lastChance: true, error: new Error("401") })).toBeUndefined();
		expect(getOAuthAccessByCredentialId.mock.calls.map(call => call[1])).toEqual([42, 42]);
	});

	test("rejects a model whose provider crosses the pinned OAuth boundary", async () => {
		const getOAuthAccessByCredentialId = vi.fn(async () => ({
			ok: true as const,
			accessToken: "must-not-be-requested",
			credentialId: 42,
			accountId: "workspace-a",
		}));
		const authStorage = { getOAuthAccessByCredentialId } as unknown as AuthStorage;
		const resolver = createExactSecurityOAuthResolver({
			authStorage,
			account: { provider: "openai-codex", credentialId: 42, accountId: "workspace-a" },
		});
		const wrongProviderModel = { ...model(), provider: "anthropic" } as unknown as Parameters<typeof resolver>[0];
		expect(() => resolver(wrongProviderModel)).toThrow("provider mismatch");
		expect(getOAuthAccessByCredentialId).not.toHaveBeenCalled();
	});

	test("fails closed when any durable account identity changes", async () => {
		const account = {
			provider: "openai-codex",
			credentialId: 42,
			accountId: "workspace-a",
			email: "owner@example.com",
			organizationId: "org-a",
			organizationName: "Workspace A",
		};
		const resolved = {
			credentialId: 42,
			accountId: "workspace-a",
			email: "owner@example.com",
			orgId: "org-a",
			orgName: "Workspace A",
		};
		for (const mismatch of [
			{ credentialId: 99 },
			{ accountId: "workspace-b" },
			{ email: "other@example.com" },
			{ orgId: "org-b" },
			{ orgName: "Workspace B" },
		]) {
			const authStorage = {
				getOAuthAccessByCredentialId: async () => ({
					ok: true as const,
					accessToken: "token",
					...resolved,
					...mismatch,
				}),
			} as unknown as AuthStorage;
			const resolver = createExactSecurityOAuthResolver({ authStorage, account });
			const exact = resolver(model()) as ApiKeyResolver;
			await expect(exact({ lastChance: false, error: undefined })).rejects.toThrow("identity mismatch");
		}
	});

	test("fails closed when the refreshed row loses its workspace identity", async () => {
		const authStorage = {
			getOAuthAccessByCredentialId: async () => ({
				ok: true as const,
				accessToken: "token",
				credentialId: 42,
				accountId: undefined,
			}),
		} as unknown as AuthStorage;
		const resolver = createExactSecurityOAuthResolver({
			authStorage,
			account: { provider: "openai-codex", credentialId: 42, accountId: "workspace-a" },
		});
		const exact = resolver(model()) as ApiKeyResolver;
		let caught: unknown;
		try {
			await exact({ lastChance: false, error: undefined });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		if (!(caught instanceof Error)) throw new Error("expected identity mismatch");
		expect(caught.message).toContain("identity mismatch");
		expect(caught.message).not.toContain("workspace-a");
		expect(caught.message).not.toContain("undefined");
	});
});
