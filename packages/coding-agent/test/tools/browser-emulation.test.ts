import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { freezeTabsForOwner, releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const OWNER_ID = "browser-emulation-test-owner";
const session: ToolSession = {
	cwd: process.cwd(),
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
	getSessionId: () => OWNER_ID,
	settings: Settings.isolated({
		"browser.enabled": true,
		"browser.headless": true,
		"browser.cmux": false,
		"browser.tern": false,
		"tools.maxTimeout": 0,
	}),
};
const prelude = createBrowserPrelude(session);
const context = { session, toolCallId: "browser-emulation-test" };
let server: Bun.Server<undefined>;
let pageUrl = "";

async function invoke(parameters: unknown) {
	return await prelude.invoke(parameters, context);
}

function valueFrom(result: { details?: Record<string, unknown> }): unknown {
	return result.details?.value;
}

async function call(method: string, args: unknown[] = []): Promise<unknown> {
	const result = await invoke({ action: "call", name: "emulation", chain: [{ method, args }] });
	return valueFrom(result as { details?: Record<string, unknown> });
}

async function run(code: string): Promise<unknown> {
	const result = await invoke({ action: "run", name: "emulation", code });
	return valueFrom(result as { details?: Record<string, unknown> });
}

beforeAll(async () => {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: await findFreeCdpPort(),
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/headers") {
				return Response.json({ value: request.headers.get("x-emulation") });
			}
			if (url.pathname === "/auth") {
				const expected = `Basic ${btoa("agent:secret")}`;
				if (request.headers.get("authorization") !== expected) {
					return new Response("authenticate", {
						status: 401,
						headers: { "WWW-Authenticate": 'Basic realm="emulation"' },
					});
				}
				return new Response("authorized");
			}
			if (url.pathname === "/no-viewport") {
				return new Response("<!doctype html><title>mobile layout fixture</title><p>Mobile layout</p>", {
					headers: { "Content-Type": "text/html" },
				});
			}
			return new Response(
				"<!doctype html><meta name='viewport' content='width=device-width'><title>emulation fixture</title><input id='paste'>",
				{ headers: { "Content-Type": "text/html" } },
			);
		},
	});
	pageUrl = `http://127.0.0.1:${server.port}/`;
});

