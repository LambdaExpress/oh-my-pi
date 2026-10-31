import { expect, it } from "bun:test";
import * as path from "node:path";

it("preserves configured CA trust across provider fetch and Codex WebSocket without bypassing validation", async () => {
	// Isolate the runtime default CA store and environment from other test files.
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/provider-tls-smoke.ts")], {
		cwd: path.resolve(import.meta.dir, "../../.."),
		env: {
			...process.env,
			NODE_EXTRA_CA_CERTS: undefined,
			NODE_TLS_REJECT_UNAUTHORIZED: undefined,
			PI_REQ_DEBUG: undefined,
			PI_CODEX_WEBSOCKET: undefined,
			PI_CODEX_WEBSOCKET_RETRY_BUDGET: "0",
			NO_PROXY: "*",
			no_proxy: "*",
		},
		stdout: "pipe",
		stderr: "pipe",
		timeout: 30_000,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	expect(JSON.parse(stdout)).toEqual({
		untrustedRejected: true,
		sseText: "tls-ok",
		websocketText: "tls-ok",
		websocketRequests: 1,
		fallbackRequests: 0,
		defaultCaText: "tls-ok",
		curatedCaRejected: true,
		hostnameMismatchRejected: true,
	});
}, 35_000);
