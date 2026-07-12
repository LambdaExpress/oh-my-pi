import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { reset as resetCapabilities } from "@oh-my-pi/pi-coding-agent/capability";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionSshConfig, SessionSshConfigMutation } from "@oh-my-pi/pi-coding-agent/session/session-ssh-config";
import { addSSHHost } from "@oh-my-pi/pi-coding-agent/ssh/config-writer";
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
				password: SENTINEL,
				description: "production",
				compat: false,
			});
			expect(created.details?.host).toEqual({
				name: "prod",
				host: "203.0.113.10",
				username: "deploy",
				port: 2222,
				keyPath: "C:/keys/prod",
				description: "production",
				compat: false,
				hasPassword: true,
			});
			expect(JSON.stringify(created)).not.toContain(SENTINEL);
			expect(harness.mutations[0]).toEqual({
				operation: "upsert",
				name: "prod",
				config: {
					host: "203.0.113.10",
					username: "deploy",
					port: 2222,
					keyPath: "C:/keys/prod",
					password: SENTINEL,
					description: "production",
					compat: false,
				},
			});

			const listed = await execute(harness, { op: "list" });
			expect(listed.details?.hosts?.map(host => host.name)).toEqual(["prod"]);
			expect(JSON.stringify(listed)).not.toContain(SENTINEL);

			await execute(harness, { op: "update", name: "prod", host: "203.0.113.11", port: null });
			expect(harness.configs.get("prod")?.config).toMatchObject({
				host: "203.0.113.11",
				username: "deploy",
				password: SENTINEL,
			});
			expect(harness.configs.get("prod")?.config.port).toBeUndefined();

			await execute(harness, { op: "update", name: "prod", password: null, key_path: null });
			expect(harness.configs.get("prod")?.config.password).toBeUndefined();
			expect(harness.configs.get("prod")?.config.keyPath).toBeUndefined();

			await execute(harness, { op: "delete", name: "prod" });
			expect(harness.configs.has("prod")).toBe(false);
			expect(harness.mutations.at(-1)).toEqual({ operation: "delete", name: "prod" });
		} finally {
			tempDir.removeSync();
		}
	});

	it("shadows a persistent alias and reveals it after delete without changing its file", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-session-fallback-");
		try {
			const cwd = tempDir.path();
			const configPath = getSSHConfigPath("project", cwd);
			await addSSHHost(configPath, "shared", { host: "persistent.example", username: "disk" });
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
			expect(JSON.stringify(harness.tool.formatApprovalDetails?.(args))).not.toContain(SENTINEL);
			const callRows = sshSessionToolRenderer.renderCall(args, {} as never, theme).render(100);
			expect(Bun.stripANSI(callRows.join("\n"))).not.toContain(SENTINEL);
			const result = await execute(harness, args);
			const resultRows = sshSessionToolRenderer.renderResult(result, {} as never, theme).render(100);
			expect(Bun.stripANSI(resultRows.join("\n"))).not.toContain(SENTINEL);
			expect(JSON.stringify(result)).not.toContain(SENTINEL);
			let errorText = "";
			try {
				await execute(harness, args);
			} catch (error) {
				errorText = error instanceof Error ? error.message : String(error);
			}
			expect(errorText).not.toContain(SENTINEL);
		} finally {
			tempDir.removeSync();
		}
	});
});
