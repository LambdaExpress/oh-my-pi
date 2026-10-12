import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { resolveScrollArguments } from "@oh-my-pi/pi-coding-agent/tools/browser/interactions";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const TAB_NAME = `interactions-${crypto.randomUUID()}`;
const STARVED_TAB_NAME = `starved-${crypto.randomUUID()}`;
let tempDir = "";
let uploadPath = "";

const html = `<!doctype html>
<style>
body { margin: 0; font: 16px sans-serif; }
#covered { position: absolute; left: 20px; top: 20px; width: 140px; height: 48px; }
#overlay { position: fixed; left: 20px; top: 20px; width: 140px; height: 48px; z-index: 10; }
#point { position: absolute; left: 300px; top: 20px; width: 100px; height: 50px; }
#drop, #highlight { margin-top: 100px; width: 180px; height: 50px; border: 1px solid black; }
</style>
<button id="covered">Covered target</button><div id="overlay"></div>
<label><input id="check" type="checkbox"> Toggle</label>
<button id="double">Double</button><input id="keys">
<button id="point">Point</button><div id="drop">Drop zone</div><div id="highlight">Highlight</div>
<script>
window.results = { covered: 0, doubles: 0, keys: [], point: 0, dropped: "" };
document.querySelector("#covered").addEventListener("click", () => results.covered++);
document.querySelector("#double").addEventListener("dblclick", () => results.doubles++);
document.querySelector("#keys").addEventListener("keydown", event => results.keys.push(event.key + ":" + event.shiftKey));
document.querySelector("#point").addEventListener("click", () => results.point++);
document.querySelector("#drop").addEventListener("dragover", event => event.preventDefault());
document.querySelector("#drop").addEventListener("drop", event => {
  event.preventDefault();
  results.dropped = event.dataTransfer.files[0]?.name || "";
});
</script>`;

function valueFrom<T>(result: { details?: unknown }): T {
	const details = result.details;
	if (!details || typeof details !== "object") throw new Error("Browser result did not include details");
	return ("value" in details ? details.value : undefined) as T;
}

function makeSession(): ToolSession {
	return {
		cwd: tempDir,
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
}

beforeAll(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-interactions-"));
	uploadPath = path.join(tempDir, "drop-fixture.txt");
	await Bun.write(uploadPath, "drop contents");
});

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

