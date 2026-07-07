import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { runSSHCommand, type SSHCommandArgs } from "@oh-my-pi/pi-coding-agent/cli/ssh-cli";
import type { SSHConfigFile } from "@oh-my-pi/pi-coding-agent/ssh/config-writer";
import * as sshConfigWriter from "@oh-my-pi/pi-coding-agent/ssh/config-writer";
import { getSSHConfigPath } from "@oh-my-pi/pi-utils";

const originalStdoutWrite = process.stdout.write.bind(process.stdout);

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

	it("redacts configured passwords in text list output", async () => {
		mockConfigReads(
			{ hosts: { prod: { host: "x", username: "root", password: "project-secret" } } },
			{ hosts: { personal: { host: "y", password: "user-secret" } } },
		);

		await run({ action: "list", args: [], flags: {} });

		expect(stdout).toContain("prod");
		expect(stdout).toContain("personal");
		expect(stdout).toContain("password:********");
		expect(stdout).not.toContain("project-secret");
		expect(stdout).not.toContain("user-secret");
	});

	it("redacts configured passwords in JSON list output", async () => {
		mockConfigReads(
			{ hosts: { prod: { host: "x", username: "root", password: "project-secret" } } },
			{ hosts: { personal: { host: "y", password: "user-secret" } } },
		);

		await run({ action: "list", args: [], flags: { json: true } });

		expect(stdout).not.toContain("project-secret");
		expect(stdout).not.toContain("user-secret");
		const parsed = JSON.parse(stdout) as {
			project: Record<string, { host: string; username?: string; password?: string }>;
			user: Record<string, { host: string; username?: string; password?: string }>;
		};
		expect(parsed.project.prod).toEqual({ host: "x", username: "root", password: "********" });
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
});
