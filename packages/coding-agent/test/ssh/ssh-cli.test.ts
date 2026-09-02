import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { runSSHCommand, type SSHCommandArgs } from "@oh-my-pi/pi-coding-agent/cli/ssh-cli";
import SSH from "@oh-my-pi/pi-coding-agent/commands/ssh";
import { parseOpenSshConfig } from "@oh-my-pi/pi-coding-agent/discovery/ssh";
import type { SSHConfigFile } from "@oh-my-pi/pi-coding-agent/ssh/config-writer";
import * as sshConfigWriter from "@oh-my-pi/pi-coding-agent/ssh/config-writer";
import { getSSHConfigPath } from "@oh-my-pi/pi-utils";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const TEST_CONFIG: CliConfig = {
	bin: "omp",
	version: "0.0.0-test",
	commands: new Map(),
};

let stdout = "";
const spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
	stdout = "";
	process.exitCode = 0;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += Bun.stripANSI(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	}) as typeof process.stdout.write;
});

afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	process.stdout.write = originalStdoutWrite;
	process.exitCode = 0;
});

function mockAddSSHHost() {
	const spy = spyOn(sshConfigWriter, "addSSHHost").mockResolvedValue(undefined);
	spies.push(spy);
	return spy;
}

function mockConfigReads(projectConfig: SSHConfigFile, userConfig: SSHConfigFile) {
	const projectPath = getSSHConfigPath("project");
	const userPath = getSSHConfigPath("user");
	const spy = spyOn(sshConfigWriter, "readSSHConfigFile").mockImplementation(async (filePath: string) => {
		if (filePath === projectPath) return projectConfig;
		if (filePath === userPath) return userConfig;
		return { hosts: {} };
	});
	spies.push(spy);
	return spy;
}

async function run(cmd: SSHCommandArgs): Promise<void> {
	await runSSHCommand(cmd);
}

describe("SSH command flag parsing", () => {
	it("parses all concrete aliases from an OpenSSH Host block", () => {
		const hosts = parseOpenSshConfig(
			`Host *
  ServerAliveInterval 30

Host mac-mini macmini
  HostName 172.27.2.7
  User qingdaochengande
  Port 22
  IdentityFile ~/.ssh/id_ed25519_macmini
`,
			"C:/Users/example",
			"C:/Users/example/.ssh/config",
		);

		expect(hosts.map(host => host.name)).toEqual(["mac-mini", "macmini"]);
		for (const host of hosts) {
			expect(host).toMatchObject({
				host: "172.27.2.7",
				username: "qingdaochengande",
				port: 22,
			});
			expect(path.normalize(host.keyPath!)).toBe(path.join("C:/Users/example", ".ssh/id_ed25519_macmini"));
			expect(host._source).toMatchObject({ provider: "ssh-openssh", level: "user" });
		}
	});

	it("parses --proxy-jump and rejects the camelCase spelling", async () => {
		const command = new SSH(["add", "relay", "--host", "target", "--proxy-jump", "user@jump:2222"], TEST_CONFIG);
		const parsed = await command.parse(SSH);
		expect(parsed.flags["proxy-jump"]).toBe("user@jump:2222");

		const camelCase = new SSH(["add", "relay", "--host", "target", "--proxyJump", "user@jump:2222"], TEST_CONFIG);
		await expect(camelCase.parse(SSH)).rejects.toThrow(/--proxyJump/);
	});
});

