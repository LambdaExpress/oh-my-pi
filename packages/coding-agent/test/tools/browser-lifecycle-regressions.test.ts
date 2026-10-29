import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { applyIgnoreHttpsErrors } from "@oh-my-pi/pi-coding-agent/tools/browser/open-options";
import { decodePng } from "@oh-my-pi/pi-coding-agent/tools/browser/screenshot";
import { getTab, releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

function createHost() {
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.headless": true,
			"browser.cmux": false,
			"browser.tern": false,
			"tools.maxTimeout": 0,
		}),
	};
	const prelude = createBrowserPrelude(session);
	return (parameters: unknown) =>
		prelude.invoke(parameters, { session, toolCallId: `browser-lifecycle-${crypto.randomUUID()}` });
}

function valueOf<T>(result: { details?: unknown }): T {
	const details = result.details;
	if (!details || typeof details !== "object" || !("value" in details)) {
		throw new Error("Browser result did not contain a value");
	}
	return details.value as T;
}

async function withBrowser(run: (browser: Browser) => Promise<void>): Promise<void> {
	const executablePath = await ensureChromiumExecutable();
	if (!executablePath) throw new Error("Chromium executable unavailable");
	const browser = await puppeteer.launch({
		executablePath,
		headless: true,
		args: ["--no-sandbox", "--site-per-process"],
	});
	try {
		await run(browser);
	} finally {
		await browser.close();
	}
}

