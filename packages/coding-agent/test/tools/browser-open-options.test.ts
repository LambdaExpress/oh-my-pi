import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { applyIgnoreHttpsErrors, resolveInitScriptSources } from "@oh-my-pi/pi-coding-agent/tools/browser/open-options";
import { DownloadManager } from "@oh-my-pi/pi-coding-agent/tools/browser/downloads";
import { buildHeadlessLaunchArgs } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { getTab, releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import type { Browser, Page } from "puppeteer-core";
import { rejectionOf } from "../helpers/rejection";
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
	return (parameters: unknown, signal?: AbortSignal) =>
		prelude.invoke(parameters, { session, toolCallId: `browser-open-options-${crypto.randomUUID()}`, signal });
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

	async function fakeDownloads(
		send: (method: string, params: unknown) => Promise<unknown> = async () => undefined,
		perTab = true,
	) {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-download-test-"));
		const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-download-test-"));
		tempDirs.push(directory, elsewhere);
		const listeners = new Map<string, (event: unknown) => void>();
		const session = {
			on: (event: string, listener: (event: unknown) => void) => listeners.set(event, listener),
			off: () => undefined,
			send,
			detach: async () => undefined,
		};
		const browser = {
			target: () => ({ createCDPSession: async () => session }),
			wsEndpoint: () => "ws://127.0.0.1/devtools/browser/download-fixture",
		} as unknown as Browser;
		const page = { frames: () => [{ _id: "frame" }], browserContext: () => ({}) } as unknown as Page;
		const downloads = new DownloadManager(browser, page, "tab", { perTab });
		const complete = async (
			guid: unknown,
			filePath: string | undefined,
			suggestedFilename: unknown = "../../report.txt",
		) => {
			await downloads.enable(directory);
			const waiting = downloads.wait();
			await downloads.arming;
			const started = { guid, url: "https://example.com/", suggestedFilename, frameId: "frame" };
			listeners.get("Browser.downloadWillBegin")!(started);
			listeners.get("Browser.downloadProgress")!({ guid, state: "completed", receivedBytes: 5, filePath });
			return (await waiting).path;
		};
		return { directory, elsewhere, downloads, complete };
	}

	it("moves only a file saved under its download GUID, under the last segment of the suggested name", async () => {
		const { directory, elsewhere, complete } = await fakeDownloads();

		const unrelated = path.join(elsewhere, "notes.txt");
		await Bun.write(unrelated, "notes");
		expect(await complete(crypto.randomUUID(), unrelated)).toBe(unrelated);
		expect(await Bun.file(unrelated).text()).toBe("notes");

		const guid = crypto.randomUUID();
		const saved = path.join(elsewhere, guid);
		await Bun.write(saved, "bytes");
		expect(await complete(guid, saved)).toBe(path.join(directory, "report.txt"));
		expect(await Bun.file(path.join(directory, "report.txt")).text()).toBe("bytes");
		expect(await Bun.file(saved).exists()).toBe(false);
	});

	it("leaves a file in place when the peer names it by a GUID that is not a UUID", async () => {
		const { directory, elsewhere, complete } = await fakeDownloads();
		const key = path.join(elsewhere, "id_ed25519");
		await Bun.write(key, "private key");

		expect(await complete("id_ed25519", key)).toBe(key);
		expect(await Bun.file(key).text()).toBe("private key");
		expect(await Bun.file(path.join(directory, "report.txt")).exists()).toBe(false);
	});

	it("leaves a symlink named by a UUID GUID in place", async () => {
		const { directory, elsewhere, complete } = await fakeDownloads();
		const guid = crypto.randomUUID();
		const link = path.join(elsewhere, guid);
		await Bun.write(path.join(elsewhere, "notes.txt"), "notes");
		await fs.symlink(path.join(elsewhere, "notes.txt"), link);

		expect(await complete(guid, link)).toBe(link);
		expect(await fs.readlink(link)).toBe(path.join(elsewhere, "notes.txt"));
		expect(await Bun.file(path.join(directory, "report.txt")).exists()).toBe(false);
	});

	it("leaves a directory named by a UUID GUID in place", async () => {
		const { directory, elsewhere, complete } = await fakeDownloads();
		const guid = crypto.randomUUID();
		const folder = path.join(elsewhere, guid);
		await Bun.write(path.join(folder, "notes.txt"), "notes");

		expect(await complete(guid, folder)).toBe(folder);
		expect(await Bun.file(path.join(folder, "notes.txt")).text()).toBe("notes");
		expect(await Bun.file(path.join(directory, "report.txt")).exists()).toBe(false);
	});

	it("keeps a directory named like the download when the rename takes the Windows replacement path", async () => {
		const { directory, elsewhere, complete } = await fakeDownloads();
		const guid = crypto.randomUUID();
		const saved = path.join(elsewhere, guid);
		await Bun.write(saved, "bytes");
		await Bun.write(path.join(directory, "report.txt", "notes.txt"), "notes");
		const rename = spyOn(nodeFs.promises, "rename").mockImplementationOnce(async () => {
			throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
		});
		try {
			expect(await complete(guid, saved)).toBe(saved);
		} finally {
			rename.mockRestore();
		}
		expect(await Bun.file(path.join(directory, "report.txt", "notes.txt")).text()).toBe("notes");
		expect(await Bun.file(saved).text()).toBe("bytes");
	});

	it("keeps the same-named file when a cross-device move fails to copy", async () => {
		const { directory, elsewhere, complete } = await fakeDownloads();
		const guid = crypto.randomUUID();
		const saved = path.join(elsewhere, guid);
		await Bun.write(saved, "bytes");
		await Bun.write(path.join(directory, "report.txt"), "earlier report");
		const rename = spyOn(nodeFs.promises, "rename").mockImplementationOnce(async () => {
			throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
		});
		const copyFile = spyOn(nodeFs.promises, "copyFile").mockImplementationOnce(async () => {
			throw Object.assign(new Error("i/o error"), { code: "EIO" });
		});
		try {
			expect(await complete(guid, saved)).toBe(saved);
		} finally {
			rename.mockRestore();
			copyFile.mockRestore();
		}
		expect(await Bun.file(path.join(directory, "report.txt")).text()).toBe("earlier report");
		expect(await fs.readdir(directory)).toEqual(["report.txt"]);
	});

	it("reports the moved file when a cross-device move cannot remove the source", async () => {
		const { directory, elsewhere, complete } = await fakeDownloads();
		const guid = crypto.randomUUID();
		const saved = path.join(elsewhere, guid);
		await Bun.write(saved, "bytes");
		await Bun.write(path.join(directory, "report.txt"), "earlier report");
		const rename = spyOn(nodeFs.promises, "rename").mockImplementationOnce(async () => {
			throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
		});
		const unlink = spyOn(nodeFs.promises, "unlink").mockImplementationOnce(async () => {
			throw Object.assign(new Error("permission denied"), { code: "EACCES" });
		});
		try {
			expect(await complete(guid, saved)).toBe(path.join(directory, "report.txt"));
		} finally {
			rename.mockRestore();
			unlink.mockRestore();
		}
		expect(await Bun.file(path.join(directory, "report.txt")).text()).toBe("bytes");
		expect(await fs.readdir(directory)).toEqual(["report.txt"]);
	});

	it("keeps real file names and leaves files in place in a browser the user drives", async () => {
		const behaviors: unknown[] = [];
		const { elsewhere, complete } = await fakeDownloads(async (method, params) => {
			if (method === "Browser.setDownloadBehavior") behaviors.push(params);
		}, false);
		const guid = crypto.randomUUID();
		const saved = path.join(elsewhere, "report.txt");
		await Bun.write(saved, "bytes");

		expect(await complete(guid, saved)).toBe(saved);
		expect(await Bun.file(saved).text()).toBe("bytes");
		expect(behaviors.length).toBeGreaterThan(0);
		for (const params of behaviors) expect(params).toMatchObject({ behavior: "allow" });
	});

	it("reports a download whose suggested name is not a string where Chromium saved it", async () => {
		const { elsewhere, complete } = await fakeDownloads();
		const guid = crypto.randomUUID();
		const saved = path.join(elsewhere, guid);
		await Bun.write(saved, "bytes");

		expect(await complete(guid, saved, null)).toBe(saved);
		expect(await Bun.file(saved).text()).toBe("bytes");
	});

	it("rejects the wait when a completed download cannot be read", async () => {
		const { complete } = await fakeDownloads();

		const error = await rejectionOf(complete(42, undefined));
		expect(error).toBeInstanceOf(ToolError);
		expect((error as ToolError).message).toStartWith("Download failed: https://example.com/");
	});

	it("rejects a wait whose signal is already aborted without leaving the enable failure unhandled", async () => {
		const { downloads } = await fakeDownloads(async () => {
			throw new Error("setDownloadBehavior failed");
		});
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		expect(await rejectionOf(downloads.wait(controller.signal))).toBe(controller.signal.reason);
		// A second enable runs the same steps, so an enable the wait started has failed by now, inside this test, where
		// Bun fails it if nothing handled the rejection.
		expect(await rejectionOf(downloads.enable())).toBeInstanceOf(Error);
	});

	it("rejects a wait aborted while downloads are being enabled with the caller's reason", async () => {
		const enabling = Promise.withResolvers<void>();
		const { downloads } = await fakeDownloads(() => enabling.promise);
		const controller = new AbortController();
		const waiting = rejectionOf(downloads.wait(controller.signal));
		const reason = new Error("cancelled");
		controller.abort(reason);
		expect(await waiting).toBe(reason);
		enabling.resolve();
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
			// Successful runs keep their result while cleanup recycles the worker.
			// A failed run must surface the cleanup failure rather than hiding it.
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
						throw new Error("Run failed before cleanup");`,
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

	it("keeps the tab on what loaded when the page outlasts the open timeout", async () => {
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				// The image never answers, so the page never fires `load`.
				if (new URL(request.url).pathname === "/hang.png") return new Promise<Response>(() => {});
				return new Response('<title>slow</title><p>partial</p><img src="/hang.png">', {
					headers: { "content-type": "text/html" },
				});
			},
		});
		try {
			const invoke = browserHost();
			const name = `slow-${crypto.randomUUID()}`;
			const open = () => rejectionOf(invoke({ action: "open", name, url: server.url.href, timeout: 3 }));
			const keptTab = { message: expect.stringContaining(`browser.tab(${JSON.stringify(name)})`) };
			// The first open creates the tab; the second reuses the one it kept.
			expect(await open()).toMatchObject(keptTab);
			expect(await open()).toMatchObject(keptTab);
			expect(
				returnedValue(
					await invoke({
						action: "run",
						name,
						code: "return { url: tab.url(), text: await tab.evaluate(() => document.body.innerText) };",
					}),
				),
			).toEqual({ url: server.url.href, text: "partial" });
		} finally {
			server.stop(true);
		}
	}, 20_000);

	it("closes the tab its open created when the navigation fails outright, but keeps a reused one", async () => {
		const refused = Bun.serve({ port: 0, fetch: () => new Response("") });
		const url = refused.url.href;
		refused.stop(true);
		const invoke = browserHost();
		const tabNames = async () =>
			(returnedValue(await invoke({ action: "tabs" })) as Array<{ name: string }>).map(tab => tab.name);
		const name = `refused-${crypto.randomUUID()}`;
		const keptNote = `browser.tab(${JSON.stringify(name)})`;

		const fresh = await rejectionOf(invoke({ action: "open", name, url }));
		expect(fresh).toMatchObject({ message: expect.stringContaining("net::ERR_CONNECTION_REFUSED") });
		expect(fresh).not.toMatchObject({ message: expect.stringContaining(keptNote) });
		expect(getTab(name)).toBeUndefined();
		expect(await tabNames()).not.toContain(name);

		await invoke({ action: "open", name, url: "data:text/html,<title>kept</title>" });
		expect(await rejectionOf(invoke({ action: "open", name, url }))).toMatchObject({
			message: expect.stringContaining(keptNote),
		});
		expect(getTab(name)?.state).toBe("alive");
		expect(await tabNames()).toContain(name);
	});

	it("closes the tab its open created when the open is cancelled during navigation", async () => {
		const requested = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<void>();
		const server = Bun.serve({
			port: 0,
			async fetch() {
				requested.resolve();
				// Held until after the cancel, so the navigation is still pending then.
				await answer.promise;
				return new Response("<title>late</title>", { headers: { "content-type": "text/html" } });
			},
		});
		try {
			const invoke = browserHost();
			const name = `cancelled-${crypto.randomUUID()}`;
			const controller = new AbortController();
			const open = rejectionOf(invoke({ action: "open", name, url: server.url.href }, controller.signal));
			await requested.promise;
			const cancelled = getTab(name);
			expect(cancelled?.state).toBe("alive");
			controller.abort();
			expect(await open).toBeInstanceOf(ToolAbortError);
			// A cancelled run may only unwind once the pending document answers.
			answer.resolve();
			// Opens of one name run in order, so this one starts after the
			// cancelled open finished unwinding, and finds no tab to reuse.
			const reopened = await invoke({ action: "open", name });
			expect(reopened.content).toEqual([expect.objectContaining({ text: expect.stringMatching(/^Opened tab /) })]);
			expect(getTab(name)).not.toBe(cancelled);
		} finally {
			server.stop(true);
		}
	}, 20_000);

	it("saves each tab's downloads into its own downloads directory, also after another tab closes", async () => {
		let served = 0;
		const gateReached = Promise.withResolvers<void>();
		const gateOpened = Promise.withResolvers<void>();
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				const tab = url.searchParams.get("tab");
				if (url.pathname === "/gate") {
					gateReached.resolve();
					await gateOpened.promise;
					return new Response("open");
				}
				if (url.pathname === "/file") {
					return new Response(`tab ${tab}, download ${++served}\n`, {
						headers: {
							"content-type": "application/octet-stream",
							"content-disposition": 'attachment; filename="fixture.bin"',
						},
					});
				}
				return new Response(`<a id="download" href="/file?tab=${tab}">download</a>`, {
					headers: { "content-type": "text/html" },
				});
			},
		});
		const first = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-download-test-"));
		const second = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-download-test-"));
		tempDirs.push(first, second);
		const unrelated = path.join(first, `${crypto.randomUUID()}.crdownload`);
		await Bun.write(unrelated, "unrelated file\n");
		try {
			const invoke = browserHost();
			const download = async (name: string, beforeClick = "") =>
				returnedValue(
					await invoke({
						action: "run",
						name,
						code: [
							"const pending = tab.waitForDownload({ timeout: 5000 });",
							beforeClick,
							"await tab.evaluate(() => document.querySelector('#download').click());",
							"return await pending;",
						].join("\n"),
					}),
				) as { path: string };
			const firstTab = `download-${crypto.randomUUID()}`;
			const secondTab = `download-${crypto.randomUUID()}`;
			await invoke({ action: "open", name: firstTab, url: `${server.url.href}?tab=first`, downloads: first });

			// Hold the first tab after its download wait is armed, then configure its sibling before the download
			// starts. Chromium's download behavior is context-wide even though the destinations are tab-scoped.
			const gate = JSON.stringify(`${server.url.href}gate`);
			const firstDownload = download(firstTab, `await tab.title(); await fetch(${gate});`);
			await gateReached.promise;
			await invoke({ action: "open", name: secondTab, url: `${server.url.href}?tab=second`, downloads: second });
			gateOpened.resolve();
			expect((await firstDownload).path).toBe(path.join(first, "fixture.bin"));
			expect(await Bun.file(path.join(first, "fixture.bin")).text()).toBe("tab first, download 1\n");
			expect(await fs.readdir(second)).toEqual([]);

			expect((await download(secondTab)).path).toBe(path.join(second, "fixture.bin"));
			expect(await Bun.file(path.join(second, "fixture.bin")).text()).toBe("tab second, download 2\n");

			await invoke({ action: "close", name: secondTab });
			expect((await download(firstTab)).path).toBe(path.join(first, "fixture.bin"));
			expect(await Bun.file(path.join(first, "fixture.bin")).text()).toBe("tab first, download 3\n");
			expect(await Bun.file(unrelated).text()).toBe("unrelated file\n");
			expect((await fs.readdir(first)).sort()).toEqual([path.basename(unrelated), "fixture.bin"].sort());
			expect(await fs.readdir(second)).toEqual(["fixture.bin"]);

			await invoke({ action: "open", name: secondTab, url: `${server.url.href}?tab=second`, downloads: second });
			await invoke({ action: "close", name: firstTab });
			expect((await download(secondTab)).path).toBe(path.join(second, "fixture.bin"));
			expect(await Bun.file(path.join(second, "fixture.bin")).text()).toBe("tab second, download 4\n");
			expect(await fs.readdir(second)).toEqual(["fixture.bin"]);
			expect(await Bun.file(unrelated).text()).toBe("unrelated file\n");
		} finally {
			gateOpened.resolve();
			server.stop(true);
		}
	}, 20_000);

	it("saves a download started inside the tab's iframe into the tab's downloads directory", async () => {
		const payload = new TextEncoder().encode("download payload\n");
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const { pathname } = new URL(request.url);
				if (pathname === "/file") {
					return new Response(payload, {
						headers: {
							"content-type": "application/octet-stream",
							"content-disposition": 'attachment; filename="fixture.bin"',
						},
					});
				}
				const body =
					pathname === "/frame" ? '<a id="download" href="/file">download</a>' : '<iframe src="/frame"></iframe>';
				return new Response(body, { headers: { "content-type": "text/html" } });
			},
		});
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-download-test-"));
		tempDirs.push(directory);
		try {
			const invoke = browserHost();
			const name = `download-${crypto.randomUUID()}`;
			await invoke({ action: "open", name, url: server.url.href, wait_until: "load", downloads: directory });
			const download = returnedValue(
				await invoke({
					action: "run",
					name,
					code: [
						"const pending = tab.waitForDownload({ timeout: 3000 });",
						"await tab.evaluate(() => document.querySelector('iframe').contentDocument.querySelector('#download').click());",
						"return await pending;",
					].join("\n"),
				}),
			) as { path: string };
			expect(download.path).toBe(path.join(directory, "fixture.bin"));
			expect(new Uint8Array(await Bun.file(download.path).arrayBuffer())).toEqual(payload);
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

	it("tracks a download started right after waitForDownload on a tab opened without a downloads directory", async () => {
		const payload = new TextEncoder().encode("download payload\n");
		const server = Bun.serve({
			port: 0,
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
		try {
			const invoke = browserHost();
			const name = `download-${crypto.randomUUID()}`;
			await invoke({ action: "open", name, url: server.url.href });
			const download = returnedValue(
				await invoke({
					action: "run",
					name,
					code: [
						"const pending = tab.waitForDownload({ timeout: 3000 });",
						"await tab.evaluate(() => document.querySelector('#download').click());",
						"return await pending;",
					].join("\n"),
				}),
			) as { path: string; bytes: number };
			tempDirs.push(path.dirname(download.path));
			expect(path.dirname(download.path)).toStartWith(path.join(os.tmpdir(), "omp-downloads-"));
			expect(download.bytes).toBe(payload.byteLength);
			expect(new Uint8Array(await Bun.file(download.path).arrayBuffer())).toEqual(payload);
		} finally {
			server.stop(true);
		}
	});
});
