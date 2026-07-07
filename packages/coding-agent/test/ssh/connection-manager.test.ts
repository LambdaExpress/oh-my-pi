import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as connectionManager from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

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

describe("supportsSshControlMaster", () => {
	it("disables OpenSSH connection multiplexing on native Windows", () => {
		expect(connectionManager.supportsSshControlMaster("win32")).toBe(false);
	});

	it("keeps OpenSSH connection multiplexing on Unix-like platforms", () => {
		expect(connectionManager.supportsSshControlMaster("linux")).toBe(true);
		expect(connectionManager.supportsSshControlMaster("darwin")).toBe(true);
	});
});