afterAll(async () => {
	server?.stop(true);
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser device, network, media, and clipboard emulation", () => {
	it("preserves mobile viewport options on open and reuse while retaining the scale alias", async () => {
		const name = `mobile-open-${crypto.randomUUID()}`;
		const evaluate = async (code: string) =>
			valueFrom(
				(await invoke({ action: "call", name, chain: [{ method: "evaluate", args: [code] }] })) as {
					details?: Record<string, unknown>;
				},
			);
		const dimensions =
			"({ width:innerWidth, height:innerHeight, ratio:devicePixelRatio, touch:navigator.maxTouchPoints > 0 })";
		await invoke({
			action: "open",
			name,
			url: pageUrl,
			viewport: { width: 390, height: 844, scale: 3, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
		});
		try {
			expect(await evaluate(dimensions)).toEqual({ width: 390, height: 844, ratio: 2, touch: true });
			await invoke({
				action: "call",
				name,
				chain: [{ method: "goto", args: [`${pageUrl}no-viewport`] }],
			});
			expect(await evaluate("innerWidth")).toBeGreaterThan(390);
			await invoke({
				action: "open",
				name,
				url: pageUrl,
				viewport: { width: 430, height: 932, scale: 3, isMobile: true, hasTouch: true },
			});
			expect(await evaluate(dimensions)).toEqual({ width: 430, height: 932, ratio: 3, touch: true });
			await invoke({
				action: "open",
				name,
				url: pageUrl,
				viewport: { width: 1440, height: 1100, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
			});
			expect(await evaluate(dimensions)).toEqual({ width: 1440, height: 1100, ratio: 1, touch: false });
		} finally {
			await invoke({ action: "close", name, kill: true });
		}
	}, 30_000);

	it("adopts raw viewport changes without discarding independent persistent emulation", async () => {
		await invoke({ action: "open", name: "emulation", url: pageUrl });
		try {
			await call("emulate", [
				{ viewport: { width: 390, height: 844, scale: 1 }, offline: true, colorScheme: "dark" },
			]);
			const stateCode =
				"return await tab.evaluate(() => ({ width:innerWidth, height:innerHeight, ratio:devicePixelRatio, offline:!navigator.onLine, dark:matchMedia('(prefers-color-scheme: dark)').matches }))";
			const immediate = await run(`await page.setViewport({ width:1440, height:1100 });
${stateCode}`);
			expect(immediate).toMatchObject({ width: 1440, height: 1100, offline: true, dark: true });
			expect(await run(stateCode)).toEqual(immediate);

			expect(
				await run(`const viewport = page.viewport();
Object.assign(viewport, { width:640, height:480, deviceScaleFactor:1 });
await page.setViewport(viewport);
await tab.emulate({ reducedMotion:true });
return await tab.evaluate(() => ({ width:innerWidth, height:innerHeight, ratio:devicePixelRatio, reduced:matchMedia('(prefers-reduced-motion: reduce)').matches, offline:!navigator.onLine }));`),
			).toEqual({ width: 640, height: 480, ratio: 1, reduced: true, offline: true });

			await call("emulate", [{ viewport: { width: 600, height: 500, scale: 1.5 } }]);
			expect(
				await run(
					"return await tab.evaluate(() => ({ width:innerWidth, height:innerHeight, ratio:devicePixelRatio, dark:matchMedia('(prefers-color-scheme: dark)').matches }))",
				),
			).toEqual({ width: 600, height: 500, ratio: 1.5, dark: true });
		} finally {
			await invoke({ action: "close", name: "emulation", kill: true });
		}
	}, 30_000);

	it("keeps raw viewport and print media overrides across device-profile reapplication", async () => {
		await invoke({ action: "open", name: "emulation", url: pageUrl });
		try {
			await call("emulate", [{ device: "iPhone 14" }]);
			const stateCode =
				"return await tab.evaluate(() => ({ width:innerWidth, height:innerHeight, ratio:devicePixelRatio, touch:navigator.maxTouchPoints > 0, deviceAgent:navigator.userAgent.includes('iPhone'), appState:window.viewportMarker, print:matchMedia('print').matches }))";
			// Puppeteer's raw media-type setter replaces media features. Exercise its
			// persistence without conflating that with persistent color-scheme settings.
			const immediate =
				await run(`await page.setViewport({ width:1440, height:1100, deviceScaleFactor:2, isMobile:false, hasTouch:false });
await page.emulateMediaType("print");
await tab.evaluate(() => { window.viewportMarker = "kept"; });
${stateCode}`);
			expect(immediate).toEqual({
				width: 1440,
				height: 1100,
				ratio: 2,
				touch: false,
				deviceAgent: true,
				appState: "kept",
				print: true,
			});
			expect(await run(stateCode)).toEqual(immediate);
		} finally {
			await invoke({ action: "close", name: "emulation", kill: true });
		}
	}, 30_000);

	it("persists independent overrides and exposes them to page APIs and requests", async () => {
		await invoke({ action: "open", name: "emulation", url: pageUrl });
		try {
			const deviceNames = (await call("devices")) as string[];
			expect(deviceNames).toContain("iPhone 14");

			const mediaState = await call("emulate", [{ colorScheme: "dark" }]);
			expect(mediaState).toMatchObject({ colorScheme: "dark" });
			expect(await run("return await tab.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)")).toBe(
				true,
			);

			await call("emulate", [{ device: "iPhone 14" }]);
			const initialDevice = (await run(
				"return await tab.evaluate(() => ({ width: innerWidth, userAgent: navigator.userAgent, touch: navigator.maxTouchPoints > 0 }))",
			)) as { width: number; userAgent: string; touch: boolean };
			expect(initialDevice.width).toBe(390);
			expect(initialDevice.userAgent).toContain("iPhone");
			expect(initialDevice.touch).toBe(true);
			await call("goto", [`${pageUrl}device`]);
			expect(await freezeTabsForOwner(OWNER_ID)).toBe(1);
			const navigatedDevice = (await run(
				"return await tab.evaluate(() => ({ width: innerWidth, userAgent: navigator.userAgent, dark: matchMedia('(prefers-color-scheme: dark)').matches }))",
			)) as { width: number; userAgent: string; dark: boolean };
			expect(navigatedDevice.width).toBe(390);
			expect(navigatedDevice.userAgent).toContain("iPhone");
			expect(navigatedDevice.dark).toBe(true);

			await call("emulate", [{ geolocation: { latitude: 37.7749, longitude: -122.4194, accuracy: 12 } }]);
			const position = (await run(
				"return await tab.evaluate(() => { const {promise, resolve, reject} = Promise.withResolvers(); navigator.geolocation.getCurrentPosition(({coords}) => resolve({latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy}), reject); return promise; })",
			)) as { latitude: number; longitude: number; accuracy: number };
			expect(position).toEqual({ latitude: 37.7749, longitude: -122.4194, accuracy: 12 });

			await call("emulate", [{ offline: true }]);
			expect(
				await run(
					`return await tab.evaluate(url => fetch(url, { cache: "no-store" }).then(() => false, () => true), ${JSON.stringify(`${pageUrl}ping?offline=1`)})`,
				),
			).toBe(true);
			await call("emulate", [{ offline: false }]);
			expect(
				await run(
					`return await tab.evaluate(url => fetch(url, { cache: "no-store" }).then(response => response.ok), ${JSON.stringify(`${pageUrl}ping?offline=0`)})`,
				),
			).toBe(true);

			await call("emulate", [{ headers: { "x-emulation": "header-value" } }]);
			expect(
				await run(
					`return await tab.evaluate(url => fetch(url).then(response => response.json()), ${JSON.stringify(`${pageUrl}headers`)})`,
				),
			).toEqual({ value: "header-value" });

			await call("emulate", [{ credentials: { username: "agent", password: "secret" } }]);
			expect(
				await run(
					`return await tab.evaluate(url => fetch(url).then(response => response.text()), ${JSON.stringify(`${pageUrl}auth`)})`,
				),
			).toBe("authorized");

			const writeResult = (await call("clipboardWrite", ["clipboard round trip"])) as { source: string };
			const readResult = (await call("clipboardRead")) as { text: string; source: string };
			expect(readResult.text).toBe("clipboard round trip");
			expect(["page", "shim"]).toContain(writeResult.source);
			expect(["page", "shim"]).toContain(readResult.source);
		} finally {
			await invoke({ action: "close", name: "emulation" });
		}
	}, 30_000);
});
