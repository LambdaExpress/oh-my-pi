import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { closeModelCacheSharedDb } from "@oh-my-pi/pi-catalog/model-cache";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getModelDbPath, setAgentDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { runSearchCommand } from "../../../src/cli/web-search-cli";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

let tempAgentDir: TempDir | undefined;
let modelDbPath: string | undefined;
let originalExitCode: typeof process.exitCode;
let settingsState: SettingsTestState | undefined;

function makeFetchMock(): typeof fetch {
	return Object.assign(
		async (input: string | Request | URL): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url === "https://www.startpage.com/") {
				return new Response("<html><body></body></html>", {
					status: 200,
					headers: { "Content-Type": "text/html" },
				});
			}
			if (url.startsWith("https://www.startpage.com/sp/search")) {
				return new Response(
					'<div class="result"><a class="result-link" href="https://startpage.example"><h2>Startpage result</h2></a><p class="description">startpage</p></div>',
					{ status: 200, headers: { "Content-Type": "text/html" } },
				);
			}
			if (url === "https://html.duckduckgo.com/html/") {
				return new Response(
					'<div class="result"><a class="result__a" href="https://duckduckgo.example">DuckDuckGo result</a><a class="result__snippet">duckduckgo</a></div>',
					{ status: 200, headers: { "Content-Type": "text/html" } },
				);
			}
			return new Response(`unexpected URL: ${url}`, { status: 500 });
		},
		{ preconnect: fetch.preconnect },
	);
}

beforeEach(async () => {
	settingsState = beginSettingsTest();
	originalExitCode = process.exitCode;
	process.exitCode = undefined;
	tempAgentDir = TempDir.createSync("@omp-search-cli-");
	setAgentDir(tempAgentDir.path());
	setProjectDir(tempAgentDir.path());
	modelDbPath = getModelDbPath();
	const settings = await Settings.init({ inMemory: true, cwd: tempAgentDir.path() });
	settings.setModelRole("web", "web/startpage");
	cfgRetryFallbackChains.set(settings, { web: [] });
});

afterEach(async () => {
	if (modelDbPath) {
		closeModelCacheSharedDb(modelDbPath);
		modelDbPath = undefined;
	}
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	process.exitCode = originalExitCode;
	if (tempAgentDir) {
		await tempAgentDir.remove();
		tempAgentDir = undefined;
	}
});

describe("runSearchCommand model role settings", () => {
	it("honors modelRoles.web for the implicit request", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock());
		let stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});

		await runSearchCommand({ query: "role selection smoke test", limit: 1, expanded: false });

		const plain = stripVTControlCharacters(stdout);
		expect(plain).toContain("startpage.example");
		expect(plain).not.toContain("duckduckgo.example");
	});

	it("treats --model as a one-shot override of modelRoles.web", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock());
		let stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});

		await runSearchCommand({
			query: "explicit model override",
			model: "web/duckduckgo",
			limit: 1,
			expanded: false,
		});

		const plain = stripVTControlCharacters(stdout);
		expect(plain).toContain("duckduckgo.example");
		expect(plain).not.toContain("startpage.example");
		expect(Settings.instance.getModelRole("web")).toBe("web/startpage");
	});
});
