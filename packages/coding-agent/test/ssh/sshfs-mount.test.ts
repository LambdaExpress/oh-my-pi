import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as piUtils from "@oh-my-pi/pi-utils";
import * as connectionManager from "../../src/ssh/connection-manager";
import { isMounted, mountRemote } from "../../src/ssh/sshfs-mount";

async function captureSshfsArgs(host: Parameters<typeof mountRemote>[0]): Promise<string[]> {
	const binDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-sshfs-args-"));
	const outputPath = path.join(binDir, "argv");
	const sshfsPath = path.join(binDir, "sshfs");
	const originalPath = process.env.PATH;
	const originalOutputPath = process.env.OMP_SSHFS_ARGV_FILE;
	let mountPath: string | undefined;

	await fs.promises.writeFile(sshfsPath, '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$OMP_SSHFS_ARGV_FILE"\n', {
		mode: 0o755,
	});
	process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
	process.env.OMP_SSHFS_ARGV_FILE = outputPath;
	vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "sshfs" ? sshfsPath : null));
	vi.spyOn(connectionManager, "ensureSshControlDir").mockImplementation(() => undefined);

	try {
		mountPath = await mountRemote(host);
		const output = await fs.promises.readFile(outputPath, "utf8");
		return output.trimEnd().split("\n");
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalOutputPath === undefined) delete process.env.OMP_SSHFS_ARGV_FILE;
		else process.env.OMP_SSHFS_ARGV_FILE = originalOutputPath;
		if (mountPath) await fs.promises.rm(mountPath, { recursive: true, force: true });
		await fs.promises.rm(binDir, { recursive: true, force: true });
	}
}

async function captureMountError(host: Parameters<typeof mountRemote>[0]): Promise<Error> {
	vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "sshfs" ? "/bin/true" : null));
	vi.spyOn(connectionManager, "ensureSshControlDir").mockImplementation(() => undefined);

	try {
		await mountRemote(host);
	} catch (error) {
		if (error instanceof Error) return error;
		throw error;
	}
	throw new Error("Expected SSHFS mount to reject");
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("mountRemote", () => {
	it("surfaces the shared ControlMaster directory guard before touching sshfs", async () => {
		vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "sshfs" ? "/bin/true" : null));
		vi.spyOn(connectionManager, "ensureSshControlDir").mockImplementation(() => {
			throw new Error("SSH control directory /tmp/omp-test is a symlink");
		});

		await expect(mountRemote({ name: "nixbox", host: "nixbox" })).rejects.toThrow("is a symlink");
	});

	it("passes an escaped ProxyJump chain to sshfs as one option value", async () => {
		if (process.platform === "win32") return;
		const proxyJump = "alice@jump-a.example:2200,jump-b.example";
		const expectedOption = String.raw`ProxyJump=alice@jump-a.example:2200\,jump-b.example`;

		const args = await captureSshfsArgs({
			name: "proxied-nixbox",
			host: "nixbox.example",
			proxyJump,
		});

		const optionIndex = args.indexOf(expectedOption);
		expect(optionIndex).toBeGreaterThan(0);
		expect(args[optionIndex - 1]).toBe("-o");
		expect(args.filter(arg => arg.includes("ProxyJump"))).toEqual([expectedOption]);
	});

	it("omits ProxyJump when the host has no proxy jump", async () => {
		if (process.platform === "win32") return;

		const args = await captureSshfsArgs({
			name: "direct-nixbox",
			host: "nixbox.example",
		});

		expect(args.some(arg => arg.includes("ProxyJump"))).toBe(false);
	});

	it("rejects a malicious ProxyJump specification without reflecting it", async () => {
		const proxyJump = "bastion.example;touch-payload";

		const error = await captureMountError({
			name: "invalid-proxy-nixbox",
			host: "nixbox.example",
			proxyJump,
		});

		expect(error.message).toBe("Invalid SSH ProxyJump specification");
		expect(error.message).not.toContain(proxyJump);
	});

	it("rejects an empty ProxyJump specification", async () => {
		const error = await captureMountError({
			name: "empty-proxy-nixbox",
			host: "nixbox.example",
			proxyJump: "",
		});

		expect(error.message).toBe("Invalid SSH ProxyJump specification");
	});

	it("rejects ProxyJump with password authentication", async () => {
		const error = await captureMountError({
			name: "password-proxy-nixbox",
			host: "nixbox.example",
			proxyJump: "bastion.example",
			password: "secret",
		});

		expect(error.message).toBe(
			"SSH ProxyJump cannot be used with password authentication; configure target authentication with a key or SSH agent instead",
		);
	});
});

describe("isMounted", () => {
	it("detects a macOS mount point when mountpoint is unavailable", async () => {
		const parentPath = import.meta.dir;
		const mountPath = path.join(parentPath, "mounted");
		const stat = async (filePath: string) => ({ dev: filePath === mountPath ? 2 : 1 });

		await expect(isMounted(mountPath, { platform: "darwin", stat, which: () => null })).resolves.toBe(true);
	});
});
