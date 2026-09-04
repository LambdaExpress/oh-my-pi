import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { $env, isEnoent } from "@oh-my-pi/pi-utils";
import { probeCdpStatus } from "./attach";
import { SHARED_BROWSER_WORKER_CONFIG_ENV, type SharedBrowserWorkerConfig } from "./shared-worker-protocol";

const STARTUP_TIMEOUT_MS = 25_000;
const STARTUP_POLL_MS = 100;
const HEALTH_POLL_MS = 500;
const HEALTH_FAILURE_LIMIT = 6;
const PROBE_TIMEOUT_MS = 500;
const DEVTOOLS_ACTIVE_PORT_FILE = "DevToolsActivePort";

function canonicalPath(value: string, cwd: string): string {
	const resolved = path.resolve(cwd, value);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function userDataDirFromArgs(args: string[]): string | undefined {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--user-data-dir") return args[index + 1];
		if (arg.startsWith("--user-data-dir=")) return arg.slice("--user-data-dir=".length);
	}
	return undefined;
}

/** Whether a root Chromium command line owns the exact OMP profile. */
export function browserArgsUseProfile(args: string[], userDataDir: string, cwd = process.cwd()): boolean {
	if (args.some(arg => arg.startsWith("--type="))) return false;
	const candidate = userDataDirFromArgs(args);
	return candidate !== undefined && canonicalPath(candidate, cwd) === canonicalPath(userDataDir, cwd);
}

async function terminateProfileBrowsers(config: SharedBrowserWorkerConfig): Promise<void> {
	const candidates = Process.fromPath(config.executablePath).filter(proc => proc.status() === ProcessStatus.Running);
	await Promise.all(
		candidates.map(async proc => {
			let args: string[];
			try {
				args = proc.args();
			} catch {
				return;
			}
			if (!browserArgsUseProfile(args, config.userDataDir, config.cwd)) return;
			await proc.terminate({ gracefulMs: 1_000, timeoutMs: 500 });
		}),
	);
}

async function removeStaleDevToolsPort(userDataDir: string): Promise<void> {
	try {
		await fs.unlink(path.join(userDataDir, DEVTOOLS_ACTIVE_PORT_FILE));
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

async function readDevToolsEndpoint(userDataDir: string): Promise<string | undefined> {
	let content: string;
	try {
		content = await fs.readFile(path.join(userDataDir, DEVTOOLS_ACTIVE_PORT_FILE), "utf8");
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	const [portText, browserPath] = content.trim().split(/\r?\n/, 2);
	const port = Number(portText);
	if (!Number.isInteger(port) || port < 1 || port > 65_535 || !browserPath?.startsWith("/")) return undefined;
	return `ws://127.0.0.1:${port}${browserPath}`;
}

async function endpointIsAlive(endpoint: string): Promise<boolean> {
	const url = new URL(endpoint);
	const status = await probeCdpStatus(`http://${url.host}/json/version`, { timeoutMs: PROBE_TIMEOUT_MS });
	return status !== null && status >= 200 && status < 300;
}

async function waitForDevToolsEndpoint(userDataDir: string): Promise<string> {
	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const endpoint = await readDevToolsEndpoint(userDataDir);
		if (endpoint && (await endpointIsAlive(endpoint))) return endpoint;
		await Bun.sleep(STARTUP_POLL_MS);
	}
	throw new Error(`Chromium did not publish a reachable DevTools endpoint within ${STARTUP_TIMEOUT_MS}ms`);
}

async function relay(stream: ReadableStream<Uint8Array>, write: (chunk: Uint8Array) => boolean): Promise<void> {
	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			write(value);
		}
	} finally {
		reader.releaseLock();
	}
}

async function waitForStdinClose(): Promise<void> {
	const reader = Bun.stdin.stream().getReader();
	try {
		while (!(await reader.read()).done) {}
	} finally {
		reader.releaseLock();
	}
}

function loadConfig(): SharedBrowserWorkerConfig {
	const raw = $env[SHARED_BROWSER_WORKER_CONFIG_ENV];
	delete $env[SHARED_BROWSER_WORKER_CONFIG_ENV];
	if (!raw) throw new Error(`${SHARED_BROWSER_WORKER_CONFIG_ENV} is required`);
	const parsed = JSON.parse(raw) as Partial<SharedBrowserWorkerConfig>;
	if (
		typeof parsed.executablePath !== "string" ||
		!Array.isArray(parsed.args) ||
		!parsed.args.every(arg => typeof arg === "string") ||
		typeof parsed.cwd !== "string" ||
		typeof parsed.userDataDir !== "string" ||
		typeof parsed.headless !== "boolean"
	) {
		throw new Error(`Invalid ${SHARED_BROWSER_WORKER_CONFIG_ENV}`);
	}
	return parsed as SharedBrowserWorkerConfig;
}

/**
 * Keep broker ownership attached to Chromium on Windows, where launching the
 * GUI executable can report a clean process exit while the real browser keeps
 * running. The CDP endpoint is the source of truth for readiness and liveness.
 */
export async function runSharedBrowserWorker(): Promise<void> {
	const config = loadConfig();
	await fs.mkdir(config.userDataDir, { recursive: true });
	await terminateProfileBrowsers(config);
	await removeStaleDevToolsPort(config.userDataDir);

	const browser = Bun.spawn([config.executablePath, ...config.args], {
		cwd: config.cwd,
		env: Bun.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: config.headless,
	});
	void relay(browser.stdout, chunk => process.stdout.write(chunk)).catch(() => {});
	void relay(browser.stderr, chunk => process.stderr.write(chunk)).catch(() => {});

	try {
		const endpoint = await waitForDevToolsEndpoint(config.userDataDir);
		process.stdout.write(`DevTools listening on ${endpoint}\n`);

		const shutdown = waitForStdinClose().then(() => true);
		let failures = 0;
		while (failures < HEALTH_FAILURE_LIMIT) {
			const stopRequested = await Promise.race([shutdown, Bun.sleep(HEALTH_POLL_MS).then(() => false)]);
			if (stopRequested) return;
			failures = (await endpointIsAlive(endpoint)) ? 0 : failures + 1;
		}
		throw new Error("Shared Chromium DevTools endpoint became unreachable");
	} finally {
		await terminateProfileBrowsers(config);
	}
}