describe("runSSHCommand password handling", () => {
	it("writes password hosts to user scope by default without echoing the password", async () => {
		const addSpy = mockAddSSHHost();

		await run({
			action: "add",
			args: ["foo"],
			flags: { host: "x", user: "y", password: "secret123" },
		});

		expect(addSpy).toHaveBeenCalledTimes(1);
		const [configPath, name, hostConfig] = addSpy.mock.calls[0]!;
		expect(configPath).toBe(getSSHConfigPath("user"));
		expect(name).toBe("foo");
		expect(hostConfig).toEqual({ host: "x", username: "y", password: "secret123" });
		expect(stdout).toContain('Added SSH host "foo" to user config');
		expect(stdout).not.toContain("secret123");
	});

	it("honors an explicit project scope for password hosts", async () => {
		const addSpy = mockAddSSHHost();

		await run({
			action: "add",
			args: ["foo"],
			flags: { host: "x", password: "secret123", scope: "project" },
		});

		expect(addSpy).toHaveBeenCalledTimes(1);
		const [configPath, name, hostConfig] = addSpy.mock.calls[0]!;
		expect(configPath).toBe(getSSHConfigPath("project"));
		expect(name).toBe("foo");
		expect(hostConfig).toEqual({ host: "x", password: "secret123" });
		expect(stdout).toContain('Added SSH host "foo" to project config');
		expect(stdout).not.toContain("secret123");
	});

	it("saves a trimmed proxy jump without changing the default project scope", async () => {
		const addSpy = mockAddSSHHost();

		await run({
			action: "add",
			args: ["relay"],
			flags: {
				host: "relay.internal",
				proxyJump: "  relay-user@bastion.example:2222,backup-bastion.example  ",
			},
		});

		expect(addSpy).toHaveBeenCalledTimes(1);
		const [configPath, name, hostConfig] = addSpy.mock.calls[0]!;
		expect(configPath).toBe(getSSHConfigPath("project"));
		expect(name).toBe("relay");
		expect(hostConfig).toEqual({
			host: "relay.internal",
			proxyJump: "relay-user@bastion.example:2222,backup-bastion.example",
		});
	});

	it.each([
		["an option-like token", "-oProxyCommand=calc"],
		["an out-of-range jump port", "relay.example:70000"],
	])("rejects %s in a proxy jump without writing a host", async (_case, proxyJump) => {
		const addSpy = mockAddSSHHost();

		await run({
			action: "add",
			args: ["relay"],
			flags: { host: "relay.internal", proxyJump },
		});

		expect(process.exitCode).toBe(1);
		expect(stdout).toContain("Error: Invalid SSH ProxyJump specification");
		expect(addSpy).not.toHaveBeenCalled();
	});

	it("rejects password authentication with a proxy jump without writing a host", async () => {
		const addSpy = mockAddSSHHost();

		await run({
			action: "add",
			args: ["relay"],
			flags: { host: "relay.internal", proxyJump: "bastion.example", password: "target-secret" },
		});

		expect(process.exitCode).toBe(1);
		expect(stdout).toContain(
			"Error: SSH ProxyJump cannot be used with password authentication; configure target authentication with a key or SSH agent instead",
		);
		expect(stdout).not.toContain("target-secret");
		expect(addSpy).not.toHaveBeenCalled();
	});

	it("redacts configured passwords in text list output", async () => {
		mockConfigReads(
			{
				hosts: {
					prod: {
						host: "x",
						username: "root",
						password: "project-secret",
						proxyJump: "relay@bastion.example:2222",
					},
				},
			},
			{ hosts: { personal: { host: "y", password: "user-secret" } } },
		);

		await run({ action: "list", args: [], flags: {} });

		expect(stdout).toContain("prod");
		expect(stdout).toContain("personal");
		expect(stdout).toContain("password:********");
		expect(stdout).toContain("jump:relay@bastion.example:2222");
		expect(stdout).not.toContain("project-secret");
		expect(stdout).not.toContain("user-secret");
	});

	it("redacts configured passwords in JSON list output", async () => {
		mockConfigReads(
			{
				hosts: {
					prod: {
						host: "x",
						username: "root",
						password: "project-secret",
						proxyJump: "relay@bastion.example:2222",
					},
				},
			},
			{ hosts: { personal: { host: "y", password: "user-secret" } } },
		);

		await run({ action: "list", args: [], flags: { json: true } });

		expect(stdout).not.toContain("project-secret");
		expect(stdout).not.toContain("user-secret");
		const parsed = JSON.parse(stdout) as {
			project: Record<string, { host: string; username?: string; password?: string; proxyJump?: string }>;
			user: Record<string, { host: string; username?: string; password?: string }>;
		};
		expect(parsed.project.prod).toEqual({
			host: "x",
			username: "root",
			password: "********",
			proxyJump: "relay@bastion.example:2222",
		});
		expect(parsed.user.personal).toEqual({ host: "y", password: "********" });
	});

	it("rejects an empty password value without writing a host", async () => {
		const addSpy = mockAddSSHHost();

		await run({
			action: "add",
			args: ["foo"],
			flags: { host: "x", password: "" },
		});

		expect(process.exitCode).toBe(1);
		expect(stdout).toContain("Error: --password requires a non-empty value");
		expect(addSpy).not.toHaveBeenCalled();
	});

	it("rejects a whitespace-only proxy jump without writing a host", async () => {
		const addSpy = mockAddSSHHost();

		await run({
			action: "add",
			args: ["foo"],
			flags: { host: "x", proxyJump: " \t " },
		});

		expect(process.exitCode).toBe(1);
		expect(stdout).toContain("Error: Invalid SSH ProxyJump specification");
		expect(addSpy).not.toHaveBeenCalled();
	});
});
