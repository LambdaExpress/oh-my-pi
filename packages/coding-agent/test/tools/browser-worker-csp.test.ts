import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const SAME_ORIGIN_CSP = "default-src 'self';script-src 'self' 'unsafe-inline' 'unsafe-eval'";
const session: ToolSession = {
	cwd: process.cwd(),
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
	getSessionId: () => "browser-worker-csp-test-owner",
	settings: Settings.isolated({
		"browser.enabled": true,
		"browser.headless": true,
		"browser.relay": false,
		"browser.cmux": false,
		"browser.tern": false,
		"tools.maxTimeout": 0,
	}),
};
const prelude = createBrowserPrelude(session);
const requests: Array<{ caseId: string | null; pathname: string; destination: string | null }> = [];
let server: Bun.Server<undefined>;
let baseUrl: string;

function headers(url: URL, contentType: string): Headers {
	const result = new Headers({ "Content-Type": contentType, "Cache-Control": "no-store" });
	const policy = url.searchParams.get("policy");
	if (policy !== "no-csp") {
		result.set(
			"Content-Security-Policy",
			policy === "block" ? `${SAME_ORIGIN_CSP};worker-src 'none'` : SAME_ORIGIN_CSP,
		);
	}
	return result;
}

beforeAll(() => {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			requests.push({
				caseId: url.searchParams.get("case"),
				pathname: url.pathname,
				destination: request.headers.get("sec-fetch-dest"),
			});
			const module = url.searchParams.get("type") === "module";
			if (url.pathname === "/worker-dependency.js") {
				return new Response(
					module
						? 'export const dependency = "dependency-loaded";'
						: 'self.classicDependency = "dependency-loaded";',
					{ headers: headers(url, "text/javascript") },
				);
			}
			if (url.pathname === "/worker.js") {
				const dependencyUrl = JSON.stringify(`./worker-dependency.js${url.search}`);
				const dependency = module
					? `import { dependency } from ${dependencyUrl};`
					: `importScripts(${dependencyUrl});const dependency = self.classicDependency;`;
				return new Response(
					`${dependency}
					const canvas = new OffscreenCanvas(10, 10);
					const context = canvas.getContext("2d");
					context.fillStyle = "#ff0000";
					context.fillRect(0, 0, 1, 1);
					const webgl = new OffscreenCanvas(10, 10).getContext("webgl2");
					postMessage({
						workerReady: true,
						href: location.href,
						name: self.name,
						dependency,
						pixel: Array.from(context.getImageData(0, 0, 1, 1).data),
						webgl: !!webgl,
					});`,
					{ headers: headers(url, "text/javascript") },
				);
			}
			const workerUrl = JSON.stringify(`/worker.js${url.search}`);
			const constructor = module
				? `new Worker(${workerUrl}, { type: "module", name: "module-fixture" })`
				: `new Worker(${workerUrl})`;
			return new Response(
				`<!doctype html><title>Worker CSP fixture</title><body>WAITING<script>
				window.workerResult = null;
				window.violations = [];
				addEventListener("securitypolicyviolation", event => {
					window.violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
				});
				try {
					const worker = ${constructor};
					worker.onmessage = event => {
						window.workerResult = event.data;
						worker.terminate();
					};
					worker.onerror = event => {
						window.workerResult = { workerError: event.type };
						worker.terminate();
					};
				} catch (error) {
					window.workerResult = { workerError: error.name };
				}
				</script>`,
				{ headers: headers(url, "text/html") },
			);
		},
	});
	baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
	try {
		await releaseAllTabs({ kill: true });
		await disposeAllVmContexts();
	} finally {
		server?.stop(true);
	}
});

async function invoke(parameters: unknown) {
	return await prelude.invoke(parameters, { session, toolCallId: "browser-worker-csp-test" });
}

