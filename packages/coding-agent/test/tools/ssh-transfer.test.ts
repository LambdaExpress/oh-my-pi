import { afterEach, describe, expect, it, vi } from "bun:test";
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

	it("rejects unknown hosts and internal URLs before SSH probing", async () => {
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
				local_path: "local://blob.bin",
				remote_path: "/srv/blob.bin",
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
