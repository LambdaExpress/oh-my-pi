import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GlobTool } from "@oh-my-pi/pi-coding-agent/tools/glob";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { resolveToolSearchScope } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import * as capability from "../../src/capability";
import type { SSHHost } from "../../src/capability/ssh";
import type { CapabilityResult, SourceMeta } from "../../src/capability/types";
import * as fileTransfer from "../../src/ssh/file-transfer";

const SOURCE: SourceMeta = {
	provider: "ssh-json",
	providerName: "SSH Config",
	path: "/test/ssh.json",
	level: "user",
};

function createTestToolSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function sshHost(name: string, proxyJump: string, level: SourceMeta["level"] = "session"): SSHHost {
	return {
		_source: {
			...SOURCE,
			provider: level === "session" ? "ssh-session" : SOURCE.provider,
			providerName: level === "session" ? "Session SSH" : SOURCE.providerName,
			path: level === "session" ? "session://test/revision-1" : SOURCE.path,
			level,
		},
		name,
		host: `${name}.internal`,
		username: "deploy",
		proxyJump,
	};
}

function mockPersistentHosts(hosts: SSHHost[]): void {
	const result: CapabilityResult<SSHHost> = {
		items: hosts,
		all: hosts,
		warnings: [],
		providers: hosts.length ? ["ssh-json"] : [],
	};
	vi.spyOn(capability, "loadCapability").mockResolvedValue(result as CapabilityResult<unknown>);
}

// `glob`, `ast_grep`, and `ast_edit` resolve internal URLs at read/write tier and
// do NOT share the exec-tier approval `read`/`grep`/`write` got for ssh://. They
// also can never produce a backing file for ssh://, so they must reject it BEFORE
// `InternalUrlRouter.resolve` — which is the point that opens the outbound SSH
// connection. The security contract these tests defend: those lower-tier tools
// never call `resolve` (never connect) for an ssh:// path.
describe("ssh:// is rejected before any connection in read/write-tier tools", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("resolveToolSearchScope (ast_grep + ast_edit) throws on ssh:// without resolving", async () => {
		// Reject if resolve is ever reached, so a guard regression fails loudly
		// instead of attempting a real connection.
		const spy = vi
			.spyOn(InternalUrlRouter.instance(), "resolve")
			.mockRejectedValue(new Error("resolve must not run for ssh://"));
		for (const internalUrlAction of ["search", "rewrite"]) {
			await expect(
				resolveToolSearchScope({ rawPaths: ["ssh://h/x"], cwd: os.tmpdir(), internalUrlAction }),
			).rejects.toThrow(/use `grep` on a specific remote file/);
		}
		expect(spy).not.toHaveBeenCalled();
	});

	it("glob throws on ssh:// without resolving", async () => {
		const spy = vi
			.spyOn(InternalUrlRouter.instance(), "resolve")
			.mockRejectedValue(new Error("resolve must not run for ssh://"));
		const tool = new GlobTool(createTestToolSession(os.tmpdir()));
		await expect(tool.execute("f", { path: "ssh://h/x" })).rejects.toThrow(/ssh:\/\//);
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("ssh:// ProxyJump survives ungated tool routing", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("passes a session alias ProxyJump through ReadTool and the internal URL router", async () => {
		const proxyJump = "jump-user@bastion.example:2200,edge";
		const host = sshHost("session-read", proxyJump);
		const session = createTestToolSession(os.tmpdir(), {
			getSessionSshHosts: async () => [host],
		});
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("file");
		const readSpy = vi
			.spyOn(fileTransfer, "readRemoteFile")
			.mockResolvedValue({ bytes: new TextEncoder().encode("remote text\n"), truncated: false });

		await new ReadTool(session).execute("read-proxy-jump", {
			path: "ssh://session-read/tmp/example.txt",
		});

		expect(readSpy.mock.calls[0]?.[0]).toMatchObject({
			name: "session-read",
			host: "session-read.internal",
			proxyJump,
		});
	});

	it("passes a session alias ProxyJump through WriteTool and the internal URL router", async () => {
		const proxyJump = "bastion-a,bastion-b";
		const host = sshHost("session-write", proxyJump);
		const session = createTestToolSession(os.tmpdir(), {
			getSessionSshHosts: async () => [host],
		});
		const writeSpy = vi.spyOn(fileTransfer, "writeRemoteFile").mockResolvedValue(undefined);

		await new WriteTool(session).execute("write-proxy-jump", {
			path: "ssh://session-write/tmp/example.txt",
			content: "remote text\n",
		});

		expect(writeSpy.mock.calls[0]?.[0]).toMatchObject({
			name: "session-write",
			host: "session-write.internal",
			proxyJump,
		});
	});

	it("passes a persistent alias ProxyJump through GrepTool and the internal URL router", async () => {
		const proxyJump = "ops@bastion.example";
		mockPersistentHosts([sshHost("persistent-grep", proxyJump, "user")]);
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("file");
		const readSpy = vi.spyOn(fileTransfer, "readRemoteFile").mockResolvedValue({
			bytes: new TextEncoder().encode("before\nremote needle\nafter\n"),
			truncated: false,
		});

		await new GrepTool(createTestToolSession(os.tmpdir())).execute("grep-proxy-jump", {
			path: "ssh://persistent-grep/tmp/example.txt",
			pattern: "needle",
		});

		expect(readSpy.mock.calls[0]?.[0]).toMatchObject({
			name: "persistent-grep",
			host: "persistent-grep.internal",
			proxyJump,
		});
	});
});
