import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { SSHHost } from "@oh-my-pi/pi-coding-agent/capability/ssh";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { isReadOnlyAgent } from "@oh-my-pi/pi-coding-agent/task";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as piUtils from "@oh-my-pi/pi-utils";

function agentByName(agents: AgentDefinition[], name: string): AgentDefinition {
	const agent = agents.find(candidate => candidate.name === name);
	expect(agent).toBeDefined();
	return agent as AgentDefinition;
}

describe("task agent capability descriptions", () => {
	it("classifies bundled scout as the only read-only delegated agent", () => {
		const agents = loadBundledAgents();

		expect(isReadOnlyAgent(agentByName(agents, "scout"))).toBe(true);
		for (const name of ["task", "sonic", "reviewer"]) {
			expect(isReadOnlyAgent(agentByName(agents, name))).toBe(false);
		}
	});

	it("keeps `wait` read-only while any exec-tier tool disqualifies the agent", () => {
		const scout = agentByName(loadBundledAgents(), "scout");

		expect(isReadOnlyAgent({ ...scout, tools: ["read", "grep", "wait", "yield"] })).toBe(true);
		expect(isReadOnlyAgent({ ...scout, tools: ["read", "grep", "wait", "bash"] })).toBe(false);
	});
});

describe("bundled scout capability boundaries", () => {
	let tempDir: TempDir;
	let settings: Settings;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-scout-capabilities-");
		settings = Settings.isolated({ "tools.xdev": true, "lsp.enabled": true, "astGrep.enabled": false });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		settings.cancelPendingSaves();
		tempDir.removeSync();
	});

	function scoutSession(enableLsp = true): ToolSession {
		const host: SSHHost = {
			name: "RemoteEvidence",
			host: "192.0.2.10",
			username: "reader",
			_source: {
				provider: "test",
				providerName: "Test",
				level: "project",
				path: tempDir.join("ssh.json"),
			},
		};
		return {
			cwd: tempDir.path(),
			hasUI: false,
			settings,
			taskDepth: 1,
			skipPythonPreflight: true,
			enableLsp,
			lspReadOnly: isReadOnlyAgent(agentByName(loadBundledAgents(), "scout")),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => tempDir.path(),
			getSessionSshHosts: async () => [host],
			discoverLocalWslTargets: async () => [],
		};
	}

	function text(result: { content: Array<{ type: string; text?: string }> }): string {
		return result.content.flatMap(block => (block.type === "text" ? [block.text ?? ""] : [])).join("\n");
	}

	function forbidExternalProcesses() {
		const fail = () => {
			throw new Error("Unexpected external process in a read-only capability check");
		};
		return {
			spawn: vi.spyOn(piUtils.ptree, "spawn").mockImplementation(fail),
			exec: vi.spyOn(piUtils.ptree, "exec").mockImplementation(fail),
		};
	}

	it("discovers enabled LSP navigation but rejects every mutable LSP operation through the write router", async () => {
		const scout = agentByName(loadBundledAgents(), "scout");
		const session = scoutSession();
		const source = "export const source = 1;\n";
		await Bun.write(tempDir.join("source.ts"), source);
		const tools = await createTools(session, scout.tools);
		const read = tools.find(tool => tool.name === "read")!;
		const write = tools.find(tool => tool.name === "write")!;

		expect(text(await read.execute("lsp-schema", { path: "xd://lsp" }))).toContain('"references"');
		const external = forbidExternalProcesses();
		for (const action of ["rename", "rename_file", "code_actions", "reload", "request"]) {
			const result = await write.execute(`lsp-${action}`, {
				path: "xd://lsp",
				content: JSON.stringify({ action, file: "source.ts", line: 1, symbol: "source", new_name: "changed" }),
			});
			expect(result.isError).toBe(true);
		}
		expect(external.spawn).not.toHaveBeenCalled();
		expect(external.exec).not.toHaveBeenCalled();
		expect(await Bun.file(tempDir.join("source.ts")).text()).toBe(source);
		expect(await Bun.file(path.join(tempDir.path(), "changed")).exists()).toBe(false);
	});

	it("does not mistake configured SSH aliases for command execution or workspace-write capabilities", async () => {
		const scout = agentByName(loadBundledAgents(), "scout");
		const session = scoutSession(false);
		const tools = await createTools(session, scout.tools);
		const read = tools.find(tool => tool.name === "read")!;
		const write = tools.find(tool => tool.name === "write")!;

		expect(text(await read.execute("ssh-aliases", { path: "ssh://" }))).toContain("RemoteEvidence");
		const external = forbidExternalProcesses();
		await expect(read.execute("ssh-schema", { path: "xd://ssh" })).rejects.toThrow();
		await expect(read.execute("lsp-schema", { path: "xd://lsp" })).rejects.toThrow();
		const sshResult = await write.execute("ssh-exec", {
			path: "xd://ssh",
			content: JSON.stringify({ host: "RemoteEvidence", command: "hostname" }),
		});
		expect(sshResult.isError).toBe(true);
		await expect(
			write.execute("remote-write", { path: "ssh://RemoteEvidence/tmp/report.txt", content: "not allowed" }),
		).rejects.toThrow();
		await expect(write.execute("workspace-write", { path: "report.txt", content: "not allowed" })).rejects.toThrow();
		expect(external.spawn).not.toHaveBeenCalled();
		expect(external.exec).not.toHaveBeenCalled();
		expect(await Bun.file(tempDir.join("report.txt")).exists()).toBe(false);

		await write.execute("scratch-write", { path: "local://report.txt", content: "local research evidence" });
		expect(text(await read.execute("scratch-read", { path: "local://report.txt:raw" }))).toBe(
			"local research evidence",
		);
	});
});
