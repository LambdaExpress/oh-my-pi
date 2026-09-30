/**
 * The prompt inventory lists every connected MCP server (see
 * `mcpInjectionItems`), so `getConnectedServerTools` has to report the live
 * connection set with the tools loaded from each — not just the servers that
 * happen to ship instructions, and not the tools of a server that was
 * disconnected.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { MANY_TOOL_COUNT, manyToolName } from "./fixtures/many-tools-mcp";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");
const SERVER = "alpha";

function fixtureConfig(): MCPStdioServerConfig {
	return { type: "stdio", command: process.execPath, args: [FIXTURE_PATH] };
}

describe("connected MCP server inventory", () => {
	let workDir: string;
	let manager: MCPManager;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-connected-"));
		manager = new MCPManager(workDir);
	});

	afterEach(async () => {
		await manager.disconnectAll();
		removeSyncWithRetries(workDir);
	});

	it("reports the tools of a connected server and forgets it after disconnect", async () => {
		await manager.connectServers({ [SERVER]: fixtureConfig() }, {});

		const connected = manager.getConnectedServerTools();
		expect(connected.get(SERVER)).toHaveLength(MANY_TOOL_COUNT);
		expect(connected.get(SERVER)).toContain(manyToolName(0));

		await manager.disconnectServer(SERVER);

		expect(manager.getConnectedServerTools().size).toBe(0);
	});
});
