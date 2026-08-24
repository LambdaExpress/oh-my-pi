import { afterEach, describe, expect, it, vi } from "bun:test";
import { getLatestRelease, runUpdateCommand } from "../../src/cli/update-cli";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

describe("runUpdateCommand fetch cancellation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("checks release metadata with a timeout signal", async () => {
		let requestSignal: AbortSignal | undefined;
		vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				requestSignal = init?.signal ?? undefined;
				return Response.json([{ tag_name: "code-999", draft: false, prerelease: false }]);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		await runUpdateCommand({ force: false, check: true });

		expect(requestSignal).toBeInstanceOf(AbortSignal);
	});
});

describe("getLatestRelease code releases", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function stubReleases(releases: unknown): string[] {
		const urls: string[] = [];
		const fetchStub = Object.assign(
			async (input: FetchInput) => {
				const url = String(input);
				urls.push(url);
				return Response.json(releases);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		return urls;
	}

	it("selects the highest stable numeric code regardless of API order", async () => {
		const urls = stubReleases([
			{ tag_name: "code-7", draft: false, prerelease: false },
			{ tag_name: "v18.0.4", draft: false, prerelease: false },
			{ tag_name: "code-12", draft: false, prerelease: false },
			{ tag_name: "code-99", draft: true, prerelease: false },
			{ tag_name: "code-30", draft: false, prerelease: true },
		]);

		const release = await getLatestRelease();

		expect(release.tag).toBe("code-12");
		expect(release.code).toBe(12);
		expect(release.dist).toBe("binary");
		expect(urls).toEqual(["https://api.github.com/repos/LambdaExpress/oh-my-pi/releases?per_page=100"]);
	});

	it("rejects a release list without a published code tag", async () => {
		stubReleases([{ tag_name: "v18.0.4", draft: false, prerelease: false }]);

		await expect(getLatestRelease()).rejects.toThrow("No published code release");
	});
});

describe("getLatestRelease proxy errors", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("translates Bun's UnsupportedProxyProtocol fetch failure into an actionable CLI message", async () => {
		const fetchStub = Object.assign(
			async () => {
				throw new Error(
					'UnsupportedProxyProtocol fetching "https://api.github.com/repos/LambdaExpress/oh-my-pi/releases?per_page=100". ' +
						"For more information, pass `verbose: true` in the second argument to fetch()",
				);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const err = await getLatestRelease({ timeoutMs: 5000 }).then(
			() => null,
			(e: unknown) => e as Error,
		);

		expect(err).toBeInstanceOf(Error);
		// The raw fetch() instruction the CLI user cannot act on must not leak through.
		expect(err?.message).not.toContain("verbose: true");
		expect(err?.message).not.toContain("fetch()");
		// Instead the user gets actionable guidance about supported proxy schemes.
		expect(err?.message).toMatch(/SOCKS/i);
		expect(err?.message).toMatch(/https?:\/\//i);
	});
});
