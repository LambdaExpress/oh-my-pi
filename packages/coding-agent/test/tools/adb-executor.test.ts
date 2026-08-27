import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AdbCommandOptions,
	type AdbExecutorDependencies,
	type AdbSpawnOptions,
	type AdbSubprocess,
	executeAdb,
	executeAdbBinary,
	parseAdbDevices,
	parseAvdList,
	resolveAndroidExecutable,
} from "../../src/adb/adb-executor";

const originalEnvironment = { ...process.env };
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "adb-executor-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function addSdkExecutable(sdkRoot: string, name: "adb" | "emulator"): Promise<string> {
	const directory = join(sdkRoot, name === "adb" ? "platform-tools" : "emulator");
	const executable = join(directory, process.platform === "win32" ? `${name}.exe` : name);
	await mkdir(directory, { recursive: true });
	await writeFile(executable, "");
	if (process.platform !== "win32") await chmod(executable, 0o755);
	return executable;
}

async function addPathExecutable(directory: string, name: "adb" | "emulator"): Promise<string> {
	const executable = join(directory, process.platform === "win32" ? `${name}.exe` : name);
	await writeFile(executable, "");
	if (process.platform !== "win32") await chmod(executable, 0o755);
	return executable;
}

function resolverDependencies(
	options: {
		which?: (name: string) => string | null;
		env?: Readonly<Record<string, string | undefined>>;
		platform?: NodeJS.Platform;
	} = {},
): Partial<AdbExecutorDependencies> {
	return {
		which: options.which ?? (() => null),
		isFile: existsSync,
		env: options.env ?? {},
		platform: options.platform ?? process.platform,
	};
}

