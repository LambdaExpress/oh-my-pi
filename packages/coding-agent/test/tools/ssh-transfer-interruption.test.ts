import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SSHConnectionTarget } from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import * as connectionManager from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import {
	executeSshFileTransfer,
	prepareSshFileTransfer,
	SshFileTransferCancelledError,
	SshFileTransferPreparationError,
	type SshFileTransferPlan,
	type SshFileTransferProgress,
} from "@oh-my-pi/pi-coding-agent/ssh/file-transfer";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { SshTransferTool } from "@oh-my-pi/pi-coding-agent/tools/ssh-transfer";
import { $which, ptree } from "@oh-my-pi/pi-utils";

const HOST: SSHConnectionTarget = { name: "interrupted-transfer", host: "fixture.invalid" };
const ID = "00000000-0000-4000-8000-000000000018";
const TRANSPORT_STDERR = "Connection closed by jump.invalid port 22\nConnection closed by UNKNOWN port 65535\n";
const POSIX_SHELL = process.platform === "win32" ? undefined : $which("sh");
const POWERSHELL = process.platform === "win32" ? $which("pwsh") : undefined;
let directory: string;

function invocation(script: string) {
	return { executable: process.execPath, args: ["-e", script] };
}

function session(manager?: AsyncJobManager): ToolSession {
	return {
		cwd: directory,
		settings: Settings.isolated({ "async.enabled": true }),
		asyncJobManager: manager,
		getAgentId: () => "Main",
		getAgentScopeId: () => "interrupted-transfer",
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

function plan(operation: "upload" | "download", localPath: string, remotePath: string, totalBytes: number) {
	return {
		operation,
		target: HOST,
		localPath,
		remotePath,
		totalBytes,
		overwrite: true,
		commitStrategy: operation === "download" ? "local-native" : "remote-posix-mv",
	} satisfies SshFileTransferPlan;
}

async function partialFiles(parent: string): Promise<string[]> {
	return (await fs.readdir(parent))
		.filter(name => name.startsWith(".omp-transfer-") && name.endsWith(".part"))
		.map(name => path.join(parent, name));
}

function downloadInvocation(source: string, length: number, exitCode = 255) {
	return invocation(`
const source = await Bun.file(${JSON.stringify(source)}).bytes();
const output = source.subarray(0, ${length});
if (output.byteLength > 0) await Bun.write(Bun.stdout, output);
await Bun.write(Bun.stderr, ${JSON.stringify(TRANSPORT_STDERR)});
process.exit(${exitCode});
`);
}

beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-interrupted-transfer-"));
	vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
	vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
		version: 7,
		os: "linux",
		shell: "sh",
		transferShell: "sh",
		compatEnabled: false,
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(directory, { recursive: true, force: true });
});

