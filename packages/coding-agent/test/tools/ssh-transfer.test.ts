import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { SSHHost } from "@oh-my-pi/pi-coding-agent/capability/ssh";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as connectionManager from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import type { SshFileTransferPlan, SshFileTransferProgress } from "@oh-my-pi/pi-coding-agent/ssh/file-transfer";
import * as fileTransfer from "@oh-my-pi/pi-coding-agent/ssh/file-transfer";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { SshTransferTool } from "@oh-my-pi/pi-coding-agent/tools/ssh-transfer";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { type ChildProcess, ptree } from "@oh-my-pi/pi-utils";

const SOURCE: SourceMeta = {
	provider: "test",
	providerName: "Test",
	path: "/dev/null",
	level: "user",
};
const HOST: SSHHost = {
	name: "fixture",
	host: "fixture.invalid",
	username: "tester",
	_source: SOURCE,
};
const HOST_INFO: connectionManager.SSHHostInfo = {
	version: 5,
	os: "linux",
	shell: "sh",
	transferShell: "sh",
	compatEnabled: false,
};

function createSession(asyncJobManager?: AsyncJobManager): ToolSession {
	return {
		cwd: path.resolve("fixture-cwd"),
		settings: Settings.isolated({ "async.enabled": true }),
		asyncJobManager,
		getAgentId: () => "Main",
		getAgentScopeId: () => "scope-1",
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

function createPlan(localPath: string): SshFileTransferPlan {
	return {
		operation: "upload",
		target: HOST,
		localPath,
		remotePath: "/srv/blob.bin",
		totalBytes: 1024 * 1024,
		overwrite: false,
		commitStrategy: "no-replace",
	};
}

function progress(transferredBytes: number, elapsedMs: number): SshFileTransferProgress {
	return {
		transferredBytes,
		totalBytes: 1024 * 1024,
		bytesPerSecond: 256 * 1024,
		averageBytesPerSecond: elapsedMs === 0 ? 0 : (transferredBytes * 1000) / elapsedMs,
		elapsedMs,
	};
}

describe("SshTransferTool", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("streams foreground progress and returns the final structured summary", async () => {
		const session = createSession();
		const tool = new SshTransferTool(session, [HOST.name], new Map([[HOST.name, HOST]]), "fixture");
		const localPath = path.resolve(session.cwd, "blob.bin");
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue(HOST_INFO);
		vi.spyOn(fileTransfer, "prepareSshFileTransfer").mockResolvedValue(createPlan(localPath));
		vi.spyOn(fileTransfer, "executeSshFileTransfer").mockImplementation(async (_plan, options) => {
			options?.onProgress?.(progress(512 * 1024, 2_000));
			return progress(1024 * 1024, 4_000);
		});
		const updates: string[] = [];

		const result = await tool.execute(
			"transfer-1",
			{ op: "upload", host: HOST.name, local_path: "blob.bin", remote_path: "/srv/blob.bin" },
			undefined,
			update => {
				const text = update.content.find(item => item.type === "text")?.text;
				if (text) updates.push(text);
			},
		);

		expect(updates).toHaveLength(1);
		expect(updates[0]).toContain("50.0%");
		expect(updates[0]).toContain("256.0KB/s");
		expect(result.details?.status).toBe("completed");
		expect(result.details?.percent).toBe(100);
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("1.0MB / 1.0MB");
	});

	it("registers background transfers with owner, scope, tool call, and terminal progress", async () => {
		const completions: string[] = [];
		const manager = new AsyncJobManager({});
		manager.registerDeliverySink("Main", async (_jobId, text) => {
			completions.push(text);
		});
		const session = createSession(manager);
		const tool = new SshTransferTool(session, [HOST.name], new Map([[HOST.name, HOST]]), "fixture");
		const localPath = path.resolve(session.cwd, "blob.bin");
		const execution = Promise.withResolvers<SshFileTransferProgress>();
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue(HOST_INFO);
		vi.spyOn(fileTransfer, "prepareSshFileTransfer").mockResolvedValue(createPlan(localPath));
		vi.spyOn(fileTransfer, "executeSshFileTransfer").mockImplementation(async (_plan, options) => {
			options?.onProgress?.(progress(512 * 1024, 2_000));
			return execution.promise;
		});

		const result = await tool.execute("transfer-2", {
			op: "upload",
			host: HOST.name,
			local_path: "blob.bin",
			remote_path: "/srv/blob.bin",
			async: true,
		});
		const jobId = result.details?.async?.jobId;
		if (!jobId) throw new Error("background transfer did not return a job id");
		const job = manager.getJob(jobId);
		expect(job?.type).toBe("ssh_transfer");
		expect(job?.ownerId).toBe("Main");
		expect(job?.scopeId).toBe("scope-1");
		expect(job?.toolCallId).toBe("transfer-2");
		expect(job?.progress?.text).toContain("50.0%");
		expect(job?.progress?.details?.transferredBytes).toBe(512 * 1024);
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("delivered automatically");

		execution.resolve(progress(1024 * 1024, 4_000));
		await manager.waitForAll();
		await manager.drainDeliveries();
		expect(manager.getJob(jobId)?.status).toBe("completed");
		expect(manager.getJob(jobId)?.progress?.text).toContain("100.0%");
		expect(completions).toHaveLength(1);
	});

	it("rejects unknown hosts and internal remote URLs before SSH probing", async () => {
		const ensureHostInfo = vi.spyOn(connectionManager, "ensureHostInfo");
		const tool = new SshTransferTool(createSession(), [HOST.name], new Map([[HOST.name, HOST]]), "fixture");

		await expect(
			tool.execute("unknown", {
				op: "upload",
				host: "missing",
				local_path: "blob.bin",
				remote_path: "/srv/blob.bin",
			}),
		).rejects.toThrow(/Unknown SSH host/);
		await expect(
			tool.execute("internal", {
				op: "upload",
				host: HOST.name,
				local_path: "blob.bin",
				remote_path: "local://blob.bin",
			}),
		).rejects.toThrow(/filesystem paths/);
		expect(ensureHostInfo).not.toHaveBeenCalled();
	});

	it("uses the last progress snapshot in the defensive abort fallback", () => {
		const tool = new SshTransferTool(createSession(), [HOST.name], new Map([[HOST.name, HOST]]), "fixture");
		const result = tool.createAbortedResult("transfer-3", {
			op: "download",
			host: HOST.name,
			local_path: "blob.bin",
			remote_path: "/srv/blob.bin",
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(result.details?.status).toBe("cancelled");
		expect(text).toContain("Cleanup deadline exceeded after 12 seconds");
		expect(text).not.toContain("password");
	});
});

type TestStdin = "pipe" | "ignore" | Buffer | Uint8Array | null;

function remoteChild<In extends TestStdin>(output: Uint8Array, accepted?: Uint8Array[]): ChildProcess<In> {
	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			if (output.byteLength > 0) controller.enqueue(output);
			controller.close();
		},
	});
	return {
		stdin: {
			write(chunk: Uint8Array) {
				accepted?.push(chunk.slice());
				return chunk.byteLength;
			},
			end() {},
		},
		stdout,
		bytes: async () => output,
		exited: Promise.resolve(0),
		exitedCleanly: Promise.resolve(0),
		kill() {},
		[Symbol.dispose]() {},
	} as unknown as ChildProcess<In>;
}

