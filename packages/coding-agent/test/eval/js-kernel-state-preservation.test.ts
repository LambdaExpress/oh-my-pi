import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { executeJs } from "@oh-my-pi/pi-coding-agent/eval/js/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { chromiumAvailable } from "../tools/chromium-probe";

function createSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
	};
}

afterEach(async () => {
	await disposeAllVmContexts();
});

describe("JavaScript retained state after rejected browser calls", () => {
	it("keeps successful bindings after an ordinary rejected Eval cell", async () => {
		const session = createSession();
		const options = { session, sessionId: `issue23-rejection-${crypto.randomUUID()}` };
		expect((await executeJs("var issue23Saved = { value: 41 };", options)).exitCode).toBe(0);
		const failed = await executeJs('await Promise.reject(new Error("ordinary cell rejection"));', options);
		expect(failed.exitCode).toBe(1);
		expect(failed.output).toContain("ordinary cell rejection");
		const resumed = await executeJs("print(issue23Saved.value + 1);", options);
		expect(resumed.exitCode).toBe(0);
		expect(resumed.output.trim()).toBe("42");
	}, 20_000);

	it("contains a late remote download rejection after the busy cell already settled", async () => {
		// A direct Worker under bun:test inherits Bun's native isBunTest flag,
		// which bypasses process rejection listeners. Run the exact late-reply
		// scenario in a plain Bun process so the production guard is exercised.
		const fixture = path.resolve(import.meta.dir, "../fixtures/js-kernel-late-rejection-probe.ts");
		const proc = Bun.spawn([process.execPath, fixture], {
			cwd: process.cwd(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const watchdog = setTimeout(() => proc.kill("SIGKILL"), 15_000);
		try {
			const [exitCode, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			expect(exitCode, stderr).toBe(0);
			expect(stdout).toContain("late bridge rejection contained; earlier binding retained");
			expect(stdout).toContain("unattributed infrastructure rejection remains fatal");
		} finally {
			clearTimeout(watchdog);
			if (proc.exitCode === null) proc.kill("SIGKILL");
		}
	}, 20_000);

	it("reports real worker loss on the first result from the replacement kernel only", async () => {
		const session = createSession();
		const options = { session, sessionId: `issue23-exit-${crypto.randomUUID()}` };
		expect((await executeJs("var issue23BeforeExit = 41;", options)).exitCode).toBe(0);
		const exited = await executeJs("process.exit(7);", options);
		expect(exited.exitCode).toBe(1);
		const resumed = await executeJs("print(typeof issue23BeforeExit);", options);
		expect(resumed.exitCode).toBe(0);
		expect(resumed.output).toContain("[JS kernel state lost]");
		expect(resumed.output).toContain("variables from earlier cells are gone");
		expect(resumed.output).toContain("undefined");
		const later = await executeJs('print("fresh kernel");', options);
		expect(later.exitCode).toBe(0);
		expect(later.output.trim()).toBe("fresh kernel");
	}, 20_000);

	it("does not claim unexpected kernel loss after an explicit reset", async () => {
		const session = createSession();
		const options = { session, sessionId: `issue23-reset-${crypto.randomUUID()}` };
		expect((await executeJs("var issue23BeforeReset = 41;", options)).exitCode).toBe(0);
		const reset = await executeJs("print(typeof issue23BeforeReset);", { ...options, reset: true });
		expect(reset.exitCode).toBe(0);
		expect(reset.output.trim()).toBe("undefined");
	}, 20_000);
});

const CHROMIUM_AVAILABLE = await chromiumAvailable();

describe("JavaScript retained state real browser Eval", () => {
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"keeps an earlier real browser handle after a rejected download wait and click",
		async () => {
			const name = `issue23-browser-${crypto.randomUUID()}`;
			const session: ToolSession = {
				...createSession(),
				settings: Settings.isolated({
					"browser.enabled": true,
					"browser.headless": true,
					"browser.relay": false,
					"browser.cmux": false,
					"browser.tern": false,
				}),
				getEvalPreludes: () => [prelude],
			};
			const prelude = createBrowserPrelude(session);
			const options = { session, sessionId: name };
			const url = `data:text/html,${encodeURIComponent("<!doctype html><button>Save</button>")}`;
			try {
				const opened = await executeJs(
					`var issue23RealSaved = 41; var issue23RealTab = await browser.open({ name: ${JSON.stringify(name)}, url: ${JSON.stringify(url)} });`,
					options,
				);
				expect(opened.exitCode).toBe(0);
				// This page never downloads. Both a valid concurrent-call busy error
				// and the eventual download timeout must remain ordinary cell errors.
				const failed = await executeJs(
					[
						"var issue23RealDownload = issue23RealTab.waitForDownload({ timeout: 0.25 });",
						'await issue23RealTab.click("text/Save");',
						"await issue23RealDownload;",
					].join("\n"),
					options,
				);
				expect(failed.exitCode).toBe(1);
				const resumed = await executeJs(
					"print(issue23RealSaved + 1); print(await issue23RealTab.title());",
					options,
				);
				expect(resumed.exitCode).toBe(0);
				expect(resumed.output).toContain("42\n");
				expect(resumed.output).not.toContain("[JS kernel state lost]");
			} finally {
				await prelude
					.invoke({ action: "close", name }, { session, toolCallId: `cleanup-${name}` })
					.catch(() => undefined);
			}
		},
		30_000,
	);
});
