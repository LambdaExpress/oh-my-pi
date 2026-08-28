import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { loadCapability, reset as resetCapabilities } from "@oh-my-pi/pi-coding-agent/capability";
import { type SSHHost, sshCapability } from "@oh-my-pi/pi-coding-agent/capability/ssh";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionSshConfig, SessionSshConfigMutation } from "@oh-my-pi/pi-coding-agent/session/session-ssh-config";
import { addSSHHost, updateSSHHost } from "@oh-my-pi/pi-coding-agent/ssh/config-writer";
import { loadEffectiveSshHosts } from "@oh-my-pi/pi-coding-agent/ssh/host-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	type SshSessionParams,
	SshSessionTool,
	sshSessionToolRenderer,
} from "@oh-my-pi/pi-coding-agent/tools/ssh-session";
import { TUI } from "@oh-my-pi/pi-tui";
import { getSSHConfigPath, TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const SENTINEL = "session-ssh-password-sentinel";

interface Harness {
	configs: Map<string, SessionSshConfig>;
	mutations: SessionSshConfigMutation[];
	tool: SshSessionTool;
}

function createHarness(cwd: string): Harness {
	const configs = new Map<string, SessionSshConfig>();
	const mutations: SessionSshConfigMutation[] = [];
	let revision = 0;
	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "compaction.enabled": false }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionSshConfigs: () => configs,
		mutateSessionSshConfig: async mutation => {
			mutations.push(structuredClone(mutation));
			if (mutation.operation === "delete") {
				configs.delete(mutation.name);
				return;
			}
			configs.set(mutation.name, {
				config: structuredClone(mutation.config),
				revisionEntryId: `revision-${++revision}`,
			});
		},
	};
	return { configs, mutations, tool: new SshSessionTool(session) };
}

async function execute(harness: Harness, params: SshSessionParams) {
	return harness.tool.execute(crypto.randomUUID(), params);
}

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	resetCapabilities();
});

