import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { applyIgnoreHttpsErrors, resolveInitScriptSources } from "@oh-my-pi/pi-coding-agent/tools/browser/open-options";
import { buildHeadlessLaunchArgs } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { getTab, releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import type { Page } from "puppeteer-core";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const tempDirs: string[] = [];

function browserHost(cwd: string = process.cwd()) {
	const session: ToolSession = {
		cwd,
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
		prelude.invoke(parameters, { session, toolCallId: `browser-open-options-${crypto.randomUUID()}` });
}

function returnedValue(result: { details?: unknown }): unknown {
	return result.details && typeof result.details === "object" ? Reflect.get(result.details, "value") : undefined;
}

async function expectBrowserError(request: Promise<unknown>, message: string): Promise<void> {
	// Await worker I/O normally: Bun's .rejects matcher can synchronously re-enter
	// the event loop and starve the worker result until the supervisor times out.
	let failure: unknown;
	try {
		await request;
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(Error);
	expect(failure).toMatchObject({ message: expect.stringContaining(message) });
}

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
	await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("browser open options CDP helpers", () => {
	it("sends the invalid-certificate override through CDP", async () => {
		const args = buildHeadlessLaunchArgs(
			{ width: 800, height: 600 },
			{ ignoreHttpsErrors: true, allowFileAccess: true },
		);
		expect(args).toContain("--hide-scrollbars");
		expect(args).toContain("--enable-features=WebMCPTesting,DevToolsWebMCPSupport");
		expect(args).toContain("--ignore-certificate-errors");
		expect(args).toContain("--allow-file-access-from-files");
		const calls: Array<{ method: string; params: unknown }> = [];
		let detached = false;
		const page = {
			createCDPSession: async () => ({
				send: async (method: string, params: unknown) => {
					calls.push({ method, params });
				},
				detach: async () => {
					detached = true;
				},
			}),
		} as unknown as Page;

		await applyIgnoreHttpsErrors(page);

		expect(calls).toEqual([{ method: "Security.setIgnoreCertificateErrors", params: { ignore: true } }]);
		expect(detached).toBe(true);
	});

	it("omits per-open launch switches unless requested", () => {
		const args = buildHeadlessLaunchArgs({ width: 800, height: 600 });
		expect(args).not.toContain("--allow-file-access-from-files");
		if (!process.env.PUPPETEER_PROXY_IGNORE_CERT_ERRORS) {
			expect(args).not.toContain("--ignore-certificate-errors");
		}
	});

	it("loads existing init-script files and preserves inline source", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-init-test-"));
		tempDirs.push(directory);
		await Bun.write(path.join(directory, "init.js"), "globalThis.fromFile = true;");
		expect(await resolveInitScriptSources(["init.js", "globalThis.inline = true;"], directory)).toEqual([
			"globalThis.fromFile = true;",
			"globalThis.inline = true;",
		]);
	});
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser open options", () => {
	it("measures borrowed viewports, preserves them on reconnect, and applies explicit overrides", async () => {
		const launched = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in launched)) throw new Error("Expected a Puppeteer browser");
		const ownerPage = await launched.browser.newPage();
		const invoke = browserHost();
		const original = { width: 1111, height: 777, deviceScaleFactor: 1.5 };
		const url = `data:text/html,<title>borrowed-${crypto.randomUUID()}</title><button>Borrowed button</button>`;
		const endpoint = new URL(launched.browser.wsEndpoint());
		const app = { cdp_url: `http://${endpoint.host}`, target: url };
		try {
			await ownerPage.setViewport(original);
			await ownerPage.goto(url);
			for (const requested of [
				undefined,
				undefined,
				{ width: 1440, height: 1000, deviceScaleFactor: 1.25 },
				{ width: 1500, height: 980, deviceScaleFactor: 1.25 },
			]) {
				const name = `borrowed-viewport-${crypto.randomUUID()}`;
				try {
					await invoke({ action: "open", name, app, ...(requested ? { viewport: requested } : {}) });
					const value = returnedValue(
						await invoke({
							action: "run",
							name,
							code: `return {
								observed: (await tab.observe()).viewport,
								actual: await page.evaluate(() => ({
									width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio,
								})),
								emulated: page.viewport(),
							};`,
						}),
					) as { observed: unknown; actual: typeof original; emulated: unknown };
					const expected = requested ?? original;
					expect(value.actual).toMatchObject({ width: expected.width, height: expected.height });
					expect(value.actual.deviceScaleFactor).toBeCloseTo(expected.deviceScaleFactor, 6);
					expect(value.observed).toEqual(value.actual);
					expect(getTab(name)?.info.viewport).toMatchObject({ width: expected.width, height: expected.height });
					expect(getTab(name)?.info.viewport.deviceScaleFactor).toBeCloseTo(value.actual.deviceScaleFactor, 6);
					if (!requested) expect(value.emulated).toBeNull();
				} finally {
					await invoke({ action: "close", name });
				}
				expect(ownerPage.isClosed()).toBe(false);
			}
		} finally {
			await ownerPage.close();
			if (launched.browser.connected) await releaseBrowser(launched, { kill: true });
		}
	}, 60_000);

	it("does not restore untouched request interception after reconnecting to a read-only CDP tab", async () => {
		const launched = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in launched)) throw new Error("Expected a Puppeteer browser");
		const ownerPage = await launched.browser.newPage();
		const invoke = browserHost();
		const url = `data:text/html,<title>read-only-${crypto.randomUUID()}</title><button>Read only</button>`;
		const endpoint = new URL(launched.browser.wsEndpoint());
		const app = { cdp_url: `http://${endpoint.host}`, target: url };
		try {
			await ownerPage.goto(url);
			for (let attempt = 0; attempt < 2; attempt++) {
				const name = `read-only-reconnect-${crypto.randomUUID()}`;
				try {
					await invoke({ action: "open", name, app, persist: true });
					// Model a relay which supports DOM reads but rejects interception
					// mutation. The transport is tab-local and dies with this worker.
					const first = returnedValue(
						await invoke({
							action: "run",
							name,
							code: `const client = page._client();
								const send = client.send.bind(client);
								client.send = (method, ...args) => {
									if (method === "Fetch.disable" || method === "Fetch.enable") {
										throw new Error("Interception unavailable on read-only relay");
									}
									return send(method, ...args);
								};
								return await page.$eval("button", element => element.textContent);`,
						}),
					);
					expect(first).toBe("Read only");
					const observation = returnedValue(
						await invoke({ action: "call", name, chain: [{ method: "observe", args: [{ compact: true }] }] }),
					) as { elements: Array<{ name?: string }> };
					expect(observation.elements.some(element => element.name === "Read only")).toBe(true);
					expect(
						returnedValue(
							await invoke({
								action: "run",
								name,
								code: 'return await page.$eval("button", element => element.textContent);',
							}),
						),
					).toBe("Read only");
				} finally {
					await invoke({ action: "close", name });
				}
			}
		} finally {
			await ownerPage.close();
			if (launched.browser.connected) await releaseBrowser(launched, { kill: true });
		}
	}, 60_000);

	it("refreshes a detached cached main frame before input without losing tab state or replaying input", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: await findFreeCdpPort(),
			fetch(request) {
				if (new URL(request.url).pathname === "/api") return Response.json({ source: "origin" });
				return new Response(
					`<title>frame fixture</title><button id="increment" onclick="document.querySelector('output').textContent++">Increment</button><output>0</output>`,
					{ headers: { "content-type": "text/html" } },
				);
			},
		});
		const launched = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in launched)) throw new Error("Expected a Puppeteer browser");
		const ownerPage = await launched.browser.newPage();
		const invoke = browserHost();
		const name = `detached-frame-${crypto.randomUUID()}`;
		const endpoint = new URL(launched.browser.wsEndpoint());
		try {
			await ownerPage.goto(server.url.href);
			await invoke({
				action: "open",
				name,
				app: { cdp_url: `http://${endpoint.host}`, target: server.url.href },
				allowed_domains: ["127.0.0.1"],
			});
			const saved = returnedValue(
				await invoke({
					action: "run",
					name,
					code: `await tab.goto(${JSON.stringify(`${server.url.href}?navigated`)});
						await tab.route("**/api", { body: { source: "retained route" } });
						await tab.setDialogs("dismiss");
						const script = await tab.addInitScript("globalThis.__retainedInit = 41");
						const button = (await tab.observe()).elements.find(element => element.name === "Increment");
						return { id: button.id, scriptId: script.id };`,
				}),
			) as { id: number; scriptId: string };
			expect(
				returnedValue(
					await invoke({
						action: "run",
						name,
						// This invalidates only Puppeteer's cached frame; Chromium's target
						// and DOM remain alive, as in the Electron lifecycle report.
						code: `const frame = page.mainFrame();
							page._client().emit("Page.frameDetached", { frameId: frame._id, reason: "remove" });
							await wait(0);
							return frame.detached;`,
					}),
				),
			).toBe(true);
			expect(
				returnedValue(
					await invoke({
						action: "run",
						name,
						code: `let staleIdRejected = false;
							try { await tab.id(${saved.id}); } catch { staleIdRejected = true; }
							await tab.click("#increment");
							const count = await page.$eval("output", element => element.textContent);
							const body = await page.evaluate(async () => await (await fetch("/api")).json());
							const dismissed = await page.evaluate(() => confirm("retained dialog policy"));
							return {
								staleIdRejected, count, body, dismissed,
								requests: (await tab.requests({ filter: "/api" })).map(request => request.status),
								scriptRetained: (await tab.initScripts()).some(script => script.id === ${JSON.stringify(saved.scriptId)}),
							};`,
					}),
				),
			).toEqual({
				staleIdRejected: true,
				count: "1",
				body: { source: "retained route" },
				dismissed: false,
				requests: [200],
				scriptRetained: true,
			});
			await expectBrowserError(
				invoke({
					action: "run",
					name,
					code: `await tab.click("#increment");
						throw new Error("Attempted to use detached Frame after completed input");`,
				}),
				"Attempted to use detached Frame after completed input",
			);
			expect(await ownerPage.$eval("output", element => element.textContent)).toBe("2");
			expect(
				returnedValue(
					await invoke({
						action: "run",
						name,
						code: "await tab.reload(); return await tab.evaluate(() => globalThis.__retainedInit);",
					}),
				),
			).toBe(41);
			await invoke({
				action: "run",
				name,
				code: `const frame = page.mainFrame();
					const client = page._client();
					const send = client.send.bind(client);
					client.send = (method, ...args) => {
						if (method === "Page.getFrameTree") throw new Error("Frame refresh rejected");
						return send(method, ...args);
					};
					client.emit("Page.frameDetached", { frameId: frame._id, reason: "remove" });
					await wait(0);`,
			});
			await expectBrowserError(
				invoke({ action: "run", name, code: 'await tab.click("#increment");' }),
				"Frame refresh rejected",
			);
			expect(await ownerPage.$eval("output", element => element.textContent)).toBe("0");
		} finally {
			await invoke({ action: "close", name });
			await ownerPage.close();
			if (launched.browser.connected) await releaseBrowser(launched, { kill: true });
			server.stop(true);
		}
	}, 60_000);

	it("cleans up changed raw interception and reports restoration failures", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: await findFreeCdpPort(),
			fetch(request) {
				return new URL(request.url).pathname === "/api"
					? Response.json({ source: "origin" })
					: new Response("<title>interception fixture</title>", {
							headers: { "content-type": "text/html" },
						});
			},
		});
		const invoke = browserHost();
		const name = `interception-cleanup-${crypto.randomUUID()}`;
		const fetchCode = 'return await page.evaluate(async () => await (await fetch("/api")).json());';
		try {
			await invoke({ action: "open", name, url: server.url.href });
			expect(
				returnedValue(
					await invoke({
						action: "run",
						name,
						code: `await page.setRequestInterception(true);
							page.on("request", request => request.respond({
								contentType: "application/json", body: JSON.stringify({ source: "temporary" }),
							}));
							${fetchCode}`,
					}),
				),
			).toEqual({ source: "temporary" });
			expect(returnedValue(await invoke({ action: "run", name, code: fetchCode }))).toEqual({ source: "origin" });
			await expectBrowserError(
				invoke({
					action: "run",
					name,
					code: `await page.setRequestInterception(true);
						const client = page._client();
						const send = client.send.bind(client);
						client.send = (method, ...args) => {
							if (method === "Fetch.disable") throw new Error("Restoration rejected");
							return send(method, ...args);
						};
						return "must not hide failed cleanup";`,
				}),
				"Failed to restore browser request interception",
			);
			expect(returnedValue(await invoke({ action: "run", name, code: fetchCode }))).toEqual({ source: "origin" });
		} finally {
			await invoke({ action: "close", name });
			server.stop(true);
		}
	}, 60_000);

	it("applies open and runtime init scripts across navigations", async () => {
		const invoke = browserHost();
		const name = `init-${crypto.randomUUID()}`;
		await invoke({
			action: "open",
			name,
			url: "data:text/html,<title>first</title>",
			init_scripts: ["globalThis.__omp_init = (globalThis.__omp_init || 0) + 1"],
		});
		expect(
			returnedValue(
				await invoke({
					action: "run",
					name,
					code: "return await tab.evaluate(() => globalThis.__omp_init);",
				}),
			),
		).toBe(1);
		expect(
			returnedValue(
				await invoke({
					action: "run",
					name,
					code: "await tab.goto('data:text/html,<title>second</title>'); return await tab.evaluate(() => globalThis.__omp_init);",
				}),
			),
		).toBe(1);
		const added = returnedValue(
			await invoke({
				action: "call",
				name,
				chain: [{ method: "addInitScript", args: ["globalThis.__omp_runtime = 42"] }],
			}),
		) as { id: string };
		expect(typeof added.id).toBe("string");
		expect(
			returnedValue(
				await invoke({
					action: "run",
					name,
					code: "await tab.goto('data:text/html,<title>third</title>'); return await tab.evaluate(() => globalThis.__omp_runtime);",
				}),
			),
		).toBe(42);
		expect(
			returnedValue(await invoke({ action: "call", name, chain: [{ method: "initScripts", args: [] }] })),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: added.id, source: expect.stringContaining("__omp_runtime") }),
			]),
		);
		await invoke({
			action: "call",
			name,
			chain: [{ method: "removeInitScript", args: [added.id] }],
		});
		expect(
			returnedValue(
				await invoke({
					action: "run",
					name,
					code: "await tab.goto('data:text/html,<title>fourth</title>'); return await tab.evaluate(() => globalThis.__omp_runtime);",
				}),
			),
		).toBeUndefined();
	});

	it("overrides navigator and request user agents", async () => {
		const seen = Promise.withResolvers<string>();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: await findFreeCdpPort(),
			fetch(request) {
				seen.resolve(request.headers.get("user-agent") ?? "");
				return new Response("<title>ua</title>", { headers: { "content-type": "text/html" } });
			},
		});
		try {
			const invoke = browserHost();
			const name = `ua-${crypto.randomUUID()}`;
			await invoke({ action: "open", name, url: server.url.href, user_agent: "omp-open-options/1.0" });
			expect(
				returnedValue(
					await invoke({
						action: "run",
						name,
						code: "return await tab.evaluate(() => navigator.userAgent);",
					}),
				),
			).toBe("omp-open-options/1.0");
			expect(await seen.promise).toBe("omp-open-options/1.0");
		} finally {
			server.stop(true);
		}
	});

	it("waits for a completed download and records its bytes", async () => {
		const payload = new TextEncoder().encode("download payload\n");
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: await findFreeCdpPort(),
			fetch(request) {
				if (new URL(request.url).pathname === "/file") {
					return new Response(payload, {
						headers: {
							"content-type": "application/octet-stream",
							"content-disposition": 'attachment; filename="fixture.bin"',
						},
					});
				}
				return new Response('<a id="download" href="/file">download</a>', {
					headers: { "content-type": "text/html" },
				});
			},
		});
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-download-test-"));
		tempDirs.push(directory);
		try {
			const invoke = browserHost();
			const name = `download-${crypto.randomUUID()}`;
			await invoke({ action: "open", name, url: server.url.href, downloads: directory });
			const download = returnedValue(
				await invoke({
					action: "run",
					name,
					code: [
						"const pending = tab.waitForDownload({ timeout: 5000 });",
						"await tab.evaluate(() => document.querySelector('#download').click());",
						"return await pending;",
					].join("\n"),
				}),
			) as { path: string; suggestedFilename: string; url: string; bytes: number };
			expect(download.path).toBe(path.join(directory, "fixture.bin"));
			expect(download.suggestedFilename).toBe("fixture.bin");
			expect(download.url).toBe(`${server.url.href}file`);
			expect(download.bytes).toBe(payload.byteLength);
			expect(new Uint8Array(await Bun.file(download.path).arrayBuffer())).toEqual(payload);
			expect(
				returnedValue(await invoke({ action: "call", name, chain: [{ method: "downloads", args: [] }] })),
			).toEqual([download]);
		} finally {
			server.stop(true);
		}
	});
});
