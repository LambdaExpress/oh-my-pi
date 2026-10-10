import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as capability from "@oh-my-pi/pi-coding-agent/capability";
import type { SSHHost } from "@oh-my-pi/pi-coding-agent/capability/ssh";
import type { CapabilityResult } from "@oh-my-pi/pi-coding-agent/capability/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { canonicalSshResourceKey, InternalUrlRouter, parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls";
import * as fileTransfer from "@oh-my-pi/pi-coding-agent/ssh/file-transfer";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const HASHLINE_HEADER = /^\[(ssh:\/\/icaro\/tmp\/app\.ts)#([0-9A-F]{4})\]/m;

function createSession(sshHosts?: readonly SSHHost[]): ToolSession {
	const settings = Settings.isolated();
	settings.set("read.summarize.enabled", false);
	return {
		cwd: os.tmpdir(),
		hasEditTool: true,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
		getSessionSshHosts: sshHosts ? async () => sshHosts : undefined,
	};
}

function textOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(content => content.type === "text")
		.map(content => content.text ?? "")
		.join("\n");
}

describe("read ssh:// hashline snapshots", () => {
	let settingsState: SettingsTestState | undefined;

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		await Settings.init({ inMemory: true });
		InternalUrlRouter.resetForTests();
	});

	afterEach(() => {
		InternalUrlRouter.resetForTests();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});

	it("records the canonical remote snapshot and recovers a stale hashline anchor", async () => {
		vi.spyOn(capability, "loadCapability").mockResolvedValue({
			items: [],
			all: [],
			warnings: [],
			providers: [],
		} as CapabilityResult<unknown>);
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("file");
		let remoteText = "one\ntwo\nthree\n";
		vi.spyOn(fileTransfer, "readRemoteFile").mockImplementation(async () => ({
			bytes: new TextEncoder().encode(remoteText),
			truncated: false,
		}));
		vi.spyOn(fileTransfer, "writeRemoteFile").mockImplementation(async (_target, _remotePath, bytes) => {
			remoteText = new TextDecoder().decode(bytes);
		});
		const session = createSession();
		const readResult = await new ReadTool(session).execute("read", { path: "ssh://icaro/tmp/app.ts:1-2" });
		const output = textOutput(readResult);
		const header = HASHLINE_HEADER.exec(output);
		const tag = header?.[2];

		expect(header?.[1]).toBe("ssh://icaro/tmp/app.ts");
		expect(tag).toBeDefined();
		expect(readResult.details?.resolvedPath).toBeUndefined();
		expect(readResult.details?.meta?.source).toEqual({ type: "internal", value: "ssh://icaro/tmp/app.ts" });

		remoteText = `inserted\n${remoteText}`;
		const editResult = await new EditTool(session, "hashline").execute("edit", {
			input: `[ssh://icaro/tmp/app.ts#${tag}]\nPUT 2.=2:\n+TWO`,
		});

		expect(editResult.isError).not.toBe(true);
		expect(remoteText).toBe("inserted\none\nTWO\nthree\n");
	});

	it("uses the session host snapshot while keeping credentials out of canonical keys and output", async () => {
		const password = "hashline-session-password-sentinel";
		const host: SSHHost = {
			name: "ephemeral",
			connectionId: "session-revision",
			host: "192.0.2.60",
			username: "deploy",
			password,
			_source: {
				provider: "ssh-session",
				providerName: "Session SSH",
				level: "user",
				path: "session://session-1/revision-1",
			},
		};
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("file");
		vi.spyOn(fileTransfer, "readRemoteFile").mockImplementation(async target => {
			if (
				target.host !== host.host ||
				target.username !== host.username ||
				target.password !== password ||
				target.connectionId !== host.connectionId
			) {
				throw new Error("Remote authentication rejected");
			}
			return {
				bytes: new TextEncoder().encode("export const value = 1;\n"),
				truncated: false,
			};
		});
		const session = createSession([host]);
		const result = await new ReadTool(session).execute("call", { path: "ssh://ephemeral/tmp/app.ts" });
		const output = textOutput(result);
		const canonicalKey = canonicalSshResourceKey(parseInternalUrl("ssh://ephemeral/tmp/app.ts"));

		expect(result.isError).not.toBe(true);
		expect(output).toContain("export const value = 1;");
		expect(output).toContain("[ssh://ephemeral/tmp/app.ts#");
		expect(output).not.toContain(password);
		expect(canonicalKey).toBe("ssh://ephemeral/tmp/app.ts");
		expect(canonicalKey).not.toContain(password);
		expect(JSON.stringify(result)).not.toContain(password);
	});
});
