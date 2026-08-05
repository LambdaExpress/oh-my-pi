import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SSHConnectionTarget } from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import * as connectionManager from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import {
	executeSshFileTransfer,
	prepareSshFileTransfer,
	SshFileTransferCancelledError,
	type SshFileTransferPlan,
	type SshFileTransferProgress,
} from "@oh-my-pi/pi-coding-agent/ssh/file-transfer";
import type { ChildProcess } from "@oh-my-pi/pi-utils";
import { ptree } from "@oh-my-pi/pi-utils";

type TestStdin = "pipe" | "ignore" | Buffer | Uint8Array | null;

interface MockSink {
	write(chunk: Uint8Array): number | Promise<number>;
	end(): void | Promise<void>;
}

interface MockChildOptions {
	stdout?: Uint8Array[];
	sink?: MockSink;
	onKill?: () => void;
	exitError?: Error;
}

function readableChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

function createChild<In extends TestStdin>(options: MockChildOptions = {}): ChildProcess<In> {
	const sink = options.sink ?? { write: (chunk: Uint8Array) => chunk.byteLength, end() {} };
	const stdout = readableChunks(options.stdout ?? []);
	const bytes = async () => {
		const body = await new Response(stdout).bytes();
		return body instanceof Uint8Array ? body : new Uint8Array(body);
	};
	const child = {
		stdin: sink,
		stdout,
		exited: Promise.resolve(options.exitError ? 1 : 0),
		exitedCleanly: options.exitError ? Promise.reject(options.exitError) : Promise.resolve(0),
		bytes,
		kill: options.onKill ?? (() => undefined),
		[Symbol.dispose]() {},
	};
	// Bun's ChildProcess type includes runtime-only members irrelevant to this transport fixture.
	return child as unknown as ChildProcess<In>;
}

function chunkPayload(payload: Uint8Array, sizes: number[]): Uint8Array[] {
	const chunks: Uint8Array[] = [];
	let offset = 0;
	let index = 0;
	while (offset < payload.byteLength) {
		const size = sizes[index % sizes.length] ?? payload.byteLength;
		chunks.push(payload.subarray(offset, Math.min(payload.byteLength, offset + size)));
		offset += size;
		index++;
	}
	return chunks;
}

function binaryPayload(size: number): Uint8Array {
	const payload = new Uint8Array(size);
	for (let index = 0; index < payload.byteLength; index++) payload[index] = (index * 131 + 0xff) & 0xff;
	payload[0] = 0;
	payload[1] = 0xff;
	payload[2] = 0xc3;
	payload[3] = 0x28;
	return payload;
}

const target: SSHConnectionTarget = { name: "fixture", host: "fixture.invalid" };
let testDir: string;

beforeEach(async () => {
	testDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ssh-transfer-core-"));
	vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
	vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
		version: 5,
		os: "linux",
		shell: "sh",
		transferShell: "sh",
		compatEnabled: false,
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(testDir, { recursive: true, force: true });
});

function uploadPlan(localPath: string, totalBytes: number): SshFileTransferPlan {
	return {
		operation: "upload",
		target,
		localPath,
		remotePath: "/tmp/output.bin",
		totalBytes,
		overwrite: false,
		commitStrategy: "no-replace",
	};
}

function downloadPlan(localPath: string, totalBytes: number): SshFileTransferPlan {
	return {
		operation: "download",
		target,
		localPath,
		remotePath: "/tmp/input.bin",
		totalBytes,
		overwrite: false,
		commitStrategy: "no-replace",
	};
}