describe("SSH transfer preflight diagnostics", () => {
	for (const operation of ["upload", "download"] as const) {
		it(`recovers a ${operation} preflight after a transient SSH probe disconnect`, async () => {
			const source = path.join(directory, "source.bin");
			const destination = path.join(directory, "destination.bin");
			const payload = Buffer.from("source bytes\0\xff");
			await fs.writeFile(source, payload);
			const transportStderr =
				operation === "upload"
					? TRANSPORT_STDERR
					: "kex_exchange_identification: read: Unknown error\nbanner exchange: Connection to 127.0.0.1 port 22: Unknown error\n";
			let probes = 0;
			vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockImplementation(async () => {
				if (probes++ === 0) {
					return invocation(`
await Bun.write(Bun.stderr, ${JSON.stringify(transportStderr)});
process.exit(255);
`);
				}
				return invocation(`console.log(${JSON.stringify(operation === "upload" ? "missing" : payload.length)})`);
			});

			const prepared = await prepareSshFileTransfer({
				operation,
				target: HOST,
				localPath: operation === "upload" ? source : destination,
				remotePath: "/tmp/remote.bin",
				overwrite: false,
			});

			expect(prepared).toMatchObject({ totalBytes: payload.length, commitStrategy: "no-replace" });
			expect(probes).toBe(2);
			expect(await fs.readFile(source)).toEqual(payload);
			expect(await Bun.file(destination).exists()).toBe(false);
			expect(await partialFiles(directory)).toEqual([]);
		});
	}

	it("retries a transient failure while establishing the SSH connection", async () => {
		const source = path.join(directory, "source.bin");
		await fs.writeFile(source, "source bytes");
		const connect = vi
			.spyOn(connectionManager, "ensureConnection")
			.mockRejectedValueOnce(new Error("Failed to start SSH master for fixture.invalid: Connection reset by peer"))
			.mockResolvedValue(undefined);
		vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockResolvedValue(
			invocation(`console.log("missing")`),
		);

		const prepared = await prepareSshFileTransfer({
			operation: "upload",
			target: HOST,
			localPath: source,
			remotePath: "/tmp/destination.bin",
			overwrite: false,
		});

		expect(prepared.totalBytes).toBe(Buffer.byteLength("source bytes"));
		expect(connect).toHaveBeenCalledTimes(2);
		expect(await partialFiles(directory)).toEqual([]);
	});

	it("keeps the known upload source size when the SSH route fails before staging", async () => {
		const source = path.join(directory, "source.bin");
		const payload = Buffer.alloc(4096, 0x71);
		await fs.writeFile(source, payload);
		let now = 1_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const connect = vi.spyOn(connectionManager, "ensureConnection").mockImplementation(async () => {
			now = 1_750;
			throw new ptree.NonZeroExitError(255, TRANSPORT_STDERR);
		});
		const build = vi.spyOn(connectionManager, "buildRemoteCommandInvocation");
		const tool = new SshTransferTool(session(), [HOST.name], new Map([[HOST.name, HOST]]), "fixture");

		const result = await tool.execute("preflight-upload", {
			op: "upload",
			host: HOST.name,
			local_path: source,
			remote_path: "/tmp/destination.bin",
			overwrite: true,
		});

		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({
			status: "failed",
			totalBytes: payload.length,
			transferredBytes: 0,
			elapsedMs: 750,
		});
		expect(result.details?.error).toContain("preflight");
		expect(result.details?.error).toContain("255");
		expect(result.details?.error).toContain("jump.invalid");
		expect(result.details?.error).toMatch(/intermediate|jump|proxy/);
		expect(result.details?.error).toMatch(/destination.*not modified|did not modify.*destination/);
		expect(result.details?.error).toContain("3 attempts");
		expect(connect).toHaveBeenCalledTimes(3);
		expect(build).not.toHaveBeenCalled();
		expect(await fs.readFile(source)).toEqual(payload);
	});

	for (const [exitCode, stderr] of [
		[255, "Permission denied (publickey).\nConnection closed by jump.invalid port 22"],
		[255, "Host key verification failed.\nConnection closed by UNKNOWN port 65535"],
		[1, "remote probe failed: Connection reset by peer"],
	] as const) {
		it(`does not retry a permanent preflight failure: ${stderr.split("\n")[0]}`, async () => {
			const source = path.join(directory, "source.bin");
			await fs.writeFile(source, "source bytes");
			const build = vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockResolvedValue(
				invocation(`
await Bun.write(Bun.stderr, ${JSON.stringify(stderr)});
process.exit(${exitCode});
`),
			);

			const error = await prepareSshFileTransfer({
				operation: "upload",
				target: HOST,
				localPath: source,
				remotePath: "/tmp/destination.bin",
				overwrite: false,
			}).catch(error => error);

			expect(error).toBeInstanceOf(SshFileTransferPreparationError);
			expect(error.cause).toBeInstanceOf(ptree.NonZeroExitError);
			expect(error.cause.exitCode).toBe(exitCode);
			expect(build).toHaveBeenCalledTimes(1);
			expect(await fs.readFile(source, "utf8")).toBe("source bytes");
			expect(await partialFiles(directory)).toEqual([]);
		});
	}

	it("stops retrying when cancelled during preflight backoff", async () => {
		const source = path.join(directory, "source.bin");
		await fs.writeFile(source, "source bytes");
		const controller = new AbortController();
		const disconnected = Promise.withResolvers<void>();
		const connect = vi.spyOn(connectionManager, "ensureConnection").mockImplementation(async () => {
			disconnected.resolve();
			throw new ptree.NonZeroExitError(255, TRANSPORT_STDERR);
		});
		const preparation = prepareSshFileTransfer({
			operation: "upload",
			target: HOST,
			localPath: source,
			remotePath: "/tmp/destination.bin",
			overwrite: false,
			signal: controller.signal,
		});
		await disconnected.promise;
		await Bun.sleep(0);
		controller.abort();

		const error = await preparation.catch(error => error);
		expect(error).toBeInstanceOf(SshFileTransferPreparationError);
		expect(error.cause.name).toBe("AbortError");
		expect(connect).toHaveBeenCalledTimes(1);
		expect(await partialFiles(directory)).toEqual([]);
	});

	it("keeps a download size already measured before a local destination conflict", async () => {
		const source = path.join(directory, "remote-source.bin");
		const destination = path.join(directory, "destination.bin");
		const payload = Buffer.from("remote source bytes");
		await fs.writeFile(source, payload);
		await fs.writeFile(destination, "existing destination");
		vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockResolvedValue(
			invocation(`console.log(Bun.file(${JSON.stringify(source)}).size)`),
		);
		const tool = new SshTransferTool(session(), [HOST.name], new Map([[HOST.name, HOST]]), "fixture");

		const result = await tool.execute("preflight-download", {
			op: "download",
			host: HOST.name,
			local_path: destination,
			remote_path: "/tmp/source.bin",
		});

		expect(result.details).toMatchObject({ status: "failed", totalBytes: payload.length, transferredBytes: 0 });
		expect(result.details?.error).toContain("already exists");
		expect(await fs.readFile(destination, "utf8")).toBe("existing destination");
		expect(await fs.readFile(source)).toEqual(payload);
		expect(await partialFiles(directory)).toEqual([]);
	});
});