async function mainValue<T>(page: Page, source: string): Promise<T> {
	return (await page.mainFrame().mainRealm().evaluate(source)) as T;
}

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser lifecycle regressions", () => {
	test("keeps a CDP certificate override alive through initial and subsequent HTTPS navigations", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			tls: {
				key: await Bun.file(path.join(import.meta.dir, "../fixtures/browser-lifecycle-key.pem")).text(),
				cert: await Bun.file(path.join(import.meta.dir, "../fixtures/browser-lifecycle-cert.pem")).text(),
			},
			fetch: () =>
				new Response("<title>local HTTPS fixture</title><button>Secure response</button>", {
					headers: { "content-type": "text/html" },
				}),
		});
		const invoke = createHost();
		const name = `https-lifetime-${crypto.randomUUID()}`;
		try {
			await withBrowser(async browser => {
				const rejectedPage = await browser.newPage();
				let failure: unknown;
				try {
					await rejectedPage.goto(server.url.href);
				} catch (error) {
					failure = error;
				} finally {
					await rejectedPage.close();
				}
				expect(failure).toMatchObject({ message: expect.stringContaining("ERR_CERT_") });
				// An ERR_CERT interstitial can replace its target. The positive case, like browser.open(),
				// applies the override to a fresh page before its first navigation, not that failed target.
				const page = await browser.newPage();
				const override = await applyIgnoreHttpsErrors(page);
				try {
					await page.goto(server.url.href);
					await page.reload();
					expect(await page.title()).toBe("local HTTPS fixture");
				} finally {
					await override.detach();
					await page.close();
				}
			});
			await invoke({ action: "open", name, url: server.url.href, ignore_https_errors: true });
			expect(
				valueOf<string>(
					await invoke({ action: "run", name, code: "await page.reload(); return await page.title();" }),
				),
			).toBe("local HTTPS fixture");
		} finally {
			if (getTab(name)) await invoke({ action: "close", name });
			server.stop(true);
		}
	}, 30_000);

	test("refuses an unpainted background cross-origin frame without moving focus, then captures it in front", async () => {
		const frameServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				new Response(
					"<style>html,body{margin:0;width:100%;height:100%;background:rgb(17,193,53)}</style><button>iframe content</button>",
					{
						headers: { "content-type": "text/html" },
					},
				),
		});
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				new Response(
					`<style>body{margin:0}header{height:20px;background:red}iframe{border:0;width:320px;height:200px}</style><header>outer</header><iframe src="http://localhost:${frameServer.port}/"></iframe>`,
					{
						headers: { "content-type": "text/html" },
					},
				),
		});
		try {
			await withBrowser(async browser => {
				const page = await browser.newPage();
				await page.setViewport({ width: 320, height: 240, deviceScaleFactor: 1 });
				await page.goto(server.url.href);
				const foreground = await browser.newPage();
				await foreground.bringToFront();
				await mainValue(
					page,
					'Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: () => "visible" }); true',
				);
				expect(await mainValue<string>(page, "document.visibilityState")).toBe("visible");
				expect(await page.evaluate(() => document.visibilityState)).toBe("hidden");
				const invoke = createHost();
				const name = `background-frame-${crypto.randomUUID()}`;
				try {
					const endpoint = new URL(browser.wsEndpoint());
					await invoke({
						action: "open",
						name,
						app: { cdp_url: `http://${endpoint.host}`, target: server.url.href },
					});
					let failure: unknown;
					try {
						await invoke({ action: "call", name, chain: [{ method: "screenshot", args: [{ silent: true }] }] });
					} catch (error) {
						failure = error;
					}
					expect(failure).toMatchObject({
						message: expect.stringContaining("background tab containing a cross-origin iframe"),
					});
					expect(await foreground.evaluate(() => document.visibilityState)).toBe("visible");
					await page.bringToFront();
					const saved = valueOf<string>(
						await invoke({
							action: "call",
							name,
							chain: [{ method: "screenshot", args: [{ silent: true, format: "png" }] }],
						}),
					);
					try {
						const image = decodePng(await Bun.file(saved).bytes());
						const pixel = (100 * image.width + 100) * 4;
						expect([...image.pixels.subarray(pixel, pixel + 4)]).toEqual([17, 193, 53, 255]);
					} finally {
						await fs.rm(saved, { force: true });
					}
				} finally {
					if (getTab(name)) await invoke({ action: "close", name });
				}
			});
		} finally {
			server.stop(true);
			frameServer.stop(true);
		}
	}, 30_000);

	test("finishes delayed interception cleanup in place while viewport, scripts, logs, HAR and requests survive", async () => {
		const slow = Promise.withResolvers<void>();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const pathname = new URL(request.url).pathname;
				if (pathname === "/slow") {
					await slow.promise;
					return new Response("slow finished");
				}
				if (pathname === "/probe" || pathname === "/before") return new Response(pathname);
				return new Response("<title>interception lifetime fixture</title><button>Ready</button>", {
					headers: { "content-type": "text/html" },
				});
			},
		});
		const invoke = createHost();
		const name = `interception-lifetime-${crypto.randomUUID()}`;
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-lifecycle-"));
		const harPath = path.join(directory, "lifecycle.har");
		try {
			await invoke({
				action: "open",
				name,
				url: server.url.href,
				viewport: { width: 840, height: 620, deviceScaleFactor: 1.25 },
				init_scripts: ["globalThis.__initialLifecycle = 19"],
			});
			const tab = getTab(name);
			if (!tab || tab.backend !== "worker") throw new Error("Expected a worker tab");
			const worker = tab.worker;
			const observer = (await tab.browser.browser.pages()).find(page => page.url() === server.url.href);
			if (!observer) throw new Error("Fixture page unavailable");
			await invoke({
				action: "run",
				name,
				code: `await tab.addInitScript("globalThis.__runtimeLifecycle = 42");
await page.reload();
await tab.harStart({ content: "text" });
await tab.evaluate(() => fetch("/before").then(response => response.text()));
globalThis.__retainedLifecycle = 73;`,
			});
			const before = valueOf<Array<{ id: string; url: string }>>(
				await invoke({
					action: "call",
					name,
					chain: [{ method: "requests", args: [] }],
				}),
			).find(request => request.url.endsWith("/before"));
			expect(before).toBeDefined();
			const completed = await invoke({
				action: "run",
				name,
				code: `await page.setRequestInterception(true);
page.on("request", request => { if (!request.isInterceptResolutionHandled()) return request.continue(); });
const requested = page.waitForRequest(request => request.url().endsWith("/slow"));
await tab.evaluate(() => { /*!world=main*/
  globalThis.__slowLifecycle = "pending";
  globalThis.__slowLifecyclePromise = fetch("/slow").then(response => response.text()).then(text => { globalThis.__slowLifecycle = text; return text; });
});
await requested;
const client = page.mainFrame().client;
const send = client.send.bind(client);
client.send = (method, ...args) => method === "Fetch.disable"
  ? send("Runtime.evaluate", { expression: "(() => { const gate = Promise.withResolvers(); globalThis.__releaseLifecycleCleanup = gate.resolve; globalThis.__lifecycleCleanupObserved = Promise.withResolvers(); return gate.promise; })()", awaitPromise: true })
      .then(() => send(method, ...args))
      .then(() => send("Runtime.evaluate", { expression: "globalThis.__lifecycleCleanupObserved.resolve()" }))
  : send(method, ...args);
return "completed without stopping the page";`,
			});
			expect(valueOf<string>(completed)).toBe("completed without stopping the page");
			expect(completed.content).toContainEqual({
				type: "text",
				text: expect.stringContaining("cleanup is still pending"),
			});
			expect(tab.worker).toBe(worker);
			// New browser requests must not remain paused while Puppeteer already considers Fetch disabled.
			expect(await mainValue<string>(observer, 'fetch("/probe").then(response => response.text())')).toBe("/probe");
			slow.resolve();
			expect(await mainValue<string>(observer, "globalThis.__slowLifecyclePromise")).toBe("slow finished");
			await mainValue(observer, "globalThis.__releaseLifecycleCleanup()");
			await mainValue(observer, "globalThis.__lifecycleCleanupObserved.promise");
			// The observer and tab worker have separate CDP sockets. Await worker readiness through real IPC,
			// rather than assuming which socket receives Chrome's completion response first.
			let ready = false;
			for (let attempt = 0; attempt < 50 && !ready; attempt++) {
				try {
					await invoke({ action: "run", name, code: "return null;" });
					ready = true;
				} catch (error) {
					if (!(error instanceof Error) || !error.message.includes("cleanup is still pending")) throw error;
				}
			}
			expect(ready).toBe(true);
			const retained = valueOf<{
				viewport: { width: number; height: number; deviceScaleFactor: number };
				init: number[];
				runGlobal: number;
				slow: string;
				requests: Array<{ id: string; url: string }>;
			}>(
				await invoke({
					action: "run",
					name,
					code: `return {
  viewport: await tab.evaluate(() => ({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio })),
  init: await tab.evaluate(() => { /*!world=main*/ return [globalThis.__initialLifecycle, globalThis.__runtimeLifecycle]; }),
  runGlobal: globalThis.__retainedLifecycle,
  slow: await tab.evaluate(() => { /*!world=main*/ return globalThis.__slowLifecycle; }),
  requests: await tab.requests(),
};`,
				}),
			);
			expect(retained.viewport).toEqual({ width: 840, height: 620, deviceScaleFactor: 1.25 });
			expect(retained.init).toEqual([19, 42]);
			expect(retained.runGlobal).toBe(73);
			expect(retained.slow).toBe("slow finished");
			expect(retained.requests).toContainEqual(expect.objectContaining({ id: before!.id, url: before!.url }));
			expect(tab.worker).toBe(worker);
			await invoke({ action: "call", name, chain: [{ method: "harStop", args: [{ path: harPath }] }] });
			const har = JSON.parse(await Bun.file(harPath).text()) as {
				log: { entries: Array<{ request: { url: string } }> };
			};
			expect(har.log.entries.some(entry => entry.request.url.endsWith("/slow"))).toBe(true);
		} finally {
			slow.resolve();
			if (getTab(name)) await invoke({ action: "close", name });
			server.stop(true);
			await fs.rm(directory, { recursive: true, force: true });
		}
	}, 30_000);
});