describe("SSH transfer local file-backed URLs", () => {
	let directory: string;
	let session: ToolSession;
	const payload = new Uint8Array([0, 255, 195, 40, 128, 65]);

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ssh-transfer-urls-"));
		session = {
			...createSession(),
			cwd: directory,
			getSessionFile: () => null,
			getArtifactsDir: () => path.join(directory, "artifacts"),
		} as ToolSession;
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue(HOST_INFO);
		vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockResolvedValue({ args: ["fixture"] });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(directory, { recursive: true, force: true });
	});

	for (const pinned of [false, true]) {
		it(`uploads local:// binary bytes from the ${pinned ? "pinned parent" : "calling session"} root`, async () => {
			const artifacts = path.join(directory, pinned ? "parent-artifacts" : "artifacts");
			if (pinned) {
				session.localProtocolOptions = {
					getArtifactsDir: () => artifacts,
					getSessionId: () => "parent",
				};
				await fs.mkdir(path.join(directory, "artifacts", "local"), { recursive: true });
				await fs.writeFile(path.join(directory, "artifacts", "local", "blob.bin"), "wrong-session");
			}
			const source = path.join(artifacts, "local", "blob.bin");
			await fs.mkdir(path.dirname(source), { recursive: true });
			await fs.writeFile(source, payload);
			const accepted: Uint8Array[] = [];
			let spawnIndex = 0;
			vi.spyOn(ptree, "spawn").mockImplementation(<In extends TestStdin>() => {
				spawnIndex++;
				if (spawnIndex === 1) return remoteChild<In>(new TextEncoder().encode("missing"));
				if (spawnIndex === 2) return remoteChild<In>(new Uint8Array(), accepted);
				return remoteChild<In>(new TextEncoder().encode("OMP_TRANSFER_COMMITTED\n"));
			});
			const tool = new SshTransferTool(session, [HOST.name], new Map([[HOST.name, HOST]]), "fixture");

			const result = await tool.execute("local-upload", {
				op: "upload",
				host: HOST.name,
				local_path: "local://blob.bin",
				remote_path: "/srv/blob.bin",
			});

			expect(result.details?.status).toBe("completed");
			expect(Buffer.concat(accepted)).toEqual(Buffer.from(payload));
			expect(await fs.readFile(source)).toEqual(Buffer.from(payload));
			expect(result.details?.localPath).toBe(source);
		});
	}

	it("downloads bytes into a new mutable local:// destination without URL materialization", async () => {
		let spawnIndex = 0;
		vi.spyOn(ptree, "spawn").mockImplementation(<In extends TestStdin>() => {
			return remoteChild<In>(spawnIndex++ === 0 ? new TextEncoder().encode(String(payload.byteLength)) : payload);
		});
		const tool = new SshTransferTool(session, [HOST.name], new Map([[HOST.name, HOST]]), "fixture");

		const result = await tool.execute("local-download", {
			op: "download",
			host: HOST.name,
			local_path: "local://nested/download.bin",
			remote_path: "/srv/blob.bin",
		});

		expect(result.details?.status).toBe("completed");
		expect(await fs.readFile(path.join(directory, "artifacts", "local", "nested", "download.bin"))).toEqual(
			Buffer.from(payload),
		);
		expect(await fs.readdir(path.join(directory, "artifacts", "local", "nested"))).toEqual(["download.bin"]);
	});

	it("rejects readonly, remote and selected download URLs before touching SSH", async () => {
		const spawn = vi.spyOn(ptree, "spawn");
		const tool = new SshTransferTool(session, [HOST.name], new Map([[HOST.name, HOST]]), "fixture");
		for (const localPath of ["artifact://1", "ssh://fixture/srv/blob.bin", "agent://Main", "local://out.bin:1-2"]) {
			await expect(
				tool.execute("invalid-local-download", {
					op: "download",
					host: HOST.name,
					local_path: localPath,
					remote_path: "/srv/blob.bin",
				}),
			).rejects.toBeInstanceOf(ToolError);
		}
		expect(spawn).not.toHaveBeenCalled();
		expect(await fs.readdir(directory)).toEqual([]);
	});

	it("rejects a local:// symlink escape before any remote I/O", async () => {
		const outside = path.join(directory, "outside");
		const root = path.join(directory, "artifacts", "local");
		await fs.mkdir(outside);
		await fs.mkdir(root, { recursive: true });
		await fs.writeFile(path.join(outside, "blob.bin"), payload);
		await fs.symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
		const spawn = vi.spyOn(ptree, "spawn");
		const tool = new SshTransferTool(session, [HOST.name], new Map([[HOST.name, HOST]]), "fixture");

		await expect(
			tool.execute("escaped-local-upload", {
				op: "upload",
				host: HOST.name,
				local_path: "local://linked/blob.bin",
				remote_path: "/srv/blob.bin",
			}),
		).rejects.toThrow(/escapes local root/);

		expect(spawn).not.toHaveBeenCalled();
		expect(await fs.readFile(path.join(outside, "blob.bin"))).toEqual(Buffer.from(payload));
	});

	it("keeps a local:// abort fallback addressable before a progress snapshot exists", () => {
		const tool = new SshTransferTool(session, [HOST.name], new Map([[HOST.name, HOST]]), "fixture");
		const result = tool.createAbortedResult("local-abort", {
			op: "download",
			host: HOST.name,
			local_path: "local://download.bin",
			remote_path: "/srv/blob.bin",
		});
		expect(result.details?.status).toBe("cancelled");
		expect(result.details?.localPath).toBe("local://download.bin");
	});
});
