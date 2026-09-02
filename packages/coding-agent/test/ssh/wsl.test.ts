import { describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import type { SSHHost } from "@oh-my-pi/pi-coding-agent/capability/ssh";
import { buildRemoteCommandInvocation, ensureHostInfo } from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import {
	createLocalWslTargets,
	discoverLocalWslTargets,
	parseWslDistributionList,
} from "@oh-my-pi/pi-coding-agent/ssh/wsl";
import { loadSshHosts } from "@oh-my-pi/pi-coding-agent/tools/ssh-hosts";

describe("local WSL target discovery", () => {
	it("decodes the UTF-16LE distribution list emitted by wsl.exe", () => {
		const output = Buffer.from("Ubuntu-24.04\r\nDebian\r\nUbuntu-24.04\r\n", "utf16le");

		expect(parseWslDistributionList(output)).toEqual(["Ubuntu-24.04", "Debian"]);
	});

	it("does not probe WSL outside Windows", async () => {
		let called = false;
		const targets = await discoverLocalWslTargets({
			platform: "linux",
			runList: async () => {
				called = true;
				return new Uint8Array();
			},
		});

		expect(targets).toEqual([]);
		expect(called).toBe(false);
	});

	it("creates an unconfigured default target and explicit distribution targets", () => {
		expect(createLocalWslTargets(["Ubuntu-24.04", "Debian"])).toEqual([
			{ name: "wsl", host: "default", transport: "wsl" },
			{
				name: "wsl:Ubuntu-24.04",
				host: "Ubuntu-24.04",
				transport: "wsl",
				distribution: "Ubuntu-24.04",
			},
			{ name: "wsl:Debian", host: "Debian", transport: "wsl", distribution: "Debian" },
		]);
	});
});

describe("local WSL tool targets", () => {
	it("adds auto-discovered WSL targets without replacing configured hosts", async () => {
		const configured: SSHHost = {
			name: "server",
			host: "server.example",
			_source: {
				provider: "test",
				providerName: "Test",
				path: "test://ssh",
				level: "session",
			},
		};
		const result = await loadSshHosts(
			{
				cwd: "C:\\repo",
				getSessionSshHosts: async () => [configured],
			} as never,
			{ discoverLocalWslTargets: async () => createLocalWslTargets(["Ubuntu-24.04"]) },
		);

		expect(result.hostNames).toEqual(["server", "wsl", "wsl:Ubuntu-24.04"]);
		expect(result.hostsByName.get("server")).toBe(configured);
		expect(result.hostsByName.get("wsl")).toMatchObject({ transport: "wsl" });
	});

	it("builds wsl.exe invocations without SSH or sshd", async () => {
		const [defaultTarget, explicitTarget] = createLocalWslTargets(["Ubuntu-24.04"]);
		expect(defaultTarget).toBeDefined();
		expect(explicitTarget).toBeDefined();

		await expect(ensureHostInfo(defaultTarget!)).resolves.toMatchObject({
			os: "wsl",
			shell: "sh",
			transferShell: "sh",
			compatEnabled: false,
		});
		await expect(buildRemoteCommandInvocation(defaultTarget!, "printf ok")).resolves.toMatchObject({
			executable: "wsl.exe",
			args: ["--exec", "sh", "-lc", "printf ok"],
		});
		await expect(buildRemoteCommandInvocation(explicitTarget!, "pwd")).resolves.toMatchObject({
			executable: "wsl.exe",
			args: ["--distribution", "Ubuntu-24.04", "--exec", "sh", "-lc", "pwd"],
		});
	});
});
