import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as connectionManager from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import { formatSshHostEntry } from "@oh-my-pi/pi-coding-agent/tools/ssh-hosts";
import { getRemoteHostDir, ptree, removeWithRetries } from "@oh-my-pi/pi-utils";

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
		expect(args).not.toContain("-J");
		expect(args.at(-2)).toBe("192.168.3.146");
		expect(args.at(-1)).toBe("ls -la");
	});

	it("passes a chained ProxyJump specification as one Unix argv value", async () => {
		const proxyJump = "jump-user@bastion.example:2222,relay@[2001:db8::1]:2200";
		const args = await connectionManager.buildRemoteCommand(
			{
				name: "host",
				host: "192.168.3.146",
				proxyJump,
			},
			"ls -la",
			{ platform: "linux" },
		);

		const proxyJumpFlag = args.indexOf("-J");
		expect(args.slice(proxyJumpFlag, proxyJumpFlag + 2)).toEqual(["-J", proxyJump]);
		expect(args.filter(arg => arg === "-J")).toHaveLength(1);
		expect(args.filter(arg => arg === proxyJump)).toHaveLength(1);
	});

	it("trims only the outside of a valid ProxyJump specification", async () => {
		const proxyJump = "jump-user@bastion.example:2222,relay@[2001:db8::1]:2200";
		const args = await connectionManager.buildRemoteCommand(
			{
				name: "host",
				host: "192.168.3.146",
				proxyJump: `  ${proxyJump}\t`,
			},
			"ls -la",
			{ platform: "linux" },
		);

		const proxyJumpFlag = args.indexOf("-J");
		expect(args.slice(proxyJumpFlag, proxyJumpFlag + 2)).toEqual(["-J", proxyJump]);
	});

	it("rejects unsafe ProxyJump specifications and bad ports without echoing the payload", async () => {
		const invalidProxyJumps = [
			"bastion.example;payload-marker",
			"bastion.example|payload-marker",
			"bastion.example`payload-marker",
			"bastion.example$payload-marker",
			"bastion.example%payload-marker",
			"bastion.example\\payload-marker",
			"user@host@payload-marker",
			"-oProxyCommand=payload-marker",
			"good.example,,payload-marker",
			"good.example,\npayload-marker",
			"user@[127.0.0.1]:22",
			"bastion.example:0",
			"bastion.example:65536",
			"bastion.example:not-a-port",
		];

		for (const proxyJump of invalidProxyJumps) {
			const error = await connectionManager
				.buildRemoteCommand(
					{
						name: "host",
						host: "192.168.3.146",
						proxyJump,
					},
					"true",
					{ platform: "linux" },
				)
				.then(
					() => undefined,
					(error: unknown) => error,
				);
			if (!(error instanceof Error)) throw new Error("Expected ProxyJump validation to reject");
			expect(error.message).toBe("Invalid SSH ProxyJump specification");
			expect(error.message).not.toContain(proxyJump);
		}
	});

	it("rejects empty ProxyJump specifications", async () => {
		for (const proxyJump of ["", " \t "]) {
			await expect(
				connectionManager.buildRemoteCommand(
					{
						name: "host",
						host: "192.168.3.146",
						proxyJump,
					},
					"true",
					{ platform: "linux" },
				),
			).rejects.toThrow("Invalid SSH ProxyJump specification");
		}
	});

	it("rejects ProxyJump with target password authentication before creating an invocation", async () => {
		await expect(
			connectionManager.buildRemoteCommandInvocation(
				{
					name: "host",
					host: "192.168.3.146",
					proxyJump: "jump-user@bastion.example:2222",
					password: "target-password",
				},
				"true",
				{ platform: "linux" },
			),
		).rejects.toThrow(
			"SSH ProxyJump cannot be used with password authentication; configure target authentication with a key or SSH agent instead",
		);
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
		expect(args).not.toContain("-J");
		expect(args.at(-2)).toBe("192.168.3.146");
		expect(args.at(-1)).toBe("ls -la");
	});

	it("passes a chained ProxyJump specification as one Windows argv value", async () => {
		const proxyJump = "jump-user@bastion.example:2222,relay@second.example:2200";
		const args = await connectionManager.buildRemoteCommand(
			{
				name: "host",
				host: "192.168.3.146",
				proxyJump,
			},
			"ls -la",
			{ platform: "win32" },
		);

		const proxyJumpFlag = args.indexOf("-J");
		expect(args.slice(proxyJumpFlag, proxyJumpFlag + 2)).toEqual(["-J", proxyJump]);
		expect(args.filter(arg => arg === "-J")).toHaveLength(1);
		expect(args.filter(arg => arg === proxyJump)).toHaveLength(1);
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

	it("separates connections, host info, and ControlMaster paths by ProxyJump", () => {
		const first = {
			name: "shared",
			host: "192.0.2.100",
			username: "deploy",
			proxyJump: "jump-user@bastion.example:2222,relay@second.example:2200",
		};
		const second = {
			...first,
			proxyJump: "jump-user@other-bastion.example:2222,relay@second.example:2200",
		};

		expect(connectionManager.getSshConnectionKey(first)).not.toBe(connectionManager.getSshConnectionKey(second));
		expect(connectionManager.getSshHostInfoKey(first)).not.toBe(connectionManager.getSshHostInfoKey(second));
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
					stdout: `${connectionManager.TRANSFER_PROBE_MARKER}Linux|6.8.0-generic|0|0`,
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

describe("SSH WSL host detection", () => {
	it("uses WSL transfer-probe evidence for bash, zsh, and sh login shells without an extra SSH call", async () => {
		const source = { provider: "test", providerName: "Test", path: "test://ssh", level: "session" as const };
		const cases = [
			{ shell: "bash", bashVersion: "5.2", transferPayload: "Linux|6.8.0-generic|1|0" },
			{ shell: "zsh", bashVersion: "", transferPayload: "Linux|6.8.0-generic|0|1" },
			{
				shell: "sh",
				bashVersion: "",
				transferPayload: "Linux|5.15.153.1-microsoft-standard-WSL2|0|0",
			},
		] as const;
		const targets = cases.map(testCase => ({
			name: `wsl-${testCase.shell}-${crypto.randomUUID()}`,
			host: `wsl-${testCase.shell}-${crypto.randomUUID()}.example`,
			compat: true,
			_source: source,
		}));
		const caseByHost = new Map(targets.map((target, index) => [target.host, cases[index]]));
		const transferCommands: string[] = [];
		const execSpy = vi.spyOn(ptree, "exec").mockImplementation(async command => {
			const remoteCommand = command.at(-1) ?? "";
			const testCase = caseByHost.get(command.at(-2) ?? "");
			if (remoteCommand.includes(connectionManager.HOST_PROBE_MARKER) && testCase) {
				return {
					exitCode: 0,
					stdout: `${connectionManager.HOST_PROBE_MARKER}linux-gnu|/bin/${testCase.shell}|${testCase.bashVersion}`,
					stderr: "",
				} as never;
			}
			if (remoteCommand.includes(connectionManager.TRANSFER_PROBE_MARKER) && testCase) {
				transferCommands.push(remoteCommand);
				return {
					exitCode: 0,
					stdout: `${connectionManager.TRANSFER_PROBE_MARKER}${testCase.transferPayload}`,
					stderr: "",
				} as never;
			}
			return { exitCode: 0, stdout: "", stderr: "" } as never;
		});

		try {
			for (let index = 0; index < targets.length; index++) {
				const target = targets[index]!;
				const testCase = cases[index]!;
				const info = await connectionManager._sshHelpersForTests.probeHostInfo(target);
				expect(info).toMatchObject({
					version: 7,
					os: "wsl",
					shell: testCase.shell,
					transferShell: "sh",
					compatEnabled: false,
				});
				expect(formatSshHostEntry(target)).toEndWith(`| wsl/${testCase.shell}`);
			}
			expect(execSpy).toHaveBeenCalledTimes(cases.length * 2);
			expect(transferCommands).toHaveLength(cases.length);
			for (const command of transferCommands) {
				expect(command).toContain("uname -s");
				expect(command).toContain("uname -r");
				expect(command).toContain(`\${WSL_DISTRO_NAME-}`);
				expect(command).toContain(`\${WSL_INTEROP-}`);
				expect(command).not.toContain("wsl.exe");
			}
		} finally {
			for (const target of targets) {
				await connectionManager.invalidateSshTarget(target, { invalidateHostInfo: true });
			}
			execSpy.mockRestore();
		}
	});

	it("recovers WSL from the transfer probe when the host marker is missing", async () => {
		const target = {
			name: `wsl-markerless-${crypto.randomUUID()}`,
			host: `wsl-markerless-${crypto.randomUUID()}.example`,
			compat: false,
		};
		const execSpy = vi.spyOn(ptree, "exec").mockImplementation(async command => {
			const remoteCommand = command.at(-1) ?? "";
			if (remoteCommand.includes(connectionManager.HOST_PROBE_MARKER)) {
				return {
					exitCode: 0,
					stdout: "Welcome to Microsoft Linux\nLast login: today",
					stderr: "profile startup noise",
				} as never;
			}
			if (remoteCommand.includes(connectionManager.TRANSFER_PROBE_MARKER)) {
				return {
					exitCode: 0,
					stdout: "transfer startup noise",
					stderr: `profile warning\n${connectionManager.TRANSFER_PROBE_MARKER}Linux|6.8.0-generic|0|1\nLinux|6.8.0-generic|0|0`,
				} as never;
			}
			return { exitCode: 0, stdout: "", stderr: "" } as never;
		});

		try {
			const info = await connectionManager._sshHelpersForTests.probeHostInfo(target);
			expect(info).toMatchObject({
				version: 7,
				os: "wsl",
				shell: "unknown",
				transferShell: "sh",
				compatEnabled: false,
			});
			expect(execSpy).toHaveBeenCalledTimes(2);
		} finally {
			await connectionManager.invalidateSshTarget(target, { invalidateHostInfo: true });
			execSpy.mockRestore();
		}
	});

	it("keeps Microsoft startup noise, noncanonical kernels, and non-1 flags as ordinary Linux", async () => {
		const target = {
			name: `linux-microsoft-noise-${crypto.randomUUID()}`,
			host: `linux-microsoft-noise-${crypto.randomUUID()}.example`,
			compat: false,
		};
		const execSpy = vi.spyOn(ptree, "exec").mockImplementation(async command => {
			const remoteCommand = command.at(-1) ?? "";
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
					stdout: `Welcome to Microsoft developer tools\n${connectionManager.TRANSFER_PROBE_MARKER}Linux|6.8.0-microsoft-hardened|true|01\nLinux|x|1|1`,
					stderr: "",
				} as never;
			}
			return { exitCode: 0, stdout: "", stderr: "" } as never;
		});

		try {
			const info = await connectionManager._sshHelpersForTests.probeHostInfo(target);
			expect(info).toMatchObject({
				version: 7,
				os: "linux",
				shell: "bash",
				transferShell: "sh",
				compatEnabled: false,
			});
			expect(execSpy).toHaveBeenCalledTimes(2);
		} finally {
			await connectionManager.invalidateSshTarget(target, { invalidateHostInfo: true });
			execSpy.mockRestore();
		}
	});

	it("refreshes a v6 Linux cache to persisted v7 WSL info on the first ensure", async () => {
		const target = {
			name: `wsl-cache-${crypto.randomUUID()}`,
			connectionId: `wsl-cache-${crypto.randomUUID()}`,
			host: `wsl-cache-${crypto.randomUUID()}.example`,
			compat: false,
		};
		const infoPath = path.join(getRemoteHostDir(), `${connectionManager.getSshHostInfoKey(target)}.json`);
		await Bun.write(
			infoPath,
			JSON.stringify({
				version: 6,
				os: "linux",
				shell: "bash",
				transferShell: "sh",
				compatEnabled: false,
			}),
			{ createPath: true },
		);
		const probeCommands: string[] = [];
		const execSpy = vi.spyOn(ptree, "exec").mockImplementation(async command => {
			const remoteCommand = command.at(-1) ?? "";
			if (command.includes("-O") && command.includes("check")) {
				return { exitCode: 0, stdout: "", stderr: "" } as never;
			}
			if (remoteCommand.includes(connectionManager.HOST_PROBE_MARKER)) {
				probeCommands.push(remoteCommand);
				return {
					exitCode: 0,
					stdout: `${connectionManager.HOST_PROBE_MARKER}linux-gnu|/bin/bash|5.2`,
					stderr: "",
				} as never;
			}
			if (remoteCommand.includes(connectionManager.TRANSFER_PROBE_MARKER)) {
				probeCommands.push(remoteCommand);
				return {
					exitCode: 0,
					stdout: `${connectionManager.TRANSFER_PROBE_MARKER}Linux|4.4.0-19041-Microsoft|0|0`,
					stderr: "",
				} as never;
			}
			return { exitCode: 0, stdout: "", stderr: "" } as never;
		});

		try {
			const info = await connectionManager.ensureHostInfo(target);
			expect(info).toMatchObject({
				version: 7,
				os: "wsl",
				shell: "bash",
				transferShell: "sh",
				compatEnabled: false,
			});
			expect(probeCommands).toHaveLength(2);
			const persisted = JSON.parse(await fs.readFile(infoPath, "utf-8"));
			expect(persisted).toMatchObject({
				version: 7,
				os: "wsl",
				shell: "bash",
				transferShell: "sh",
				compatEnabled: false,
			});
			expect(await connectionManager.ensureHostInfo(target)).toEqual(info);
			expect(probeCommands).toHaveLength(2);
		} finally {
			await connectionManager.invalidateSshTarget(target, { invalidateHostInfo: true });
			execSpy.mockRestore();
			await fs.rm(infoPath, { force: true });
		}
	});
});
