import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { acquireBrowser, holdBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	captureScreenshotBuffer,
	decodePng,
	type DecodedPng,
} from "@oh-my-pi/pi-coding-agent/tools/browser/screenshot";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ScreenshotResult } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { untilAborted } from "@oh-my-pi/pi-utils";
import type { Page } from "puppeteer-core";
import { CdpFrame } from "puppeteer-core/lib/puppeteer/cdp/Frame.js";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

async function withScreenshotPage(run: (page: Page, frame: CdpFrame) => Promise<void>): Promise<void> {
	const handle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
	if (!("browser" in handle)) throw new Error("Expected a Puppeteer browser");
	holdBrowser(handle);
	try {
		const page = await handle.browser.newPage();
		try {
			const frame = page.mainFrame();
			if (!(frame instanceof CdpFrame)) throw new Error("Expected a CDP frame");
			await run(page, frame);
		} finally {
			await page.close();
		}
	} finally {
		await releaseBrowser(handle, { kill: true });
	}
}

function pixelAt(image: DecodedPng, x: number, y: number): number[] {
	const offset = (y * image.width + x) * 4;
	return [...image.pixels.subarray(offset, offset + 4)];
}

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
		prelude.invoke(parameters, { session, toolCallId: `browser-screenshot-plus-${crypto.randomUUID()}` });
}

