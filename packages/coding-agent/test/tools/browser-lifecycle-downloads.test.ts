import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Browser, Page } from "puppeteer-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { DownloadManager, type BrowserDownload } from "@oh-my-pi/pi-coding-agent/tools/browser/downloads";
import { getTab, releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

function downloadFixture(options: { unsupported?: boolean } = {}) {
	const listeners = new Map<string, (event: unknown) => void>();
	const commands: Array<{ method: string; params: unknown }> = [];
	let pageSessionDetached = false;
	const connection = {
		on: (type: string, handler: (event: unknown) => void) => listeners.set(type, handler),
		off: (type: string) => listeners.delete(type),
		send: async (method: string, params: unknown) => {
			commands.push({ method, params });
			if (options.unsupported) throw new Error("Browser domain is not allowed by chrome.debugger");
		},
	};
	const browser = {
		wsEndpoint: () => "ws://127.0.0.1/devtools/browser/download-connection-fixture",
	} as unknown as Browser;
	const page = {
		createCDPSession: async () => ({
			connection: () => connection,
			send: async () => {
				throw new Error("Browser download commands must use the root connection, not a child session");
			},
			detach: async () => {
				pageSessionDetached = true;
			},
		}),
		browserContext: () => ({}),
		frames: () => [{ _id: "fixture-frame" }],
	} as unknown as Page;
	return {
		manager: new DownloadManager(browser, page, crypto.randomUUID(), { perTab: false }),
		commands,
		emit: (type: string, event: unknown) => listeners.get(type)?.(event),
		get pageSessionDetached() {
			return pageSessionDetached;
		},
	};
}

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
});

describe("native browser download inventory", () => {
	test("arms a native Blob inventory without changing the user's download directory", async () => {
		const fixture = downloadFixture();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-download-fixture-"));
		const saved = path.join(directory, "native.toml");
		await Bun.write(saved, "fixture = true\n");
		try {
			await fixture.manager.start();
			expect(fixture.pageSessionDetached).toBe(true);
			expect(fixture.commands).toEqual([
				{
					method: "Browser.setDownloadBehavior",
					params: { behavior: "default", eventsEnabled: true },
				},
			]);
			fixture.emit("Browser.downloadWillBegin", {
				guid: "unrelated",
				frameId: "other-frame",
				url: "blob:https://example.com/unrelated",
				suggestedFilename: "other.txt",
			});
			fixture.emit("Browser.downloadProgress", {
				guid: "unrelated",
				state: "completed",
				receivedBytes: 5,
				filePath: saved,
			});
			expect(await fixture.manager.list()).toEqual([]);
			fixture.emit("Browser.downloadWillBegin", {
				guid: "native",
				frameId: "fixture-frame",
				url: "blob:https://example.com/native",
				suggestedFilename: "native.toml",
			});
			fixture.emit("Browser.downloadProgress", {
				guid: "native",
				state: "completed",
				receivedBytes: 15,
				filePath: saved,
			});
			expect(await fixture.manager.list()).toEqual([
				{
					path: saved,
					url: "blob:https://example.com/native",
					suggestedFilename: "native.toml",
					bytes: 15,
				},
			]);
			expect((await fixture.manager.wait()).path).toBe(saved);
			expect(await Bun.file(saved).text()).toBe("fixture = true\n");
		} finally {
			await fixture.manager.close();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test("reports an unsupported relay debugger instead of a successful empty inventory", async () => {
		const fixture = downloadFixture({ unsupported: true });
		try {
			await fixture.manager.start();
			await expect(fixture.manager.list()).rejects.toThrow("Download tracking is unavailable");
			await expect(fixture.manager.wait()).rejects.toThrow("Browser domain is not allowed");
		} finally {
			await fixture.manager.close();
		}
	});

	test("does not invent a saved path when a native browser omits it", async () => {
		const fixture = downloadFixture();
		try {
			await fixture.manager.start();
			fixture.emit("Browser.downloadWillBegin", {
				guid: "native",
				frameId: "fixture-frame",
				url: "blob:https://example.com/native",
				suggestedFilename: "native.toml",
			});
			fixture.emit("Browser.downloadProgress", { guid: "native", state: "completed", receivedBytes: 15 });
			await expect(fixture.manager.list()).rejects.toThrow("without exposing its saved path");
		} finally {
			await fixture.manager.close();
		}
	});
});

describe.skipIf(!CHROMIUM_AVAILABLE)("managed native Blob downloads", () => {
	test("inventories a completed download without a preceding waitForDownload or custom directory", async () => {
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
		const invoke = (parameters: unknown) =>
			prelude.invoke(parameters, { session, toolCallId: "browser-native-blob" });
		const name = `blob-inventory-${crypto.randomUUID()}`;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				new Response(
					`<button id="save">Save</button><script>
document.querySelector("#save").addEventListener("click", () => {
  const blob = new Blob(["fixture = true\\n"], { type: "application/toml" });
  const link = document.createElement("a");
  link.href = window.URL.createObjectURL(blob);
  link.download = "native-fixture.toml";
  document.body.appendChild(link);
  link.click();
  link.remove();
  document.body.dataset.blobClicked = "yes";
});
</script>`,
					{ headers: { "content-type": "text/html" } },
				),
		});
		let saved: string | undefined;
		try {
			await invoke({
				action: "open",
				name,
				url: server.url.href,
			});
			await invoke({
				action: "run",
				name,
				timeout: 5,
				// Observe completion, without tab.waitForDownload(), enabling downloads, or changing their path.
				// This fails if worker initialization did not already subscribe to native download events.
				code: `const root = page.mainFrame().client.connection();
const frameId = page.mainFrame()._id;
const completed = Promise.withResolvers();
let downloadGuid;
const begin = event => { if (event.frameId === frameId) downloadGuid = event.guid; };
const progress = event => { if (event.guid === downloadGuid && event.state === "completed") completed.resolve(); };
root.on("Browser.downloadWillBegin", begin);
root.on("Browser.downloadProgress", progress);
try {
  await page.click("#save");
  if (await page.$eval("body", body => body.dataset.blobClicked) !== "yes") {
    throw new Error("Blob fixture did not complete native download initiation");
  }
  await completed.promise;
} finally {
  root.off("Browser.downloadWillBegin", begin);
  root.off("Browser.downloadProgress", progress);
}`,
			});
			const result = await invoke({ action: "call", name, chain: [{ method: "downloads", args: [] }] });
			const details = result.details;
			if (!details || typeof details !== "object" || !("value" in details) || !Array.isArray(details.value)) {
				throw new Error("Download inventory did not return an array");
			}
			const downloads = details.value as BrowserDownload[];
			expect(downloads).toHaveLength(1);
			const download = downloads[0]!;
			saved = download.path;
			expect(download.url.startsWith("blob:")).toBe(true);
			expect(download.suggestedFilename).toBe("native-fixture.toml");
			expect(await Bun.file(saved).text()).toBe("fixture = true\n");
		} finally {
			if (getTab(name)) await invoke({ action: "close", name });
			if (saved) await fs.rm(saved, { force: true });
			server.stop(true);
		}
	}, 30_000);
});
