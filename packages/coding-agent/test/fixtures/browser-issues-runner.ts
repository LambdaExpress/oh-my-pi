import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { decodePng } from "@oh-my-pi/pi-coding-agent/tools/browser/screenshot";
import { getTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ManagedTabInfo } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import {
	type BrowserIssueCdpProxy,
	createBrowserIssueCdpProxy,
	createBrowserIssueSite,
} from "./browser-issues-fixture";

function host(maxTimeout = 0) {
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
			"tools.maxTimeout": maxTimeout,
		}),
	};
	const prelude = createBrowserPrelude(session);
	return (parameters: unknown) =>
		prelude.invoke(parameters, { session, toolCallId: `browser-issues-${crypto.randomUUID()}` });
}

function valueOf<T>(result: { details?: unknown }): T {
	if (!result.details || typeof result.details !== "object" || !("value" in result.details)) {
		throw new Error(`Browser helper did not return a value:\n${JSON.stringify(result, null, 2)}`);
	}
	return result.details.value as T;
}

async function failureOf(operation: Promise<unknown>): Promise<Error> {
	try {
		await operation;
	} catch (error) {
		assert(error instanceof Error);
		return error;
	}
	throw new Error("Expected the browser operation to reject");
}

/** Exercises host prelude -> supervisor -> worker -> real Chromium; only this runner's isolated targets are closed. */
export async function runBrowserIssueRegressions(options: { longWaits: boolean; keepScreenshot?: boolean }) {
	const invoke = host();
	const cappedInvoke = host(3);
	const site = createBrowserIssueSite();
	const name = `browser-issues-${crypto.randomUUID()}`;
	const borrowedName = `${name}-borrowed`;
	const lostName = `${name}-lost`;
	const startUrl = `${site.url}?fixture=${name}`;
	const checks: string[] = [];
	const timingsMs: Record<string, number> = {};
	let proxy: BrowserIssueCdpProxy | undefined;
	let screenshotPath: string | undefined;
	const execute = (code: string, timeout = 15, tabName = name) =>
		invoke({ action: "run", name: tabName, code, timeout });
	const run = async <T>(code: string, timeout = 15, tabName = name): Promise<T> =>
		valueOf<T>(await execute(code, timeout, tabName));
	try {
		await invoke({
			action: "open",
			name,
			url: startUrl,
			app: { tern: false },
			viewport: { width: 1000, height: 700, deviceScaleFactor: 1.5 },
		});
		const owned = getTab(name);
		assert(owned?.backend === "worker");
		const originalPage = (await owned.browser.browser.pages()).find(page => page.url() === startUrl);
		assert(originalPage);
		const delivery = await run<{
			counts: { clear: number; remove: number };
			value: string;
			removed: number;
		}>(`await tab.click('#clear');
await tab.click('#remove');
return await tab.evaluate(() => ({
  counts:window.fixtureCounts,
  value:document.querySelector('#selected').value,
  removed:document.querySelectorAll('#clear,#remove').length,
}));`);
		assert.equal(delivery.counts.clear, 1);
		assert.equal(delivery.counts.remove, 1);
		assert.equal(delivery.value, "");
		assert.equal(delivery.removed, 0);
		checks.push("03: consumed mousedown and synchronous click removal each execute once");

		const role = await run<{
			names: string[];
			matches: number[];
			login: number;
			loginSpaced: number;
		}>(`await tab.evaluate(() => {
  document.querySelector('#login').insertAdjacentHTML('afterend', '<button id="login-spaced">Login <i class="caret"></i></button>');
  window.fixtureCounts.loginSpaced = 0;
  document.querySelector('#login-spaced').addEventListener('click', () => window.fixtureCounts.loginSpaced++);
});
const observation = await tab.observe({compact:true});
const entries = observation.elements.filter(entry => entry.role === 'button' && (entry.name?.startsWith('Login') || entry.name === 'Hidden icon'));
if (entries.length !== 3) throw new Error('Spaced, unspaced or aria-hidden icon button missing from observe');
const selectors = entries.map(entry => 'role/button[name=' + JSON.stringify(entry.name) + ' exact]');
const matches = await Promise.all(selectors.map(selector => tab.count(selector)));
await tab.click(selectors[0]);
await tab.click(selectors[1]);
return {names:entries.map(entry => entry.name), matches, ...await tab.evaluate(() => ({
  login:window.fixtureCounts.login, loginSpaced:window.fixtureCounts.loginSpaced,
}))};`);
		assert.deepEqual(role.names, ["Login\uf0da", "Login \uf0da", "Hidden icon"]);
		assert.deepEqual(role.matches, [1, 1, 1]);
		assert.equal(role.login, 1);
		assert.equal(role.loginSpaced, 1);
		checks.push("18: exact observed AX names preserve inline icon whitespace and select each control once");

		const race = await run<{ count: number; value: string }>(`const rawPage = page.mainFrame().page();
const queryAll = rawPage.$$;
const client = page.mainFrame().client;
const send = client.send.bind(client);
let queries = 0;
rawPage.$$ = async selector => {
  // The action's first query finds the target; its watchdog's first response sees the post-click document.
  if (selector === 'text/Activity exact' && ++queries === 2) await wait(2300);
  return await queryAll.call(rawPage, selector);
};
client.send = (method, params, options) => {
  const sent = send(method, params, options);
  // Chromium really dispatches once; only the acknowledgement is delayed.
  return method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased'
    ? sent.then(async value => { await wait(2800); return value; })
    : sent;
};
try {
  await tab.click('text/Activity exact');
  return await tab.evaluate(() => ({count:window.fixtureCounts.activity,value:document.querySelector('#count').textContent}));
} finally {
  rawPage.$$ = queryAll;
  client.send = send;
}`);
		assert.deepEqual(race, { count: 1, value: "Activity selected" });
		checks.push("34: zero-match watchdog cannot invalidate a resolved, already-dispatched target");
		screenshotPath = valueOf<string>(
			await invoke({
				action: "call",
				name,
				chain: [{ method: "screenshot", args: [{ fullPage: false, silent: true, format: "png" }] }],
			}),
		);

		const navigationClicks = await run<number>(`await tab.click('#navigate');
await tab.waitForUrl(${JSON.stringify(`${site.url}chosen`)});
return await tab.evaluate(() => Number(sessionStorage.getItem('fixtureNavigationClicks')));`);
		assert.equal(navigationClicks, 1);
		checks.push("03/34: navigating trusted click succeeds without replay");

		await execute(`await tab.goto(${JSON.stringify(startUrl)});`);
		const refused = await run<{
			failures: number;
			downs: number;
			clicks: number;
		}>(`await tab.evaluate(() => { /*!world=main*/
  document.body.insertAdjacentHTML('beforeend', '<button id="disabled-fixture" disabled>Disabled</button><div inert><button id="inert-fixture">Inert</button></div><button id="dropped-fixture" style="position:fixed;left:30px;top:500px">Dropped</button>');
  globalThis.fixtureDowns = 0; globalThis.fixtureClicks = 0;
  document.querySelector('#dropped-fixture').addEventListener('mousedown', event => {
    globalThis.fixtureDowns++; event.currentTarget.style.transform = 'translateX(500px)';
  });
  for (const id of ['disabled-fixture','inert-fixture','dropped-fixture'])
    document.getElementById(id).addEventListener('click', () => globalThis.fixtureClicks++);
});
let failures = 0;
for (const selector of ['#disabled-fixture','#inert-fixture','#dropped-fixture']) {
  try { await tab.click(selector); } catch { failures++; }
}
return {failures,...await tab.evaluate(() => ({downs:globalThis.fixtureDowns,clicks:globalThis.fixtureClicks}))};`);
		assert.deepEqual(refused, { failures: 3, downs: 1, clicks: 0 });
		checks.push("03/34: disabled, inert and genuinely dropped input remain failures, never replayed");

		proxy = createBrowserIssueCdpProxy(owned.browser.browser.wsEndpoint());
		await invoke({ action: "open", name: borrowedName, app: { cdp_url: proxy.url, target: startUrl }, timeout: 20 });
		const borrowed = getTab(borrowedName);
		assert(borrowed?.backend === "worker");
		const borrowedWorker = borrowed.worker;
		const borrowedTarget = borrowed.targetId;
		const detached = await run<boolean>(
			`await tab.route('**/api/retained', {body:{retained:true}});
await tab.addInitScript('globalThis.retainedBrowserIssueScript = 41');
const frame = page.mainFrame();
// Dispose the actual Puppeteer frame and its realms while it remains indexed, not an overridden detached getter.
frame[Symbol.dispose]();
return frame.detached;`,
			10,
			borrowedName,
		);
		assert.equal(detached, true);
		const listed = valueOf<ManagedTabInfo[]>(await invoke({ action: "tabs" }));
		assert.equal(listed.find(tab => tab.name === borrowedName)?.mainFrameDetached, true);
		const recovered = await run<{ title: string; body: unknown; scriptValue: number; detached: boolean }>(
			`await tab.reload();
return {
  title:await tab.title(),
  body:await tab.evaluate(async () => await (await fetch('/api/retained')).json()),
  scriptValue:await tab.evaluate(() => globalThis.retainedBrowserIssueScript),
  detached:page.mainFrame().detached,
};`,
			10,
			borrowedName,
		);
		assert.equal(recovered.title, "Browser issue fixture");
		assert.deepEqual(recovered.body, { retained: true });
		assert.equal(recovered.scriptValue, 41);
		assert.equal(recovered.detached, false);
		assert.equal(borrowed.worker, borrowedWorker);
		assert.equal(borrowed.targetId, borrowedTarget);
		assert.equal(originalPage.isClosed(), false);
		checks.push("26: actual disposed indexed frame is reported, rebuilt in place, and retains routes/scripts/target");

		proxy.hold("Page.stopLoading");
		let started = performance.now();
		const navigationFailure = await failureOf(
			invoke({
				action: "run",
				name: borrowedName,
				timeout: 3,
				code: `await tab.goto(${JSON.stringify(`${site.url}pending`)});`,
			}),
		);
		timingsMs.navigationTimeout = performance.now() - started;
		assert.match(navigationFailure.message, /tab\.goto.*timed out/);
		assert(timingsMs.navigationTimeout < 4_500);
		assert.equal(getTab(borrowedName), borrowed);
		assert.equal(borrowed.worker, borrowedWorker);
		assert.equal(originalPage.isClosed(), false);
		proxy.release("Page.stopLoading");
		assert.equal(await run<string>("return await tab.title();", 5, borrowedName), "Pending navigation");
		checks.push(
			"05: normal navigation deadline survives a stalled stop-loading acknowledgement with the same diagnostic target",
		);

		await execute(`await tab.goto(${JSON.stringify(`${site.url}blank`)});`, 5, borrowedName);
		const blankPath = valueOf<string>(
			await invoke({
				action: "call",
				name: borrowedName,
				chain: [{ method: "screenshot", args: [{ fullPage: false, silent: true, format: "png" }] }],
			}),
		);
		try {
			const image = decodePng(await Bun.file(blankPath).bytes());
			const pixel = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4;
			assert.deepEqual([...image.pixels.subarray(pixel, pixel + 4)], [255, 255, 255, 255]);
		} finally {
			await fs.rm(blankPath, { force: true });
		}
		proxy.hold("Page.captureScreenshot");
		started = performance.now();
		const screenshotFailure = await failureOf(
			invoke({
				action: "run",
				name: borrowedName,
				timeout: 3,
				code: "await tab.screenshot({fullPage:false,silent:true});",
			}),
		);
		timingsMs.screenshotTimeout = performance.now() - started;
		assert.match(screenshotFailure.message, /tab\.screenshot.*timed out/);
		assert(timingsMs.screenshotTimeout < 4_500);
		assert.equal(getTab(borrowedName), borrowed);
		assert.equal(borrowed.worker, borrowedWorker);
		const diagnosis = await run<{ title: string; bodyLength: number; api: unknown; requests: number }>(
			`return {
  title:await tab.title(),
  ...await tab.evaluate(async () => ({bodyLength:document.body.textContent.length,api:await (await fetch('/api/diagnostic')).json()})),
  requests:(await tab.requests({filter:'/api/diagnostic'})).length,
};`,
			5,
			borrowedName,
		);
		assert.deepEqual(diagnosis, { title: "Blank application", bodyLength: 0, api: { fixture: true }, requests: 1 });
		assert.equal(originalPage.isClosed(), false);
		proxy.release("Page.captureScreenshot");
		checks.push(
			"56: blank viewport captures normally; stalled capture is bounded and evaluate/requests remain diagnostic",
		);

		await invoke({ action: "close", name: borrowedName });
		assert.equal(originalPage.isClosed(), false);
		checks.push("26/56: releasing a borrowed CDP handle never closes the borrowed target");

		if (options.longWaits) {
			await execute(`await tab.goto(${JSON.stringify(`${site.url}delayed?delay=32000`)});`, 10);
			started = performance.now();
			const protocol = await run<{ status: number }>(
				`const client = await page.createCDPSession();
try {
  await client.send('Network.enable');
  await client.send('Network.emulateNetworkConditions', {offline:false,latency:65000,downloadThroughput:-1,uploadThroughput:-1});
  const [response] = await Promise.all([
    page.evaluate(async () => { /*!world=main*/ const response = await fetch('/api/h3-prompt-llm/archive/list'); return {status:response.status}; }),
    page.waitForSelector('#late').then(handle => handle.dispose()),
  ]);
  return response;
} finally {
  await client.send('Network.emulateNetworkConditions', {offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  await client.detach();
}`,
				105,
			);
			timingsMs.protocol105 = performance.now() - started;
			assert.deepEqual(protocol, { status: 200 });
			assert(timingsMs.protocol105 >= 60_000 && timingsMs.protocol105 < 105_000);
			checks.push("12: 105-second run permits a 65-second fetch and a raw Puppeteer wait exceeding 30 seconds");
		}
		await execute(
			`await tab.goto(${JSON.stringify(`${site.url}delayed?delay=${options.longWaits ? 32000 : 500}`)});`,
			10,
		);
		started = performance.now();
		const found = valueOf<boolean>(
			await invoke({
				action: "call",
				name,
				chain: [{ method: "waitForSelector", args: ["#late", { timeout: 180000 }] }],
			}),
		);
		timingsMs.selector180 = performance.now() - started;
		assert.equal(found, true);
		if (options.longWaits) assert(timingsMs.selector180 >= 30_000 && timingsMs.selector180 < 180_000);
		checks.push("44: direct 180000ms selector wait retains its explicit deadline");
		await execute(`await tab.evaluate(() => {
  const frame = document.createElement('iframe'); frame.id = 'late-frame'; frame.srcdoc = '<p>Waiting in frame</p>';
  frame.addEventListener('load', () => setTimeout(() => {
    const input = frame.contentDocument.createElement('input'); input.id = 'frame-late'; frame.contentDocument.body.append(input);
  }, 500), {once:true});
  document.body.append(frame);
});`);
		const foundInFrame = valueOf<boolean>(
			await invoke({
				action: "call",
				name,
				chain: [
					{ method: "frame", args: ["#late-frame"] },
					{ method: "waitForSelector", args: ["#frame-late", { timeout: 180000 }] },
				],
			}),
		);
		assert.equal(foundInFrame, true);
		checks.push("44: frame-scoped direct wait uses the same millisecond-to-call deadline policy");

		for (const [label, call] of [
			["explicit", invoke],
			["global", cappedInvoke],
		] as const) {
			await execute(`await tab.goto(${JSON.stringify(`${site.url}delayed?delay=10000`)});`, 10);
			started = performance.now();
			const failure = await failureOf(
				call({
					action: "call",
					name,
					...(label === "explicit" ? { timeout: 3 } : {}),
					chain: [{ method: "waitForSelector", args: ["#late", { timeout: 180000 }] }],
				}),
			);
			timingsMs[`${label}Cap`] = performance.now() - started;
			assert.match(failure.message, /waitForSelector.*timed out/);
			assert(timingsMs[`${label}Cap`]! < 4_500);
			assert.equal(getTab(name), owned);
		}
		checks.push("44: explicit outer and tools.maxTimeout deadlines still cap long helper waits");
		await invoke({ action: "open", name: lostName, url: "about:blank", app: { tern: false } });
		const lost = getTab(lostName);
		assert(lost?.backend === "worker");
		const lostPage = (await lost.browser.browser.pages()).find(page => {
			const target = page.target() as unknown as { _targetId?: string };
			return target._targetId === lost.targetId;
		});
		assert(lostPage);
		// A genuinely destroyed target, rather than a detached-property fixture, must leave the live list.
		await lostPage.close();
		// Await the browser socket's close event through its managed worker, not a fixed sleep.
		await failureOf(invoke({ action: "run", name: lostName, code: "return await tab.title();", timeout: 5 }));
		const liveAfterClose = valueOf<ManagedTabInfo[]>(await invoke({ action: "tabs" }));
		assert.equal(
			liveAfterClose.some(tab => tab.name === lostName),
			false,
		);
		assert.equal(getTab(name), owned);
		checks.push("26: a genuinely destroyed target is not advertised as a live managed tab");
		return {
			checks,
			timingsMs,
			longWaits: options.longWaits,
			roleNames: role.names,
			screenshotPath: options.keepScreenshot ? screenshotPath : undefined,
		};
	} finally {
		proxy?.release("Page.stopLoading");
		proxy?.release("Page.captureScreenshot");
		try {
			try {
				if (getTab(lostName)) await invoke({ action: "close", name: lostName });
			} finally {
				if (getTab(borrowedName)) await invoke({ action: "close", name: borrowedName });
			}
		} finally {
			proxy?.close();
			try {
				if (getTab(name)) await invoke({ action: "close", name });
			} finally {
				site.close();
				if (screenshotPath && !options.keepScreenshot) await fs.rm(screenshotPath, { force: true });
			}
		}
	}
}
