import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SSHHost } from "@oh-my-pi/pi-coding-agent/capability/ssh";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { SshTransferTool } from "@oh-my-pi/pi-coding-agent/tools/ssh-transfer";

const SSH_OK = (() => {
	try {
		const result = Bun.spawnSync(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=4", "localhost", "true"]);
		return result.exitCode === 0;
	} catch {
		return false;
	}
})();

const SOURCE: SourceMeta = {
	provider: "session",
	providerName: "Session",
	path: "session://ssh-transfer-localhost-e2e",
	level: "project",
};
const LOCALHOST: SSHHost = {
	name: "localhost",
	host: "localhost",
	_source: SOURCE,
};
const TEMPORARY_ALIAS: SSHHost = {
	name: "temporary-localhost",
	host: "localhost",
	connectionId: `ssh-transfer-e2e-${process.pid}`,
	_source: SOURCE,
};
const REMOTE_DIR = `/tmp/omp-ssh-transfer-${process.pid}`;
let localDir = "";

function createSession(): ToolSession {
	return {
		cwd: localDir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getPlanModeState: () => undefined,
		settings: Settings.isolated({ "async.enabled": true }),
	};
}

async function runRemote(script: string): Promise<void> {
	await Bun.$`ssh -o BatchMode=yes localhost ${script}`.quiet();
}

describe.skipIf(!SSH_OK)("SSH transfer against a real localhost SSH server", () => {
	beforeAll(async () => {
		localDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ssh-transfer-e2e-"));
		await runRemote(`rm -rf ${REMOTE_DIR}; mkdir -p ${REMOTE_DIR}`);
	});

	afterAll(async () => {
		await Bun.$`ssh -o BatchMode=yes localhost rm -rf ${REMOTE_DIR}`.nothrow().quiet();
		if (localDir) await fs.rm(localDir, { recursive: true, force: true });
	});

	it("round-trips binary and empty files through direct and temporary-alias hosts", async () => {
		const session = createSession();
		const hosts = new Map([
			[LOCALHOST.name, LOCALHOST],
			[TEMPORARY_ALIAS.name, TEMPORARY_ALIAS],
		]);
		const tool = new SshTransferTool(session, [...hosts.keys()], hosts, "localhost e2e");
		const uploadPath = path.join(localDir, "upload.bin");
		const downloadPath = path.join(localDir, "download.bin");
		const replacementPath = path.join(localDir, "replacement.bin");
		const replacementDownloadPath = path.join(localDir, "replacement-download.bin");
		const emptyUploadPath = path.join(localDir, "empty.bin");
		const emptyDownloadPath = path.join(localDir, "empty-download.bin");
		const payload = new Uint8Array(160 * 1024 + 17);
		for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 131 + 17) & 0xff;
		payload.set([0x00, 0xff, 0xc3, 0x28, 0x80], 97);
		const replacement = new Uint8Array([0xff, 0x00, 0x80, 0x41, 0x42, 0x43]);
		await Bun.write(uploadPath, payload);
		await Bun.write(replacementPath, replacement);
		await Bun.write(emptyUploadPath, new Uint8Array());

		const upload = await tool.execute("localhost-upload", {
			op: "upload",
			host: LOCALHOST.name,
			local_path: uploadPath,
			remote_path: `${REMOTE_DIR}/payload.bin`,
		});
		expect(upload.details?.status).toBe("completed");
		expect(upload.details?.transferredBytes).toBe(payload.byteLength);

		const download = await tool.execute("alias-download", {
			op: "download",
			host: TEMPORARY_ALIAS.name,
			local_path: downloadPath,
			remote_path: `${REMOTE_DIR}/payload.bin`,
		});
		expect(download.details?.status).toBe("completed");
		expect(new Uint8Array(await Bun.file(downloadPath).arrayBuffer())).toEqual(payload);

		const conflict = await tool.execute("default-conflict", {
			op: "upload",
			host: TEMPORARY_ALIAS.name,
			local_path: replacementPath,
			remote_path: `${REMOTE_DIR}/payload.bin`,
		});
		expect(conflict.details?.status).toBe("failed");
		expect(conflict.details?.error).toMatch(/already exists|overwrite/i);

		const overwrite = await tool.execute("explicit-overwrite", {
			op: "upload",
			host: TEMPORARY_ALIAS.name,
			local_path: replacementPath,
			remote_path: `${REMOTE_DIR}/payload.bin`,
			overwrite: true,
		});
		expect(overwrite.details?.status).toBe("completed");
		const replacementDownload = await tool.execute("replacement-download", {
			op: "download",
			host: LOCALHOST.name,
			local_path: replacementDownloadPath,
			remote_path: `${REMOTE_DIR}/payload.bin`,
		});
		expect(replacementDownload.details?.status).toBe("completed");
		expect(new Uint8Array(await Bun.file(replacementDownloadPath).arrayBuffer())).toEqual(replacement);

		const emptyUpload = await tool.execute("alias-empty-upload", {
			op: "upload",
			host: TEMPORARY_ALIAS.name,
			local_path: emptyUploadPath,
			remote_path: `${REMOTE_DIR}/empty.bin`,
		});
		expect(emptyUpload.details?.status).toBe("completed");
		expect(emptyUpload.details?.totalBytes).toBe(0);
		const emptyDownload = await tool.execute("localhost-empty-download", {
			op: "download",
			host: LOCALHOST.name,
			local_path: emptyDownloadPath,
			remote_path: `${REMOTE_DIR}/empty.bin`,
		});
		expect(emptyDownload.details?.status).toBe("completed");
		expect((await Bun.file(emptyDownloadPath).arrayBuffer()).byteLength).toBe(0);

		const listing = await Bun.$`ssh -o BatchMode=yes localhost ls -A ${REMOTE_DIR}`.text();
		expect(
			listing
				.split(/\r?\n/)
				.filter(Boolean)
				.some(name => name.startsWith(".omp-transfer-")),
		).toBe(false);
	});
});
