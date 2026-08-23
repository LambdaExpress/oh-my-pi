import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as connectionManager from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import { formatSshHostEntry } from "@oh-my-pi/pi-coding-agent/tools/ssh-hosts";
import { ptree, removeWithRetries } from "@oh-my-pi/pi-utils";

async function withLooseKey<T>(run: (keyPath: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ssh-key-"));
	const keyPath = path.join(dir, "id_ed25519");
	await Bun.write(keyPath, "dummy-key");
	await fs.chmod(keyPath, 0o666);
	try {
		return await run(keyPath);
	} finally {
		await removeWithRetries(dir);
	}
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

function expectArgsNotToContain(args: string[], secret: string) {
	expect(args.join("\u0000")).not.toContain(secret);
}

describe("buildRemoteCommand", () => {
	it("includes -n, BatchMode=yes, and OpenSSH ControlMaster options on Unix-like platforms without a password", async () => {
		const args = await connectionManager.buildRemoteCommand(
			{
				name: "host",
				host: "192.168.3.146",
			},
			"ls -la",
			{ platform: "linux" },
		);

		expect(args[0]).toBe("-n");
		expect(args).toContain("ControlMaster=auto");
		expect(args).toContain("BatchMode=yes");
		expect(args).not.toContain("BatchMode=no");
		expect(args).not.toContain("NumberOfPasswordPrompts=1");
		expect(args.at(-2)).toBe("192.168.3.146");
		expect(args.at(-1)).toBe("ls -la");
	});

	it("uses one password prompt without putting the configured password in ssh argv", async () => {
		const password = "s3cr3t-value";
		const args = await connectionManager.buildRemoteCommand(
			{
				name: "pw",
				host: "192.0.2.1",
				username: "root",
				password,
			},
			"true",
			{ platform: "linux" },
		);

		expect(args).toContain("BatchMode=no");
		expect(args).toContain("NumberOfPasswordPrompts=1");
		expect(args).not.toContain("BatchMode=yes");
		expect(args.at(-2)).toBe("root@192.0.2.1");
		expect(args.at(-1)).toBe("true");
		expectArgsNotToContain(args, password);
	});

	it("omits OpenSSH ControlMaster options on Windows", async () => {
		const args = await connectionManager.buildRemoteCommand(
			{
				name: "host",
				host: "192.168.3.146",
			},
			"ls -la",
			{ platform: "win32" },
		);

		expect(args[0]).toBe("-n");
		expect(args).not.toContain("ControlMaster=auto");
		expect(args.some(arg => arg.startsWith("ControlPath="))).toBe(false);
		expect(args).not.toContain("ControlPersist=3600");
		expect(args).toContain("BatchMode=yes");
		expect(args.at(-2)).toBe("192.168.3.146");
		expect(args.at(-1)).toBe("ls -la");
	});

	it("skips Unix mode-bit key validation for Windows args", async () => {
		await withLooseKey(async keyPath => {
			const args = await connectionManager.buildRemoteCommand(
				{
					name: "host",
					host: "192.168.3.146",
					keyPath,
				},
				"ls -la",
				{ platform: "win32" },
			);

			expect(args).toContain("-i");
			expect(args).toContain(keyPath);
			expect(args.at(-2)).toBe("192.168.3.146");
			expect(args.at(-1)).toBe("ls -la");
		});
	});

	it("keeps identity file argv for password hosts without leaking the configured password", async () => {
		await withLooseKey(async keyPath => {
			const password = "s3cr3t-value";
			const args = await connectionManager.buildRemoteCommand(
				{
					name: "pw-key",
					host: "192.0.2.1",
					username: "root",
					keyPath,
					password,
				},
				"true",
				{ platform: "win32" },
			);

			expect(args).toContain("-i");
			expect(args).toContain(keyPath);
			expect(args).toContain("BatchMode=no");
			expect(args).toContain("NumberOfPasswordPrompts=1");
			expect(args.at(-2)).toBe("root@192.0.2.1");
			expect(args.at(-1)).toBe("true");
			expectArgsNotToContain(args, password);
		});
	});

	it("builds an askpass invocation without leaking the configured password to argv or script contents", async () => {
		const password = "s3cr3t-value";
		const invocation = await connectionManager.buildRemoteCommandInvocation(
			{
				name: "pw",
				host: "192.0.2.1",
				username: "root",
				password,
			},
			"true",
			{ platform: "linux" },
		);
		const askpassPath = invocation.env?.SSH_ASKPASS;
		if (!askpassPath) {
			throw new Error("buildRemoteCommandInvocation did not provide SSH_ASKPASS");
		}
		const askpassDir = path.dirname(askpassPath);

		try {
			expect(invocation.env?.OMP_SSH_PASSWORD).toBe(password);
			expect(invocation.env?.SSH_ASKPASS_REQUIRE).toBe("force");
			expect(await pathExists(askpassPath)).toBe(true);
			expect(invocation.args.at(-2)).toBe("root@192.0.2.1");
			expect(invocation.args.at(-1)).toBe("true");
			expectArgsNotToContain(invocation.args, password);

			const scriptContents = await fs.readFile(askpassPath, "utf8");
			expect(scriptContents).toContain("OMP_SSH_PASSWORD");
			expect(scriptContents).not.toContain(password);
		} finally {
			await invocation.cleanup?.();
		}

		expect(await pathExists(askpassDir)).toBe(false);
	});

	it("still rejects missing identity files on Windows args", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ssh-key-"));
		const keyPath = path.join(dir, "missing_id_ed25519");
		try {
			await expect(
				connectionManager.buildRemoteCommand(
					{
						name: "host",
						host: "192.168.3.146",
						keyPath,
					},
					"ls -la",
					{ platform: "win32" },
				),
			).rejects.toThrow("SSH key not found");
		} finally {
			await removeWithRetries(dir);
		}
	});

	it("still rejects directory identity paths on Windows args", async () => {
		const keyPath = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ssh-key-"));
		try {
			await expect(
				connectionManager.buildRemoteCommand(
					{
						name: "host",
						host: "192.168.3.146",
						keyPath,
					},
					"ls -la",
					{ platform: "win32" },
				),
			).rejects.toThrow("SSH key is not a file");
		} finally {
			await removeWithRetries(keyPath);
		}
	});

	it("rejects group/world-readable identity files on Unix-like platforms", async () => {
		await withLooseKey(async keyPath => {
			await expect(
				connectionManager.buildRemoteCommand(
					{
						name: "host",
						host: "192.168.3.146",
						keyPath,
					},
					"ls -la",
					{ platform: "linux" },
				),
			).rejects.toThrow("SSH key permissions must be 600 or stricter");
		});
	});
});

describe("SSH connection identities", () => {
	it("separates same-name targets by session revision and ControlMaster path", () => {
		const first = {
			name: "shared",
			connectionId: "session-a/revision-1",
			host: "192.0.2.100",
			username: "deploy",
			port: 2222,
		};
		const second = { ...first, connectionId: "session-b/revision-1" };
		expect(connectionManager.getSshConnectionKey(first)).not.toBe(connectionManager.getSshConnectionKey(second));
		expect(connectionManager.getControlPath(first)).not.toBe(connectionManager.getControlPath(second));
	});

	it("shares host-info only for the same non-secret remote identity", () => {
		const first = {
			name: "one",
			connectionId: "session-a/revision-1",
			host: "EXAMPLE.com",
			username: "deploy",
			port: 22,
			keyPath: "/keys/one",
			password: "first-secret",
			compat: false,
		};
		const sameRemote = {
			...first,
			name: "two",
			connectionId: "session-b/revision-9",
			host: "example.COM",
			keyPath: "/keys/two",
			password: "second-secret",
		};
		expect(connectionManager.getSshHostInfoKey(first)).toBe(connectionManager.getSshHostInfoKey(sameRemote));
		expect(connectionManager.getSshHostInfoKey(first)).not.toBe(
			connectionManager.getSshHostInfoKey({ ...sameRemote, port: 2222 }),
		);
		expect(connectionManager.getSshHostInfoKey(first)).not.toBe(
			connectionManager.getSshHostInfoKey({ ...sameRemote, username: "other" }),
		);
	});

	it("keeps passwords out of identity keys, ControlMaster paths, and argv", async () => {
		const password = "connection-identity-password-sentinel";
		const target = {
			name: "secret",
			connectionId: "session-a/revision-1",
			host: "192.0.2.101",
			username: "deploy",
			password,
		};
		const connectionKey = connectionManager.getSshConnectionKey(target);
		const hostInfoKey = connectionManager.getSshHostInfoKey(target);
		const controlPath = connectionManager.getControlPath(target);
		const args = await connectionManager.buildRemoteCommand(target, "true", { platform: "linux" });
		for (const value of [connectionKey, hostInfoKey, controlPath, ...args]) expect(value).not.toContain(password);
		expect(args).toContain(`ControlPath=${controlPath}`);
	});

	it("does not use password changes as cache identity while revision changes still isolate connections", () => {
		const original = {
			name: "shared",
			connectionId: "session-a/revision-1",
			host: "192.0.2.102",
			password: "old-password",
		};
		expect(connectionManager.getSshConnectionKey(original)).toBe(
			connectionManager.getSshConnectionKey({ ...original, password: "new-password" }),
		);
		expect(connectionManager.getSshConnectionKey(original)).not.toBe(
			connectionManager.getSshConnectionKey({
				...original,
				connectionId: "session-a/revision-2",
				password: "new-password",
			}),
		);
	});

	it("settles an invalidated pending target without reviving it or deleting a replacement pending entry", async () => {
		const releaseOldProbe = Promise.withResolvers<void>();
		const execSpy = vi.spyOn(ptree, "exec").mockImplementation(async command => {
			if (command.includes("old.example")) await releaseOldProbe.promise;
			const remoteCommand = command.at(-1) ?? "";
			if (command.includes("-O") && command.includes("check")) {
				return { exitCode: 1, stdout: "", stderr: "no existing master" } as never;
			}
			if (remoteCommand.includes(connectionManager.HOST_PROBE_MARKER)) {
				return {
					exitCode: 0,
					stdout: `${connectionManager.HOST_PROBE_MARKER}linux-gnu|/bin/bash|5.2`,
					stderr: "",
				} as never;
			}
			if (remoteCommand.includes(connectionManager.TRANSFER_PROBE_MARKER)) {
				return {
					exitCode: 0,
					stdout: `${connectionManager.TRANSFER_PROBE_MARKER}Linux`,
					stderr: "",
				} as never;
			}
			return { exitCode: 0, stdout: "", stderr: "" } as never;
		});
		const oldTarget = {
			name: "shared",
			connectionId: `race-old-${crypto.randomUUID()}`,
			host: "old.example",
		};
		const newTarget = {
			name: "shared",
			connectionId: `race-new-${crypto.randomUUID()}`,
			host: "new.example",
		};
		const oldKey = connectionManager.getSshConnectionKey(oldTarget);
		const newKey = connectionManager.getSshConnectionKey(newTarget);

		try {
			const oldConnection = connectionManager.ensureConnection(oldTarget);
			expect(connectionManager._sshConnectionStateForTests.snapshot().pendingKeys).toContain(oldKey);
			const invalidation = connectionManager.invalidateSshTarget(oldTarget);
			const newConnection = connectionManager.ensureConnection(newTarget);
			await newConnection;
			expect(connectionManager._sshConnectionStateForTests.snapshot().activeKeys).toContain(newKey);

			releaseOldProbe.resolve();
			await oldConnection;
			await invalidation;
			const settled = connectionManager._sshConnectionStateForTests.snapshot();
			expect(settled.pendingKeys).not.toContain(oldKey);
			expect(settled.pendingKeys).not.toContain(newKey);
			expect(settled.activeKeys).not.toContain(oldKey);
			expect(settled.activeKeys).toContain(newKey);
		} finally {
			releaseOldProbe.resolve();
			await connectionManager.invalidateSshTarget(oldTarget, { invalidateHostInfo: true });
			await connectionManager.invalidateSshTarget(newTarget, { invalidateHostInfo: true });
			execSpy.mockRestore();
		}
	});
});

describe("supportsSshControlMaster", () => {
	it("disables OpenSSH connection multiplexing on native Windows", () => {
		expect(connectionManager.supportsSshControlMaster("win32")).toBe(false);
	});

	it("keeps OpenSSH connection multiplexing on Unix-like platforms", () => {
		expect(connectionManager.supportsSshControlMaster("linux")).toBe(true);
		expect(connectionManager.supportsSshControlMaster("darwin")).toBe(true);
	});
});

describe("SSH login shell detection", () => {
	it("distinguishes a PowerShell 7 login shell from a Windows host that only has pwsh installed", async () => {
		const source = { provider: "test", providerName: "Test", path: "test://ssh", level: "session" as const };
		const powerShellTarget = {
			name: `powershell-login-${crypto.randomUUID()}`,
			host: `powershell-login-${crypto.randomUUID()}.example`,
			compat: false,
			_source: source,
		};
		const unknownShellTarget = {
			name: `unknown-login-${crypto.randomUUID()}`,
			host: `unknown-login-${crypto.randomUUID()}.example`,
			compat: false,
			_source: source,
		};
		let loginShellIsPowerShell = true;
		const execSpy = vi.spyOn(ptree, "exec").mockImplementation(async command => {
			const remoteCommand = command.at(-1) ?? "";
			if (remoteCommand.includes(connectionManager.HOST_PROBE_MARKER)) {
				return {
					exitCode: 0,
					stdout: `${connectionManager.HOST_PROBE_MARKER}%OS%|%COMSPEC%|`,
					stderr: "Out-File: Could not find a part of the path 'C:\\dev\\null'.",
				} as never;
			}
			if (remoteCommand.includes(connectionManager.TRANSFER_PROBE_MARKER)) {
				return { exitCode: 1, stdout: "", stderr: "not a POSIX login shell" } as never;
			}
			if (remoteCommand.includes("-EncodedCommand")) {
				return {
					exitCode: 0,
					stdout: `${connectionManager.POWERSHELL_PROBE_MARKER}Win32NT`,
					stderr: "",
				} as never;
			}
			if (remoteCommand.includes("PI_POWERSHELL_LOGIN|")) {
				return loginShellIsPowerShell
					? ({ exitCode: 0, stdout: "PI_POWERSHELL_LOGIN|", stderr: "" } as never)
					: ({ exitCode: 1, stdout: "", stderr: "not PowerShell syntax" } as never);
			}
			return { exitCode: 1, stdout: "", stderr: "unexpected probe" } as never;
		});

		try {
			const info = await connectionManager._sshHelpersForTests.probeHostInfo(powerShellTarget);
			expect(info).toMatchObject({
				os: "windows",
				shell: "powershell",
				powerShellCommand: "pwsh",
				compatEnabled: false,
			});
			expect(formatSshHostEntry(powerShellTarget)).toEndWith("| windows/powershell");

			loginShellIsPowerShell = false;
			const unknownShellInfo = await connectionManager._sshHelpersForTests.probeHostInfo(unknownShellTarget);
			expect(unknownShellInfo).toMatchObject({
				os: "windows",
				shell: "unknown",
				powerShellCommand: "pwsh",
			});
			expect(formatSshHostEntry(unknownShellTarget)).toEndWith("| windows/unknown");
		} finally {
			await connectionManager.invalidateSshTarget(powerShellTarget, { invalidateHostInfo: true });
			await connectionManager.invalidateSshTarget(unknownShellTarget, { invalidateHostInfo: true });
			execSpy.mockRestore();
		}
	});
});