describe("ssh_session tool", () => {
	it("creates, lists, updates, clears, and deletes session-only aliases", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-session-tool-");
		try {
			const harness = createHarness(tempDir.path());
			const created = await execute(harness, {
				op: "create",
				name: "prod",
				host: "203.0.113.10",
				username: "deploy",
				port: 2222,
				key_path: "C:/keys/prod",
				description: "production",
				compat: false,
				proxy_jump: "  bastion@jump.example:2200,backup.example  ",
			});
			expect(created.details?.host).toEqual({
				name: "prod",
				host: "203.0.113.10",
				username: "deploy",
				port: 2222,
				keyPath: "C:/keys/prod",
				description: "production",
				compat: false,
				proxyJump: "bastion@jump.example:2200,backup.example",
				hasPassword: false,
			});
			expect(created.details?.changedFields).toContain("proxy_jump");
			const createdText = created.content[0]?.type === "text" ? created.content[0].text : "";
			expect(createdText).toContain("via bastion@jump.example:2200,backup.example");
			expect(JSON.stringify(created)).not.toContain(SENTINEL);
			expect(harness.mutations[0]).toEqual({
				operation: "upsert",
				name: "prod",
				config: {
					host: "203.0.113.10",
					username: "deploy",
					port: 2222,
					keyPath: "C:/keys/prod",
					description: "production",
					compat: false,
					proxyJump: "bastion@jump.example:2200,backup.example",
				},
			});

			const listed = await execute(harness, { op: "list" });
			expect(listed.details?.hosts?.map(host => host.name)).toEqual(["prod"]);
			expect(listed.details?.hosts?.[0]?.proxyJump).toBe("bastion@jump.example:2200,backup.example");
			const listedText = listed.content[0]?.type === "text" ? listed.content[0].text : "";
			expect(listedText).toContain("via bastion@jump.example:2200,backup.example");
			expect(JSON.stringify(listed)).not.toContain(SENTINEL);

			const updated = await execute(harness, {
				op: "update",
				name: "prod",
				host: "203.0.113.11",
				port: null,
				proxy_jump: " relay.example ",
			});
			expect(updated.details?.changedFields).toContain("proxy_jump");
			const updatedText = updated.content[0]?.type === "text" ? updated.content[0].text : "";
			expect(updatedText).toContain("via relay.example");
			expect(harness.configs.get("prod")?.config).toMatchObject({
				host: "203.0.113.11",
				username: "deploy",
				proxyJump: "relay.example",
			});
			expect(harness.configs.get("prod")?.config.port).toBeUndefined();

			const cleared = await execute(harness, {
				op: "update",
				name: "prod",
				key_path: null,
				proxy_jump: null,
			});
			expect(cleared.details?.changedFields).toContain("proxy_jump");
			expect(harness.configs.get("prod")?.config.password).toBeUndefined();
			expect(harness.configs.get("prod")?.config.keyPath).toBeUndefined();
			expect(harness.configs.get("prod")?.config.proxyJump).toBeUndefined();

			await execute(harness, { op: "delete", name: "prod" });
			expect(harness.configs.has("prod")).toBe(false);
			expect(harness.mutations.at(-1)).toEqual({ operation: "delete", name: "prod" });
		} finally {
			tempDir.removeSync();
		}
	});

	it("normalizes persistent ProxyJump values and rejects unsafe configs before writing", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-persistent-proxy-jump-");
		try {
			const configPath = getSSHConfigPath("project", tempDir.path());
			await addSSHHost(configPath, "persistent", {
				host: "persistent.example",
				proxyJump: "  user@bastion.example:2200,next.example  ",
			});
			let rawConfig = await Bun.file(configPath).text();
			expect(rawConfig).toContain('"proxyJump": "user@bastion.example:2200,next.example"');

			await updateSSHHost(configPath, "persistent", {
				host: "persistent.example",
				proxyJump: "  relay.example  ",
			});
			rawConfig = await Bun.file(configPath).text();
			expect(rawConfig).toContain('"proxyJump": "relay.example"');

			const validConfig = rawConfig;
			await expect(
				addSSHHost(configPath, "dangerous", {
					host: "dangerous.example",
					proxyJump: "relay.example -oProxyCommand=calc",
				}),
			).rejects.toThrow(/Invalid SSH ProxyJump specification/);
			expect(await Bun.file(configPath).text()).toBe(validConfig);

			await expect(
				updateSSHHost(configPath, "persistent", {
					host: "persistent.example",
					password: SENTINEL,
					proxyJump: "relay.example",
				}),
			).rejects.toThrow(/cannot be used with password authentication/);
			expect(await Bun.file(configPath).text()).toBe(validConfig);
		} finally {
			tempDir.removeSync();
		}
	});

	it("skips unsafe persistent ProxyJump aliases with safe warnings", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-discovery-proxy-jump-");
		try {
			const cwd = tempDir.path();
			const configPath = getSSHConfigPath("project", cwd);
			await addSSHHost(configPath, "bootstrap", { host: "bootstrap.example" });
			const dangerousSpec = "relay.example -oProxyCommand=calc";
			await Bun.write(
				configPath,
				JSON.stringify({
					hosts: {
						valid: {
							host: "valid.example",
							proxyJump: "  user@bastion.example:2200,next.example  ",
						},
						"wrong-type": { host: "wrong-type.example", proxyJump: 42 },
						dangerous: { host: "dangerous.example", proxyJump: dangerousSpec },
						"password-combo": {
							host: "password-combo.example",
							password: SENTINEL,
							proxyJump: "relay.example",
						},
					},
				}),
			);
			resetCapabilities();

			const discovered = await loadCapability<SSHHost>(sshCapability.id, {
				cwd,
				providers: ["ssh-json"],
			});
			expect(discovered.items.find(host => host.name === "valid")).toMatchObject({
				host: "valid.example",
				proxyJump: "user@bastion.example:2200,next.example",
			});
			for (const name of ["wrong-type", "dangerous", "password-combo"]) {
				expect(discovered.items.some(host => host.name === name)).toBe(false);
			}
			const warnings = discovered.warnings.join("\n");
			expect(warnings).toContain("wrong-type");
			expect(warnings).toContain("dangerous");
			expect(warnings).toContain("password-combo");
			expect(warnings).not.toContain(dangerousSpec);
			expect(warnings).not.toContain(SENTINEL);
		} finally {
			tempDir.removeSync();
		}
	});

	it("shadows a persistent alias and reveals it after delete without changing its file", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-session-fallback-");
		try {
			const cwd = tempDir.path();
			const configPath = getSSHConfigPath("project", cwd);
			await addSSHHost(configPath, "shared", {
				host: "persistent.example",
				username: "disk",
				proxyJump: "persistent-bastion.example",
			});
			const originalConfig = await Bun.file(configPath).text();
			const harness = createHarness(cwd);

			await execute(harness, {
				op: "create",
				name: "shared",
				host: "session.example",
				username: "branch",
				password: SENTINEL,
			});
			let effective = await loadEffectiveSshHosts(cwd, { sessionId: "session-1", hosts: harness.configs });
			expect(effective.find(host => host.name === "shared")).toMatchObject({
				host: "session.example",
				username: "branch",
				password: SENTINEL,
			});

			await execute(harness, { op: "delete", name: "shared" });
			resetCapabilities();
			effective = await loadEffectiveSshHosts(cwd, { sessionId: "session-1", hosts: harness.configs });
			expect(effective.find(host => host.name === "shared")).toMatchObject({
				host: "persistent.example",
				username: "disk",
				proxyJump: "persistent-bastion.example",
			});
			expect(await Bun.file(configPath).text()).toBe(originalConfig);
		} finally {
			tempDir.removeSync();
		}
	});

	it("rejects invalid operations without exposing password arguments", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-session-validation-");
		try {
			const harness = createHarness(tempDir.path());
			const invalidCreates: SshSessionParams[] = [
				{ op: "create", name: "bad/name", host: "example.com" },
				{ op: "create", name: "empty-host", host: " " },
				{ op: "create", name: "bad-port", host: "example.com", port: 0 },
				{ op: "create", name: "fractional-port", host: "example.com", port: 22.5 },
				{ op: "create", name: "empty-password", host: "example.com", password: " " },
				{ op: "create", name: "empty-key", host: "example.com", key_path: " " },
				{ op: "create", name: "empty-proxy-jump", host: "example.com", proxy_jump: " " },
				{ op: "create", name: "null-proxy-jump", host: "example.com", proxy_jump: null },
				{
					op: "create",
					name: "dangerous-proxy-jump",
					host: "example.com",
					proxy_jump: "relay.example -oProxyCommand=calc",
				},
				{
					op: "create",
					name: "password-proxy-jump",
					host: "example.com",
					password: SENTINEL,
					proxy_jump: "relay.example",
				},
			];
			for (const params of invalidCreates) await expect(execute(harness, params)).rejects.toThrow();
			await expect(execute(harness, { op: "update", name: "persistent-only", password: SENTINEL })).rejects.toThrow(
				/not found/,
			);
			await expect(execute(harness, { op: "delete", name: "persistent-only" })).rejects.toThrow(/not found/);
			await expect(execute(harness, { op: "update", name: "missing" })).rejects.toThrow(/at least one|not found/);
		} finally {
			tempDir.removeSync();
		}
	});

	it("validates ProxyJump compatibility against the final merged session config", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-session-proxy-jump-compat-");
		try {
			const harness = createHarness(tempDir.path());
			await execute(harness, {
				op: "create",
				name: "switchable",
				host: "example.com",
				password: SENTINEL,
			});
			await expect(
				execute(harness, {
					op: "update",
					name: "switchable",
					proxy_jump: "relay.example",
				}),
			).rejects.toThrow(/cannot be used with password authentication/);

			await execute(harness, {
				op: "update",
				name: "switchable",
				password: null,
				proxy_jump: "  relay.example  ",
			});
			expect(harness.configs.get("switchable")?.config).toMatchObject({
				host: "example.com",
				proxyJump: "relay.example",
			});
			expect(harness.configs.get("switchable")?.config.password).toBeUndefined();

			await expect(
				execute(harness, {
					op: "update",
					name: "switchable",
					password: SENTINEL,
				}),
			).rejects.toThrow(/cannot be used with password authentication/);

			await execute(harness, {
				op: "update",
				name: "switchable",
				password: SENTINEL,
				proxy_jump: null,
			});
			expect(harness.configs.get("switchable")?.config).toMatchObject({
				host: "example.com",
				password: SENTINEL,
			});
			expect(harness.configs.get("switchable")?.config.proxyJump).toBeUndefined();
		} finally {
			tempDir.removeSync();
		}
	});

	it("replaces the pending create row with one completed result row", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-session-render-");
		try {
			const harness = createHarness(tempDir.path());
			const args: SshSessionParams = {
				op: "create",
				name: "temporary",
				host: "connect.example.com",
				username: "root",
				port: 24314,
				password: SENTINEL,
			};
			const component = new ToolExecutionComponent(
				"ssh_session",
				args,
				{},
				undefined,
				new TUI(new VirtualTerminal(300, 10)),
			);

			component.updateResult(await execute(harness, args), false);
			const rendered = Bun.stripANSI(component.render(300).join("\n"));

			expect(rendered.match(/SSH Session/g)).toHaveLength(1);
			expect(rendered).toContain("temporary: root@connect.example.com:24314 (password configured)");
		} finally {
			tempDir.removeSync();
		}
	});

	it("keeps approval, rendering, results, and errors free of password text", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-session-secret-");
		try {
			const harness = createHarness(tempDir.path());
			const args: SshSessionParams = {
				op: "create",
				name: "secret",
				host: "example.com",
				password: SENTINEL,
			};
			const approvalDetails = JSON.stringify(harness.tool.formatApprovalDetails?.(args));
			expect(approvalDetails).not.toContain(SENTINEL);
			const callRows = sshSessionToolRenderer.renderCall(args, {} as never, theme).render(100);
			const renderedCall = Bun.stripANSI(callRows.join("\n"));
			expect(renderedCall).not.toContain(SENTINEL);
			const result = await execute(harness, args);
			const resultRows = sshSessionToolRenderer.renderResult(result, {} as never, theme).render(100);
			const renderedResult = Bun.stripANSI(resultRows.join("\n"));
			expect(renderedResult).not.toContain(SENTINEL);
			expect(JSON.stringify(result)).not.toContain(SENTINEL);
			let errorText = "";
			try {
				await execute(harness, args);
			} catch (error) {
				errorText = error instanceof Error ? error.message : String(error);
			}
			expect(errorText).not.toContain(SENTINEL);

			const proxyArgs: SshSessionParams = {
				op: "create",
				name: "jump",
				host: "example.com",
				proxy_jump: "bastion@jump.example:2200,backup.example",
			};
			expect(JSON.stringify(harness.tool.formatApprovalDetails?.(proxyArgs))).toContain(
				"bastion@jump.example:2200,backup.example",
			);
			const proxyCallRows = sshSessionToolRenderer.renderCall(proxyArgs, {} as never, theme).render(100);
			expect(Bun.stripANSI(proxyCallRows.join("\n"))).toContain("bastion@jump.example:2200,backup.example");
			const proxyResult = await execute(harness, proxyArgs);
			const proxyResultRows = sshSessionToolRenderer.renderResult(proxyResult, {} as never, theme).render(100);
			expect(Bun.stripANSI(proxyResultRows.join("\n"))).toContain("bastion@jump.example:2200,backup.example");
		} finally {
			tempDir.removeSync();
		}
	});
});
