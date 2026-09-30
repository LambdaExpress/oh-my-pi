import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AuthStorage, type FetchImpl, type Model, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { searchAnthropic } from "@oh-my-pi/pi-coding-agent/web/search/providers/anthropic";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { restoreEnvValue } from "../helpers/settings-test-state";

const originalAnthropicSearchApiKey = process.env.ANTHROPIC_SEARCH_API_KEY;
const originalAnthropicSearchBaseUrl = process.env.ANTHROPIC_SEARCH_BASE_URL;
const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
const originalFoundryBaseUrl = process.env.FOUNDRY_BASE_URL;
const originalUseFoundry = process.env.CLAUDE_CODE_USE_FOUNDRY;

/** Selected catalog model the search pipeline resolves for Anthropic web search. */
const searchModel: Model<"anthropic-messages"> = buildModel({
	id: "claude-haiku-4-5",
	name: "Claude Haiku 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

function restoreSearchEnv(): void {
	restoreEnvValue("ANTHROPIC_SEARCH_API_KEY", originalAnthropicSearchApiKey);
	restoreEnvValue("ANTHROPIC_SEARCH_BASE_URL", originalAnthropicSearchBaseUrl);
	restoreEnvValue("ANTHROPIC_BASE_URL", originalAnthropicBaseUrl);
	restoreEnvValue("FOUNDRY_BASE_URL", originalFoundryBaseUrl);
	restoreEnvValue("CLAUDE_CODE_USE_FOUNDRY", originalUseFoundry);
}

/** SearchParams around a mocked transport — only the HTTP call is faked, credentials/model stay real. */
function makeSearchParams(query: string, fetchMock: FetchImpl): SearchParams {
	return {
		query,
		systemPrompt: "Anthropic web search test system prompt",
		authStorage,
		model: searchModel,
		modelRegistry,
		fetch: fetchMock,
	};
}

function jsonResponse(body: Record<string, unknown>, status = 200): FetchImpl {
	return () =>
		Promise.resolve(
			new Response(JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
		);
}

/** JSON-answering fetch that records every request URL it was called with. */
function recordingJsonResponse(urls: string[], body: Record<string, unknown>): FetchImpl {
	return (input: string | URL | Request, init?: RequestInit) => {
		urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		return jsonResponse(body)(input, init);
	};
}

/** Minimal response that ran the web-search tool, so `searchAnthropic` resolves. */
const searchToolResponseBody: Record<string, unknown> = {
	id: "msg_base_url",
	model: "claude-haiku-4-5",
	content: [
		{ type: "server_tool_use", name: "web_search", input: { query: "bun test runner" } },
		{
			type: "web_search_tool_result",
			content: [
				{
					type: "web_search_result",
					title: "Bun Docs",
					url: "https://bun.sh/docs",
					encrypted_content: "enc",
					page_age: "2 days ago",
				},
			],
		},
		{ type: "text", text: "Bun's test runner is fast." },
	],
	usage: { input_tokens: 10, output_tokens: 20, server_tool_use: { web_search_requests: 1 } },
};

describe("searchAnthropic", () => {
	beforeEach(() => {
		authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		modelRegistry = new ModelRegistry(authStorage);
		process.env.ANTHROPIC_SEARCH_API_KEY = "test-key-123";
	});

	afterEach(() => {
		restoreSearchEnv();
		authStorage.close();
	});

	it("throws SearchProviderError when the model answers with plain text without running the search tool", async () => {
		const fetchMock = jsonResponse({
			id: "msg_clarify",
			model: "claude-haiku-4-5",
			content: [{ type: "text", text: "What would you like me to do with these filenames?" }],
			usage: { input_tokens: 5, output_tokens: 12 },
		});

		const error = await searchAnthropic(makeSearchParams("list the files", fetchMock)).then(
			() => null,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(SearchProviderError);
		expect((error as Error).message).toContain("did not execute");
		expect((error as SearchProviderError).provider).toBe("anthropic");
		expect((error as SearchProviderError).status).toBe(502);
	});

	it("returns answer and sources for a normal response with tool use", async () => {
		const fetchMock = jsonResponse({
			id: "msg_search",
			model: "claude-haiku-4-5",
			content: [
				{ type: "server_tool_use", name: "web_search", input: { query: "bun test runner" } },
				{
					type: "web_search_tool_result",
					content: [
						{
							type: "web_search_result",
							title: "Bun Docs",
							url: "https://bun.sh/docs",
							encrypted_content: "enc",
							page_age: "2 days ago",
						},
					],
				},
				{ type: "text", text: "Bun's test runner is fast." },
			],
			usage: { input_tokens: 10, output_tokens: 20, server_tool_use: { web_search_requests: 1 } },
		});

		const result = await searchAnthropic(makeSearchParams("bun test runner", fetchMock));
		expect(result.provider).toBe("anthropic");
		expect(result.answer).toBe("Bun's test runner is fast.");
		expect(result.sources).toHaveLength(1);
		expect(result.sources[0].title).toBe("Bun Docs");
		expect(result.sources[0].url).toBe("https://bun.sh/docs");
		expect(result.searchQueries).toEqual(["bun test runner"]);
	});

	it("does not throw when the search tool ran but returned zero results", async () => {
		const fetchMock = jsonResponse({
			id: "msg_zero",
			model: "claude-haiku-4-5",
			content: [
				{ type: "server_tool_use", name: "web_search", input: { query: "zzz nonexistent phrase" } },
				{ type: "web_search_tool_result", content: [] },
				{ type: "text", text: "No results found for that query." },
			],
			usage: { input_tokens: 8, output_tokens: 15, server_tool_use: { web_search_requests: 1 } },
		});

		const result = await searchAnthropic(makeSearchParams("zzz nonexistent phrase", fetchMock));
		expect(result.sources).toHaveLength(0);
		expect(result.searchQueries).toEqual(["zzz nonexistent phrase"]);
		expect(result.answer).toBe("No results found for that query.");
	});

	it("prefers ANTHROPIC_SEARCH_BASE_URL over the chat base URL", async () => {
		process.env.ANTHROPIC_BASE_URL = "https://chat-gateway.example.com";
		process.env.ANTHROPIC_SEARCH_BASE_URL = "https://search-gateway.example.com";
		const urls: string[] = [];

		const result = await searchAnthropic(
			makeSearchParams("bun test runner", recordingJsonResponse(urls, searchToolResponseBody)),
		);

		expect(urls).toEqual(["https://search-gateway.example.com/v1/messages?beta=true"]);
		expect(result.sources).toHaveLength(1);
	});

	it("follows the chat ANTHROPIC_BASE_URL when no search base URL is set", async () => {
		delete process.env.ANTHROPIC_SEARCH_BASE_URL;
		process.env.ANTHROPIC_BASE_URL = "https://chat-gateway.example.com";
		const urls: string[] = [];

		await searchAnthropic(makeSearchParams("bun test runner", recordingJsonResponse(urls, searchToolResponseBody)));

		expect(urls).toEqual(["https://chat-gateway.example.com/v1/messages?beta=true"]);
	});

	it("falls back to the model base URL when no base URL env var is set", async () => {
		delete process.env.ANTHROPIC_SEARCH_BASE_URL;
		delete process.env.ANTHROPIC_BASE_URL;
		delete process.env.CLAUDE_CODE_USE_FOUNDRY;
		delete process.env.FOUNDRY_BASE_URL;
		const urls: string[] = [];

		const result = await searchAnthropic(
			makeSearchParams("bun test runner", recordingJsonResponse(urls, searchToolResponseBody)),
		);

		expect(urls).toEqual(["https://api.anthropic.com/v1/messages?beta=true"]);
		expect(result.sources).toHaveLength(1);
	});
});
