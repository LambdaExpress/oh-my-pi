import { afterEach, describe, expect, it, vi } from "bun:test";
import { handlePyPI } from "../../src/web/scrapers/pypi";
import * as scrapers from "../../src/web/scrapers/types";

function stubPackageApi() {
	return vi.spyOn(scrapers, "loadPage").mockImplementation(async url => {
		const version = url.endsWith("/1.9.0/json") ? "1.9.0" : url.endsWith("/1.0%2Blocal/json") ? "1.0+local" : "2.0.1";
		const content = url.startsWith("https://pypistats.org/")
			? JSON.stringify({ data: { last_week: 14 } })
			: JSON.stringify({
					info: {
						name: "example-package",
						version,
						summary: `Summary for ${version}`,
						description: `Documentation for ${version}`,
					},
				});
		return { ok: true, status: 200, finalUrl: url, contentType: "application/json", content };
	});
}

describe("PyPI release-qualified URLs", () => {
	afterEach(() => vi.restoreAllMocks());

	it("uses the requested release for the API, heading, metadata and description", async () => {
		const loadPage = stubPackageApi();
		const result = await handlePyPI("https://pypi.org/project/example-package/1.9.0/", 10);

		expect(loadPage).toHaveBeenCalledWith("https://pypi.org/pypi/example-package/1.9.0/json", expect.anything());
		expect(loadPage).not.toHaveBeenCalledWith("https://pypi.org/pypi/example-package/json", expect.anything());
		expect(result?.content).toStartWith("# example-package 1.9.0\n");
		expect(result?.content).toContain("**Version:** 1.9.0");
		expect(result?.content).toContain("Summary for 1.9.0");
		expect(result?.content).toContain("Documentation for 1.9.0");
		expect(result?.content).not.toContain("Latest");
		expect(result?.content).not.toContain("2.0.1");
	});

	it("uses latest metadata only when the URL does not specify a release", async () => {
		const loadPage = stubPackageApi();
		const result = await handlePyPI("https://www.pypi.org/project/example-package/", 10);

		expect(loadPage).toHaveBeenCalledWith("https://pypi.org/pypi/example-package/json", expect.anything());
		expect(result?.content).toContain("**Latest:** 2.0.1");
		expect(result?.content).toContain("Documentation for 2.0.1");
	});

	it("preserves an encoded version as a single API path segment", async () => {
		const loadPage = stubPackageApi();
		const result = await handlePyPI("https://pypi.org/project/example-package/1.0%2Blocal/", 10);

		expect(loadPage).toHaveBeenCalledWith(
			"https://pypi.org/pypi/example-package/1.0%2Blocal/json",
			expect.anything(),
		);
		expect(result?.content).toContain("**Version:** 1.0+local");
		expect(result?.content).toContain("Documentation for 1.0+local");
	});

	it("does not replace an unavailable requested release with latest", async () => {
		const loadPage = vi.spyOn(scrapers, "loadPage").mockImplementation(async url => ({
			ok: false,
			status: 404,
			finalUrl: url,
			contentType: "application/json",
			content: "{}",
		}));

		expect(await handlePyPI("https://pypi.org/project/example-package/0.0.0/", 10)).toBeNull();
		expect(loadPage).toHaveBeenCalledWith("https://pypi.org/pypi/example-package/0.0.0/json", expect.anything());
		expect(loadPage).not.toHaveBeenCalledWith("https://pypi.org/pypi/example-package/json", expect.anything());
	});
});
