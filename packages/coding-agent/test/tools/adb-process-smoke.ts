import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import {
	type AdbExecutorDependencies,
	type AdbSubprocess,
	executeAdb,
	executeAdbBinary,
} from "../../src/adb/adb-executor";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { AdbTool, type AdbToolDetails } from "../../src/tools/adb";
import { ToolAbortError } from "../../src/tools/tool-errors";
import { encodeRawPng } from "../../src/utils/png-encode";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

const SERIAL = "emulator-5554";
const XML =
	'<hierarchy rotation="0"><node text="Save" resource-id="app:id/save" class="android.widget.Button" package="app" enabled="true" clickable="true" bounds="[10,20][110,80]" /></hierarchy>';
const WINDOWS = `Input Dispatcher State:
  Display: 0
    Windows:
      0: name=app/.MainActivity, id=1, displayId=0, inputConfig={DEFAULT}, touchableRegion=[0,0][1080,2400], ownerPid=123`;

function resultText(result: AgentToolResult<AdbToolDetails>): string {
	return result.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
}

function watchMarker(directory: string, name: string): { promise: Promise<void>; close(): void } {
	const ready = Promise.withResolvers<void>();
	const watcher = nodeFs.watch(directory, (_event, filename) => {
		if (filename?.toString() === name) ready.resolve();
	});
	const timer = setTimeout(() => ready.reject(new Error(`Fixture did not reach ${name}`)), 5_000);
	return {
		promise: ready.promise,
		close() {
			clearTimeout(timer);
			watcher.close();
		},
	};
}

