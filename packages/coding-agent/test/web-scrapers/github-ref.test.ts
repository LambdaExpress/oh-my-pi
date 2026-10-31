import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { handleGitHub } from "../../src/web/scrapers/github";

function serveGitHub(routes: Record<string, unknown>) {
	const fixtureFetch: typeof fetch = Object.assign(
		async (input: string | Request | URL) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const route = routes[url];
			if (route === undefined) return new Response("not found", { status: 404 });
			return typeof route === "string" ? new Response(route) : Response.json(route);
		},
		{
			preconnect: () => {
				throw new Error("Unexpected preconnect in the isolated GitHub fixture");
			},
		},
	);
	return spyOn(globalThis, "fetch").mockImplementation(fixtureFetch);
}

const API = "https://api.github.com/repos/owner/repository";
const RAW = "https://raw.githubusercontent.com/owner/repository";
const repo = { full_name: "owner/repository", default_branch: "main" };
const refs = [{ ref: "refs/heads/2022/full", object: { sha: "9fa89524cab15930c21a46fa4f6d28f5996c0e92" } }];

describe("GitHub slash-containing references", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reads the slash branch root and its README instead of inventing branch 2022", async () => {
		serveGitHub({
			[API]: repo,
			[`${API}/git/matching-refs/heads/2022`]: refs,
			[`${API}/git/matching-refs/tags/2022`]: [],
			[`${API}/contents/?ref=2022%2Ffull`]: [
				{ name: "Assets", type: "dir", path: "Assets" },
				{ name: "README.md", type: "file", path: "README.md" },
			],
			[`${RAW}/2022%2Ffull/README.md`]: "# Full branch README",
		});
		const result = await handleGitHub("https://github.com/owner/repository/tree/2022/full", 5);
		expect(result?.method).toBe("github-tree");
		expect(result?.content).toContain("**Branch:** 2022/full\n");
		expect(result?.content).toContain("[dir] Assets");
		expect(result?.content).toContain("# Full branch README");
	});

	it("separates the directory from an authoritative slash branch", async () => {
		serveGitHub({
			[API]: repo,
			[`${API}/git/matching-refs/heads/2022`]: refs,
			[`${API}/git/matching-refs/tags/2022`]: [],
			[`${API}/contents/Assets/Scenes?ref=2022%2Ffull`]: [
				{ name: "Scene.unity", type: "file", path: "Assets/Scenes/Scene.unity" },
			],
		});
		const result = await handleGitHub("https://github.com/owner/repository/tree/2022/full/Assets/Scenes", 5);
		expect(result?.content).toContain("# owner/repository/Assets/Scenes");
		expect(result?.content).toContain("**Branch:** 2022/full\n");
		expect(result?.content).toContain("Scene.unity");
	});

	it("uses the same authoritative reference for blob reads and percent-encoded slashes", async () => {
		serveGitHub({
			[`${API}/git/matching-refs/heads/2022`]: refs,
			[`${API}/git/matching-refs/tags/2022`]: [],
			[`${RAW}/2022%2Ffull/Assets/config.json`]: '{"branch":"2022/full"}',
		});
		const result = await handleGitHub("https://github.com/owner/repository/blob/2022%2Ffull/Assets/config.json", 5);
		expect(result?.method).toBe("github-raw");
		expect(result?.content).toBe('{"branch":"2022/full"}');
	});

	it("does not claim a successful directory when the authoritative contents request fails", async () => {
		serveGitHub({
			[API]: repo,
			[`${API}/git/matching-refs/heads/2022`]: refs,
			[`${API}/git/matching-refs/tags/2022`]: [],
		});
		expect(await handleGitHub("https://github.com/owner/repository/tree/2022/full/missing", 5)).toBeNull();
	});

	it("reports ambiguous repository refs instead of guessing a branch/path split", async () => {
		serveGitHub({
			[`${API}/git/matching-refs/heads/2022`]: [{ ref: "refs/heads/2022" }],
			[`${API}/git/matching-refs/tags/2022`]: [{ ref: "refs/tags/2022/full" }],
		});
		const result = await handleGitHub("https://github.com/owner/repository/tree/2022/full", 5);
		expect(result?.method).toBe("github-ref-ambiguous");
		expect(result?.content).toContain("2022/full");
		expect(result?.content).toContain("explicit ref");
		expect(result?.content).not.toContain("## Contents");
	});

	it("resolves a commit URL's tree without interpreting its file path as a branch", async () => {
		const sha = "9fa89524cab15930c21a46fa4f6d28f5996c0e92";
		serveGitHub({
			[API]: repo,
			[`${API}/git/matching-refs/heads/9fa8952`]: [],
			[`${API}/git/matching-refs/tags/9fa8952`]: [],
			[`${API}/commits/9fa8952`]: { sha },
			[`${API}/contents/Assets?ref=${sha}`]: [{ name: "Scene.unity", type: "file", path: "Assets/Scene.unity" }],
		});
		const result = await handleGitHub("https://github.com/owner/repository/tree/9fa8952/Assets", 5);
		expect(result?.method).toBe("github-tree");
		expect(result?.content).toContain(`**Branch:** ${sha}\n`);
		expect(result?.content).toContain("Scene.unity");
	});
});
