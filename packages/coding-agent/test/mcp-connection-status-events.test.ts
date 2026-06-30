import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { McpConnectionStatusEvent } from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");
const BUN_EXEC = process.execPath;

describe("MCPManager connection status events", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-status-"));
	});

	afterEach(() => {
		removeSyncWithRetries(workDir);
	});

	it("emits connecting, connected, and failed updates for startup status", async () => {
		const manager = new MCPManager(workDir);
		const events: McpConnectionStatusEvent[] = [];
		const success: MCPServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
		};
		const invalid: MCPServerConfig = { type: "stdio", command: "" };

		try {
			const alphaConnected = Promise.withResolvers<void>();
			const result = await manager.connectServers({ alpha: success, broken: invalid }, {}, event => {
				events.push(event);
				if (event.type === "connected" && event.serverName === "alpha") alphaConnected.resolve();
			});

			if (!events.some(event => event.type === "connected" && event.serverName === "alpha")) {
				await alphaConnected.promise;
			}
			expect(manager.getConnectionStatus("alpha")).toBe("connected");
			expect(result.errors.get("broken")).toBe('Server "broken": stdio server requires "command" field');
			expect(events).toEqual([
				{ type: "connecting", serverNames: ["alpha", "broken"] },
				{ type: "failed", serverName: "broken", error: 'Server "broken": stdio server requires "command" field' },
				{ type: "connected", serverName: "alpha" },
			]);
		} finally {
			await manager.disconnectAll();
		}
	}, 30_000);
});