describe("SSH transfers with real failing subprocesses", () => {
	for (const existingDestination of [false, true]) {
		it(`retains an interrupted download and ${existingDestination ? "preserves an existing" : "does not create a final"} destination`, async () => {
			const source = path.join(directory, "remote-source.bin");
			const destination = path.join(directory, "destination.bin");
			const payload = Buffer.from("byte-exact remote source\0\xff");
			const acceptedBytes = 9;
			await fs.writeFile(source, payload);
			if (existingDestination) await fs.writeFile(destination, "previous destination");
			vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockResolvedValue(
				downloadInvocation(source, acceptedBytes),
			);
			const progress: SshFileTransferProgress[] = [];

			const error = await executeSshFileTransfer(plan("download", destination, "/tmp/source.bin", payload.length), {
				onProgress: update => progress.push(update),
			}).catch(error => error);

			expect(error).toBeInstanceOf(Error);
			expect(error.message).toContain("Process exited with code 255");
			expect(error.message).toContain("jump.invalid");
			expect(error.message).toContain("before commit");
			expect(error.message).toMatch(/retained/i);
			const partials = await partialFiles(directory);
			expect(partials).toHaveLength(1);
			expect(error.message).toContain(partials[0]);
			expect(await fs.readFile(partials[0]!)).toEqual(payload.subarray(0, acceptedBytes));
			expect(await fs.readFile(source)).toEqual(payload);
			if (existingDestination) {
				expect(await fs.readFile(destination, "utf8")).toBe("previous destination");
			} else {
				expect(await Bun.file(destination).exists()).toBe(false);
			}
			expect(progress.at(-1)).toMatchObject({ transferredBytes: acceptedBytes, totalBytes: payload.length });
		});
	}

	it("removes an empty failed download stage and reports that no recoverable bytes remain", async () => {
		const source = path.join(directory, "remote-source.bin");
		const destination = path.join(directory, "destination.bin");
		await fs.writeFile(source, "unchanged source");
		await fs.writeFile(destination, "previous destination");
		vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockResolvedValue(downloadInvocation(source, 0));

		const error = await executeSshFileTransfer(plan("download", destination, "/tmp/source.bin", 16)).catch(
			error => error,
		);

		expect(error.message).toMatch(/empty.*removed/i);
		expect(error.message).toContain("255");
		expect(await partialFiles(directory)).toEqual([]);
		expect(await fs.readFile(destination, "utf8")).toBe("previous destination");
	});

	it("keeps the actual exit 255 and partial upload when the local write also encounters a closed pipe", async () => {
		const source = path.join(directory, "source.bin");
		const destination = path.join(directory, "destination.bin").replaceAll("\\", "/");
		const stage = path.join(directory, `.omp-transfer-${ID}.part`);
		const payload = Buffer.alloc(512 * 1024, 0x63);
		await fs.writeFile(source, payload);
		await fs.writeFile(destination, "previous destination");
		vi.spyOn(crypto, "randomUUID").mockReturnValue(ID);
		const build = vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockResolvedValue(
			invocation(`
const reader = Bun.stdin.stream().getReader();
const { value } = await reader.read();
const partial = value.subarray(0, 17);
await Bun.write(${JSON.stringify(stage)}, partial);
await Bun.write(Bun.stdout, "OMP_TRANSFER_PROGRESS " + partial.length + "\\n");
await Bun.write(Bun.stderr, ${JSON.stringify(TRANSPORT_STDERR)});
process.exit(255);
`),
		);
		const progress: SshFileTransferProgress[] = [];

		const error = await executeSshFileTransfer(plan("upload", source, destination, payload.length), {
			onProgress: update => progress.push(update),
		}).catch(error => error);

		expect(error.message).toContain("Process exited with code 255");
		expect(error.message).toContain("jump.invalid");
		expect(error.message).toContain("commit was not attempted");
		expect(error.message).toContain(stage.replaceAll("\\", "/"));
		expect(error.message).toMatch(/retained|not deleted/i);
		expect(await fs.readFile(stage)).toEqual(payload.subarray(0, 17));
		expect(await fs.readFile(source)).toEqual(payload);
		expect(await fs.readFile(destination, "utf8")).toBe("previous destination");
		expect(progress.at(-1)).toMatchObject({ transferredBytes: 17, totalBytes: payload.length });
		expect(build).toHaveBeenCalledTimes(1);
	});

	it("removes an interrupted partial download on explicit cancellation", async () => {
		const source = path.join(directory, "remote-source.bin");
		const destination = path.join(directory, "destination.bin");
		const payload = Buffer.from("read-only remote source bytes");
		await fs.writeFile(source, payload);
		await fs.writeFile(destination, "previous destination");
		const controller = new AbortController();
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => (now += 300));
		vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockResolvedValue(
			invocation(`
Bun.serve({ port: 0, fetch: () => new Response("fixture") });
await Bun.write(Bun.stdout, (await Bun.file(${JSON.stringify(source)}).bytes()).subarray(0, 7));
`),
		);

		const error = await executeSshFileTransfer(plan("download", destination, "/tmp/source.bin", payload.length), {
			signal: controller.signal,
			onProgress: update => {
				if (update.transferredBytes > 0) controller.abort(new Error("explicit fixture cancellation"));
			},
		}).catch(error => error);

		expect(error).toBeInstanceOf(SshFileTransferCancelledError);
		expect(error.message).toMatch(/removed/i);
		expect(await partialFiles(directory)).toEqual([]);
		expect(await fs.readFile(source)).toEqual(payload);
		expect(await fs.readFile(destination, "utf8")).toBe("previous destination");
	});

	it("removes an interrupted partial upload on explicit cancellation", async () => {
		const source = path.join(directory, "source.bin");
		const destination = path.join(directory, "destination.bin").replaceAll("\\", "/");
		const stage = path.join(directory, `.omp-transfer-${ID}.part`);
		const payload = Buffer.alloc(512 * 1024, 0x73);
		await fs.writeFile(source, payload);
		await fs.writeFile(destination, "previous destination");
		vi.spyOn(crypto, "randomUUID").mockReturnValue(ID);
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => (now += 300));
		const controller = new AbortController();
		let invocationIndex = 0;
		vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockImplementation(async () => {
			if (invocationIndex++ > 0) {
				return invocation(`await Bun.file(${JSON.stringify(stage)}).delete()`);
			}
			return invocation(`
Bun.serve({ port: 0, fetch: () => new Response("fixture") });
const reader = Bun.stdin.stream().getReader();
const { value } = await reader.read();
await Bun.write(${JSON.stringify(stage)}, value.subarray(0, 17));
await Bun.write(Bun.stdout, "OMP_TRANSFER_PROGRESS 17\\n");
`);
		});

		const error = await executeSshFileTransfer(plan("upload", source, destination, payload.length), {
			signal: controller.signal,
			onProgress: update => {
				if (update.transferredBytes > 0) controller.abort(new Error("explicit fixture cancellation"));
			},
		}).catch(error => error);

		expect(error).toBeInstanceOf(SshFileTransferCancelledError);
		expect(error.message).toMatch(/artifacts were removed/i);
		expect(await partialFiles(directory)).toEqual([]);
		expect(await fs.readFile(source)).toEqual(payload);
		expect(await fs.readFile(destination, "utf8")).toBe("previous destination");
	});

	it("delivers failed background progress with the real byte count and retained download path", async () => {
		const source = path.join(directory, "remote-source.bin");
		const destination = path.join(directory, "destination.bin");
		const payload = Buffer.from("background remote evidence");
		await fs.writeFile(source, payload);
		const manager = new AsyncJobManager({});
		const deliveries: string[] = [];
		manager.registerDeliverySink("Main", async (_jobId, text) => {
			deliveries.push(text);
		});
		let invocationIndex = 0;
		vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockImplementation(async () => {
			if (invocationIndex++ === 0) return invocation(`console.log(${payload.length})`);
			return downloadInvocation(source, 7);
		});
		const tool = new SshTransferTool(session(manager), [HOST.name], new Map([[HOST.name, HOST]]), "fixture");

		const result = await tool.execute("async-download", {
			op: "download",
			host: HOST.name,
			local_path: destination,
			remote_path: "/tmp/source.bin",
			async: true,
		});
		const jobId = result.details?.async?.jobId;
		if (!jobId) throw new Error("missing background job id");
		await manager.waitForAll();
		await manager.drainDeliveries();

		const details = manager.getJob(jobId)?.progress?.details;
		expect(details).toMatchObject({ status: "failed", totalBytes: payload.length, transferredBytes: 7 });
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]).toContain("255");
		const partials = await partialFiles(directory);
		expect(partials).toHaveLength(1);
		expect(deliveries[0]).toContain(partials[0]);
		expect(await fs.readFile(partials[0]!)).toEqual(payload.subarray(0, 7));
		expect(await Bun.file(destination).exists()).toBe(false);
	});
});

