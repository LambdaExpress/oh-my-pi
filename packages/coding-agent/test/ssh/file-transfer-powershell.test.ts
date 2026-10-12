import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SSHConnectionTarget } from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import * as connectionManager from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import { executeSshFileTransfer, type SshFileTransferPlan } from "@oh-my-pi/pi-coding-agent/ssh/file-transfer";
import { $which, getRemoteHostDir } from "@oh-my-pi/pi-utils";

const POWERSHELL = $which("pwsh");
const ENCODED_PREFIX = "pwsh -NoProfile -NonInteractive -EncodedCommand ";
const COMMIT_MARKER_WRITE = "[Console]::Out.WriteLine('OMP_TRANSFER_COMMITTED')";
const target: SSHConnectionTarget = { name: "local-powershell-transaction", host: "transaction.invalid" };
const payload = new Uint8Array([0, 255, 195, 40, 128, 65, 66, 67]);
const original = new Uint8Array([65, 66, 67, 68, 69, 70, 71, 72]);
const unrelated = new Uint8Array([81, 82, 83, 84, 85, 86, 87, 88]);

interface Artifacts {
	stage: string;
	proof: string;
	backup: string;
}

function hash(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function encodedInvocation(script: string) {
	return {
		executable: POWERSHELL!,
		args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", connectionManager.encodePowerShellScript(script)],
	};
}

async function artifactPaths(directory: string): Promise<Artifacts> {
	const entry = (await fs.readdir(directory)).find(
		name => name.startsWith(".omp-transfer-") && name.endsWith(".part"),
	);
	if (!entry) throw new Error("transfer stage was not created");
	const prefix = path.join(directory, entry.slice(0, -".part".length));
	return { stage: `${prefix}.part`, proof: `${prefix}.proof`, backup: `${prefix}.backup` };
}

// Only the remote process boundary is redirected. All generated scripts,
// native identity checks, stage streaming and acknowledgement I/O run for real.
describe.skipIf(process.platform !== "win32" || !POWERSHELL)("PowerShell SSH transfer transactions", () => {
	let directory: string;
	let source: string;
	let destination: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-powershell-transfer-"));
		source = path.join(directory, "source.bin");
		destination = path.join(directory, "destination.bin");
		await fs.writeFile(source, payload);
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 7,
			os: "windows",
			shell: "powershell",
			powerShellCommand: "pwsh",
			compatEnabled: false,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(directory, { recursive: true, force: true });
	});

	function plan(overwrite = false): SshFileTransferPlan {
		return {
			operation: "upload",
			target,
			localPath: source,
			remotePath: destination,
			totalBytes: payload.byteLength,
			overwrite,
			commitStrategy: overwrite ? "remote-windows-replace" : "no-replace",
		};
	}

	function redirectScripts(transform: (script: string) => string | Promise<string> = script => script): void {
		vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockImplementation(async (_target, command) => {
			const script = Buffer.from(command.slice(ENCODED_PREFIX.length), "base64").toString("utf16le");
			return encodedInvocation(await transform(script));
		});
	}

	for (const overwrite of [false, true]) {
		it(`commits a ${overwrite ? "replacement" : "new file"} with exit zero and round-trips binary stdout`, async () => {
			if (overwrite) await fs.writeFile(destination, original);
			let finalizations = 0;
			redirectScripts(script => {
				if (script.includes(COMMIT_MARKER_WRITE) && ++finalizations > 1) {
					throw new Error("recovery route unavailable after successful commit");
				}
				return script;
			});

			const result = await executeSshFileTransfer(plan(overwrite));
			expect(result.transferredBytes).toBe(payload.byteLength);
			expect(finalizations).toBe(1);
			expect(hash(await fs.readFile(destination))).toBe(hash(payload));
			expect(hash(await fs.readFile(source))).toBe(hash(payload));
			expect((await fs.readdir(directory)).filter(name => name.startsWith(".omp-transfer-"))).toEqual([]);

			const downloaded = path.join(directory, "downloaded.bin");
			await executeSshFileTransfer({
				...plan(),
				operation: "download",
				localPath: downloaded,
			});
			expect(await fs.readFile(downloaded)).toEqual(Buffer.from(payload));
		}, 60_000);
	}

	it("keeps proof and the previous destination until a lost commit marker is recovered", async () => {
		await fs.writeFile(destination, original);
		let artifacts: Artifacts | undefined;
		let finalizations = 0;
		redirectScripts(async script => {
			if (!script.includes(COMMIT_MARKER_WRITE)) return script;
			finalizations++;
			if (finalizations === 1) {
				artifacts = await artifactPaths(directory);
				return script.replace(COMMIT_MARKER_WRITE, "exit 75");
			}
			if (!artifacts) throw new Error("missing transfer artifacts");
			expect(hash(await fs.readFile(destination))).toBe(hash(payload));
			expect(hash(await fs.readFile(artifacts.proof))).toBe(hash(payload));
			expect(hash(await fs.readFile(artifacts.backup))).toBe(hash(original));
			return script;
		});

		await executeSshFileTransfer(plan(true));

		expect(finalizations).toBe(2);
		expect(hash(await fs.readFile(destination))).toBe(hash(payload));
		expect((await fs.readdir(directory)).filter(name => name.startsWith(".omp-transfer-"))).toEqual([]);
	}, 60_000);

	it("preserves the proof and overwrite backup when the remote receives EOF instead of ACK", async () => {
		await fs.writeFile(destination, original);
		let commitScript: string | undefined;
		let artifacts: Artifacts | undefined;
		const heldCommit = new Error("holding the generated commit before launch");
		redirectScripts(async script => {
			if (script.includes(COMMIT_MARKER_WRITE)) {
				commitScript = script;
				artifacts = await artifactPaths(directory);
				throw heldCommit;
			}
			return script;
		});
		await expect(executeSshFileTransfer(plan(true))).rejects.toBe(heldCommit);
		if (!commitScript || !artifacts) throw new Error("commit was not captured");
		const invocation = encodedInvocation(commitScript);
		const child = Bun.spawn([invocation.executable, ...invocation.args], {
			stdin: new Uint8Array(),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(stdout.trim()).toBe("OMP_TRANSFER_COMMITTED");
		expect(hash(await fs.readFile(destination))).toBe(hash(payload));
		expect(hash(await fs.readFile(artifacts.proof))).toBe(hash(payload));
		expect(hash(await fs.readFile(artifacts.backup))).toBe(hash(original));
	}, 60_000);

	for (const retainProof of [true, false]) {
		it(`leaves an unrelated same-size destination and backup untouched when proof is ${retainProof ? "present" : "missing"}`, async () => {
			await fs.writeFile(destination, original);
			let artifacts: Artifacts | undefined;
			let finalizations = 0;
			redirectScripts(async script => {
				if (!script.includes(COMMIT_MARKER_WRITE)) return script;
				finalizations++;
				if (finalizations === 1) {
					artifacts = await artifactPaths(directory);
					return script.replace(COMMIT_MARKER_WRITE, "exit 75");
				}
				if (!artifacts) throw new Error("missing transfer artifacts");
				await fs.unlink(destination);
				await fs.writeFile(destination, unrelated);
				if (!retainProof) await fs.unlink(artifacts.proof);
				return script;
			});

			const error = await executeSshFileTransfer(plan(true)).catch(error => error);

			expect(error).toBeInstanceOf(Error);
			expect(error.message).toMatch(/completion is uncertain/);
			expect(error.message).toMatch(/destination=different/);
			expect(error.message).toMatch(/backup=present/);
			expect(finalizations).toBe(2);
			expect(hash(await fs.readFile(destination))).toBe(hash(unrelated));
			expect(hash(await fs.readFile(source))).toBe(hash(payload));
			if (!artifacts) throw new Error("missing transfer artifacts");
			expect(hash(await fs.readFile(artifacts.backup))).toBe(hash(original));
			if (retainProof) expect(hash(await fs.readFile(artifacts.proof))).toBe(hash(payload));
		}, 60_000);
	}

	it("preserves the known backup when the recovery route is unavailable", async () => {
		await fs.writeFile(destination, original);
		let artifacts: Artifacts | undefined;
		let finalizations = 0;
		redirectScripts(async script => {
			if (!script.includes(COMMIT_MARKER_WRITE)) return script;
			if (++finalizations > 1) throw new Error("injected connection closure during recovery");
			artifacts = await artifactPaths(directory);
			return script.replace(COMMIT_MARKER_WRITE, "exit 75");
		});

		const error = await executeSshFileTransfer(plan(true)).catch(error => error);

		expect(error).toBeInstanceOf(Error);
		expect(error.message).toMatch(/completion is uncertain/);
		expect(error.message).toMatch(/previous-destination preservation are unknown/);
		expect(error.message).not.toMatch(/commit failed/);
		expect(hash(await fs.readFile(destination))).toBe(hash(payload));
		if (!artifacts) throw new Error("missing transfer artifacts");
		expect(hash(await fs.readFile(artifacts.backup))).toBe(hash(original));
		expect(hash(await fs.readFile(artifacts.proof))).toBe(hash(payload));
	}, 60_000);

	it("rejects a mismatched proof without changing or deleting either destination version", async () => {
		await fs.writeFile(destination, original);
		let artifacts: Artifacts | undefined;
		let finalizations = 0;
		redirectScripts(async script => {
			if (script.includes(COMMIT_MARKER_WRITE) && ++finalizations === 1) {
				artifacts = await artifactPaths(directory);
				await fs.writeFile(artifacts.proof, unrelated);
			}
			return script;
		});

		const error = await executeSshFileTransfer(plan(true)).catch(error => error);

		expect(error).toBeInstanceOf(Error);
		expect(error.message).toMatch(/completion is uncertain/);
		expect(hash(await fs.readFile(destination))).toBe(hash(original));
		if (!artifacts) throw new Error("missing transfer artifacts");
		expect(hash(await fs.readFile(artifacts.stage))).toBe(hash(payload));
		expect(hash(await fs.readFile(artifacts.proof))).toBe(hash(unrelated));
	}, 60_000);
});

// Run generated command argv inside an IBM437 PowerShell process, not a
// source-text assertion of an encoding prefix.
describe.skipIf(!POWERSHELL)("verified PowerShell SSH Unicode output", () => {
	it("preserves literal and constructed Chinese under an OEM console code page", async () => {
		const host: SSHConnectionTarget = { name: `unicode-${crypto.randomUUID()}`, host: "unicode.invalid" };
		const cache = path.join(getRemoteHostDir(), `${connectionManager.getSshHostInfoKey(host)}.json`);
		await fs.mkdir(path.dirname(cache), { recursive: true });
		await fs.writeFile(
			cache,
			JSON.stringify({
				version: 7,
				os: "windows",
				shell: "powershell",
				powerShellCommand: "pwsh",
				compatEnabled: false,
			}),
		);
		try {
			const args = await connectionManager.buildRemoteCommand(
				host,
				"[pscustomobject]@{Literal='中文'; Constructed=(-join ([char[]]@(39640,38596,36335,22320,38081,31449))); Encoding=[Console]::OutputEncoding.WebName} | ConvertTo-Json -Compress",
			);
			const command = args.at(-1)!;
			const script = "[Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(437)\n" + command;
			const invocation = encodedInvocation(script);
			const child = Bun.spawn([invocation.executable, ...invocation.args], { stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
			expect(JSON.parse(stdout)).toEqual({ Literal: "中文", Constructed: "高雄路地铁站", Encoding: "utf-8" });
		} finally {
			await fs.rm(cache, { force: true });
		}
	}, 30_000);
});
