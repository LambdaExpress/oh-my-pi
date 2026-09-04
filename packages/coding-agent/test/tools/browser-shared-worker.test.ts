import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { browserArgsUseProfile } from "../../src/tools/browser/shared-worker";

describe("shared browser worker", () => {
	const cwd = path.resolve("D:/project/example");
	const profile = path.join(cwd, ".omp", "browser.profile");

	it("matches only the exact root browser profile", () => {
		expect(browserArgsUseProfile([`--user-data-dir=${profile}`], profile, cwd)).toBe(true);
		expect(browserArgsUseProfile(["--user-data-dir", profile], profile, cwd)).toBe(true);
		expect(browserArgsUseProfile([`--user-data-dir=${profile}-other`], profile, cwd)).toBe(false);
		expect(browserArgsUseProfile(["--type=renderer", `--user-data-dir=${profile}`], profile, cwd)).toBe(false);
	});
});
