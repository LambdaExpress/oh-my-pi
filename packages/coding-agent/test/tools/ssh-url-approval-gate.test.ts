import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type ExtensionRunner, ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as connectionManager from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import * as fileTransfer from "@oh-my-pi/pi-coding-agent/ssh/file-transfer";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type SSHToolDetails, SshTool } from "@oh-my-pi/pi-coding-agent/tools/ssh";
import { Snowflake } from "@oh-my-pi/pi-utils";

// Fixed SSH filesystem reads pass the production read gate. Mutations and
// arbitrary SSH commands still require exec approval before any transfer.
const BASE_SETTINGS = {
	"async.enabled": false,
	"bash.autoBackground.enabled": false,
	"bashInterceptor.enabled": false,
} as const;

const APPROVAL_RE = /requires approval but no interactive UI available/;

describe("SSH read and exec boundaries through the production approval wrapper", () => {
	let tempDir: string;
	let session: AgentSession;

	beforeAll(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-ssh-approval-${Snowflake.next()}-`));
		const cwd = path.join(tempDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		fs.writeFileSync(path.join(cwd, "local.txt"), "hello-local\n");
		const sessionManager = SessionManager.create(cwd, path.join(tempDir, "sessions"));
		const created = await createAgentSession({
			cwd,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated(BASE_SETTINGS),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] },
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "grep", "glob", "write", "edit"],
		});
		session = created.session;
	});

	afterAll(async () => {
		await session.dispose();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup; the OS reclaims the temp dir
		}
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function tool(name: "read" | "grep" | "glob" | "write" | "edit") {
		const found = session.getToolByName(name);
		if (!found) throw new Error(`Expected ${name} tool`);
		return found;
	}

	function ctx(approvalMode: "always-ask" | "write"): AgentToolContext {
		return {
			settings: Settings.isolated({ ...BASE_SETTINGS, "tools.approvalMode": approvalMode }),
		} as AgentToolContext;
	}

	it("read: fixed SSH and local reads run at read tier", async () => {
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("file");
		vi.spyOn(fileTransfer, "readRemoteFile").mockResolvedValue({
			bytes: new TextEncoder().encode("hello-remote\n"),
			truncated: false,
		});
		const remote = await tool("read").execute(
			"r-ssh",
			{ path: "ssh://localhost/etc/hostname" },
			undefined,
			undefined,
			ctx("always-ask"),
		);
		expect(JSON.stringify(remote.content)).toContain("hello-remote");
		const ok = await tool("read").execute("r-local", { path: "local.txt" }, undefined, undefined, ctx("always-ask"));
		expect(JSON.stringify(ok.content)).toContain("hello-local");
	});

	it("grep: mixed SSH and local paths run through read approval", async () => {
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("file");
		vi.spyOn(fileTransfer, "readRemoteFile").mockResolvedValue({
			bytes: new TextEncoder().encode("hello-remote\n"),
			truncated: false,
		});
		const ok = await tool("grep").execute(
			"s-mixed",
			{ pattern: "hello", path: "local.txt;ssh://localhost/etc/hosts" },
			undefined,
			undefined,
			ctx("always-ask"),
		);
		expect(JSON.stringify(ok.content)).toContain("hello-local");
		expect(JSON.stringify(ok.content)).toContain("hello-remote");
	});

	it("glob: mixed SSH and local file targets run through read approval", async () => {
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("file");
		vi.spyOn(fileTransfer, "readRemoteFile").mockResolvedValue({
			bytes: new TextEncoder().encode("remote file\n"),
			truncated: false,
		});
		const result = await tool("glob").execute(
			"glob-mixed",
			{ path: "ssh://localhost/tmp/evidence.json;local.txt" },
			undefined,
			undefined,
			ctx("always-ask"),
		);
		expect(JSON.stringify(result.content)).toContain("evidence.json");
		expect(JSON.stringify(result.content)).toContain("local.txt");
	});

	it("arbitrary SSH commands remain exec-gated before host probing", async () => {
		const probe = vi.spyOn(connectionManager, "ensureHostInfo").mockRejectedValue(new Error("must not probe"));
		const toolSession: ToolSession = {
			cwd: tempDir,
			hasUI: false,
			settings: Settings.isolated(BASE_SETTINGS),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		};
		const runner = {
			consumeToolCallEmitted: () => false,
			hasHandlers: () => false,
			hasUI: () => false,
		} as unknown as ExtensionRunner;
		const ssh = new ExtensionToolWrapper<SshTool["parameters"], SSHToolDetails>(
			new SshTool(
				toolSession,
				["fixture"],
				new Map([["fixture", { name: "fixture", host: "fixture.invalid" }]]),
				"fixture",
			),
			runner,
		);
		for (const command of ["touch /tmp/not-approved", "printf x > /tmp/not-approved", "rm /tmp/not-approved"]) {
			await expect(
				ssh.execute("ssh-command", { host: "fixture", command }, undefined, undefined, ctx("always-ask")),
			).rejects.toThrow(APPROVAL_RE);
		}
		expect(probe).not.toHaveBeenCalled();
	});

	it("write: ssh:// requires approval (exec), a local write runs (write tier, write mode)", async () => {
		await expect(
			tool("write").execute(
				"w-ssh",
				{ path: "ssh://localhost/tmp/x", content: "x" },
				undefined,
				undefined,
				ctx("write"),
			),
		).rejects.toThrow(APPROVAL_RE);
		const ok = await tool("write").execute(
			"w-local",
			{ path: "out.txt", content: "data\n" },
			undefined,
			undefined,
			ctx("write"),
		);
		expect(JSON.stringify(ok.content)).toContain("out.txt");
	});

	it("edit: ssh:// requires approval before transfer, local edit reaches write-tier execution", async () => {
		const writeSpy = vi.spyOn(fileTransfer, "writeRemoteFile").mockResolvedValue(undefined);
		const deleteSpy = vi.spyOn(fileTransfer, "deleteRemoteFile").mockResolvedValue(undefined);
		await expect(
			tool("edit").execute(
				"e-ssh",
				{ input: "[ssh://localhost/tmp/x#ABCD]\nREM" },
				undefined,
				undefined,
				ctx("write"),
			),
		).rejects.toThrow(APPROVAL_RE);
		expect(writeSpy).not.toHaveBeenCalled();
		expect(deleteSpy).not.toHaveBeenCalled();

		let localError: unknown;
		try {
			await tool("edit").execute(
				"e-local",
				{ input: "[local.txt]\nSWAP 1.=1:\n+HELLO" },
				undefined,
				undefined,
				ctx("write"),
			);
		} catch (error) {
			localError = error;
		}
		expect(String(localError)).not.toMatch(APPROVAL_RE);
	});
});