describe("SSH file transfer core", () => {
	it("uploads arbitrary binary bytes through partial sink writes", async () => {
		const payload = binaryPayload(192 * 1024 + 37);
		const localPath = path.join(testDir, "upload.bin");
		await fs.writeFile(localPath, payload);
		const accepted: Uint8Array[] = [];
		const progress: SshFileTransferProgress[] = [];
		const cleanup = vi.fn(async () => undefined);
		vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockImplementation(async (_host, command) => ({
			args: [command.includes("OMP_TRANSFER_COMMITTED") ? "commit" : "stage"],
			cleanup,
		}));
		vi.spyOn(ptree, "spawn").mockImplementation(<In extends TestStdin>(command: string[]) => {
			if (command[1] === "commit") {
				return createChild<In>({ stdout: [new TextEncoder().encode("OMP_TRANSFER_COMMITTED\n")] });
			}
			return createChild<In>({
				sink: {
					write(chunk) {
						const count = Math.max(1, Math.ceil(chunk.byteLength / 3));
						accepted.push(chunk.slice(0, count));
						return count;
					},
					end() {},
				},
			});
		});

		const result = await executeSshFileTransfer(uploadPlan(localPath, payload.byteLength), {
			onProgress: update => progress.push(update),
		});

		expect(Buffer.concat(accepted)).toEqual(Buffer.from(payload));
		expect(result.transferredBytes).toBe(payload.byteLength);
		expect(result.totalBytes).toBe(payload.byteLength);
		expect(progress[0]?.transferredBytes).toBe(0);
		expect(progress.at(-1)?.transferredBytes).toBe(payload.byteLength);
		expect(cleanup).toHaveBeenCalledTimes(2);
	});

	it("downloads irregular binary chunks through partial local writes", async () => {
		const payload = binaryPayload(160 * 1024 + 19);
		const localPath = path.join(testDir, "nested", "download.bin");
		const realOpen = fs.open.bind(fs);
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await realOpen(...args);
			const partialHandle = {
				write(buffer: Uint8Array, offset: number, length: number) {
					return handle.write(buffer, offset, Math.max(1, Math.ceil(length / 3)));
				},
				sync: () => handle.sync(),
				close: () => handle.close(),
			};
			// The production path uses only this deliberately narrowed FileHandle surface.
			return partialHandle as unknown as fs.FileHandle;
		});
		vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockResolvedValue({ args: ["download"] });
		vi.spyOn(ptree, "spawn").mockImplementation(<In extends TestStdin>() =>
			createChild<In>({ stdout: chunkPayload(payload, [1, 8193, 65537, 17]) }),
		);

		const result = await executeSshFileTransfer(downloadPlan(localPath, payload.byteLength));

		expect(await fs.readFile(localPath)).toEqual(Buffer.from(payload));
		expect(result.transferredBytes).toBe(payload.byteLength);
		expect((await fs.readdir(path.dirname(localPath))).filter(name => name.endsWith(".part"))).toEqual([]);
	});

	it("rejects a zero-byte remote sink write and cleans the stage", async () => {
		const localPath = path.join(testDir, "upload.bin");
		await fs.writeFile(localPath, new Uint8Array([1, 2, 3]));
		vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockResolvedValue({ args: ["stage"] });
		let spawnIndex = 0;
		vi.spyOn(ptree, "spawn").mockImplementation(<In extends TestStdin>() => {
			spawnIndex++;
			if (spawnIndex === 1) {
				return createChild<In>({ sink: { write: () => 0, end() {} } });
			}
			return createChild<In>();
		});

		await expect(executeSshFileTransfer(uploadPlan(localPath, 3))).rejects.toThrow(/accepted zero bytes/);
		expect(spawnIndex).toBe(2);
	});

	it("cancels before the commit gate and waits for artifact cleanup", async () => {
		const localPath = path.join(testDir, "upload.bin");
		await fs.writeFile(localPath, new Uint8Array([1, 2, 3]));
		const controller = new AbortController();
		vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockResolvedValue({ args: ["ssh"] });
		let spawnIndex = 0;
		vi.spyOn(ptree, "spawn").mockImplementation(<In extends TestStdin>() => {
			spawnIndex++;
			if (spawnIndex === 1) {
				return createChild<In>({
					sink: {
						write: chunk => chunk.byteLength,
						end() {
							controller.abort(new Error("cancel fixture"));
						},
					},
				});
			}
			return createChild<In>();
		});

		await expect(
			executeSshFileTransfer(uploadPlan(localPath, 3), { signal: controller.signal }),
		).rejects.toBeInstanceOf(SshFileTransferCancelledError);
		expect(spawnIndex).toBe(2);
	});

	it("uses commit-wins once the upload enters finalization", async () => {
		const localPath = path.join(testDir, "upload.bin");
		await fs.writeFile(localPath, new Uint8Array([1, 2, 3]));
		const controller = new AbortController();
		vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockImplementation(async (_host, command) => ({
			args: [command.includes("OMP_TRANSFER_COMMITTED") ? "commit" : "stage"],
		}));
		vi.spyOn(ptree, "spawn").mockImplementation(<In extends TestStdin>(command: string[]) => {
			if (command[1] === "commit") {
				controller.abort(new Error("late cancel"));
				return createChild<In>({ stdout: [new TextEncoder().encode("OMP_TRANSFER_COMMITTED\n")] });
			}
			return createChild<In>();
		});

		await expect(
			executeSshFileTransfer(uploadPlan(localPath, 3), { signal: controller.signal }),
		).resolves.toMatchObject({ transferredBytes: 3, totalBytes: 3 });
	});

	it("recovers a committed upload when the commit acknowledgement is lost", async () => {
		const localPath = path.join(testDir, "upload.bin");
		await fs.writeFile(localPath, new Uint8Array([1, 2, 3]));
		const commands: string[] = [];
		vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockImplementation(async (_host, command) => {
			commands.push(command);
			return { args: [`invocation-${commands.length}`] };
		});
		let spawnIndex = 0;
		vi.spyOn(ptree, "spawn").mockImplementation(<In extends TestStdin>() => {
			spawnIndex++;
			if (spawnIndex === 2) return createChild<In>({ exitError: new Error("connection lost after commit") });
			if (spawnIndex === 3) {
				return createChild<In>({ stdout: [new TextEncoder().encode("OMP_TRANSFER_COMMITTED\n")] });
			}
			return createChild<In>();
		});

		await expect(executeSshFileTransfer(uploadPlan(localPath, 3))).resolves.toMatchObject({
			transferredBytes: 3,
			totalBytes: 3,
		});
		expect(spawnIndex).toBe(3);
		expect(commands[1]).toContain('ln "$stage" "$proof"');
		expect(commands[2]).toContain('"$destination" -ef "$proof"');
	});

	it("reports finite zero-byte progress and commits an empty download", async () => {
		const localPath = path.join(testDir, "empty.bin");
		const progress: SshFileTransferProgress[] = [];
		vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockResolvedValue({ args: ["download"] });
		vi.spyOn(ptree, "spawn").mockImplementation(<In extends TestStdin>() => createChild<In>());

		const result = await executeSshFileTransfer(downloadPlan(localPath, 0), {
			onProgress: update => progress.push(update),
		});

		expect(await fs.readFile(localPath)).toEqual(Buffer.alloc(0));
		expect(result).toMatchObject({ transferredBytes: 0, totalBytes: 0 });
		for (const update of progress) {
			expect(update.transferredBytes).toBe(0);
			expect(Number.isFinite(update.bytesPerSecond)).toBe(true);
			expect(Number.isFinite(update.averageBytesPerSecond)).toBe(true);
		}
	});

	it("preflights without creating a stage and records the exact strategy", async () => {
		const localPath = path.join(testDir, "upload.bin");
		await fs.writeFile(localPath, new Uint8Array([1, 2, 3, 4]));
		const commands: string[] = [];
		vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockImplementation(async (_host, command) => {
			commands.push(command);
			return { args: [`probe-${commands.length}`] };
		});
		let spawnIndex = 0;
		vi.spyOn(ptree, "spawn").mockImplementation(<In extends TestStdin>() => {
			const stdout = spawnIndex++ === 0 ? new TextEncoder().encode("file") : new TextEncoder().encode("exchange");
			return createChild<In>({ stdout: [stdout] });
		});

		const plan = await prepareSshFileTransfer({
			operation: "upload",
			target,
			localPath,
			remotePath: "/tmp/output.bin",
			overwrite: true,
		});

		expect(plan).toMatchObject({ totalBytes: 4, commitStrategy: "remote-linux-exchange" });
		expect(commands).toHaveLength(2);
		expect(commands.every(command => !command.includes(".omp-transfer-") && !command.includes("mkdir"))).toBe(true);
	});
});
