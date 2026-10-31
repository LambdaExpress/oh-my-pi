import { describe, expect, test } from "bun:test";
import { runBrowserIssueRegressions } from "../fixtures/browser-issues-runner";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const LONG_WAITS = process.env.OMP_BROWSER_LONG_WAITS === "1";

describe.skipIf(!CHROMIUM_AVAILABLE)("browser issue consumer regressions", () => {
	test(
		"preserves exactly-once input, exact AX icon whitespace, bounded diagnostics and recoverable frame state",
		async () => {
			const result = await runBrowserIssueRegressions({ longWaits: LONG_WAITS });
			expect(result.roleNames).toEqual(["Login\uf0da", "Login \uf0da", "Hidden icon"]);
		},
		LONG_WAITS ? 180_000 : 60_000,
	);
});
