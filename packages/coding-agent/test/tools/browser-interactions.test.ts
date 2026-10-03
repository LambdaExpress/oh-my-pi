import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
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

describe.skipIf(!CHROMIUM_AVAILABLE)("browser interaction parity", () => {
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
