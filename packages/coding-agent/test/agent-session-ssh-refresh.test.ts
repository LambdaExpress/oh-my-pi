import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { reset as resetCapabilities } from "@oh-my-pi/pi-coding-agent/capability";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { addSSHHost } from "@oh-my-pi/pi-coding-agent/ssh/config-writer";
import * as connectionManager from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import {
	loadSshTool,
	loadSshTransferTool,
	type Tool,
	type ToolSession,
	XdevRegistry,
} from "@oh-my-pi/pi-coding-agent/tools";
import { getAgentDir, getSSHConfigPath, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

function createModel(): Model<"openai-responses"> {
	return buildModel({
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

function waitForSessionEvent(
	session: AgentSession,
	predicate: (event: AgentSessionEvent) => boolean,
): Promise<AgentSessionEvent> {
	const result = Promise.withResolvers<AgentSessionEvent>();
	const unsubscribe = session.subscribe(event => {
		if (!predicate(event)) return;
		unsubscribe();
		result.resolve(event);
	});
	return result.promise;
}

function sshSessionAssistant(password: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "ssh-session-call",
				name: "ssh_session",
				arguments: { op: "create", name: "prod", host: "example.com", password },
			},
		],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

interface CreateSessionOptions {
	initialTools?: AgentTool[];
	registryTools?: AgentTool[];
	requestedToolNames?: ReadonlySet<string>;
	xdevRegistry?: XdevRegistry;
	reloadSshTool?: () => Promise<Tool | null>;
	reloadSshTransferTool?: () => Promise<Tool | null>;
}

describe("AgentSession SSH transfer refresh", () => {
	const tempDirs: TempDir[] = [];
	const sessions: AgentSession[] = [];
	const originalAgentDir = getAgentDir();

	beforeEach(() => {
		const agentDir = TempDir.createSync("@pi-ssh-refresh-agent-");
		tempDirs.push(agentDir);
		setAgentDir(agentDir.path());
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		setAgentDir(originalAgentDir);
		for (const tempDir of tempDirs.splice(0)) tempDir.removeSync();
		resetCapabilities();
	});

	function createSession(cwd: string, options: CreateSessionOptions = {}): AgentSession {
		const settings = Settings.isolated({ "compaction.enabled": false });
		const sessionManager = SessionManager.inMemory(cwd);
		const toolSession: ToolSession = {
			cwd,
			hasUI: false,
			settings,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
		};
		const initialTools = options.initialTools ?? [];
		const registryTools = options.registryTools ?? initialTools;
		const toolRegistry = new Map(registryTools.map(tool => [tool.name, tool]));
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: initialTools,
				messages: [],
			},
		});
		let session!: AgentSession;
		const reloadSshTool =
			options.reloadSshTool ??
			(async () => {
				if (options.requestedToolNames && !options.requestedToolNames.has("ssh")) return null;
				return loadSshTool(toolSession);
			});
		const reloadSshTransferTool =
			options.reloadSshTransferTool ??
			(async () => {
				if (options.requestedToolNames && !options.requestedToolNames.has("ssh_transfer")) return null;
				return loadSshTransferTool(toolSession);
			});
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: {} as never,
			toolRegistry,
			reloadSshTool,
			reloadSshTransferTool,
			getXdevToolEntries: () => options.xdevRegistry?.entries() ?? [],
			xdevRegistry: options.xdevRegistry,
			rebuildSystemPrompt: async (toolNames, tools) => ({
				systemPrompt: toolNames.map(name => `${name}:${tools.get(name)?.description ?? ""}`),
			}),
		});
		toolSession.getSessionSshConfigs = () => session.getSessionSshConfigs();
		toolSession.getSessionSshHosts = () => session.getSessionSshHosts();
		toolSession.mutateSessionSshConfig = mutation => session.mutateSessionSshConfig(mutation);
		sessions.push(session);
		return session;
	}

	it("refreshes mounted xd:// SSH devices after session SSH CRUD", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-xdev-refresh-");
		tempDirs.push(tempDir);
		const xdevRegistry = new XdevRegistry([]);
		const session = createSession(tempDir.path(), { xdevRegistry });

		await session.mutateSessionSshConfig({
			operation: "upsert",
			name: "ephemeral",
			config: { host: "192.0.2.50", username: "session-user", password: "secret" },
		});

		expect(xdevRegistry.get("ssh")?.description).toContain("ephemeral (192.0.2.50)");
		expect(xdevRegistry.get("ssh_transfer")?.description).toContain("ephemeral (192.0.2.50)");
		expect(session.getMountedXdevToolNames()).toEqual(expect.arrayContaining(["ssh", "ssh_transfer"]));
		expect(session.getAllToolNames()).not.toContain("ssh");
		expect(session.getAllToolNames()).not.toContain("ssh_transfer");

		await session.mutateSessionSshConfig({ operation: "delete", name: "ephemeral" });
		expect(xdevRegistry.get("ssh_transfer")).toBeUndefined();
		expect(xdevRegistry.get("ssh")).toBeUndefined();
	});

	it("preserves configured passwords in mounted session aliases without exposing them in descriptions", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-xdev-password-");
		tempDirs.push(tempDir);
		const xdevRegistry = new XdevRegistry([]);
		const session = createSession(tempDir.path(), { xdevRegistry });
		const password = "session-ssh-password-sentinel";
		await session.mutateSessionSshConfig({
			operation: "upsert",
			name: "prod",
			config: { host: "192.0.2.60", username: "root", password },
		});

		const hosts = await session.getSessionSshHosts();
		expect(hosts).toContainEqual(expect.objectContaining({ name: "prod", password }));
		expect(xdevRegistry.get("ssh")?.description).toContain("prod (192.0.2.60)");
		expect(xdevRegistry.get("ssh")?.description).not.toContain(password);
	});

	it("keeps mounted SSH devices tracked across tool repartitioning", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-xdev-repartition-");
		tempDirs.push(tempDir);
		const xdevRegistry = new XdevRegistry([]);
		const session = createSession(tempDir.path(), { xdevRegistry });

		await session.mutateSessionSshConfig({
			operation: "upsert",
			name: "ephemeral",
			config: { host: "192.0.2.51" },
		});
		expect(session.getMountedXdevToolNames()).toContain("ssh");
		expect(session.getMountedXdevToolNames()).toContain("ssh_transfer");

		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "xdev") notices.push(event.message);
		});
		await session.setActiveToolsByName(session.getEnabledToolNames());

		expect(xdevRegistry.get("ssh")).toBeDefined();
		expect(xdevRegistry.get("ssh_transfer")).toBeDefined();
		expect(session.getMountedXdevToolNames()).toContain("ssh");
		expect(session.getMountedXdevToolNames()).toContain("ssh_transfer");
		expect(notices).not.toContain("xd://: unmounted ssh");
		expect(notices).not.toContain("xd://: unmounted ssh_transfer");
	});

	it("refreshes top-level SSH tools when xd:// is disabled", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-top-level-refresh-");
		tempDirs.push(tempDir);
		const session = createSession(tempDir.path());

		await session.mutateSessionSshConfig({
			operation: "upsert",
			name: "staging",
			config: { host: "192.0.2.10" },
		});

		expect(session.getAllToolNames()).toEqual(expect.arrayContaining(["ssh", "ssh_transfer"]));
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["ssh", "ssh_transfer"]));
		expect(session.getToolByName("ssh")?.description).toContain("staging (192.0.2.10)");
		expect(session.getToolByName("ssh_transfer")?.description).toContain("staging (192.0.2.10)");
		expect(session.agent.state.systemPrompt.join("\n")).toContain("staging (192.0.2.10)");

		await session.mutateSessionSshConfig({ operation: "delete", name: "staging" });
		expect(session.getAllToolNames()).not.toContain("ssh");
		expect(session.getActiveToolNames()).not.toContain("ssh");
		expect(session.getAllToolNames()).not.toContain("ssh_transfer");
		expect(session.getActiveToolNames()).not.toContain("ssh_transfer");
	});

	it("honors explicit tool allowlists for command and transfer tools", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-allowlist-refresh-");
		tempDirs.push(tempDir);
		const blocked = createSession(tempDir.path(), { requestedToolNames: new Set(["ssh_session"]) });
		await blocked.mutateSessionSshConfig({
			operation: "upsert",
			name: "hidden",
			config: { host: "203.0.113.12" },
		});
		expect(blocked.getAllToolNames()).not.toContain("ssh_transfer");
		expect(blocked.getAllToolNames()).not.toContain("ssh");

		const sshOnly = createSession(tempDir.path(), { requestedToolNames: new Set(["ssh"]) });
		await sshOnly.mutateSessionSshConfig({
			operation: "upsert",
			name: "command-only",
			config: { host: "203.0.113.13" },
		});
		expect(sshOnly.getActiveToolNames()).toContain("ssh");
		expect(sshOnly.getAllToolNames()).not.toContain("ssh_transfer");

		const transferOnly = createSession(tempDir.path(), { requestedToolNames: new Set(["ssh_transfer"]) });
		await transferOnly.mutateSessionSshConfig({
			operation: "upsert",
			name: "transfer-only",
			config: { host: "203.0.113.14" },
		});
		expect(transferOnly.getActiveToolNames()).toContain("ssh_transfer");
		expect(transferOnly.getAllToolNames()).not.toContain("ssh");
	});

	it("does not activate an existing inactive transfer tool during refresh", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-inactive-refresh-");
		tempDirs.push(tempDir);
		await addSSHHost(getSSHConfigPath("project", tempDir.path()), "dev", { host: "192.0.2.20" });
		const toolSession: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		};
		const transferTool = await loadSshTransferTool(toolSession);
		expect(transferTool).not.toBeNull();
		const session = createSession(tempDir.path(), { registryTools: [transferTool as AgentTool] });

		await session.refreshSshTools({ activateIfAvailable: true });
		expect(session.getAllToolNames()).toContain("ssh_transfer");
		expect(session.getActiveToolNames()).not.toContain("ssh_transfer");
	});

	it("invalidates a changed connection before rebuilding the transfer description", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-invalidation-");
		tempDirs.push(tempDir);
		const session = createSession(tempDir.path());
		await session.mutateSessionSshConfig({
			operation: "upsert",
			name: "prod",
			config: { host: "203.0.113.9", password: "old-secret" },
		});
		const invalidateSpy = spyOn(connectionManager, "invalidateSshTarget").mockResolvedValue(undefined);
		try {
			await session.mutateSessionSshConfig({
				operation: "upsert",
				name: "prod",
				config: { host: "203.0.113.10", password: "new-secret" },
			});
			expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ name: "prod", host: "203.0.113.9" }), {
				invalidateHostInfo: true,
			});
			expect(session.getToolByName("ssh_transfer")?.description).toContain("prod (203.0.113.10)");
		} finally {
			invalidateSpy.mockRestore();
		}
	});

	it("reveals a persistent fallback after deleting a session override", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-session-fallback-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();
		await addSSHHost(getSSHConfigPath("project", cwd), "shared", {
			host: "persistent.example",
			username: "disk",
		});
		const session = createSession(cwd);
		await session.refreshSshTools({ activateIfAvailable: true });
		await session.mutateSessionSshConfig({
			operation: "upsert",
			name: "shared",
			config: { host: "session.example", username: "branch" },
		});
		expect(session.getToolByName("ssh_transfer")?.description).toContain("shared (session.example)");
		expect(session.getToolByName("ssh")?.description).toContain("shared (session.example)");

		await session.mutateSessionSshConfig({ operation: "delete", name: "shared" });
		expect(session.getToolByName("ssh_transfer")?.description).toContain("shared (persistent.example)");
		expect(session.getToolByName("ssh")?.description).toContain("shared (persistent.example)");
	});

	it("redacts ssh_session passwords from streaming events, persistence, and active context", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-session-event-redaction-");
		tempDirs.push(tempDir);
		const session = createSession(tempDir.path());
		const password = "agent-session-event-password-sentinel";
		const assistant = sshSessionAssistant(password);

		session.agent.emitExternalEvent({ type: "message_start", message: assistant });
		const updatePromise = waitForSessionEvent(session, event => event.type === "message_update");
		session.agent.emitExternalEvent({
			type: "message_update",
			message: assistant,
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: JSON.stringify(assistant.content[0]),
				partial: assistant,
			},
		});
		const updateEvent = await updatePromise;
		expect(JSON.stringify(updateEvent)).not.toContain(password);

		const messageEndPromise = waitForSessionEvent(
			session,
			event => event.type === "message_end" && event.message.role === "assistant",
		);
		session.agent.emitExternalEvent({ type: "message_end", message: assistant });
		expect(JSON.stringify(await messageEndPromise)).not.toContain(password);
		await session.waitForMessagePersistence(assistant);
		const persistedAssistant = session.sessionManager
			.getEntries()
			.find(entry => entry.type === "message" && entry.message.role === "assistant");
		expect(JSON.stringify(persistedAssistant)).not.toContain(password);
		expect(JSON.stringify(persistedAssistant)).toContain("[REDACTED]");

		const executionStartPromise = waitForSessionEvent(
			session,
			event => event.type === "tool_execution_start" && event.toolName === "ssh_session",
		);
		session.agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "ssh-session-call",
			toolName: "ssh_session",
			args: { op: "create", name: "prod", host: "example.com", password },
		});
		expect(JSON.stringify(await executionStartPromise)).not.toContain(password);
	});
});
