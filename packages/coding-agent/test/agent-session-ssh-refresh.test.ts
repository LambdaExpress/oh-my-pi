import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { reset as resetCapabilities } from "@oh-my-pi/pi-coding-agent/capability";
import { type SSHHost, sshCapability } from "@oh-my-pi/pi-coding-agent/capability/ssh";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { addSSHHost, removeSSHHost, updateSSHHost } from "@oh-my-pi/pi-coding-agent/ssh/config-writer";
import * as connectionManager from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import { loadSshTool, loadSshTransferTool, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
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

describe("AgentSession SSH tool refresh", () => {
	const tempDirs: TempDir[] = [];
	const sessions: AgentSession[] = [];
	const originalAgentDir = getAgentDir();

	beforeEach(() => {
		const agentDir = TempDir.createSync("@pi-ssh-refresh-agent-");
		tempDirs.push(agentDir);
		setAgentDir(agentDir.path());
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		setAgentDir(originalAgentDir);
		for (const tempDir of tempDirs.splice(0)) {
			tempDir.removeSync();
		}
		resetCapabilities();
	});

	function createSession(
		cwd: string,
		initialTools: AgentTool[] = [],
		registryTools = initialTools,
		options?: { reloadSshTools?: () => Promise<Tool[]>; requestedToolNames?: ReadonlySet<string> },
	): AgentSession {
		const settings = Settings.isolated({ "compaction.enabled": false });
		const sessionManager = SessionManager.inMemory(cwd);
		const toolSession: ToolSession = {
			cwd,
			hasUI: false,
			settings,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
		};
		const toolRegistry = new Map(registryTools.map(tool => [tool.name, tool]));
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: initialTools,
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: {} as never,
			toolRegistry,
			reloadSshTools:
				options?.reloadSshTools ??
				(async () => {
					const [sshTool, transferTool] = await Promise.all([
						loadSshTool(toolSession),
						loadSshTransferTool(toolSession),
					]);
					const tools: Tool[] = [];
					if (sshTool) tools.push(sshTool);
					if (transferTool) tools.push(transferTool);
					return tools;
				}),
			requestedToolNames: options?.requestedToolNames,
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

	it("adds the ssh tool after a first host is written over a cached missing config", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();

		const preWrite = await loadCapability<SSHHost>(sshCapability.id, { cwd });
		expect(preWrite.items).toHaveLength(0);

		const session = createSession(cwd);
		await addSSHHost(getSSHConfigPath("project", cwd), "staging", { host: "192.0.2.10" });
		await session.refreshSshTools({ activateIfAvailable: true });

		expect(session.getAllToolNames()).toContain("ssh");
		expect(session.getActiveToolNames()).toContain("ssh");
		expect(session.getAllToolNames()).toContain("ssh_transfer");
		expect(session.getActiveToolNames()).toContain("ssh_transfer");
		expect(session.getToolByName("ssh_transfer")?.description).toContain("staging (192.0.2.10)");
		expect(session.getToolByName("ssh")?.description).toContain("staging (192.0.2.10)");
		expect(session.agent.state.systemPrompt.join("\n")).toContain("staging (192.0.2.10)");
	});

	it("removes ssh from registry and active tools when the last host is removed", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();
		const configPath = getSSHConfigPath("project", cwd);

		await addSSHHost(configPath, "prod", { host: "203.0.113.9" });
		const sshTool = await loadSshTool({
			cwd,
			hasUI: false,
			settings: Settings.isolated({ "compaction.enabled": false }),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
		});
		expect(sshTool).not.toBeNull();

		const session = createSession(cwd, [sshTool as unknown as AgentTool]);
		await removeSSHHost(configPath, "prod");
		await session.refreshSshTools();

		expect(session.getAllToolNames()).not.toContain("ssh");
		expect(session.getActiveToolNames()).not.toContain("ssh");
		expect(session.getAllToolNames()).not.toContain("ssh_transfer");
		expect(session.getActiveToolNames()).not.toContain("ssh_transfer");
	});

	it("does not activate an existing inactive ssh tool during reload refresh", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();
		const configPath = getSSHConfigPath("project", cwd);

		await addSSHHost(configPath, "dev", { host: "192.0.2.20" });
		const sshTool = await loadSshTool({
			cwd,
			hasUI: false,
			settings: Settings.isolated({ "compaction.enabled": false }),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
		});
		expect(sshTool).not.toBeNull();

		await addSSHHost(configPath, "dev2", { host: "192.0.2.21" });
		const session = createSession(cwd, [], [sshTool as unknown as AgentTool]);
		await session.refreshSshTools({ activateIfAvailable: true });

		expect(session.getAllToolNames()).toContain("ssh");
		expect(session.getActiveToolNames()).not.toContain("ssh");
		expect(session.getToolByName("ssh")?.description).toContain("dev2 (192.0.2.21)");
	});

	it("reloads ssh from the session's current cwd after move", async () => {
		const oldProject = TempDir.createSync("@pi-ssh-refresh-old-");
		const newProject = TempDir.createSync("@pi-ssh-refresh-new-");
		tempDirs.push(oldProject, newProject);
		await SessionManager.inMemory(oldProject.path()).moveTo?.(newProject.path());
		await addSSHHost(getSSHConfigPath("project", newProject.path()), "moved", { host: "198.51.100.8" });
		const movedTool = await loadSshTool({
			cwd: newProject.path(),
			hasUI: false,
			settings: Settings.isolated({ "compaction.enabled": false }),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
		});
		expect(movedTool).not.toBeNull();

		const refreshedSession = createSession(oldProject.path(), [], [], {
			reloadSshTools: async () => (movedTool ? [movedTool] : []),
		});
		await refreshedSession.refreshSshTools({ activateIfAvailable: true });

		expect(refreshedSession.getAllToolNames()).toContain("ssh");
		expect(refreshedSession.getToolByName("ssh")?.description).toContain("moved (198.51.100.8)");
	});

	it("closes the old target and invalidates host metadata before rebuilding descriptions", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();
		const configPath = getSSHConfigPath("project", cwd);

		await addSSHHost(configPath, "prod", { host: "203.0.113.9" });
		const initialTool = await loadSshTool({
			cwd,
			hasUI: false,
			settings: Settings.isolated({ "compaction.enabled": false }),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
		});
		expect(initialTool).not.toBeNull();
		const session = createSession(cwd, [initialTool as unknown as AgentTool]);
		await session.refreshSshTools({ activateIfAvailable: true });

		const invalidateSpy = spyOn(connectionManager, "invalidateSshTarget").mockResolvedValue(undefined);
		try {
			await updateSSHHost(configPath, "prod", { host: "203.0.113.10" });
			await session.refreshSshTools({ activateIfAvailable: true });

			expect(invalidateSpy).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({ name: "prod", host: "203.0.113.9" }),
				{ invalidateHostInfo: true },
			);
			expect(session.getToolByName("ssh")?.description).toContain("prod (203.0.113.10)");
		} finally {
			invalidateSpy.mockRestore();
		}
	});

	it("closes the old target without invalidating host metadata when only its password changes", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();
		const configPath = getSSHConfigPath("project", cwd);

		await addSSHHost(configPath, "prod", { host: "203.0.113.9", password: "old-secret" });
		const initialTool = await loadSshTool({
			cwd,
			hasUI: false,
			settings: Settings.isolated({ "compaction.enabled": false }),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
		});
		expect(initialTool).not.toBeNull();
		const session = createSession(cwd, [initialTool as unknown as AgentTool]);
		await session.refreshSshTools({ activateIfAvailable: true });

		const invalidateSpy = spyOn(connectionManager, "invalidateSshTarget").mockResolvedValue(undefined);
		try {
			await updateSSHHost(configPath, "prod", { host: "203.0.113.9", password: "new-secret" });
			await session.refreshSshTools({ activateIfAvailable: true });

			expect(invalidateSpy).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({ name: "prod", host: "203.0.113.9", password: "old-secret" }),
				{ invalidateHostInfo: false },
			);
			expect(session.getToolByName("ssh")?.description).toContain("prod (203.0.113.9)");
			expect(session.getToolByName("ssh")?.description).not.toContain("new-secret");
		} finally {
			invalidateSpy.mockRestore();
		}
	});

	it("invalidates newly added host names before rebuilding the ssh tool", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();
		const configPath = getSSHConfigPath("project", cwd);

		await addSSHHost(configPath, "fresh", { host: "203.0.113.11" });
		const session = createSession(cwd);
		await session.refreshSshTools({ activateIfAvailable: true });

		expect(session.getToolByName("ssh")?.description).toContain("fresh (203.0.113.11)");
		expect(session.getToolByName("ssh")?.description).toContain("fresh (203.0.113.11)");
	});

	it("keeps the SSH registry and system prompt synchronized with session CRUD", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-session-refresh-");
		tempDirs.push(tempDir);
		const session = createSession(tempDir.path());

		await session.mutateSessionSshConfig({
			operation: "upsert",
			name: "ephemeral",
			config: { host: "192.0.2.50", username: "session-user", password: "secret" },
		});
		expect(session.getAllToolNames()).toContain("ssh");
		expect(session.getActiveToolNames()).toContain("ssh");
		expect(session.getToolByName("ssh")?.description).toContain("ephemeral (192.0.2.50)");
		expect(session.agent.state.systemPrompt.join("\n")).toContain("ephemeral (192.0.2.50)");
		expect(session.agent.state.systemPrompt.join("\n")).not.toContain("secret");

		await session.mutateSessionSshConfig({ operation: "delete", name: "ephemeral" });
		expect(session.getAllToolNames()).not.toContain("ssh");
		expect(session.getActiveToolNames()).not.toContain("ssh");
	});

	it("reveals a persistent fallback after deleting a session override", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-session-fallback-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();
		await addSSHHost(getSSHConfigPath("project", cwd), "shared", { host: "persistent.example", username: "disk" });
		const session = createSession(cwd);
		await session.refreshSshTools({ activateIfAvailable: true });

		await session.mutateSessionSshConfig({
			operation: "upsert",
			name: "shared",
			config: { host: "session.example", username: "branch" },
		});
		expect(session.getToolByName("ssh")?.description).toContain("shared (session.example)");

		await session.mutateSessionSshConfig({ operation: "delete", name: "shared" });
		expect(session.getAllToolNames()).toContain("ssh");
		expect(session.getToolByName("ssh")?.description).toContain("shared (persistent.example)");
	});

	it("isolates same-name aliases and closes only the updated session target", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-session-target-isolation-");
		tempDirs.push(tempDir);
		const first = createSession(tempDir.path());
		const second = createSession(tempDir.path());
		await first.mutateSessionSshConfig({
			operation: "upsert",
			name: "shared",
			config: { host: "first.example", password: "first-password" },
		});
		await second.mutateSessionSshConfig({
			operation: "upsert",
			name: "shared",
			config: { host: "second.example", password: "second-password" },
		});
		const firstTarget = (await first.getSessionSshHosts()).find(host => host.name === "shared")!;
		const secondTarget = (await second.getSessionSshHosts()).find(host => host.name === "shared")!;
		expect(firstTarget.connectionId).not.toBe(secondTarget.connectionId);

		const invalidateSpy = spyOn(connectionManager, "invalidateSshTarget").mockResolvedValue(undefined);
		try {
			await first.mutateSessionSshConfig({
				operation: "upsert",
				name: "shared",
				config: { host: "first.example", password: "updated-password" },
			});
			expect(invalidateSpy).toHaveBeenCalledTimes(1);
			expect(invalidateSpy).toHaveBeenCalledWith(firstTarget, { invalidateHostInfo: false });
			expect(first.getSessionSshConfigs().get("shared")?.config.password).toBe("updated-password");
			expect(second.getSessionSshConfigs().get("shared")?.config.password).toBe("second-password");
		} finally {
			invalidateSpy.mockRestore();
		}
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
		if (updateEvent.type !== "message_update") throw new Error("expected message_update");
		expect(updateEvent.assistantMessageEvent.type).toBe("toolcall_delta");
		if (updateEvent.assistantMessageEvent.type !== "toolcall_delta") throw new Error("expected toolcall_delta");
		expect(updateEvent.assistantMessageEvent.delta).toBe("");

		const messageEndPromise = waitForSessionEvent(
			session,
			event => event.type === "message_end" && event.message.role === "assistant",
		);
		session.agent.emitExternalEvent({ type: "message_end", message: assistant });
		const messageEndEvent = await messageEndPromise;
		expect(JSON.stringify(messageEndEvent)).not.toContain(password);
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

		const executionEndPromise = waitForSessionEvent(
			session,
			event => event.type === "tool_execution_end" && event.toolName === "ssh_session",
		);
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: "ssh-session-call",
			toolName: "ssh_session",
			result: { content: [{ type: "text", text: "failed safely" }] },
			isError: true,
		});
		await executionEndPromise;
		expect(JSON.stringify(session.agent.state.messages)).not.toContain(password);
		expect(JSON.stringify(session.agent.state.messages)).toContain("[REDACTED]");
	});

	it("does not activate ssh when it was excluded from the requested tool allowlist", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();
		const configPath = getSSHConfigPath("project", cwd);
		const blockedTool: AgentTool = {
			name: "ssh",
			label: "SSH",
			description: "blocked",
			parameters: { type: "object", properties: {} },
			strict: true,
			execute: async () => ({ content: [{ type: "text", text: "" }] }),
		};

		await addSSHHost(configPath, "hidden", { host: "203.0.113.12" });
		const session = createSession(cwd, [], [blockedTool], {
			reloadSshTools: async () => [blockedTool],
			requestedToolNames: new Set(["read"]),
		});
		await session.refreshSshTools({ activateIfAvailable: true });

		expect(session.getAllToolNames()).toContain("ssh");
		expect(session.getActiveToolNames()).not.toContain("ssh");
	});

	it("applies explicit allowlists independently to both SSH tools", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();
		const sshTool: AgentTool = {
			name: "ssh",
			label: "SSH",
			description: "ssh",
			parameters: { type: "object", properties: {} },
			strict: true,
			execute: async () => ({ content: [{ type: "text", text: "" }] }),
		};
		const transferTool: AgentTool = {
			name: "ssh_transfer",
			label: "SSH Transfer",
			description: "ssh_transfer",
			parameters: { type: "object", properties: {} },
			strict: true,
			execute: async () => ({ content: [{ type: "text", text: "" }] }),
		};
		const session = createSession(cwd, [], [], {
			reloadSshTools: async () => [sshTool, transferTool],
			requestedToolNames: new Set(["ssh_transfer"]),
		});

		await session.refreshSshTools({ activateIfAvailable: true });

		expect(session.getAllToolNames()).toEqual(expect.arrayContaining(["ssh", "ssh_transfer"]));
		expect(session.getActiveToolNames()).not.toContain("ssh");
		expect(session.getActiveToolNames()).toContain("ssh_transfer");
	});
});