function valueFrom<T>(result: { details?: unknown }): T {
	if (!result.details || typeof result.details !== "object" || !("value" in result.details)) {
		throw new Error("Browser result did not include a value");
	}
	return result.details.value as T;
}

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser screenshot parity", () => {
	test("captures viewport, offscreen selector, and full page without animation or visibility callbacks", async () => {
		await withScreenshotPage(async (page, frame) => {
			await page.setViewport({ width: 400, height: 300, deviceScaleFactor: 1 });
			await page.setContent(`<!doctype html><style>
body { margin: 0; width: 800px; height: 1800px; background: white; }
#target { position: absolute; left: 520px; top: 1150px; width: 180px; height: 420px; background: #1473e6; }
#marker { position: absolute; right: 0; bottom: 0; width: 20px; height: 20px; background: #e62929; }
</style><div id="target"><div id="marker"></div></div>`);
			// Model a background relay tab in both worlds, including Puppeteer's
			// visibility-observer path used by ElementHandle.screenshot().
			for (const realm of [frame.mainRealm(), frame.isolatedRealm()]) {
				await realm.evaluate(`{
					globalThis.requestAnimationFrame = () => 1;
					globalThis.IntersectionObserver = class {
						observe() {}
						unobserve() {}
						disconnect() {}
						takeRecords() { return []; }
					};
				}`);
			}
			const viewport = decodePng(
				await captureScreenshotBuffer(page, {}, AbortSignal.timeout(5_000), selector => page.$(selector)),
			);
			expect([viewport.width, viewport.height]).toEqual([400, 300]);
			expect(pixelAt(viewport, 100, 100)).toEqual([255, 255, 255, 255]);

			const selected = decodePng(
				await captureScreenshotBuffer(page, { selector: "#target" }, AbortSignal.timeout(5_000), selector =>
					page.$(selector),
				),
			);
			expect([selected.width, selected.height]).toEqual([180, 420]);
			expect(pixelAt(selected, 0, 0)).toEqual([20, 115, 230, 255]);
			expect(pixelAt(selected, 179, 399)).toEqual([20, 115, 230, 255]);
			expect(pixelAt(selected, 179, 419)).toEqual([230, 41, 41, 255]);
			const scroll = (await page.evaluate("({ x: scrollX, y: scrollY })")) as { x: number; y: number };
			expect(scroll.x).toBeGreaterThan(0);
			expect(scroll.y).toBeGreaterThan(0);

			const fullPage = decodePng(
				await captureScreenshotBuffer(page, { fullPage: true }, AbortSignal.timeout(5_000), selector =>
					page.$(selector),
				),
			);
			expect([fullPage.width, fullPage.height]).toEqual([800, 1800]);
			expect(pixelAt(fullPage, 520, 1150)).toEqual([20, 115, 230, 255]);
			expect(pixelAt(fullPage, 699, 1569)).toEqual([230, 41, 41, 255]);
		});
	}, 30_000);

	test("aborts a selector capture while page-side scrolling is paused", async () => {
		await withScreenshotPage(async (page, frame) => {
			await page.setContent('<div id="target" style="width:80px;height:40px;background:blue"></div>');
			for (const realm of [frame.mainRealm(), frame.isolatedRealm()]) {
				await realm.evaluate("document.querySelector('#target').scrollIntoView = () => { debugger; }");
			}
			const client = await page.createCDPSession();
			const paused = Promise.withResolvers<void>();
			client.once("Debugger.paused", () => paused.resolve());
			await client.send("Debugger.enable");
			const controller = new AbortController();
			const reason = new Error("Screenshot cancelled");
			const capture = captureScreenshotBuffer(page, { selector: "#target" }, controller.signal, selector =>
				page.$(selector),
			).then(
				buffer => ({ buffer }),
				error => ({ error }),
			);
			try {
				await untilAborted(AbortSignal.timeout(5_000), () => paused.promise);
				controller.abort(reason);
				expect(await untilAborted(AbortSignal.timeout(1_000), () => capture)).toEqual({
					error: expect.objectContaining({ name: "AbortError", cause: reason }),
				});
			} finally {
				controller.abort();
				await client.send("Debugger.resume").catch(() => undefined);
				await capture;
				await client.detach();
			}
		});
	}, 15_000);

	test("propagates selector scrolling and invisible-element failures", async () => {
		await withScreenshotPage(async (page, frame) => {
			await page.setContent('<div id="target" style="width:80px;height:40px"></div>');
			for (const realm of [frame.mainRealm(), frame.isolatedRealm()]) {
				await realm.evaluate(
					"document.querySelector('#target').scrollIntoView = () => { throw new Error('Scrolling blocked by page'); }",
				);
			}
			await expect(
				captureScreenshotBuffer(page, { selector: "#target" }, AbortSignal.timeout(5_000), selector =>
					page.$(selector),
				),
			).rejects.toThrow("Scrolling blocked by page");
			for (const realm of [frame.mainRealm(), frame.isolatedRealm()]) {
				await realm.evaluate(`{
					const target = document.querySelector('#target');
					delete target.scrollIntoView;
					target.style.display = 'none';
				}`);
			}
			await expect(
				captureScreenshotBuffer(page, { selector: "#target" }, AbortSignal.timeout(5_000), selector =>
					page.$(selector),
				),
			).rejects.toMatchObject({ name: "Error" });
		});
	}, 15_000);

	test("annotates observed ids, detects pixel changes, writes JPEG screenshots, and prints PDF", async () => {
		const invoke = createHost();
		const name = `screenshot-plus-${crypto.randomUUID()}`;
		const html = `<!doctype html><html><head><style>
body { margin: 0; width: 800px; height: 600px; background: white; }
button { margin: 80px; width: 180px; height: 60px; }
#change { position: absolute; left: 350px; top: 250px; width: 200px; height: 160px; background: #1473e6; }
</style></head><body>
<button onclick="document.title='clicked'">Submit</button><div id="change"></div>
</body></html>`;
		await invoke({
			action: "open",
			name,
			url: `data:text/html,${encodeURIComponent(html)}`,
			viewport: { width: 800, height: 600 },
		});
		try {
			const observed = valueFrom<{ elements: Array<{ id: number; role: string; name?: string }> }>(
				await invoke({ action: "call", name, chain: [{ method: "observe", args: [] }] }),
			);
			const button = observed.elements.find(element => element.role === "button" && element.name === "Submit");
			expect(button).toBeDefined();

			// Regression: puppeteer returns a Uint8Array; encoding it with
			// `toString("base64")` produced decimal text that decoded to garbage
			// (0x0 dimensions, "image decoder failed", corrupt file on disk).
			const plain = await invoke({ action: "call", name, chain: [{ method: "screenshot", args: [] }] });
			const plainText = plain.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			expect(plainText).not.toContain("image decoder failed");
			expect(plainText).toMatch(/Dimensions: [1-9]\d*x[1-9]\d*/);
			const plainShots =
				plain.details && typeof plain.details === "object" && "screenshots" in plain.details
					? plain.details.screenshots
					: undefined;
			// The prelude reports the worker's ScreenshotResult[] verbatim under details.screenshots.
			const plainInfo = Array.isArray(plainShots) ? (plainShots as ScreenshotResult[])[0] : undefined;
			if (!plainInfo) throw new Error("Expected one screenshot result");
			expect(plainInfo.width).toBeGreaterThan(0);
			const plainMeta = await new Bun.Image(await fs.readFile(plainInfo.dest)).metadata();
			expect(plainMeta.width).toBe(plainInfo.width);

			const annotated = await invoke({
				action: "call",
				name,
				chain: [{ method: "screenshot", args: [{ annotate: true }] }],
			});
			const legendText = annotated.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			expect(legendText).toContain(`[${button?.id}] button "Submit"`);
			await invoke({
				action: "call",
				name,
				chain: [
					{ method: "id", args: [button?.id] },
					{ method: "click", args: [] },
				],
			});
			expect(valueFrom<string>(await invoke({ action: "call", name, chain: [{ method: "title", args: [] }] }))).toBe(
				"clicked",
			);

			type ChangeResult = { path?: string; changed: boolean; revision: number; pixelChangeRatio: number };
			const first = valueFrom<ChangeResult>(
				await invoke({
					action: "call",
					name,
					chain: [{ method: "screenshot", args: [{ ifChanged: true, silent: true }] }],
				}),
			);
			const staticCapture = valueFrom<ChangeResult>(
				await invoke({
					action: "call",
					name,
					chain: [{ method: "screenshot", args: [{ ifChanged: true, silent: true }] }],
				}),
			);
			expect(first).toMatchObject({ changed: true, revision: 1 });
			expect(staticCapture).toEqual({ changed: false, revision: 1, pixelChangeRatio: 0 });
			const baselinePath = valueFrom<string>(
				await invoke({
					action: "call",
					name,
					chain: [{ method: "screenshot", args: [{ format: "png", silent: true }] }],
				}),
			);

			await invoke({
				action: "call",
				name,
				chain: [{ method: "evaluate", args: ["document.querySelector('#change').style.background = '#e62929'"] }],
			});
			const changed = valueFrom<ChangeResult>(
				await invoke({
					action: "call",
					name,
					chain: [{ method: "screenshot", args: [{ ifChanged: true, silent: true }] }],
				}),
			);
			expect(changed.changed).toBe(true);
			expect(changed.revision).toBe(2);
			expect(changed.pixelChangeRatio).toBeGreaterThan(0);
			const diff = valueFrom<{ pixelChangeRatio: number; changed: boolean; diffPath: string }>(
				await invoke({
					action: "call",
					name,
					chain: [{ method: "diffScreenshot", args: [baselinePath] }],
				}),
			);
			expect(diff.changed).toBe(true);
			expect(diff.pixelChangeRatio).toBeGreaterThan(0);
			expect((await fs.readFile(diff.diffPath)).subarray(0, 8)).toEqual(
				Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			);

			await invoke({
				action: "call",
				name,
				chain: [
					{
						method: "evaluate",
						args: [
							"document.body.insertAdjacentHTML('beforeend', '<i style=position:absolute;left:1px;top:1px>!</i>')",
						],
					},
				],
			});
			const suppressed = valueFrom<ChangeResult>(
				await invoke({
					action: "call",
					name,
					chain: [{ method: "screenshot", args: [{ threshold: 0.1, silent: true }] }],
				}),
			);
			expect(suppressed.changed).toBe(false);
			expect(suppressed.pixelChangeRatio).toBeGreaterThan(0);
			expect(suppressed.pixelChangeRatio).toBeLessThan(0.1);

			const jpegPath = valueFrom<string>(
				await invoke({
					action: "call",
					name,
					chain: [{ method: "screenshot", args: [{ format: "jpeg", quality: 75, silent: true }] }],
				}),
			);
			expect(jpegPath.endsWith(".jpg")).toBe(true);
			const jpeg = await fs.readFile(jpegPath);
			expect([...jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);

			const pdfPath = valueFrom<string>(
				await invoke({
					action: "call",
					name,
					chain: [{ method: "pdf", args: [{ printBackground: true }] }],
				}),
			);
			const pdf = await fs.readFile(pdfPath);
			expect(pdf.byteLength).toBeGreaterThan(100);
			expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
		} finally {
			await invoke({ action: "close", name, kill: true }).catch(() => undefined);
		}
	}, 30_000);
});
