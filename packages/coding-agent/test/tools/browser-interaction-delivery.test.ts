import { afterAll, describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
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
const context = { session, toolCallId: "browser-interaction-delivery" };

function dataUrl(html: string): string {
	return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function onPage<T>(url: string, code: string): Promise<T> {
	const name = `interaction-delivery-${crypto.randomUUID()}`;
	await prelude.invoke(
		{
			action: "open",
			name,
			url,
			viewport: { width: 1365, height: 768, deviceScaleFactor: 1.5 },
		},
		context,
	);
	try {
		const result = await prelude.invoke({ action: "run", name, code, timeout: 20 }, context);
		const details = result.details;
		if (!details || typeof details !== "object" || !("value" in details)) {
			throw new Error("Browser run did not return a value");
		}
		return details.value as T;
	} finally {
		await prelude.invoke({ action: "close", name, kill: true }, context).catch(() => undefined);
	}
}

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("trusted browser interaction delivery", () => {
	test("counts and clicks named roles through nested open shadow roots", async () => {
		const result = await onPage<{
			observed: boolean;
			role: number;
			aria: number;
			labelled: number;
			scoped: number;
			selected: number;
			clicks: Array<{ id: string; trusted: boolean }>;
		}>(
			dataUrl(`<!doctype html><marimo-button></marimo-button><script>
window.selected = null;
window.clicks = [];
const root = document.querySelector('marimo-button').attachShadow({mode:'open'});
root.innerHTML = '<button id="launch">Launch Anima</button><section id="nested"></section>';
root.querySelector('#nested').attachShadow({mode:'open'}).innerHTML =
  '<span id="button-label">Labelled shadow action</span><button aria-labelledby="button-label"></button>';
root.querySelector('#launch').addEventListener('click', event => {
  if (event.isTrusted) window.selected = 10973;
});
document.addEventListener('click', event => {
  window.clicks.push({id:event.composedPath()[0].id, trusted:event.isTrusted});
}, true);
</script>`),
			`const observation = await tab.observe({compact:true});
const role = await tab.count('role/button[name="Launch Anima" exact]');
const aria = await tab.count('aria/Launch Anima');
const labelled = await tab.count('role/button[name="Labelled shadow action" exact]');
const host = await page.$('marimo-button');
const scopedHandles = await host.$$('role/button');
const scoped = scopedHandles.length;
await Promise.all(scopedHandles.map(handle => handle.dispose()));
await host.dispose();
await tab.click('role/button[name="Launch Anima" exact]');
return {
  observed:observation.elements.some(element => element.role === 'button' && element.name === 'Launch Anima'),
  role,aria,labelled,scoped,
  ...await tab.evaluate(() => ({selected:window.selected,clicks:window.clicks})),
};`,
		);
		expect(result).toEqual({
			observed: true,
			role: 1,
			aria: 1,
			labelled: 1,
			scoped: 2,
			selected: 10973,
			clicks: [{ id: "launch", trusted: true }],
		});
	}, 30_000);

	test("completes guarded observed-handle right clicks and typing against Chromium", async () => {
		const result = await onPage<{
			contextMenus: Array<{ trusted: boolean; button: number }>;
			inputs: Array<{ trusted: boolean; value: string }>;
			value: string;
			focused: boolean;
		}>(
			dataUrl(`<!doctype html><button id="menu">Menu</button><input id="entry" aria-label="Entry"><script>
window.contextMenus = [];
window.inputs = [];
document.querySelector('#menu').addEventListener('contextmenu', event => {
  window.contextMenus.push({trusted:event.isTrusted,button:event.button});
  event.preventDefault();
});
document.querySelector('#entry').addEventListener('input', event => {
  window.inputs.push({trusted:event.isTrusted,value:event.currentTarget.value});
});
</script>`),
			`const {elements} = await tab.observe();
const menu = elements.find(element => element.role === 'button' && element.name === 'Menu');
const entry = elements.find(element => element.role === 'textbox' && element.name === 'Entry');
if (!menu || !entry) throw new Error('Missing observed input fixture');
await (await tab.id(menu.id)).click({button:'right',count:2});
await (await tab.id(entry.id)).type('abc', {delay:7});
return await tab.evaluate(() => ({
  contextMenus:window.contextMenus,
  inputs:window.inputs,
  value:document.querySelector('#entry').value,
  focused:document.activeElement.id === 'entry',
}));`,
		);
		expect(result).toEqual({
			contextMenus: [
				{ trusted: true, button: 2 },
				{ trusted: true, button: 2 },
			],
			inputs: [
				{ trusted: true, value: "a" },
				{ trusted: true, value: "ab" },
				{ trusted: true, value: "abc" },
			],
			value: "abc",
			focused: true,
		});
	}, 30_000);

	test("background DPR 1.5 input either selects once at CSS coordinates or explicitly fails", async () => {
		const result = await onPage<{
			visibility: string;
			dpr: number;
			failure: string | null;
			selected: number | null;
			clicks: Array<{ trusted: boolean; value: string; x: number; y: number }>;
		}>(
			dataUrl(`<!doctype html><style>
body {margin:0}
#choice {position:fixed;left:726.6667px;top:253.6667px;width:346.6667px;height:30px;list-style:none}
</style><ul role="listbox"><li id="choice" role="option" data-value="10973">Elva Sun</li></ul><script>
window.selected = null;
window.clicks = [];
document.addEventListener('click', event => {
  window.clicks.push({trusted:event.isTrusted,value:event.target.getAttribute('data-value'),x:event.clientX,y:event.clientY});
}, true);
document.querySelector('#choice').addEventListener('click', event => {
  if (event.isTrusted) window.selected = 10973;
});
</script>`),
			`const foreground = await browser.newPage();
try {
  // Owned pages emulate focus at startup; disable the native CDP override to
  // exercise the real hidden renderer state used by relay pages.
  await page.emulateFocusedPage(false);
  await foreground.bringToFront();
  await page.waitForFunction(() => document.visibilityState === 'hidden', {polling:50,timeout:2000});
  // The main-world stealth bootstrap deliberately reports "visible"; the utility
  // world reads Chromium's real visibility, just like the input delivery watcher.
  const before = await page.evaluate(() => ({visibility:document.visibilityState,dpr:devicePixelRatio}));
  let failure = null;
  try { await tab.click('#choice'); }
  catch (error) { failure = String(error); }
  return {...before,failure,...await tab.evaluate(() => ({selected:window.selected,clicks:window.clicks}))};
} finally {
  await page.emulateFocusedPage(true);
  await foreground.close();
}`,
		);
		expect(result.visibility).toBe("hidden");
		expect(result.dpr).toBe(1.5);
		if (result.failure !== null) {
			expect(result.failure).toContain("did not deliver the click");
			expect(result.failure).toContain("visibility:hidden");
			expect(result.selected).toBeNull();
			expect(result.clicks).toEqual([]);
		} else {
			expect(result.selected).toBe(10973);
			expect(result.clicks).toHaveLength(1);
			expect(result.clicks[0]).toMatchObject({ trusted: true, value: "10973" });
			expect(result.clicks[0].x).toBeGreaterThan(895);
			expect(result.clicks[0].x).toBeLessThan(905);
			expect(result.clicks[0].y).toBeGreaterThan(263);
			expect(result.clicks[0].y).toBeLessThan(274);
		}
	}, 30_000);

	test("does not treat mousedown or a synthetic click as a completed trusted click or replay it", async () => {
		const result = await onPage<{
			failure: string | null;
			downs: number;
			clicks: boolean[];
			selected: number | null;
		}>(
			dataUrl(`<!doctype html><button id="moves" style="position:fixed;left:30px;top:30px;width:180px;height:40px">Moving option</button><script>
window.downs = 0;
window.clicks = [];
window.selected = null;
const target = document.querySelector('#moves');
target.addEventListener('mousedown', () => {
  window.downs++;
  target.style.transform = 'translateX(400px)';
  target.dispatchEvent(new MouseEvent('click', {bubbles:true}));
});
target.addEventListener('click', event => {
  window.clicks.push(event.isTrusted);
  if (event.isTrusted) window.selected = 10973;
});
</script>`),
			`let failure = null;
try { await tab.click('#moves'); }
catch (error) { failure = String(error); }
return {failure,...await tab.evaluate(() => ({downs:window.downs,clicks:window.clicks,selected:window.selected}))};`,
		);
		expect(result.failure).toContain("did not deliver the click");
		expect(result.downs).toBe(1);
		expect(result.clicks).toEqual([false]);
		expect(result.selected).toBeNull();
	}, 30_000);

	test("retains the trusted click receipt when the click immediately navigates", async () => {
		let navigations = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const path = new URL(request.url).pathname;
				if (path === "/start") {
					return new Response(
						`<!doctype html><a id="choose" href="/chosen">Choose</a><script>
sessionStorage.setItem('trusted-clicks', '[]');
document.querySelector('#choose').addEventListener('click', event => {
  const clicks = JSON.parse(sessionStorage.getItem('trusted-clicks'));
  clicks.push(event.isTrusted);
  sessionStorage.setItem('trusted-clicks', JSON.stringify(clicks));
});
</script>`,
						{ headers: { "content-type": "text/html" } },
					);
				}
				if (path === "/chosen") navigations++;
				return new Response("<!doctype html><title>Chosen</title><p>Selected once</p>", {
					headers: { "content-type": "text/html" },
				});
			},
		});
		const destination = `http://127.0.0.1:${server.port}/chosen`;
		try {
			const result = await onPage<{
				waitFailure: string | null;
				url: string;
				regexpUrl: string;
				regexpLastIndex: number;
				text: string;
				clicks: boolean[];
			}>(
				`http://127.0.0.1:${server.port}/start`,
				`await tab.click('#choose');
let waitFailure = null;
try { await tab.waitForUrl(${JSON.stringify(destination)}); }
catch (error) { waitFailure = String(error); }
const regex = new RegExp('/chosen$', 'g');
regex.lastIndex = 2;
const regexpUrl = await tab.waitForUrl(regex);
return {
  waitFailure,
  url:await tab.url(),
  regexpUrl,
  regexpLastIndex:regex.lastIndex,
  text:await tab.text(),
  clicks:await tab.evaluate(() => JSON.parse(sessionStorage.getItem('trusted-clicks'))),
};`,
			);
			expect(result).toEqual({
				waitFailure: null,
				url: destination,
				regexpUrl: destination,
				regexpLastIndex: 2,
				text: "Selected once",
				clicks: [true],
			});
			expect(navigations).toBe(1);
		} finally {
			await server.stop(true);
		}
	}, 30_000);
});
