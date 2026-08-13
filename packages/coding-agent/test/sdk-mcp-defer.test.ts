import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type MCPLoadResult, MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import {
	MCP_CONNECTION_STATUS_EVENT_CHANNEL,
	type McpConnectionStatusEvent,
} from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import { type CustomTool, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Contract for B1 (interactive MCP deferral): when `hasUI` is true, MCP
// discovery is deferred off the first-paint path, so an explicitly requested
// MCP tool (e.g. via `--tools`) whose server has not yet connected MUST still
// be a *known* tool — registered as a deterministic "still connecting"
// placeholder — rather than vanishing and surfacing as "unknown tool" if the
// model calls it before the background connection completes. With `hasUI`
// false there is no deferral, so an MCP tool name with no real backing is not
// registered at all (the non-UI paths keep the blocking discover path).
describe("createAgentSession MCP deferral (B1)", () => {
	let registryDir: string;
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	const PENDING_MCP_TOOL = "mcp__pending_connectingtool";

	const baseOptions = () => ({
		cwd: tempDir,
		agentDir: tempDir,
		modelRegistry,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({}),
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableLsp: false,
		skipPythonPreflight: true,
		// No .mcp.json in tempDir, so no real MCP server can ever back this name.
		enableMCP: true,
		toolNames: ["read", PENDING_MCP_TOOL],
	});

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-sdk-mcp-defer-registry-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		if (registryDir && fs.existsSync(registryDir)) {
			removeSyncWithRetries(registryDir);
		}
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-mcp-defer-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it("registers a pending placeholder for an explicit MCP tool when hasUI defers discovery", async () => {
		const { session } = await createAgentSession({ ...baseOptions(), hasUI: true });
		try {
			// The explicitly requested MCP tool is a known, resolvable tool even
			// though no server has connected — deterministic, not "unknown tool".
			expect(session.getActiveToolNames()).toContain(PENDING_MCP_TOOL);
			await session.refreshMCPTools([
				{
					name: PENDING_MCP_TOOL,
					label: "Connected MCP tool",
					description: "Connected replacement.",
					parameters: type({}),
					mcpServerName: "pending",
					mcpToolName: "connectingtool",
					async execute() {
						return { content: [{ type: "text", text: "connected" }] };
					},
				} satisfies CustomTool,
			]);
			expect(session.getToolByName(PENDING_MCP_TOOL)?.label).toBe("Connected MCP tool");
		} finally {
			await session.dispose();
		}
	});

	it("does not fabricate the MCP tool in non-UI mode (no deferral, no backing server)", async () => {
		const { session } = await createAgentSession({ ...baseOptions(), hasUI: false });
		try {
			// Without deferral there is no placeholder; the name has no real
			// server backing, so it is simply not a registered tool.
			expect(session.getActiveToolNames()).not.toContain(PENDING_MCP_TOOL);
			// A normal builtin is unaffected.
			expect(session.getActiveToolNames()).toContain("read");
		} finally {
			await session.dispose();
		}
	});

	it("holds MCP startup status until the returned deferred starter runs", async () => {
		fs.writeFileSync(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					delayed: { type: "stdio", command: process.execPath },
				},
			}),
		);

		const eventBus = new EventBus();
		const eventsBeforeManualStart: McpConnectionStatusEvent[] = [];
		const unsubscribeEarly = eventBus.on(MCP_CONNECTION_STATUS_EVENT_CHANNEL, event => {
			eventsBeforeManualStart.push(event as McpConnectionStatusEvent);
		});
		const discoverSpy = spyOn(MCPManager.prototype, "discoverAndConnect").mockImplementation(async options => {
			options?.onStatus?.({ type: "connecting", serverNames: ["delayed"] });
			return {
				tools: [],
				errors: new Map<string, string>(),
				connectedServers: [],
				exaApiKeys: [],
			} satisfies MCPLoadResult;
		});

		const result = await createAgentSession({
			...baseOptions(),
			hasUI: true,
			deferMCPDiscoveryStart: true,
			eventBus,
			toolNames: ["read"],
		});

		try {
			expect(eventsBeforeManualStart).toEqual([]);
			expect(discoverSpy).not.toHaveBeenCalled();
			expect(typeof result.startDeferredMCPDiscovery).toBe("function");

			const eventsAfterListenerRegistration: McpConnectionStatusEvent[] = [];
			const unsubscribeLate = eventBus.on(MCP_CONNECTION_STATUS_EVENT_CHANNEL, event => {
				eventsAfterListenerRegistration.push(event as McpConnectionStatusEvent);
			});
			try {
				result.startDeferredMCPDiscovery?.();

				expect(eventsAfterListenerRegistration).toEqual([{ type: "connecting", serverNames: ["delayed"] }]);
				expect(discoverSpy).toHaveBeenCalledTimes(1);
			} finally {
				unsubscribeLate();
			}
		} finally {
			unsubscribeEarly();
			discoverSpy.mockRestore();
			await result.session.dispose();
		}
	});
});