describe("interrupted generated remote stage scripts", () => {
	it.skipIf(!POSIX_SHELL)("retains bytes when the actual POSIX stage receives SIGHUP", async () => {
		const source = path.join(directory, "source.bin");
		const destination = path.join(directory, "destination.bin");
		const stage = path.join(directory, `.omp-transfer-${ID}.part`);
		const payload = Buffer.alloc(512 * 1024, 0x79);
		await fs.writeFile(source, payload);
		await fs.writeFile(destination, "previous destination");
		vi.spyOn(crypto, "randomUUID").mockReturnValue(ID);
		let invocationIndex = 0;
		vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockImplementation(async (_target, command) => {
			if (invocationIndex++ > 0) return { executable: POSIX_SHELL!, args: ["-c", command] };
			return invocation(`
const child = Bun.spawn([${JSON.stringify(POSIX_SHELL)}, "-c", ${JSON.stringify(command)}], {
	stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true,
});
const stderr = new Response(child.stderr).text();
const reader = Bun.stdin.stream().getReader();
const { value } = await reader.read();
await child.stdin.write(value.subarray(0, 17));
await child.stdin.flush();
let observed = "";
let interrupted = false;
for await (const chunk of child.stdout) {
	await Bun.write(Bun.stdout, chunk);
	observed = (observed + new TextDecoder().decode(chunk)).slice(-256);
	if (!interrupted && /OMP_TRANSFER_PROGRESS [1-9]/.test(observed)) {
		interrupted = true;
		process.kill(-child.pid, "SIGHUP");
	}
}
await child.exited;
await Bun.write(Bun.stderr, await stderr);
await Bun.write(Bun.stderr, ${JSON.stringify(TRANSPORT_STDERR)});
process.exit(255);
`);
		});

		const error = await executeSshFileTransfer(plan("upload", source, destination, payload.length)).catch(
			error => error,
		);

		expect(error.message).toContain("255");
		expect(error.message).toContain(stage);
		expect(await fs.readFile(stage)).toEqual(payload.subarray(0, 17));
		expect(await fs.readFile(source)).toEqual(payload);
		expect(await fs.readFile(destination, "utf8")).toBe("previous destination");
	});

	it.skipIf(!POWERSHELL)(
		"retains bytes when the actual PowerShell stage throws after flushing",
		async () => {
			const source = path.join(directory, "source.bin");
			const destination = path.join(directory, "destination.bin");
			const stage = path.join(directory, `.omp-transfer-${ID}.part`);
			const payload = Buffer.from([0, 255, 128, 1, 2, 3]);
			await fs.writeFile(source, payload);
			await fs.writeFile(destination, "previous destination");
			vi.spyOn(crypto, "randomUUID").mockReturnValue(ID);
			vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
				version: 7,
				os: "windows",
				shell: "powershell",
				powerShellCommand: "pwsh",
				compatEnabled: false,
			});
			vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockImplementation(async (_target, command) => {
				const encoded = command.slice("pwsh -NoProfile -NonInteractive -EncodedCommand ".length);
				const script = Buffer.from(encoded, "base64")
					.toString("utf16le")
					.replace("$stream.Flush($true)", "$stream.Flush($true)\nthrow 'injected remote stage failure'");
				return {
					executable: POWERSHELL!,
					args: [
						"-NoProfile",
						"-NonInteractive",
						"-EncodedCommand",
						connectionManager.encodePowerShellScript(script),
					],
				};
			});

			const error = await executeSshFileTransfer({
				...plan("upload", source, destination, payload.length),
				commitStrategy: "remote-windows-replace",
			}).catch(error => error);

			expect(error.message).toContain("injected remote stage failure");
			expect(error.message).not.toContain("SSH transport exited with status 255");
			expect(error.message).toContain(stage);
			expect(await fs.readFile(stage)).toEqual(payload);
			expect(await fs.readFile(source)).toEqual(payload);
			expect(await fs.readFile(destination, "utf8")).toBe("previous destination");
		},
		20_000,
	);
});
