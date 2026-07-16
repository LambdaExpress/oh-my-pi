#!/usr/bin/env bun
/**
 * Minimal stdio MCP server used by `mcp-connection-status-events.test.ts` to
 * exercise connection lifecycle and disposal while initialization is delayed.
 * The optional `--delay <ms>` argument stalls the `initialize` response so the
 * test can deterministically dispose the manager during connection.
 *
 * Speaks newline-delimited JSON-RPC 2.0 (the wire format of `StdioTransport`),
 * same shape as `instructions-mcp.ts`. The server only starts when run as the
 * entry module (`import.meta.main`).
 */
import * as readline from "node:readline";

/** Stable fixture tool count for deterministic `tools/list` responses. */
export const MANY_TOOL_COUNT = 45;

/** Alphabetic names: MCP tool-name sanitization strips digits, so numeric
 *  suffixes like `tool_01` would all collapse into one colliding name. */
export function manyToolName(index: number): string {
	const hi = String.fromCharCode(97 + Math.floor(index / 26));
	const lo = String.fromCharCode(97 + (index % 26));
	return `tool_${hi}${lo}`;
}

type JsonRpcRequest = {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
};

function buildResult(method: string): Record<string, unknown> {
	switch (method) {
		case "initialize":
			return {
				protocolVersion: "2025-03-26",
				serverInfo: { name: "many-fixture", version: "1.0.0" },
				capabilities: { tools: {} },
			};
		case "tools/list":
			return {
				tools: Array.from({ length: MANY_TOOL_COUNT }, (_, i) => ({
					name: manyToolName(i),
					description: `Fixture tool #${i}; never actually called by the test.`,
					inputSchema: { type: "object", properties: {}, additionalProperties: false },
				})),
			};
		default:
			return {};
	}
}

function startServer(): void {
	const delayIndex = process.argv.indexOf("--delay");
	const initializeDelayMs = delayIndex >= 0 ? Number(process.argv[delayIndex + 1]) || 0 : 0;
	const rl = readline.createInterface({ input: process.stdin });
	rl.on("line", line => {
		void (async () => {
			const trimmed = line.trim();
			if (trimmed.length === 0) return;
			let msg: JsonRpcRequest;
			try {
				msg = JSON.parse(trimmed) as JsonRpcRequest;
			} catch {
				return;
			}
			// Notifications (no `id`) get no response.
			if (msg.id === undefined || msg.id === null) return;
			if (msg.method === "initialize" && initializeDelayMs > 0) {
				await Bun.sleep(initializeDelayMs);
			}
			const response = { jsonrpc: "2.0" as const, id: msg.id, result: buildResult(msg.method) };
			process.stdout.write(`${JSON.stringify(response)}\n`);
		})();
	});
	rl.on("close", () => process.exit(0));
}

if (import.meta.main) {
	startServer();
}
