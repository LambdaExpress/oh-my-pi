import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { InternalUrlFilesystem } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
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
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

let settingsState: SettingsTestState | undefined;

beforeEach(() => {
	settingsState = beginSettingsTest();
});

afterEach(() => {
	vi.restoreAllMocks();
	InternalUrlRouter.resetForTests();
	restoreSettingsTestState(settingsState);
});

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

describe("URL filesystem preserves capability boundaries", () => {
	it("rejects exec-only schemes before resolution and SSH rewrites before transfer", async () => {
		const router = InternalUrlRouter.instance();
		const resolve = vi.fn(async () => {
			throw new Error("exec-only resolve must not run at read tier");
		});
		router.register({
			scheme: "exec-only",
			spec: { backing: "remote", selectors: "none", immutable: true, readTier: "exec" },
			resolve,
		});
		const spy = vi
			.spyOn(router, "resolve")
			.mockRejectedValue(new Error("resolve must not run before capability validation"));
		await expect(
			resolveToolSearchScope({
				rawPaths: ["exec-only://h/x"],
				cwd: os.tmpdir(),
				internalUrlAction: "search",
				filesystem: new InternalUrlFilesystem({ context: {}, tier: "read" }),
			}),
		).rejects.toThrow(/exec-only:\/\/ access needs exec approval/);
		await expect(
			resolveToolSearchScope({
				rawPaths: ["ssh://h/x"],
				cwd: os.tmpdir(),
				internalUrlAction: "rewrite",
				filesystem: new InternalUrlFilesystem({ context: {}, tier: "write" }),
				fileWritableOnly: true,
			}),
		).rejects.toThrow("Cannot rewrite ssh://h/x: ssh:// URLs are not editable files");
		expect(spy).not.toHaveBeenCalled();
		expect(resolve).not.toHaveBeenCalled();
	});

	it("globs SSH paths through fixed read-only operations at read tier", async () => {
		mockPersistentHosts([]);
		const statSpy = vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("file");
		vi.spyOn(fileTransfer, "readRemoteFile").mockResolvedValue({
			bytes: new TextEncoder().encode("remote file\n"),
			truncated: false,
		});
		const tool = new GlobTool(createTestToolSession(os.tmpdir()));
		const result = await tool.execute("f", { path: "ssh://h/x" });
		expect(result.details?.files).toEqual(["ssh://h/x"]);
		expect(statSpy.mock.calls[0]?.[1]).toBe("/x");
	});
});

describe("ssh:// ProxyJump survives ungated tool routing", () => {
	it("reads the session alias content instead of a same-name persistent destination", async () => {
		const proxyJump = "jump-user@bastion.example:2200,edge";
		const host = sshHost("session-read", proxyJump);
		const persistentHost = { ...sshHost("session-read", "persistent-bastion", "user"), host: "persistent.internal" };
		mockPersistentHosts([persistentHost]);
		const session = createTestToolSession(os.tmpdir(), {
			getSessionSshHosts: async () => [host],
		});
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("file");
		vi.spyOn(fileTransfer, "readRemoteFile").mockImplementation(async target => ({
			bytes: new TextEncoder().encode(
				target.host === host.host && target.proxyJump === proxyJump
					? "session-only document\n"
					: "wrong destination document\n",
			),
			truncated: false,
		}));

		const result = await new ReadTool(session).execute("read-proxy-jump", {
			path: "ssh://session-read/tmp/example.txt",
		});
		const text = result.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n");
		expect(text).toContain("session-only document");
		expect(text).not.toContain("wrong destination document");
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
