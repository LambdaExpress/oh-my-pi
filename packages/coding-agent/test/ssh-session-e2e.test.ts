import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { reset as resetCapabilities } from "@oh-my-pi/pi-coding-agent/capability";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { parseInternalUrl, SshProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { SessionSshConfig } from "@oh-my-pi/pi-coding-agent/session/session-ssh-config";
import { reconstructSessionSshConfigs } from "@oh-my-pi/pi-coding-agent/session/session-ssh-config";
import { addSSHHost } from "@oh-my-pi/pi-coding-agent/ssh/config-writer";
import { HOST_PROBE_MARKER, TRANSFER_PROBE_MARKER } from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import { loadEffectiveSshHosts } from "@oh-my-pi/pi-coding-agent/ssh/host-registry";
import { loadSshTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { SshSessionTool } from "@oh-my-pi/pi-coding-agent/tools/ssh-session";
import { getSSHConfigPath, TempDir } from "@oh-my-pi/pi-utils";

const OLD_PASSWORD = "e2e-old-session-password-sentinel";
const NEW_PASSWORD = "e2e-new-session-password-sentinel";

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(block => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

describe("session SSH fake-binary smoke", () => {
	it("shares branch aliases across ssh and ssh://, rotates password auth, and falls back after delete", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-session-e2e-");
		const cwd = tempDir.path();
		const binDir = path.join(cwd, "bin");
		const argvLog = path.join(cwd, "ssh-argv.log");
		const passwordLog = path.join(cwd, "ssh-password.log");
		const countFile = path.join(cwd, "ssh-count.txt");
		const fakeSource = path.join(binDir, "fake-ssh.ts");
		const fakeSsh = path.join(binDir, process.platform === "win32" ? "ssh.exe" : "ssh");
		const originalPath = process.env.PATH;
		const originalArgvLog = process.env.OMP_TEST_SSH_ARGV_LOG;
		const originalPasswordLog = process.env.OMP_TEST_SSH_PASSWORD_LOG;
		const originalCountFile = process.env.OMP_TEST_SSH_COUNT_FILE;
		const sessionHostname = `session-${crypto.randomUUID()}.example`;
		let manager: SessionManager | undefined;
		try {
			await fs.mkdir(binDir, { recursive: true });
			await Bun.write(
				fakeSource,
				[
					'import * as fs from "node:fs";',
					"const countFile = Bun.env.OMP_TEST_SSH_COUNT_FILE!;",
					"const argvLog = Bun.env.OMP_TEST_SSH_ARGV_LOG!;",
					"const passwordLog = Bun.env.OMP_TEST_SSH_PASSWORD_LOG!;",
					"const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) + 1 : 1;",
					"fs.writeFileSync(countFile, String(count));",
					"fs.appendFileSync(argvLog, JSON.stringify(process.argv.slice(2)) + '\\n');",
					"if (Bun.env.OMP_SSH_PASSWORD) fs.appendFileSync(passwordLog, Bun.env.OMP_SSH_PASSWORD + '\\n');",
					`if (count === 1) process.stdout.write('${HOST_PROBE_MARKER}linux-gnu|/bin/bash|5.2\\n');`,
					`else if (count === 2) process.stdout.write('${TRANSFER_PROBE_MARKER}Linux\\n');`,
					"else if (count === 3 || count === 6) process.stdout.write('ssh-command-through-session-alias\\n');",
					"else if (count === 4) process.stdout.write('file\\n');",
					"else if (count === 5) process.stdout.write('remote-file-through-session-alias\\n');",
					"else process.stdout.write('unexpected-fake-ssh-call-' + count + '\\n');",
				].join("\n"),
			);
			const build = Bun.spawn([process.execPath, "build", "--compile", fakeSource, "--outfile", fakeSsh], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const buildExitCode = await build.exited;
			if (buildExitCode !== 0) {
				throw new Error(`failed to compile fake ssh: ${await new Response(build.stderr).text()}`);
			}
			if (process.platform !== "win32") await fs.chmod(fakeSsh, 0o755);
			process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
			process.env.OMP_TEST_SSH_ARGV_LOG = argvLog;
			process.env.OMP_TEST_SSH_PASSWORD_LOG = passwordLog;
			process.env.OMP_TEST_SSH_COUNT_FILE = countFile;

			await addSSHHost(getSSHConfigPath("project", cwd), "shared", {
				host: "persistent.example",
				username: "persistent-user",
			});
			resetCapabilities();
			manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
			let configs = new Map<string, SessionSshConfig>();
			const toolSession: ToolSession = {
				cwd,
				hasUI: false,
				settings: Settings.isolated({ "compaction.enabled": false }),
				getSessionFile: () => manager?.getSessionFile() ?? null,
				getSessionSpawns: () => "*",
				getSessionId: () => manager?.getSessionId() ?? null,
				getSessionSshConfigs: () => configs,
				getSessionSshHosts: () =>
					loadEffectiveSshHosts(cwd, {
						sessionId: manager?.getSessionId() ?? "missing",
						hosts: configs,
					}),
				mutateSessionSshConfig: async mutation => {
					if (!manager) throw new Error("session manager unavailable");
					if (mutation.operation === "upsert") manager.appendSshConfigUpsert(mutation.name, mutation.config);
					else manager.appendSshConfigDelete(mutation.name);
					configs = reconstructSessionSshConfigs(manager.getBranch());
					resetCapabilities();
				},
			};
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "Configure the session SSH alias." }],
				api: "openai-responses",
				provider: "openai",
				model: "mock",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});
			const sessionTool = new SshSessionTool(toolSession);
			await sessionTool.execute("create", {
				op: "create",
				name: "shared",
				host: sessionHostname,
				username: "session-user",
				port: 2222,
				password: OLD_PASSWORD,
			});

			let sshTool = await loadSshTool(toolSession);
			if (!sshTool) throw new Error("ssh tool did not load for session alias");
			const commandResult = await sshTool.execute("ssh-command", {
				host: "shared",
				command: "echo smoke",
				timeout: 10,
			});
			expect(resultText(commandResult)).toContain("ssh-command-through-session-alias");
			const effective = await toolSession.getSessionSshHosts?.();
			const handler = new SshProtocolHandler();
			const resource = await handler.resolve(parseInternalUrl("ssh://shared/tmp/value.txt"), {
				cwd,
				sshHosts: effective,
			});
			expect(resource.content).toBe("remote-file-through-session-alias\n");
			expect(resource.url).not.toContain(OLD_PASSWORD);

			await sessionTool.execute("update", { op: "update", name: "shared", password: NEW_PASSWORD });
			sshTool = await loadSshTool(toolSession);
			if (!sshTool) throw new Error("ssh tool disappeared after password update");
			await sshTool.execute("ssh-command-updated", { host: "shared", command: "echo updated", timeout: 10 });
			const passwordInvocations = (await Bun.file(passwordLog).text()).split("\n").filter(Boolean);
			expect(passwordInvocations).toContain(OLD_PASSWORD);
			expect(passwordInvocations.at(-1)).toBe(NEW_PASSWORD);

			await sessionTool.execute("delete", { op: "delete", name: "shared" });
			const fallbackHosts = await toolSession.getSessionSshHosts?.();
			expect(fallbackHosts?.find(host => host.name === "shared")).toMatchObject({
				host: "persistent.example",
				username: "persistent-user",
			});
			expect(configs.has("shared")).toBe(false);

			await manager.flush();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("session JSONL was not persisted");
			const rawSession = await Bun.file(sessionFile).text();
			expect(rawSession).toContain(OLD_PASSWORD);
			expect(rawSession).toContain(NEW_PASSWORD);
			expect(rawSession).toContain('"operation":"delete"');
			const argv = await Bun.file(argvLog).text();
			for (const password of [OLD_PASSWORD, NEW_PASSWORD]) {
				expect(argv).not.toContain(password);
				expect(resultText(commandResult)).not.toContain(password);
				expect(handler.canonicalKey(parseInternalUrl("ssh://shared/tmp/value.txt"))).not.toContain(password);
			}
		} finally {
			await manager?.close();
			resetCapabilities();
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (originalArgvLog === undefined) delete process.env.OMP_TEST_SSH_ARGV_LOG;
			else process.env.OMP_TEST_SSH_ARGV_LOG = originalArgvLog;
			if (originalPasswordLog === undefined) delete process.env.OMP_TEST_SSH_PASSWORD_LOG;
			else process.env.OMP_TEST_SSH_PASSWORD_LOG = originalPasswordLog;
			if (originalCountFile === undefined) delete process.env.OMP_TEST_SSH_COUNT_FILE;
			else process.env.OMP_TEST_SSH_COUNT_FILE = originalCountFile;
			tempDir.removeSync();
		}
	}, 30_000);
});
