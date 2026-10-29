import assert from "node:assert/strict";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SessionSnapshot, WorkerInbound, WorkerOutbound } from "@oh-my-pi/pi-coding-agent/eval/js/worker-protocol";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";

// Run with plain `bun`, not inside bun:test: Bun's process-wide isBunTest
// bypasses process rejection listeners in Worker threads and forwards straight
// to the test runner. This oracle must exercise the production rejection guard.
const worker = new Worker(new URL("../../src/eval/js/worker-entry.ts", import.meta.url).href, {
	type: "module",
});
const listeners = new Set<(message: WorkerOutbound) => void>();
const pending = new Set<(error: Error) => void>();
const failed = Promise.withResolvers<Error>();
let failure: Error | undefined;
worker.addEventListener("message", event => {
	for (const listener of listeners) listener(event.data as WorkerOutbound);
});
const fail = (error: Error): void => {
	failure = error;
	failed.resolve(error);
	for (const reject of pending) reject(error);
	pending.clear();
};
worker.addEventListener("error", event => {
	// The probe asserts this failure explicitly; do not also throw it on the
	// parent event loop, including for the final expected infrastructure error.
	event.preventDefault();
	fail(new Error(event.message || "JS eval worker failed"));
});
worker.addEventListener("close", () => fail(new Error("JS eval worker exited")));

function waitFor(predicate: (message: WorkerOutbound) => boolean): Promise<WorkerOutbound> {
	if (failure) return Promise.reject(failure);
	const deferred = Promise.withResolvers<WorkerOutbound>();
	const reject = (error: Error): void => {
		listeners.delete(listener);
		deferred.reject(error);
	};
	const listener = (message: WorkerOutbound): void => {
		if (!predicate(message)) return;
		listeners.delete(listener);
		pending.delete(reject);
		deferred.resolve(message);
	};
	listeners.add(listener);
	pending.add(reject);
	return deferred.promise;
}

function send(message: WorkerInbound): void {
	worker.postMessage(message);
}

function isBrowserCall(message: WorkerOutbound, method: string): boolean {
	if (message.type !== "tool-call" || message.name !== "__prelude__") return false;
	const args = message.args as { parameters?: { chain?: Array<{ method?: string }> } } | undefined;
	const chain = args?.parameters?.chain;
	return Array.isArray(chain) && chain.at(-1)?.method === method;
}

const session: ToolSession = {
	cwd: process.cwd(),
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => null,
	settings: Settings.isolated(),
};
const prelude = createBrowserPrelude(session);
const snapshot: SessionSnapshot = {
	cwd: process.cwd(),
	sessionId: `issue23-busy-${crypto.randomUUID()}`,
	preludes: [{ name: prelude.name, exports: [...prelude.exports], source: prelude.javascript }],
};
async function run(runId: string, code: string): Promise<WorkerOutbound> {
	const result = waitFor(message => message.type === "result" && message.runId === runId);
	send({ type: "run", runId, code, filename: `[${runId}].js`, snapshot });
	return await result;
}

try {
	const ready = waitFor(message => message.type === "ready");
	send({ type: "init", snapshot });
	await ready;
	const seeded = await run("issue23-seed", "var issue23SavedTab = browser.tab('download-tab');");
	assert.equal(seeded.type, "result");
	if (seeded.type !== "result") throw new Error("expected initial result");
	assert.equal(seeded.ok, true);

	// The actual shipped browser facade creates both calls. Control only the
	// host replies so the download rejects strictly after the busy run settled.
	const downloadCall = waitFor(message => isBrowserCall(message, "waitForDownload"));
	const clickCall = waitFor(message => isBrowserCall(message, "click"));
	const busyResult = run(
		"issue23-busy",
		"var issue23DownloadPromise = issue23SavedTab.waitForDownload(); await issue23SavedTab.id(5).click();",
	);
	const [download, click] = await Promise.all([downloadCall, clickCall]);
	assert.equal(download.type, "tool-call");
	assert.equal(click.type, "tool-call");
	if (download.type !== "tool-call" || click.type !== "tool-call") throw new Error("expected tool calls");
	send({
		type: "tool-reply",
		id: click.id,
		reply: {
			ok: false,
			error: {
				name: "ToolError",
				message: 'Tab "download-tab" is busy',
				stack: 'ToolError: Tab "download-tab" is busy\n    at hostCall (browser-host.ts:1:1)',
				isToolError: true,
			},
		},
	});
	const busy = await busyResult;
	assert.equal(busy.type, "result");
	if (busy.type !== "result" || busy.ok) throw new Error("busy call unexpectedly succeeded");
	assert.equal(busy.error.message, 'Tab "download-tab" is busy');

	const reported = waitFor(message => message.type === "log" && message.level === "warn");
	send({
		type: "tool-reply",
		id: download.id,
		reply: {
			ok: false,
			error: {
				name: "ToolError",
				message: "Download timed out",
				stack: "ToolError: Download timed out\n    at hostCall (browser-host.ts:2:1)",
				isToolError: true,
			},
		},
	});
	const warning = await reported;
	assert.equal(warning.type, "log");
	if (warning.type !== "log") throw new Error("expected late rejection warning");
	assert.equal(warning.msg, "Unhandled rejection from a finished eval cell (missing await?)");
	assert.equal(warning.meta?.filename, "[issue23-busy].js");
	assert.equal((warning.meta?.error as { message?: string } | undefined)?.message, "Download timed out");

	const text = waitFor(message => message.type === "text" && message.runId === "issue23-resume");
	const [resumed, output] = await Promise.all([run("issue23-resume", "print(issue23SavedTab.name);"), text]);
	assert.equal(resumed.type, "result");
	if (resumed.type !== "result") throw new Error("expected resumed result");
	assert.equal(resumed.ok, true);
	assert.equal(output.type, "text");
	if (output.type !== "text") throw new Error("expected retained tab name");
	assert.equal(output.chunk, "download-tab\n");
	console.log("late bridge rejection contained; earlier binding retained");

	// Install an idle, unattributed rejection only after its configuring run
	// settles. It has no bridge owner or cell frame and must still reach the
	// native worker error path, not become a warning or a successful result.
	const armed = await run(
		"issue23-arm-infrastructure",
		[
			'import { parentPort as issue23ParentPort } from "node:worker_threads";',
			'issue23ParentPort.once("message", () => {',
			'  var error = new Error("unattributed infrastructure rejection");',
			'  error.stack = "Error: unattributed infrastructure rejection\\n    at infrastructure.ts:1:1";',
			"  void Promise.reject(error);",
			"});",
		].join("\n"),
	);
	assert.equal(armed.type, "result");
	if (armed.type !== "result") throw new Error("expected infrastructure setup result");
	assert.equal(armed.ok, true);
	worker.postMessage({ type: "issue23-infrastructure-trigger" });
	assert.match((await failed.promise).message, /unattributed infrastructure rejection/);
	console.log("unattributed infrastructure rejection remains fatal");
} finally {
	listeners.clear();
	pending.clear();
	worker.terminate();
}
