import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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
const context = { session, toolCallId: "browser-queries-test" };
const name = "queries";

async function invoke(parameters: unknown) {
	return await prelude.invoke(parameters, context);
}

async function call(method: string, args: unknown[] = []): Promise<unknown> {
	const result = (await invoke({
		action: "call",
		name,
		chain: [{ method, args }],
	})) as { details?: Record<string, unknown> };
	return result.details?.value;
}

async function run(code: string): Promise<unknown> {
	const result = (await invoke({ action: "run", name, code })) as { details?: Record<string, unknown> };
	return result.details?.value;
}

beforeAll(async () => {
	if (!CHROMIUM_AVAILABLE) return;
	const html = `<!doctype html>
		<style>#styled { color: rgb(1, 2, 3); display: block; } #hidden { display: none; }</style>
		<label for="username">User name</label><input id="username" value="alice">
		<label>Wrapped field <input id="wrapped" value="wrapped-value"></label>
		<input id="aria" aria-label="Secret code" value="1234">
		<input id="placeholder" placeholder="Search records" value="needle">
		<div data-testid="status-card">Ready</div>
		<img alt="Company logo" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
		<div title="Helpful details">Titled content</div>
		<button id="save-long">Save Changes</button><button id="save-exact">Save</button>
		<div id="copy">Hello <strong>world</strong></div>
		<div class="item">one</div><div class="item">two</div>
		<div id="styled">Styled</div><div id="hidden">Hidden</div>
		<button id="enabled">Enabled</button><button id="disabled" disabled>Disabled</button>
		<input id="checked" type="checkbox" checked><input id="unchecked" type="checkbox">
		<div id="empty"></div>`;
	await invoke({ action: "open", name, url: `data:text/html,${encodeURIComponent(html)}` });
});

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser semantic selectors and queries", () => {
	it("resolves semantic selector prefixes, role names, and exact role names", async () => {
		expect(await call("value", ["label/User name"])).toBe("alice");
		expect(await call("value", ["label/Wrapped field"])).toBe("wrapped-value");
		expect(await call("value", ["label/Secret code"])).toBe("1234");
		expect(await call("value", ["placeholder/Search records"])).toBe("needle");
		expect(await call("text", ["testid/status-card"])).toBe("Ready");
		expect(await call("attr", ["alt/Company", "alt"])).toBe("Company logo");
		expect(await call("text", ["title/Helpful"])).toBe("Titled content");
		expect(await call("text", ['role/button[name="save"]'])).toBe("Save Changes");
		expect(await call("text", ['role/button[name="save" exact]'])).toBe("Save");
		expect(await call("count", ["role/button"])).toBe(4);
	});

	it("returns DOM content, values, attributes, counts, boxes, styles, and query state branches", async () => {
		expect(await call("text", ["#copy"])).toBe("Hello world");
		expect(await call("html", ["#copy"])).toBe("Hello <strong>world</strong>");
		expect(await call("value", ["#username"])).toBe("alice");
		expect(await call("value", ["#missing"])).toBeNull();
		expect(await call("attr", ["#username", "id"])).toBe("username");
		expect(await call("attr", ["#username", "missing"])).toBeNull();
		expect(await call("count", [".item"])).toBe(2);
		expect(await call("box", ["#copy"])).toEqual(
			expect.objectContaining({
				x: expect.any(Number),
				y: expect.any(Number),
				width: expect.any(Number),
				height: expect.any(Number),
			}),
		);
		expect(await call("box", ["#missing"])).toBeNull();
		expect(await call("styles", ["#styled", ["color", "display"]])).toEqual({
			color: "rgb(1, 2, 3)",
			display: "block",
		});
		const defaultStyles = (await call("styles", ["#styled"])) as Record<string, string>;
		expect(defaultStyles["font-family"]).toBeTruthy();
		expect(defaultStyles.color).toBe("rgb(1, 2, 3)");
		expect(await call("styles", ["#missing"])).toBeNull();
		expect(await call("isVisible", ["#copy"])).toBe(true);
		expect(await call("isVisible", ["#hidden"])).toBe(false);
		expect(await call("isVisible", ["#missing"])).toBe(false);
		expect(await call("isEnabled", ["#enabled"])).toBe(true);
		expect(await call("isEnabled", ["#disabled"])).toBe(false);
		expect(await call("isEnabled", ["#missing"])).toBe(false);
		expect(await call("isChecked", ["#checked"])).toBe(true);
		expect(await call("isChecked", ["#unchecked"])).toBe(false);
		expect(await call("isChecked", ["#missing"])).toBe(false);
	});

	it("exposes the same read queries on element handles", async () => {
		expect(
			await run(`const element = await tab.waitFor("#username"); return {
				text: await element.text(), html: await element.html(), value: await element.value(),
				attr: await element.attr("id"), styles: await element.styles(["display"]),
				enabled: await element.isEnabled(), checked: await element.isChecked()
			}`),
		).toEqual({
			text: "",
			html: "",
			value: "alice",
			attr: "username",
			styles: { display: "inline-block" },
			enabled: true,
			checked: false,
		});
	});

	it("observes and clicks rendered modal controls despite AX omissions, split text, and paused rendering", async () => {
		const modalName = `modal-${crypto.randomUUID()}`;
		const modalHtml = `<!doctype html>
<meta charset="utf-8">
<style>
body { margin:0; font:16px sans-serif; }
#backdrop { position:fixed; inset:0; background:#0006; z-index:1; }
#active-modal { position:fixed; top:40px; left:40px; width:480px; padding:24px; background:white; z-index:2; }
#confirm span { display:block; }
#scroller { height:70px; overflow:auto; border:1px solid black; }
button { margin:8px; padding:10px; }
</style>
<button id="background" onclick="recordClick('background')">继续连接到 微信消息网关</button>
<section role="dialog" style="display:none"><button>继续连接到 微信消息网关</button></section>
<section role="dialog" style="visibility:hidden"><button>继续连接到 微信消息网关</button></section>
<div id="backdrop"></div>
<section id="active-modal" role="dialog" aria-modal="true" aria-label="连接 微信消息网关">
  <button id="close">关闭</button>
  <button disabled>继续连接到 微信消息网关</button>
  <div aria-hidden="true">
    <button id="confirm" onclick="recordClick('confirm')"><span>继续连接到</span><span>微信消息网关</span></button>
  </div>
  <button id="inline" onclick="recordClick('inline')"><span>返回到 </span><strong>授权页面</strong></button>
  <div id="scroller"><div style="height:180px">说明</div>
    <button id="scroll-confirm" onclick="recordClick('scroll')"><span>滚动后 </span><strong>继续连接</strong></button>
  </div>
  <output id="status"></output>
</section>
<script>
window.clicks = [];
window.recordClick = name => { clicks.push(name); document.querySelector("#status").textContent = clicks.join(","); };
</script>`;
		try {
			await invoke({
				action: "open",
				name: modalName,
				url: `data:text/html;charset=utf-8,${encodeURIComponent(modalHtml)}`,
			});
			const result = (await invoke({
				action: "run",
				name: modalName,
				timeout: 20,
				code: `await tab.waitFor("#active-modal");
const cdp = await page.createCDPSession();
await cdp.send("Emulation.setVirtualTimePolicy", { policy:"pause" });
try {
	const all = await tab.observe();
	const viewport = await tab.observe({viewportOnly:true});
	const scoped = await tab.observe({selector:"#active-modal"});
	const onlyControl = await tab.observe({selector:"#confirm"});
	const enabledConfirm = observation => observation.elements.filter(element =>
		element.role === "button" && element.name === "继续连接到 微信消息网关" && !element.states.includes("disabled")
	).length;
	const hasScroll = observation => observation.elements.some(element => element.name === "滚动后 继续连接");
	const cached = onlyControl.elements.find(element => element.role === "button");
	if (cached) await (await tab.id(cached.id)).click();
	await tab.click("text/继续连接到 微信消息网关");
	await tab.click("text/返回到 授权页面");
	await tab.click("text/滚动后 继续连接");
	return {
		enabled:[all,viewport,scoped,onlyControl].map(enabledConfirm),
		scroll:{all:hasScroll(all),viewport:hasScroll(viewport)},
		clicks:await page.mainFrame().mainRealm().evaluate(() => clicks),
		status:await tab.text("#status"),
	};
} finally {
	await cdp.send("Emulation.setVirtualTimePolicy", {policy:"advance"});
	await cdp.detach();
}`,
			})) as { details?: Record<string, unknown> };
			expect(result.details?.value).toEqual({
				enabled: [1, 1, 1, 1],
				scroll: { all: true, viewport: false },
				clicks: ["confirm", "confirm", "inline", "scroll"],
				status: "confirm,confirm,inline,scroll",
			});
		} finally {
			await invoke({ action: "close", name: modalName, kill: true }).catch(() => undefined);
		}
	}, 30_000);

	it("waits for delayed body and scoped exact text and reports a named timeout", async () => {
		expect(await call("waitForText", ["Hello world", { timeout: 1_000 }])).toBeUndefined();
		// This integration case deliberately exercises the page's real timer while waitForText polls Chromium.
		expect(
			await run(`await page.evaluate(() => {
				setTimeout(() => {
					const node = document.createElement("div");
					node.textContent = "appeared later";
					document.body.append(node);
				}, 100);
			});
			await tab.waitForText("appeared later", { timeout: 2_000 });
			return true`),
		).toBe(true);
		expect(
			await run(`await page.evaluate(() => {
				setTimeout(() => { document.querySelector("#empty").textContent = "exact scoped text"; }, 100);
			});
			await tab.waitForText("exact scoped text", { selector: "#empty", exact: true, timeout: 2_000 });
			return true`),
		).toBe(true);
		const timeout = (await run(`try {
			await tab.waitForText("never appears", { timeout: 150 });
			return null;
		} catch (error) {
			return { name: error.name, message: error.message };
		}`)) as { name: string; message: string } | null;
		expect(timeout?.name).toBe("ToolError");
		expect(timeout?.message).toContain("tab.waitForText");
	}, 15_000);
});
