import { afterEach, describe, expect, it, vi } from "bun:test";
import type { SSHConnectionTarget } from "../connection-manager";
import * as connectionManager from "../connection-manager";
import {
	deleteRemoteFile,
	listRemoteDir,
	moveRemoteFile,
	readRemoteFile,
	statRemotePath,
	writeRemoteFile,
} from "../file-transfer";

const POWERSHELL_PREFIX = "pwsh -NoProfile -NonInteractive -EncodedCommand ";

function decodePowerShellCommand(command: string): string {
	expect(command.startsWith(POWERSHELL_PREFIX)).toBe(true);
	return Buffer.from(command.slice(POWERSHELL_PREFIX.length), "base64").toString("utf16le");
}

describe("ssh file-transfer backend guard", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rejects a Windows remote without a verified PowerShell transfer backend", async () => {
		// Stub BOTH the connection and the host-info probe so the guard is reached
		// without opening a real SSH connection and before any command is spawned.
		const ensureConnectionSpy = vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		const ensureHostInfoSpy = vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 5,
			os: "windows",
			shell: "cmd",
			compatEnabled: false,
		});
		const buildSpy = vi
			.spyOn(connectionManager, "buildRemoteCommand")
			.mockRejectedValue(new Error("should-not-build-command"));
		const target: SSHConnectionTarget = { name: "winbox", host: "winbox" };
		await expect(readRemoteFile(target, "C:/x.txt", { maxBytes: 1024 })).rejects.toThrow(
			/without a verified PowerShell transfer backend/,
		);
		await expect(writeRemoteFile(target, "C:/x.txt", new Uint8Array([1]), {})).rejects.toThrow(
			/without a verified PowerShell transfer backend/,
		);
		await expect(deleteRemoteFile(target, "C:/x.txt", {})).rejects.toThrow(
			/without a verified PowerShell transfer backend/,
		);
		await expect(moveRemoteFile(target, "C:/x.txt", "C:/y.txt", {})).rejects.toThrow(
			/without a verified PowerShell transfer backend/,
		);
		await expect(statRemotePath(target, "C:/x.txt")).rejects.toThrow(
			/without a verified PowerShell transfer backend/,
		);
		await expect(listRemoteDir(target, "C:/")).rejects.toThrow(/without a verified PowerShell transfer backend/);
		// Prove the guard ran through the stubbed transport rather than failing early
		// for an unrelated reason (e.g. a future import refactor bypassing the mocks).
		expect(ensureConnectionSpy).toHaveBeenCalled();
		expect(ensureHostInfoSpy).toHaveBeenCalled();
		expect(buildSpy).not.toHaveBeenCalled();
	});

	it("dispatches Windows transfers through the verified PowerShell backend", async () => {
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 5,
			os: "windows",
			shell: "powershell",
			powerShellCommand: "pwsh",
			compatEnabled: false,
		});
		const buildSpy = vi
			.spyOn(connectionManager, "buildRemoteCommand")
			.mockRejectedValue(new Error("stop-before-spawn"));
		const target: SSHConnectionTarget = { name: "winps", host: "winps" };

		await expect(readRemoteFile(target, "C:/x.txt", { maxBytes: 1024 })).rejects.toThrow(/stop-before-spawn/);
		await expect(writeRemoteFile(target, "C:/x.txt", new Uint8Array([1]), {})).rejects.toThrow(/stop-before-spawn/);
		await expect(statRemotePath(target, "C:/x.txt")).rejects.toThrow(/stop-before-spawn/);
		await expect(listRemoteDir(target, "C:/")).rejects.toThrow(/stop-before-spawn/);
		await expect(deleteRemoteFile(target, "C:/x.txt", {})).rejects.toThrow(/stop-before-spawn/);
		await expect(moveRemoteFile(target, "C:/x.txt", "C:/y.txt", {})).rejects.toThrow(/stop-before-spawn/);

		const dispatches = buildSpy.mock.calls.map(call => call[1] as string);
		expect(dispatches).toHaveLength(6);
		for (const command of dispatches) {
			expect(command.startsWith(POWERSHELL_PREFIX)).toBe(true);
		}
		expect(buildSpy.mock.calls[1]?.[2]).toMatchObject({ allowStdin: true });
	});

	it("normalizes ssh URL drive paths only inside PowerShell transfer scripts", async () => {
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 5,
			os: "windows",
			shell: "powershell",
			powerShellCommand: "pwsh",
			compatEnabled: false,
		});
		const buildSpy = vi
			.spyOn(connectionManager, "buildRemoteCommand")
			.mockRejectedValue(new Error("stop-before-spawn"));
		const target: SSHConnectionTarget = { name: "winps", host: "winps" };

		await expect(readRemoteFile(target, "/C:/Users/me/a.txt", { maxBytes: 1024 })).rejects.toThrow(
			/stop-before-spawn/,
		);
		const driveScript = decodePowerShellCommand(buildSpy.mock.calls[0]?.[1] as string);
		expect(driveScript).toContain("$p = 'C:/Users/me/a.txt'");

		await expect(readRemoteFile(target, "/", { maxBytes: 1024 })).rejects.toThrow(/stop-before-spawn/);
		const rootScript = decodePowerShellCommand(buildSpy.mock.calls[1]?.[1] as string);
		expect(rootScript).toContain("$p = '/'");
	});

	it("rejects a non-Windows remote with no verified transferShell", async () => {
		// No transferShell means the capability probe never confirmed any of
		// sh/bash/zsh works. The guard refuses regardless of `shell` because the
		// real ssh:// contract is "did we verify a POSIX shell works", not
		// "what name did the login shell self-report" (#3719).
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 5,
			os: "linux",
			shell: "unknown",
			compatEnabled: false,
		});
		const target: SSHConnectionTarget = { name: "noshell", host: "noshell" };
		await expect(readRemoteFile(target, "/etc/hosts", { maxBytes: 1024 })).rejects.toThrow(/no verified POSIX shell/);
		await expect(writeRemoteFile(target, "/tmp/x", new Uint8Array([1]), {})).rejects.toThrow(
			/no verified POSIX shell/,
		);
		await expect(deleteRemoteFile(target, "/tmp/x", {})).rejects.toThrow(/no verified POSIX shell/);
		await expect(moveRemoteFile(target, "/tmp/x", "/tmp/y", {})).rejects.toThrow(/no verified POSIX shell/);
	});

	it("dispatches transfer commands through the verified transferShell, not the login shell", async () => {
		// The bug fix: if the login shell is fish/csh/tcsh, the legacy guard
		// would refuse the host — but allowing it isn't enough on its own.
		// OpenSSH still hands our snippets to `$SHELL -c`, so a fish login
		// shell would choke on `if [ … ]; then …`. Every transfer command
		// must be wrapped in `<transferShell> -c '…'` to force parsing
		// under the shell we verified can run it (#3719).
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 5,
			os: "linux",
			// Login shell is fish; only `transferShell` indicates a working POSIX shell.
			shell: "unknown",
			transferShell: "bash",
			compatEnabled: false,
		});
		const buildSpy = vi
			.spyOn(connectionManager, "buildRemoteCommand")
			.mockRejectedValue(new Error("stop-before-spawn"));
		const target: SSHConnectionTarget = { name: "fishbox", host: "fishbox" };

		await expect(readRemoteFile(target, "/etc/hosts", { maxBytes: 1024 })).rejects.toThrow(/stop-before-spawn/);
		await expect(writeRemoteFile(target, "/tmp/x", new Uint8Array([1]), {})).rejects.toThrow(/stop-before-spawn/);
		await expect(statRemotePath(target, "/etc/hosts")).rejects.toThrow(/stop-before-spawn/);
		await expect(listRemoteDir(target, "/etc")).rejects.toThrow(/stop-before-spawn/);
		await expect(deleteRemoteFile(target, "/tmp/x", {})).rejects.toThrow(/stop-before-spawn/);
		await expect(moveRemoteFile(target, "/tmp/x", "/tmp/y", {})).rejects.toThrow(/stop-before-spawn/);

		// Each dispatch must start with `bash -c '…'` and embed the original
		// POSIX snippet inside the quoted command. Read also drops `-n`
		// (allowStdin: true) because cat-staging needs stdin streaming.
		const dispatches = buildSpy.mock.calls.map(call => call[1] as string);
		expect(dispatches[0]).toMatch(/^bash -c '.*head -c 1025/);
		expect(dispatches[1]).toMatch(/^bash -c '.*cat > /);
		expect(buildSpy.mock.calls[1]?.[2]).toMatchObject({ allowStdin: true });
		expect(dispatches[2]).toMatch(/^bash -c '.*if \[ -d /);
		expect(dispatches[3]).toMatch(/^bash -c '.*LC_ALL=C ls -1Ap /);
		expect(dispatches[4]).toMatch(/^bash -c '.*rm -f -- /);
		expect(dispatches[5]).toMatch(/^bash -c '.*mv -- /);
	});

	it("uses sh -c when transferShell is sh (the most universal POSIX fallback)", async () => {
		// Belt-and-suspenders: the common happy path with a sh-family login
		// shell still routes through `sh -c` to keep one dispatch shape.
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 5,
			os: "linux",
			shell: "sh",
			transferShell: "sh",
			compatEnabled: false,
		});
		const buildSpy = vi
			.spyOn(connectionManager, "buildRemoteCommand")
			.mockRejectedValue(new Error("stop-before-spawn"));
		const target: SSHConnectionTarget = { name: "shbox", host: "shbox" };

		await expect(readRemoteFile(target, "/etc/hosts", { maxBytes: 1024 })).rejects.toThrow(/stop-before-spawn/);
		expect(buildSpy.mock.calls[0]?.[1]).toMatch(/^sh -c '.*head -c 1025/);
	});
});