/** Standalone, device-free smoke of the real ADB executor and tool consumers. */
export async function runAdbProcessSmoke(): Promise<string[]> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "adb-process-smoke-"));
	const processes: AdbSubprocess[] = [];
	const screenshots: string[] = [];
	const exercised: string[] = [];
	const png = encodeRawPng(Uint8Array.of(255, 0, 0, 255), 1, 1, 4);
	const fixture = path.join(import.meta.dir, "adb-process-fixture.ts");
	const sourceLog = 'complete 中文 log "quoted"\n';
	let artifact = 0;
	const dependencies = (mode = "normal"): Partial<AdbExecutorDependencies> => ({
		resolveExecutable: () => process.execPath,
		env: { ...process.env, OMP_ADB_FIXTURE_ROOT: root, OMP_ADB_FIXTURE_MODE: mode },
		spawn: (argv, options) => {
			const child = Bun.spawn([argv[0]!, fixture, ...argv.slice(1)], options);
			processes.push(child);
			return child;
		},
	});
	const tool = (mode = "normal"): AdbTool => {
		const boundary = dependencies(mode);
		return new AdbTool(
			{
				cwd: root,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => null,
				settings: Settings.isolated({ "tools.maxTimeout": 5 }),
				allocateOutputArtifact: async () => ({
					path: path.join(root, `output-${++artifact}.txt`),
					id: `adb-smoke-${artifact}`,
				}),
			} as ToolSession,
			{
				resolveExecutable: () => process.execPath,
				executeAdb: (args, options) => executeAdb(args, { ...options, dependencies: boundary }),
				executeAdbBinary: (args, options) => executeAdbBinary(args, { ...options, dependencies: boundary }),
			},
		);
	};
	try {
		await Bun.write(path.join(root, "source.png"), png);
		await Bun.write(path.join(root, "source.log"), sourceLog);
		await Bun.write(path.join(root, "hierarchy.xml"), XML);
		await Bun.write(path.join(root, "windows.txt"), WINDOWS);

		const split = await executeAdb(["-s", SERIAL, "shell", "split-text"], {
			timeoutMs: 2_000,
			dependencies: dependencies(),
		});
		assert.equal(split.output, '发送到"电脑\\共享\n');
		exercised.push("UTF-8 bytes split inside a Chinese character");

		const input = `Native retained "reason" '24680' ;$(printf injected)&|<>`;
		const textResult = await tool().execute("text", {
			op: "input",
			device: SERIAL,
			action: "text",
			text: input,
		});
		assert.equal(textResult.details?.inputDispatch, "unconfirmed");
		const injected = (await Bun.file(path.join(root, "input-text.json")).json()) as {
			values: string[];
			text: string;
		};
		assert.deepEqual(injected.values, [input.replaceAll(" ", "%s")]);
		assert.equal(injected.text, input);
		exercised.push("remote shell parsing preserves spaces, quotes, and metacharacters as one text argument");

		const inputAttempts = path.join(root, "input-attempts.jsonl");
		const attemptsBefore = Bun.JSONL.parse(await Bun.file(inputAttempts).text()).length;
		const quiet = await tool("input-denied-log-only").execute("log-only-denial", {
			op: "click",
			device: SERIAL,
			selector: { text: "Save" },
		});
		assert.equal(quiet.details?.inputDispatch, "unconfirmed");
		assert.equal(quiet.details?.click?.inputDispatch, "unconfirmed");
		assert.notEqual(quiet.isError, true);
		assert.equal(Bun.JSONL.parse(await Bun.file(inputAttempts).text()).length, attemptsBefore + 1);
		exercised.push("quiet zero-exit input remains unconfirmed without replay, including device-log-only denial");

		for (const params of [
			{ op: "input", device: SERIAL, action: "tap", x: 60, y: 50 },
			{ op: "input", device: SERIAL, action: "text", text: "synthetic input" },
			{ op: "input", device: SERIAL, action: "keyevent", key: "HOME" },
			{ op: "click", device: SERIAL, selector: { text: "Save" } },
		] as const) {
			await assert.rejects(
				tool("input-denied").execute("denied", params),
				error => error instanceof ToolError && /SecurityException/.test(error.message),
			);
		}
		const diagnostic = await tool().execute("ordinary-shell", { op: "shell", device: SERIAL, command: "diagnostic" });
		assert.match(resultText(diagnostic), /SecurityException/);
		exercised.push("exit-zero injection denial fails raw and semantic inputs, not ordinary shell diagnostics");

		const inheritedReady = watchMarker(root, "inherited-ready");
		const inheritedAbort = new AbortController();
		let inheritedWriter: Process | null = null;
		let inheritedSettled = false;
		const inheritedPending = executeAdbBinary(["-s", SERIAL, "exec-out", "screencap", "-p"], {
			timeoutMs: 4_000,
			signal: inheritedAbort.signal,
			dependencies: dependencies("inherited-stream"),
		});
		void inheritedPending.then(
			() => {
				inheritedSettled = true;
			},
			() => {
				inheritedSettled = true;
			},
		);
		const inheritedRoot = processes.at(-1)!;
		try {
			await inheritedReady.promise;
			const writerPid = Number(await Bun.file(path.join(root, "inherited-ready")).text());
			assert.ok(Number.isSafeInteger(writerPid) && writerPid > 0);
			inheritedWriter = Process.fromPid(writerPid);
			assert.equal(inheritedWriter?.status(), ProcessStatus.Running);
			await Bun.write(path.join(root, "inherited-root-exit"), "exit");
			assert.equal(await inheritedRoot.exited, 0);
			assert.equal(inheritedWriter?.status(), ProcessStatus.Running);
			assert.equal(inheritedSettled, false, "root exit is not inherited stdout EOF");
			await Bun.write(path.join(root, "inherited-release"), "release");
			const inherited = await inheritedPending;
			assert.equal(inherited.cancelled, false);
			assert.equal(inherited.exitCode, 0);
			assert.deepEqual(Buffer.from(inherited.bytes), png);
			assert.equal(await inheritedWriter?.waitForExit({ timeoutMs: 1_000 }), true);
		} finally {
			inheritedAbort.abort();
			inheritedReady.close();
			await inheritedWriter?.terminate({ group: true, gracefulMs: -1, timeoutMs: 500 });
			await inheritedPending.catch(() => undefined);
		}
		exercised.push(
			"root exit does not truncate a live inherited stdout writer released after exit with a 450ms delay",
		);

		const screenshot = await tool().execute("screenshot", { op: "screenshot", device: SERIAL });
		assert.ok(screenshot.details?.path);
		screenshots.push(screenshot.details.path);
		assert.deepEqual(await Bun.file(screenshot.details.path).bytes(), new Uint8Array(png));
		const image = screenshot.content.find(part => part.type === "image");
		assert.ok(image?.type === "image");
		assert.deepEqual(Buffer.from(image.data, "base64"), png);
		await assert.rejects(tool("truncated-png").execute("truncated", { op: "screenshot", device: SERIAL }), ToolError);
		exercised.push("screenshot consumer saves exact decodable bytes and rejects truncated PNGs");

		const binaryReady = watchMarker(root, "binary-ready");
		const binaryAbort = new AbortController();
		const binaryPending = executeAdbBinary(["-s", SERIAL, "exec-out", "screencap", "-p"], {
			timeoutMs: 4_000,
			signal: binaryAbort.signal,
			dependencies: dependencies("binary-blocked"),
		});
		void binaryPending.catch(() => undefined);
		try {
			await binaryReady.promise;
			binaryAbort.abort();
			const cancelled = await binaryPending;
			assert.equal(cancelled.cancelled, true);
			assert.equal(cancelled.timedOut, undefined);
			assert.equal(cancelled.bytes.length, 0);
		} finally {
			binaryAbort.abort();
			binaryReady.close();
		}
		exercised.push("binary cancellation kills a real process without returning its partial PNG");

		const destination = path.join(root, "existing log.txt");
		await Bun.write(destination, "retained old log");
		await assert.rejects(
			tool("pull-failed").execute("failed-pull", {
				op: "pull",
				device: SERIAL,
				remotePath: "/sdcard/log.txt",
				localPath: destination,
			}),
			/partial write/,
		);
		assert.equal(await Bun.file(destination).text(), "retained old log");

		const pullReady = watchMarker(root, "pull-ready");
		const pullAbort = new AbortController();
		const pullPending = tool("pull-blocked")
			.execute(
				"cancel-pull",
				{
					op: "pull",
					device: SERIAL,
					remotePath: "/sdcard/log.txt",
					localPath: destination,
				},
				pullAbort.signal,
			)
			.catch(error => error);
		try {
			await pullReady.promise;
			pullAbort.abort();
			assert.ok((await pullPending) instanceof ToolAbortError);
		} finally {
			pullAbort.abort();
			pullReady.close();
		}
		assert.equal(await Bun.file(destination).text(), "retained old log");
		await tool().execute("complete-pull", {
			op: "pull",
			device: SERIAL,
			remotePath: "/sdcard/log.txt",
			localPath: destination,
		});
		assert.equal(await Bun.file(destination).text(), sourceLog);
		const directory = path.join(root, "existing-directory");
		await Bun.write(path.join(directory, "tree", "retained.txt"), "unrelated old entry");
		await tool().execute("file-to-directory", {
			op: "pull",
			device: SERIAL,
			remotePath: "/sdcard/log.txt",
			localPath: directory,
		});
		assert.equal(await Bun.file(path.join(directory, "log.txt")).text(), sourceLog);
		await tool().execute("directory-pull", {
			op: "pull",
			device: SERIAL,
			remotePath: "/sdcard/tree",
			localPath: directory,
		});
		assert.equal(await Bun.file(path.join(directory, "tree", "updated.txt")).text(), "complete directory entry");
		assert.equal(await Bun.file(path.join(directory, "tree", "retained.txt")).text(), "unrelated old entry");
		const newDirectory = path.join(root, "new-directory");
		await tool().execute("new-directory-pull", {
			op: "pull",
			device: SERIAL,
			remotePath: "/sdcard/tree",
			localPath: newDirectory,
		});
		assert.equal(await Bun.file(path.join(newDirectory, "updated.txt")).text(), "complete directory entry");
		await assert.rejects(
			tool().execute("directory-over-file", {
				op: "pull",
				device: SERIAL,
				remotePath: "/sdcard/tree",
				localPath: destination,
			}),
			/Cannot replace a local file/,
		);
		assert.equal(await Bun.file(destination).text(), sourceLog);
		assert.equal(
			(await fs.readdir(root)).some(name => name.startsWith(".omp-adb-pull-")),
			false,
		);
		exercised.push(
			"failed and cancelled pulls preserve old files; complete pulls publish and directory merges retain unrelated files",
		);

		await tool().execute("push", {
			op: "push",
			device: SERIAL,
			localPath: path.join(root, "source.log"),
			remotePath: "/sdcard/log.txt",
		});
		await assert.rejects(
			tool("push-blocked").execute("ack-without-exit", {
				op: "push",
				device: SERIAL,
				localPath: path.join(root, "source.log"),
				remotePath: "/sdcard/log.txt",
				timeout: 1,
			}),
			error =>
				error instanceof ToolError &&
				/timed out/.test(error.message) &&
				/1 file pushed/.test(error.message) &&
				/client process exit/.test(error.message),
		);
		exercised.push("push acknowledgement alone is not success without client exit and EOF");

		for (const phase of ["devices", "identity"] as const) {
			const marker = watchMarker(root, `${phase}-ready`);
			const abort = new AbortController();
			const pending = tool(`${phase}-blocked`)
				.execute(
					`cancel-${phase}`,
					{
						op: "shell",
						device: SERIAL,
						command: "diagnostic",
						timeout: 3,
					},
					abort.signal,
				)
				.catch(error => error);
			try {
				await marker.promise;
				abort.abort();
				assert.ok((await pending) instanceof ToolAbortError);
			} finally {
				abort.abort();
				marker.close();
			}
		}
		await assert.rejects(
			tool("devices-blocked").execute("preflight-timeout", {
				op: "screenshot",
				device: SERIAL,
				timeout: 1,
			}),
			/timed out/,
		);
		assert.equal(
			processes.every(child => child.exitCode !== null),
			true,
		);
		exercised.push("status device listing and emulator identity honor timeout and cancellation");
		return exercised;
	} finally {
		await Promise.all(
			processes.map(async child => {
				if (child.exitCode === null) child.kill("SIGKILL");
				await Promise.race([child.exited.catch(() => undefined), Bun.sleep(1_000)]);
			}),
		);
		await Promise.all(screenshots.map(file => fs.rm(file, { force: true })));
		await fs.rm(root, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	console.log(JSON.stringify({ exercised: await runAdbProcessSmoke() }, null, 2));
}