afterEach(async () => {
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, originalEnvironment);
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

interface FakeProcessControl {
	process: AdbSubprocess;
	finish(exitCode: number): void;
	wasTerminated: () => boolean;
}

function fakeProcess(
	stdout: ReadableStream<Uint8Array> | null = null,
	stderr: ReadableStream<Uint8Array> | null = null,
): FakeProcessControl {
	let resolveExit!: (exitCode: number) => void;
	let exitCode: number | null = null;
	let killed = false;
	const exited = new Promise<number>(resolve => {
		resolveExit = resolve;
	});
	return {
		process: {
			pid: 4242,
			stdout,
			stderr,
			exited,
			get exitCode() {
				return exitCode;
			},
			get killed() {
				return killed;
			},
			kill() {
				killed = true;
				exitCode = -1;
				resolveExit(-1);
			},
		},
		finish(code) {
			exitCode = code;
			resolveExit(code);
		},
		wasTerminated: () => killed,
	};
}

function dependenciesFor(
	spawn: (argv: readonly string[], options: AdbSpawnOptions) => AdbSubprocess,
	terminateTree: (process: AdbSubprocess) => Promise<void> = async process => process.kill("SIGKILL"),
): Partial<AdbExecutorDependencies> {
	return {
		which: () => "/fake/android/platform-tools/adb",
		isFile: () => true,
		spawn,
		terminateTree,
		env: {},
		platform: "linux",
	};
}

describe("resolveAndroidExecutable", () => {
	test("prefers PATH over configured SDK roots", async () => {
		const pathDirectory = await temporaryDirectory();
		const sdkRoot = await temporaryDirectory();
		const expected = await addPathExecutable(pathDirectory, "adb");
		await addSdkExecutable(sdkRoot, "adb");

		expect(
			resolveAndroidExecutable(
				"adb",
				resolverDependencies({
					which: name => (name === "adb" ? expected : null),
					env: { ANDROID_SDK_ROOT: sdkRoot },
				}),
			),
		).toBe(expected);
	});

	test("prefers ANDROID_SDK_ROOT over ANDROID_HOME", async () => {
		const sdkRoot = await temporaryDirectory();
		const androidHome = await temporaryDirectory();
		const expected = await addSdkExecutable(sdkRoot, "adb");
		await addSdkExecutable(androidHome, "adb");

		expect(
			resolveAndroidExecutable(
				"adb",
				resolverDependencies({ env: { ANDROID_SDK_ROOT: sdkRoot, ANDROID_HOME: androidHome } }),
			),
		).toBe(expected);
	});

	test("falls through a missing SDK root to ANDROID_HOME", async () => {
		const missingSdkRoot = await temporaryDirectory();
		const androidHome = await temporaryDirectory();
		const expected = await addSdkExecutable(androidHome, "emulator");

		expect(
			resolveAndroidExecutable(
				"emulator",
				resolverDependencies({
					env: { ANDROID_SDK_ROOT: join(missingSdkRoot, "missing"), ANDROID_HOME: androidHome },
				}),
			),
		).toBe(expected);
	});

	const windowsTest = process.platform === "win32" ? test : test.skip;
	windowsTest("falls through environment SDK roots to the Windows default SDK", async () => {
		const localAppData = await temporaryDirectory();
		const expected = await addSdkExecutable(join(localAppData, "Android", "Sdk"), "adb");

		expect(
			resolveAndroidExecutable(
				"adb",
				resolverDependencies({ env: { LOCALAPPDATA: localAppData }, platform: "win32" }),
			),
		).toBe(expected);
	});

	test("returns null when no configured candidate exists", async () => {
		const emptyRoot = await temporaryDirectory();
		const dependencies = resolverDependencies({
			env: {
				ANDROID_SDK_ROOT: join(emptyRoot, "sdk-root"),
				ANDROID_HOME: join(emptyRoot, "android-home"),
			},
		});

		expect(resolveAndroidExecutable("adb", dependencies)).toBeNull();
		expect(resolveAndroidExecutable("emulator", dependencies)).toBeNull();
	});
});

describe("parseAdbDevices", () => {
	test("parses supported and unknown states with device metadata", () => {
		const output = [
			"List of devices attached",
			"device-1 device product:husky model:Pixel_8 transport_id:1",
			"device-2 offline product:akita model:Pixel_8a transport_id:2",
			"device-3 unauthorized usb:3-1 transport_id:3",
			"device-4 recovery product:oriole model:Pixel_6 transport_id:4",
			"",
		].join("\n");

		expect(parseAdbDevices(output)).toEqual([
			{
				serial: "device-1",
				state: "device",
				product: "husky",
				model: "Pixel_8",
				transportId: "1",
			},
			{
				serial: "device-2",
				state: "offline",
				product: "akita",
				model: "Pixel_8a",
				transportId: "2",
			},
			{ serial: "device-3", state: "unauthorized", transportId: "3" },
			{
				serial: "device-4",
				state: "unknown",
				product: "oriole",
				model: "Pixel_6",
				transportId: "4",
			},
		]);
	});

	test("returns an empty list for an empty adb device list", () => {
		expect(parseAdbDevices("List of devices attached\n\n")).toEqual([]);
	});

	test("ignores daemon and server diagnostics mixed into output", () => {
		const output = [
			"adb server version (39) doesn't match this client (41); killing...",
			"* daemon not running; starting now at tcp:5037",
			"* daemon started successfully",
			"List of devices attached",
			"emulator-5554 device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 transport_id:7",
			"",
		].join("\r\n");

		expect(parseAdbDevices(output)).toEqual([
			{
				serial: "emulator-5554",
				state: "device",
				product: "sdk_gphone64_x86_64",
				model: "sdk_gphone64_x86_64",
				transportId: "7",
			},
		]);
	});
});

describe("parseAvdList", () => {
	test("removes empty lines while preserving order", () => {
		expect(parseAvdList("\r\nPixel_8_API_35\r\n\r\nMedium Phone\nTablet_API_34\n")).toEqual([
			"Pixel_8_API_35",
			"Medium Phone",
			"Tablet_API_34",
		]);
	});
});

describe("executeAdb", () => {
	test("preserves argv element boundaries and reports non-zero output", async () => {
		const child = fakeProcess(streamOf(bytes("stdout text\n")), streamOf(bytes("stderr context\n")));
		let spawnedArgv: readonly string[] = [];
		let spawnedOptions: AdbSpawnOptions | undefined;
		const commandArgs = [
			"-s",
			"emulator serial with spaces",
			"shell",
			"echo one argument with spaces",
			"/sdcard/a path/file.txt",
		] as const;
		const options: AdbCommandOptions = {
			cwd: "/working directory/with spaces",
			dependencies: dependenciesFor((argv, spawnOptions) => {
				spawnedArgv = argv;
				spawnedOptions = spawnOptions;
				queueMicrotask(() => child.finish(17));
				return child.process;
			}),
		};

		const result = await executeAdb(commandArgs, options);

		expect(spawnedArgv).toEqual(["/fake/android/platform-tools/adb", ...commandArgs]);
		expect(spawnedOptions?.cwd).toBe("/working directory/with spaces");
		expect(result.exitCode).toBe(17);
		expect(result.cancelled).toBe(false);
		expect(result.output).toContain("stdout text");
		expect(result.output).toContain("stderr context");
	});

	test("marks an in-flight aborted command as cancelled and terminates it", async () => {
		const child = fakeProcess();
		const controller = new AbortController();
		const execution = executeAdb(["devices", "-l"], {
			signal: controller.signal,
			dependencies: dependenciesFor(() => {
				queueMicrotask(() => controller.abort());
				return child.process;
			}),
		});

		const result = await execution;

		expect(result.cancelled).toBe(true);
		expect(result.timedOut).toBeUndefined();
		expect(child.wasTerminated()).toBe(true);
	});

	test("marks a bounded command timeout and terminates the child", async () => {
		const child = fakeProcess();
		const result = await executeAdb(["wait-for-device"], {
			timeoutMs: 1,
			dependencies: dependenciesFor(() => child.process),
		});

		expect(result.cancelled).toBe(true);
		expect(result.timedOut).toBe(true);
		expect(child.wasTerminated()).toBe(true);
	});
});

describe("executeAdbBinary", () => {
	test("returns stdout bytes without decoding and keeps stderr separate", async () => {
		const expected = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80]);
		const child = fakeProcess(streamOf(expected), streamOf(bytes("binary command warning")));
		let spawnedArgv: readonly string[] = [];
		const args = ["-s", "serial with spaces", "exec-out", "screencap", "-p"] as const;

		const result = await executeAdbBinary(args, {
			dependencies: dependenciesFor(argv => {
				spawnedArgv = argv;
				queueMicrotask(() => child.finish(9));
				return child.process;
			}),
		});

		expect(spawnedArgv).toEqual(["/fake/android/platform-tools/adb", ...args]);
		expect(result.bytes).toEqual(expected);
		expect(result.exitCode).toBe(9);
		expect(result.cancelled).toBe(false);
		expect(result.stderr).toBe("binary command warning");
	});

	test("reports cancellation without returning partial binary output", async () => {
		const child = fakeProcess(streamOf(new Uint8Array([0x00, 0xff])));
		const controller = new AbortController();
		const execution = executeAdbBinary(["exec-out", "screencap", "-p"], {
			signal: controller.signal,
			dependencies: dependenciesFor(() => {
				queueMicrotask(() => controller.abort());
				return child.process;
			}),
		});

		const result = await execution;

		expect(result.bytes).toEqual(new Uint8Array());
		expect(result.cancelled).toBe(true);
		expect(result.timedOut).toBeUndefined();
		expect(child.wasTerminated()).toBe(true);
	});

	test("reports timeout without returning partial binary output", async () => {
		const child = fakeProcess(streamOf(new Uint8Array([0x89, 0x50])));
		const result = await executeAdbBinary(["exec-out", "screencap", "-p"], {
			timeoutMs: 1,
			dependencies: dependenciesFor(() => child.process),
		});

		expect(result.bytes).toEqual(new Uint8Array());
		expect(result.cancelled).toBe(true);
		expect(result.timedOut).toBe(true);
		expect(child.wasTerminated()).toBe(true);
	});
});