describe("browser scroll argument boundaries", () => {
	test("normalizes finite positional and wheel-option deltas without treating them as absolute coordinates", () => {
		expect(resolveScrollArguments(-12.5, 0, { selector: "#scroller" })).toEqual({
			deltaX: -12.5,
			deltaY: 0,
			selector: "#scroller",
		});
		expect(resolveScrollArguments({ deltaY: 120 })).toEqual({ deltaX: 0, deltaY: 120, selector: undefined });
		expect(resolveScrollArguments({ deltaX: 0 })).toEqual({ deltaX: 0, deltaY: 0, selector: undefined });
		expect(resolveScrollArguments({ deltaX: 7, deltaY: -9, selector: "#scroller" })).toEqual({
			deltaX: 7,
			deltaY: -9,
			selector: "#scroller",
		});
	});

	test("rejects malformed shapes and non-finite deltas at the helper boundary", () => {
		const invalid: unknown[][] = [
			[{ y: 0 }],
			[{}],
			[{ selector: "#scroller" }],
			[{ deltaY: 1, x: 0 }],
			[{ deltaX: undefined }],
			[{ deltaY: Number.NaN }],
			[{ deltaX: Number.POSITIVE_INFINITY }],
			[{ deltaY: "120" }],
			[{ deltaY: 1 }, 2],
			[null],
			[[0, 1]],
			[0],
			[0, Number.NEGATIVE_INFINITY],
			[0, 1, { selector: "" }],
			[0, 1, { selector: 42 }],
			[0, 1, { deltaY: 2 }],
			[0, 1, null],
		];
		for (const args of invalid) {
			expect(() => resolveScrollArguments(args[0], args[1], args[2])).toThrow(ToolError);
		}
	});
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser interaction parity", () => {
	test("focuses keyboard-enabled SVG through selector, handle, and selector-key helpers", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const name = `svg-focus-${crypto.randomUUID()}`;
		const context = { session, toolCallId: "browser-svg-focus" };
		const svgHtml = `<!doctype html><button id="other">Other</button>
<svg id="map" tabindex="0" viewBox="0 0 100 100" width="200" height="200"><rect width="100" height="100"/></svg>
<script>
let pans = 0;
document.getElementById("map").addEventListener("keydown", event => {
  if (event.key === "ArrowRight") event.currentTarget.setAttribute("viewBox", ++pans + " 0 100 100");
});
</script>`;
		await prelude.invoke({ action: "open", name, url: `data:text/html,${encodeURIComponent(svgHtml)}` }, context);
		try {
			await prelude.invoke({ action: "call", name, chain: [{ method: "focus", args: ["#map"] }] }, context);
			const result = await prelude.invoke(
				{
					action: "run",
					name,
					code: `const active = await tab.evaluate(() => document.activeElement.id);
await tab.keyDown("ArrowRight");
await tab.keyUp("ArrowRight");
await tab.focus("#other");
await tab.press("ArrowRight", { selector: "#map" });
await tab.focus("#other");
const map = await tab.waitFor("#map");
await map.focus();
await map.press("ArrowRight");
return { active, focused: await tab.evaluate(() => document.activeElement.id), viewBox: await tab.attr("#map", "viewBox") };`,
				},
				context,
			);
			expect(valueFrom<{ active: string; focused: string; viewBox: string }>(result)).toEqual({
				active: "map",
				focused: "map",
				viewBox: "3 0 100 100",
			});
		} finally {
			await prelude.invoke({ action: "close", name, kill: true }, context).catch(() => undefined);
		}
	}, 30_000);

	test("trusted-clicks distant anchors while CSS smooth navigation moves the document", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const name = `smooth-click-${crypto.randomUUID()}`;
		const context = { session, toolCallId: "browser-smooth-click" };
		const smoothHtml = `<!doctype html><style>
html { scroll-behavior: smooth; } body { margin: 0; height: 60000px; }
a, section { position: absolute; display: block; width: 150px; height: 40px; left: 20px; }
#down { top: 100px; } #up { top: 40000px; } #bottom { top: 55000px; } #top { top: 10px; }
</style>
<section id="top"></section><a id="down" href="#bottom">Go down</a>
<a id="up" href="#top">Go up</a><section id="bottom"></section>
<script>
window.anchorClicks = [];
for (const link of document.querySelectorAll("a")) link.addEventListener("click", event => {
  anchorClicks.push({ id: event.currentTarget.id, trusted: event.isTrusted });
});
</script>`;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				return new Response(smoothHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
			},
		});
		try {
			await prelude.invoke(
				{
					action: "open",
					name,
					url: server.url.href,
					viewport: { width: 390, height: 844, scale: 1 },
				},
				context,
			);
			const result = await prelude.invoke(
				{
					action: "run",
					name,
					code: `await tab.click("#down");
await tab.click("#up");
await page.$eval("#down", element => element.scrollIntoView({ block: "center", behavior: "instant" }));
await tab.click("#down");
return await tab.evaluate(() => ({ hash: location.hash, clicks: anchorClicks, smooth: getComputedStyle(document.documentElement).scrollBehavior }));`,
					timeout: 25,
				},
				context,
			);
			expect(
				valueFrom<{ hash: string; clicks: { id: string; trusted: boolean }[]; smooth: string }>(result),
			).toEqual({
				hash: "#bottom",
				clicks: [
					{ id: "down", trusted: true },
					{ id: "up", trusted: true },
					{ id: "down", trusted: true },
				],
				smooth: "smooth",
			});
		} finally {
			await prelude.invoke({ action: "close", name, kill: true }, context).catch(() => undefined);
			server.stop(true);
		}
	}, 30_000);

	test("dispatches supported wheel options and scrolls a selected element without accepting absolute coordinates", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const name = `scroll-options-${crypto.randomUUID()}`;
		const context = { session, toolCallId: "browser-scroll-options" };
		const scrollHtml = `<!doctype html><style>
body { height: 20000px; margin: 0; }
#scroller { width: 150px; height: 100px; overflow: auto; } #content { width: 2000px; height: 2000px; }
</style><div id="scroller"><div id="content"></div></div>
<script>window.wheels=[]; document.addEventListener("wheel", event => wheels.push({ x:event.deltaX, y:event.deltaY, trusted:event.isTrusted }));</script>`;
		await prelude.invoke(
			{
				action: "open",
				name,
				url: `data:text/html,${encodeURIComponent(scrollHtml)}`,
				viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
			},
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name,
					code: `let rejected = false;
try { await tab.scroll({ y: 0 }); } catch { rejected = true; }
await tab.scroll({ deltaX: 25, deltaY: 70, selector: "#scroller" });
const element = await tab.evaluate(() => { const e = document.getElementById("scroller"); return { x:e.scrollLeft, y:e.scrollTop }; });
await tab.mouseMove(400, 300);
await tab.scroll({ deltaY: 120 });
await wait(() => tab.evaluate(() => wheels.length === 1 && scrollY > 0), { timeout: 5000 });
await tab.scroll(-5, 30);
await wait(() => tab.evaluate(() => wheels.length === 2), { timeout: 5000 });
await tab.wheel(3, -10);
await wait(() => tab.evaluate(() => wheels.length === 3), { timeout: 5000 });
return { rejected, element, wheels: await tab.evaluate(() => wheels) };`,
					timeout: 20,
				},
				context,
			);
			expect(valueFrom<{ rejected: boolean; element: { x: number; y: number }; wheels: unknown[] }>(result)).toEqual(
				{
					rejected: true,
					element: { x: 25, y: 70 },
					wheels: [
						{ x: 0, y: 120, trusted: true },
						{ x: -5, y: 30, trusted: true },
						{ x: 3, y: -10, trusted: true },
					],
				},
			);
		} finally {
			await prelude.invoke({ action: "close", name, kill: true }, context).catch(() => undefined);
		}
	}, 30_000);

	test("fills framework-controlled fields when keyboard dispatch acknowledges without inserting text", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const name = `fill-${crypto.randomUUID()}`;
		const context = { session, toolCallId: "browser-fill-contract" };
		const fixtureDir = path.join(import.meta.dir, "../fixtures");
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const pathname = new URL(request.url).pathname;
				if (pathname === "/react.js") {
					return new Response(Bun.file(path.join(fixtureDir, "react-18.3.1.production.min.js")));
				}
				if (pathname === "/react-dom.js") {
					return new Response(Bun.file(path.join(fixtureDir, "react-dom-18.3.1.production.min.js")));
				}
				return new Response(
					`<!doctype html><div id="app"></div>
<div id="editable" contenteditable>stale</div>
<input id="disabled" disabled value="kept"><fieldset disabled><input id="fieldset" value="kept"></fieldset>
<input id="readonly" readonly value="kept"><div id="locked-editor" contenteditable aria-readonly="true">kept</div>
<input id="reject" value="kept">
<script src="/react.js"></script><script src="/react-dom.js"></script>
<script>
window.fillEvents = {};
for (const type of ["input", "change"]) document.addEventListener(type, event => {
  const key = event.target.id + ":" + type;
  fillEvents[key] = (fillEvents[key] || 0) + 1;
});
document.querySelector("#reject").addEventListener("input", event => event.target.value = "kept");
function Form() {
  const [values, setValues] = React.useState({username:"stale", password:"stale", notes:"stale"});
  const [revision, setRevision] = React.useState(0);
  window.formValues = values;
  const field = (id, tag, type, label) => React.createElement(tag, {
    id, type, "aria-label":label, value:values[id],
    onChange:event => setValues(previous => ({...previous, [id]:event.target.value}))
  });
  return React.createElement("div", null,
    field("username", "input", "text", "Username"),
    field("password", "input", "password", "Password"),
    field("notes", "textarea", undefined, "Notes"),
    React.createElement("button", {id:"rerender", onClick:() => setRevision(value => value + 1)}, "Render " + revision));
}
ReactDOM.createRoot(document.querySelector("#app")).render(React.createElement(Form));
</script>`,
					{ headers: { "content-type": "text/html; charset=utf-8" } },
				);
			},
		});
		try {
			await prelude.invoke({ action: "open", name, url: server.url.href }, context);
			const result = await prelude.invoke(
				{
					action: "run",
					name,
					code: `await tab.waitFor("#username");
const keyboard = page.keyboard;
const originalType = keyboard.type;
const originalSendCharacter = keyboard.sendCharacter;
keyboard.type = async () => {};
keyboard.sendCharacter = async () => {};
try {
	await tab.fill('role/textbox[name="Username" exact]', "alice");
	await tab.fill("#password", "private-fill-fixture");
	await (await tab.waitFor("#notes")).fill("新的\\n文本");
	await tab.fill("#editable", "替换\\n内容");
	await tab.fill("#username", "");
	await tab.click("#rerender");
	const blocked = [];
	for (const selector of ["#disabled", "#fieldset", "#readonly", "#locked-editor"]) {
		try {
			await (await tab.waitFor(selector)).fill("private-fill-fixture");
			blocked.push(false);
		} catch {
			blocked.push(true);
		}
	}
	let rejected;
	try {
		await tab.fill("#reject", "private-fill-fixture");
		rejected = { failed:false };
	} catch (error) {
		rejected = { failed:true, message:error.message };
	}
	return {
		blocked, rejected,
		state:await page.mainFrame().mainRealm().evaluate(() => ({
			username:formValues.username === "" && document.querySelector("#username").value === "",
			password:formValues.password === "private-fill-fixture" && document.querySelector("#password").value === formValues.password,
			notes:formValues.notes === "新的\\n文本" && document.querySelector("#notes").value === formValues.notes,
			editable:document.querySelector("#editable").innerText === "替换\\n内容",
			unchanged:["disabled","fieldset","readonly","locked-editor","reject"].every(id => {
				const element = document.getElementById(id);
				return (element.value ?? element.innerText) === "kept";
			}),
			events:fillEvents,
		})),
	};
} finally {
	keyboard.type = originalType;
	keyboard.sendCharacter = originalSendCharacter;
}`,
					timeout: 20,
				},
				context,
			);
			const value = valueFrom<{
				blocked: boolean[];
				rejected: { failed: boolean; message?: string };
				state: Record<string, unknown>;
			}>(result);
			expect(value.blocked).toEqual([true, true, true, true]);
			expect(value.rejected.failed).toBe(true);
			expect(value.rejected.message).not.toContain("private-fill-fixture");
			expect(value.state).toEqual({
				username: true,
				password: true,
				notes: true,
				editable: true,
				unchanged: true,
				events: {
					"username:input": 2,
					"username:change": 2,
					"password:input": 1,
					"password:change": 1,
					"notes:input": 1,
					"notes:change": 1,
					"editable:input": 1,
					"editable:change": 1,
					"reject:input": 1,
					"reject:change": 1,
				},
			});
		} finally {
			await prelude.invoke({ action: "close", name, kill: true }, context).catch(() => undefined);
			server.stop(true);
		}
	}, 30_000);

	test("guards covered clicks and drives keyboard, pointer, drop-zone, checked-state, and highlight interactions", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const invoke = (parameters: unknown) =>
			prelude.invoke(parameters, { session, toolCallId: "browser-interactions" });
		const call = async (method: string, args: unknown[] = []): Promise<unknown> => {
			const result = await invoke({ action: "call", name: TAB_NAME, chain: [{ method, args }] });
			return valueFrom<unknown>(result);
		};

		await invoke({
			action: "open",
			name: TAB_NAME,
			url: `data:text/html,${encodeURIComponent(html)}`,
		});
		try {
			const blocked = await invoke({
				action: "run",
				name: TAB_NAME,
				code: `try {
	await tab.click("#covered");
	return "clicked";
} catch (error) {
	return error instanceof Error ? error.message : String(error);
}`,
				timeout: 10,
			});
			expect(valueFrom<string>(blocked)).toBe('tab.click("#covered") blocked: covered by <div#overlay>');
			await call("evaluate", ["document.querySelector('#overlay').remove()"]);
			await call("click", ["#covered"]);

			await call("check", ["#check"]);
			await call("check", ["#check"]);
			expect(await call("evaluate", ["document.querySelector('#check').checked"])).toBe(true);
			await call("uncheck", ["#check"]);
			await call("uncheck", ["#check"]);
			expect(await call("evaluate", ["document.querySelector('#check').checked"])).toBe(false);

			await call("dblclick", ["#double"]);
			await call("focus", ["#keys"]);
			await call("keyDown", ["Shift"]);
			await call("press", ["a"]);
			await call("keyUp", ["Shift"]);
			await call("clickAt", [350, 45]);
			await call("uploadFile", ["#drop", uploadPath]);

			const highlight = await invoke({
				action: "run",
				name: TAB_NAME,
				code: `const pending = tab.highlight("#highlight", { duration: 1000 });
// The overlay is injected asynchronously and removed once the helper's
// host-side hold elapses, so wait for the node instead of sampling the count.
await tab.waitForSelector("[data-omp-highlight-overlay]", { timeout: 5000 });
const during = await tab.evaluate(() => document.querySelectorAll("[data-omp-highlight-overlay]").length);
await pending;
const after = await tab.evaluate(() => document.querySelectorAll("[data-omp-highlight-overlay]").length);
return { during, after };`,
			});
			expect(valueFrom<{ during: number; after: number }>(highlight)).toEqual({ during: 1, after: 0 });

			const results = await call("evaluate", ["window.results"]);
			expect(results).toMatchObject({
				covered: 1,
				doubles: 1,
				keys: ["Shift:true", "a:true"],
				point: 1,
				dropped: "drop-fixture.txt",
			});
		} finally {
			await invoke({ action: "close", name: TAB_NAME, kill: true }).catch(() => undefined);
		}
	}, 30_000);

	// Backgrounded headless tabs deliver no animation frames, which stalls every
	// Puppeteer `Locator` precondition (viewport/stability/enabled) forever.
	// Virtual time pinned at "pause" reproduces that state deterministically.
	test("fills page and frame selectors on a tab that produces no animation frames", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const starvedHtml = `<!doctype html><input id="q" value="stale"><div id="editable" contenteditable>stale</div>
<iframe id="inner" srcdoc='<!doctype html><input id="deep" value="stale"><button id="go" onclick="this.dataset.clicked=1">Go</button>'></iframe>`;
		const context = { session, toolCallId: "browser-starved" };
		await prelude.invoke(
			{ action: "open", name: STARVED_TAB_NAME, url: `data:text/html,${encodeURIComponent(starvedHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: STARVED_TAB_NAME,
					code: `await tab.waitFor("#inner");
const cdp = await page.createCDPSession();
await cdp.send("Emulation.setVirtualTimePolicy", { policy: "pause" });
await tab.fill("#q", "typed");
const inner = await tab.frame("#inner");
await inner.fill("#deep", "nested");
await tab.fill("#editable", "replaced");
await inner.click("#go");
return {
	page: await tab.value("#q"),
	frame: await inner.value("#deep"),
	editable: await tab.text("#editable"),
	clicked: await inner.attr("#go", "data-clicked"),
};`,
					timeout: 25,
				},
				context,
			);
			expect(valueFrom<{ page: string; frame: string; editable: string; clicked: string }>(result)).toEqual({
				page: "typed",
				frame: "nested",
				editable: "replaced",
				clicked: "1",
			});
		} finally {
			await prelude.invoke({ action: "close", name: STARVED_TAB_NAME, kill: true }, context).catch(() => undefined);
		}
	}, 40_000);
});