interface WorkerProbe {
	workerResult: {
		workerReady?: boolean;
		workerError?: string;
		href?: string;
		name?: string;
		dependency?: string;
		pixel?: number[];
		webgl?: boolean;
	};
	violations: Array<{ directive: string; blocked: string }>;
	pageWebgl: boolean;
}

async function probe(type: "classic" | "module", policy: "self" | "no-csp" | "block") {
	const caseId = crypto.randomUUID();
	const name = `worker-csp-${caseId}`;
	const query = new URLSearchParams({ case: caseId, type, policy });
	const workerUrl = `${baseUrl}/worker.js?${query}`;
	await invoke({ action: "open", name, url: `${baseUrl}/?${query}` });
	try {
		// Raw Puppeteer waits default to the isolated world, unlike tab.evaluate.
		// Read the fixture's own globals and do not treat undefined as a result.
		const ready = `//!world=main\n${
			policy === "block"
				? '!!window.workerResult && window.violations.some(event => event.directive === "worker-src")'
				: "!!window.workerResult"
		}`;
		const result = await invoke({
			action: "run",
			name,
			code: `await page.waitForFunction(
				${JSON.stringify(ready)},
				{ timeout: 5000 },
			);
			return await tab.evaluate(() => ({
				workerResult: window.workerResult,
				violations: window.violations,
				pageWebgl: !!new OffscreenCanvas(10, 10).getContext("webgl2"),
			}));`,
		});
		const value = (result.details as { value: WorkerProbe }).value;
		return { value, workerUrl, workerRequests: requests.filter(entry => entry.caseId === caseId) };
	} finally {
		await invoke({ action: "close", name, kill: true });
	}
}

describe.skipIf(!CHROMIUM_AVAILABLE)("managed browser native Worker CSP semantics", () => {
	it("runs same-origin classic Workers with script-src fallback and no blob permission", async () => {
		const { value, workerUrl, workerRequests } = await probe("classic", "self");
		expect(value.workerResult).toMatchObject({
			workerReady: true,
			href: workerUrl,
			dependency: "dependency-loaded",
			pixel: [255, 0, 0, 255],
		});
		expect(value.violations).toEqual([]);
		expect(workerRequests).toContainEqual(expect.objectContaining({ pathname: "/worker.js", destination: "worker" }));
		expect(workerRequests).toContainEqual(expect.objectContaining({ pathname: "/worker-dependency.js" }));
	}, 30_000);

	it("preserves same-origin module Worker options and relative imports under CSP", async () => {
		const { value, workerUrl, workerRequests } = await probe("module", "self");
		expect(value.workerResult).toMatchObject({
			workerReady: true,
			href: workerUrl,
			name: "module-fixture",
			dependency: "dependency-loaded",
		});
		expect(value.violations).toEqual([]);
		expect(workerRequests).toContainEqual(expect.objectContaining({ pathname: "/worker.js", destination: "worker" }));
		expect(workerRequests).toContainEqual(expect.objectContaining({ pathname: "/worker-dependency.js" }));
	}, 30_000);

	it("keeps no-CSP Worker OffscreenCanvas and WebGL capabilities intact", async () => {
		const { value, workerUrl } = await probe("classic", "no-csp");
		expect(value.workerResult).toMatchObject({
			workerReady: true,
			href: workerUrl,
			dependency: "dependency-loaded",
			pixel: [255, 0, 0, 255],
			webgl: value.pageWebgl,
		});
		expect(value.violations).toEqual([]);
	}, 30_000);

	it("enforces worker-src none against the original URL without requesting its script", async () => {
		const { value, workerUrl, workerRequests } = await probe("classic", "block");
		expect(value.workerResult).toHaveProperty("workerError");
		expect(value.workerResult.workerReady).toBeUndefined();
		expect(value.violations).toContainEqual({ directive: "worker-src", blocked: workerUrl });
		expect(workerRequests.some(entry => entry.pathname === "/worker.js")).toBe(false);
	}, 30_000);
});
