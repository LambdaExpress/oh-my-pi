import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { reset as resetCapabilities } from "@oh-my-pi/pi-coding-agent/capability";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { parseInternalUrl, SshProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { addSSHHost } from "@oh-my-pi/pi-coding-agent/ssh/config-writer";
import * as connectionManager from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import * as fileTransfer from "@oh-my-pi/pi-coding-agent/ssh/file-transfer";
import * as sshExecutor from "@oh-my-pi/pi-coding-agent/ssh/ssh-executor";
import { loadSshTool, loadSshTransferTool, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type XdevState, xdevEntries } from "@oh-my-pi/pi-coding-agent/tools/xdev";
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
	xdev?: XdevState;
	reloadSshTool?: () => Promise<Tool | null>;
	reloadSshTransferTool?: () => Promise<Tool | null>;
	asyncJobManager?: AsyncJobManager;
	agentId?: string;
	agentScopeId?: string;
}

function createTestXdevState(): XdevState {
	return {
		tools: new Map(),
		mountedNames: new Set(),
		builtInNames: new Set(),
		isActive: () => true,
	};
}

describe("AgentSession SSH transfer refresh", () => {
	const tempDirs: TempDir[] = [];
	const homeDirs: TempDir[] = [];
	const sessions: AgentSession[] = [];
	const originalAgentDir = getAgentDir();
	let homedirSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		const agentDir = TempDir.createSync("@pi-ssh-refresh-agent-");
		const homeDir = TempDir.createSync("@pi-ssh-refresh-home-");
		tempDirs.push(agentDir);
		homeDirs.push(homeDir);
		setAgentDir(agentDir.path());
		homedirSpy = spyOn(os, "homedir").mockReturnValue(homeDir.path());
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		homedirSpy.mockRestore();
		setAgentDir(originalAgentDir);
		for (const tempDir of tempDirs.splice(0)) tempDir.removeSync();
		for (const homeDir of homeDirs.splice(0)) homeDir.removeSync();
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
		const toolRegistry = options.xdev?.tools ?? new Map(registryTools.map(tool => [tool.name, tool]));
		if (options.xdev) {
			for (const tool of registryTools) toolRegistry.set(tool.name, tool);
		}
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
			asyncJobManager: options.asyncJobManager,
			agentId: options.agentId,
			agentScopeId: options.agentScopeId,
			toolRegistry,
			reloadSshTool,
			reloadSshTransferTool,
			getXdevToolEntries: () => (options.xdev ? xdevEntries(options.xdev) : []),
			xdev: options.xdev,
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
		const xdev = createTestXdevState();
		const session = createSession(tempDir.path(), { xdev });

		await session.mutateSessionSshConfig({
			operation: "upsert",
			name: "ephemeral",
			config: { host: "192.0.2.50", username: "session-user", password: "secret" },
		});

		expect(xdev.tools.get("ssh")?.description).toContain("ephemeral (192.0.2.50)");
		expect(xdev.tools.get("ssh_transfer")?.description).toContain("ephemeral (192.0.2.50)");
		expect(session.getMountedXdevToolNames()).toEqual(expect.arrayContaining(["ssh", "ssh_transfer"]));
		expect(session.getActiveToolNames()).not.toContain("ssh");
		expect(session.getActiveToolNames()).not.toContain("ssh_transfer");

		await session.mutateSessionSshConfig({ operation: "delete", name: "ephemeral" });
		expect(xdev.tools.get("ssh_transfer")?.description ?? "").not.toContain("ephemeral");
		expect(xdev.tools.get("ssh")?.description ?? "").not.toContain("ephemeral");
	});

	it("refreshes loaded SSH command and transfer targets after OpenSSH config changes", async () => {
		const homeDir = TempDir.createSync("@pi-ssh-refresh-home-");
		tempDirs.push(homeDir);
		const home = homeDir.path();
		const homedirSpy = spyOn(os, "homedir").mockReturnValue(home);
		const configPath = path.join(home, ".ssh", "config");
		await fs.mkdir(path.dirname(configPath), { recursive: true });
		await fs.writeFile(
			configPath,
			[
				"Host live-alias",
				"  HostName old.example",
				"  User old-user",
				"  Port 2201",
				"  IdentityFile ~/.ssh/id_old",
				"  ProxyJump old-jump.example:2221",
			].join("\n"),
		);

		const toolSession: ToolSession = {
			cwd: home,
			hasUI: false,
			settings: Settings.isolated({ "async.enabled": false }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		};
		const commandTargets: connectionManager.SSHConnectionTarget[] = [];
		const transferTargets: connectionManager.SSHConnectionTarget[] = [];
		const hostInfoSpy = spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 5,
			os: "linux",
			shell: "sh",
			transferShell: "sh",
			compatEnabled: false,
		});
		const executeSpy = spyOn(sshExecutor, "executeSSH").mockImplementation(async target => {
			commandTargets.push(structuredClone(target));
			return {
				output: "ok",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 1,
				totalBytes: 2,
				outputLines: 1,
				outputBytes: 2,
			};
		});
		const prepareSpy = spyOn(fileTransfer, "prepareSshFileTransfer").mockImplementation(async input => {
			transferTargets.push(structuredClone(input.target));
			return {
				operation: input.operation,
				target: input.target,
				localPath: input.localPath,
				remotePath: input.remotePath,
				totalBytes: 1,
				overwrite: input.overwrite,
				commitStrategy: "no-replace",
			};
		});
		const transferSpy = spyOn(fileTransfer, "executeSshFileTransfer").mockResolvedValue({
			transferredBytes: 1,
			totalBytes: 1,
			bytesPerSecond: 1,
			averageBytesPerSecond: 1,
			elapsedMs: 1,
		});

		try {
			const commandTool = await loadSshTool(toolSession);
			const transferTool = await loadSshTransferTool(toolSession);
			expect(commandTool).not.toBeNull();
			expect(transferTool).not.toBeNull();

			await commandTool!.execute("ssh-old", { host: "live-alias", command: "true" });
			await transferTool!.execute("transfer-old", {
				op: "upload",
				host: "live-alias",
				local_path: "fixture.bin",
				remote_path: "/tmp/fixture.bin",
			});
			expect(commandTargets[0]).toMatchObject({
				host: "old.example",
				username: "old-user",
				port: 2201,
				proxyJump: "old-jump.example:2221",
			});
			expect(transferTargets[0]).toMatchObject({
				host: "old.example",
				username: "old-user",
				port: 2201,
				proxyJump: "old-jump.example:2221",
			});

			await fs.writeFile(
				configPath,
				[
					"Host live-alias",
					"  HostName refreshed-target.example",
					"  User refreshed-user",
					"  Port 2202",
					"  IdentityFile ~/.ssh/id_refreshed",
					"  ProxyJump ops@refreshed-jump.example:2222",
				].join("\n"),
			);
			const changedAt = new Date(Date.now() + 2_000);
			await fs.utimes(configPath, changedAt, changedAt);

			await commandTool!.execute("ssh-refreshed", { host: "live-alias", command: "true" });
			await transferTool!.execute("transfer-refreshed", {
				op: "upload",
				host: "live-alias",
				local_path: "fixture.bin",
				remote_path: "/tmp/fixture.bin",
			});

			const refreshedTarget = {
				host: "refreshed-target.example",
				username: "refreshed-user",
				port: 2202,
				keyPath: expect.stringContaining("id_refreshed"),
				proxyJump: "ops@refreshed-jump.example:2222",
			};
			expect(commandTargets[1]).toMatchObject(refreshedTarget);
			expect(transferTargets[1]).toMatchObject(refreshedTarget);
			expect(commandTool!.description).toContain("live-alias (refreshed-target.example)");
			expect(commandTool!.description).not.toContain("old.example");
			expect(transferTool!.description).toContain("live-alias (refreshed-target.example)");
			expect(transferTool!.description).not.toContain("old.example");
		} finally {
			homedirSpy.mockRestore();
			hostInfoSpy.mockRestore();
			executeSpy.mockRestore();
			prepareSpy.mockRestore();
			transferSpy.mockRestore();
		}
	});

	it("preserves configured passwords in mounted session aliases without exposing them in descriptions", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-xdev-password-");
		tempDirs.push(tempDir);
		const xdev = createTestXdevState();
		const session = createSession(tempDir.path(), { xdev });
		const password = "session-ssh-password-sentinel";
		await session.mutateSessionSshConfig({
			operation: "upsert",
			name: "prod",
			config: { host: "192.0.2.60", username: "root", password },
		});

		const hosts = await session.getSessionSshHosts();
		expect(hosts).toContainEqual(expect.objectContaining({ name: "prod", password }));
		expect(xdev.tools.get("ssh")?.description).toContain("prod (192.0.2.60)");
		expect(xdev.tools.get("ssh")?.description).not.toContain(password);
	});

	it("keeps mounted SSH devices tracked across tool repartitioning", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-xdev-repartition-");
		tempDirs.push(tempDir);
		const xdev = createTestXdevState();
		const session = createSession(tempDir.path(), { xdev });

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

		expect(xdev.tools.get("ssh")).toBeDefined();
		expect(xdev.tools.get("ssh_transfer")).toBeDefined();
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
		expect(session.getToolByName("ssh")?.description ?? "").not.toContain("staging");
		expect(session.getToolByName("ssh_transfer")?.description ?? "").not.toContain("staging");
		expect(session.agent.state.systemPrompt.join("\n")).not.toContain("staging (192.0.2.10)");
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

	it("rotates proxy jump connection and host-info identities across all session SSH consumers", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-proxy-jump-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();
		const session = createSession(cwd);
		const oldProxyJump = "jump-old.example:2201";
		const newProxyJump = "ops@jump-new.example:2202,jump-edge.example";
		const oldPassword = "old-target-password";
		await session.mutateSessionSshConfig({
			operation: "upsert",
			name: "prod",
			config: { host: "203.0.113.20", username: "deploy", password: oldPassword, proxyJump: oldProxyJump },
		});
		const oldSshTool = session.getToolByName("ssh");
		const oldTransferTool = session.getToolByName("ssh_transfer");
		const invalidateSpy = spyOn(connectionManager, "invalidateSshTarget").mockResolvedValue(undefined);
		try {
			await session.mutateSessionSshConfig({
				operation: "upsert",
				name: "prod",
				config: { host: "203.0.113.20", username: "deploy", password: oldPassword, proxyJump: newProxyJump },
			});

			expect(invalidateSpy).toHaveBeenCalledTimes(2);
			expect(invalidateSpy).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({ name: "prod", proxyJump: oldProxyJump }),
				{ invalidateHostInfo: true },
			);
			expect(invalidateSpy).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({ name: "prod", proxyJump: newProxyJump }),
				{ invalidateHostInfo: true },
			);

			const sshTool = session.getToolByName("ssh") as unknown as {
				hostsByName: ReadonlyMap<string, { proxyJump?: string }>;
			};
			const transferTool = session.getToolByName("ssh_transfer") as unknown as {
				hostsByName: ReadonlyMap<string, { proxyJump?: string }>;
			};
			expect(sshTool).not.toBe(oldSshTool);
			expect(transferTool).not.toBe(oldTransferTool);
			expect(sshTool.hostsByName.get("prod")?.proxyJump).toBe(newProxyJump);
			expect(transferTool.hostsByName.get("prod")?.proxyJump).toBe(newProxyJump);

			const refreshedHosts = await session.getSessionSshHosts();
			const statSpy = spyOn(fileTransfer, "statRemotePath").mockResolvedValue("file");
			const readSpy = spyOn(fileTransfer, "readRemoteFile").mockResolvedValue({
				bytes: new TextEncoder().encode("through refreshed proxy jump\n"),
				truncated: false,
			});
			try {
				await new SshProtocolHandler().resolve(parseInternalUrl("ssh://prod/tmp/proxy-jump.txt"), {
					cwd,
					sshHosts: refreshedHosts,
				});
				expect(readSpy).toHaveBeenCalledWith(
					expect.objectContaining({ name: "prod", proxyJump: newProxyJump }),
					"/tmp/proxy-jump.txt",
					expect.objectContaining({ maxBytes: 1024 * 1024 }),
				);
			} finally {
				statSpy.mockRestore();
				readSpy.mockRestore();
			}

			invalidateSpy.mockClear();
			await session.mutateSessionSshConfig({
				operation: "upsert",
				name: "prod",
				config: {
					host: "203.0.113.20",
					username: "deploy",
					password: "rotated-target-password",
					proxyJump: newProxyJump,
				},
			});
			expect(invalidateSpy).toHaveBeenCalledTimes(1);
			expect(invalidateSpy).toHaveBeenCalledWith(
				expect.objectContaining({ name: "prod", password: oldPassword, proxyJump: newProxyJump }),
				{ invalidateHostInfo: false },
			);
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
	it("publishes mounted SSH transfer background progress after the write call returns", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-transfer-progress-");
		tempDirs.push(tempDir);
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		const agentScopeId = "ssh-transfer-progress-scope";
		const agentId = "Main";
		const session = createSession(tempDir.path(), { asyncJobManager: manager, agentId, agentScopeId });
		const release = Promise.withResolvers<void>();
		const publishProgress = Promise.withResolvers<void>();
		const toolCallId = "mounted-ssh-transfer";
		const jobId = manager.register(
			"ssh_transfer",
			"upload fixture",
			async ({ jobId: runningJobId, reportProgress }) => {
				await publishProgress.promise;
				await reportProgress("50%", {
					operation: "upload",
					host: "fixture",
					localPath: "/tmp/blob.bin",
					remotePath: "/srv/blob.bin",
					status: "running",
					totalBytes: 100,
					transferredBytes: 50,
					percent: 50,
					bytesPerSecond: 25,
					averageBytesPerSecond: 25,
					elapsedMs: 2_000,
					async: { state: "running", jobId: runningJobId, type: "ssh_transfer" },
				});
				await release.promise;
				return "completed";
			},
			{ toolCallId, ownerId: agentId, scopeId: agentScopeId },
		);
		const events: AgentSessionEvent[] = [];
		const unsubscribe = session.subscribe(event => events.push(event));
		const published = waitForSessionEvent(
			session,
			event => event.type === "tool_execution_end" && event.toolCallId === toolCallId,
		);

		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId,
			toolName: "write",
			result: {
				content: [{ type: "text", text: "Background upload started." }],
				details: {
					xdev: {
						tool: "ssh_transfer",
						mode: "execute",
						args: {
							op: "upload",
							host: "fixture",
							local_path: "/tmp/blob.bin",
							remote_path: "/srv/blob.bin",
							async: true,
						},
						inner: { async: { state: "running", jobId, type: "ssh_transfer" } },
					},
				},
			},
		});

		await published;
		await Promise.resolve();
		expect(events.find(event => event.type === "async_job_update")).toMatchObject({
			type: "async_job_update",
			job: { id: jobId, toolCallId, type: "ssh_transfer", status: "running" },
		});
		const progressed = waitForSessionEvent(
			session,
			event => event.type === "async_job_update" && event.job.progress?.details?.transferredBytes === 50,
		);
		publishProgress.resolve();
		expect(await progressed).toMatchObject({
			type: "async_job_update",
			job: {
				id: jobId,
				progress: { details: { transferredBytes: 50, percent: 50 } },
			},
		});
		unsubscribe();

		release.resolve();
		await manager.getJob(jobId)?.promise;
	});
});
