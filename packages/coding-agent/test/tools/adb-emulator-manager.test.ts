import { describe, expect, test } from "bun:test";
import type {
	AdbCommandOptions,
	AdbCommandResult,
	AdbDevice,
	AdbSpawnOptions,
	AdbSubprocess,
	AndroidExecutableName,
} from "../../src/adb/adb-executor";
import { EmulatorManager, type EmulatorManagerDependencies } from "../../src/adb/emulator-manager";
import { ToolAbortError, ToolError } from "../../src/tools/tool-errors";

const DEFAULT_AVD = "Medium Phone";
const DEFAULT_SERIAL = "emulator-5588";

function textStream(text: string): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	return new ReadableStream({
		start(controller) {
			if (bytes.byteLength > 0) controller.enqueue(bytes);
			controller.close();
		},
	});
}

interface HangingStreamControl {
	readonly stream: ReadableStream<Uint8Array>;
	readonly cancelled: boolean;
}

function hangingStream(text = ""): HangingStreamControl {
	let cancelled = false;
	const bytes = new TextEncoder().encode(text);
	return {
		stream: new ReadableStream({
			start(controller) {
				if (bytes.byteLength > 0) controller.enqueue(bytes);
			},
			cancel() {
				cancelled = true;
			},
		}),
		get cancelled() {
			return cancelled;
		},
	};
}

function rejectingStream(error: Error): ReadableStream<Uint8Array> {
	return new ReadableStream({
		pull() {
			throw error;
		},
	});
}

interface FakeProcessControl {
	readonly process: AdbSubprocess;
	readonly terminated: boolean;
	finish(exitCode: number): void;
}

function runningProcess(
	pid = 4242,
	streams: { stdout?: ReadableStream<Uint8Array>; stderr?: ReadableStream<Uint8Array> } = {},
): FakeProcessControl {
	const exit = Promise.withResolvers<number>();
	let exitCode: number | null = null;
	let killed = false;
	return {
		process: {
			pid,
			stdout: streams.stdout ?? textStream(""),
			stderr: streams.stderr ?? textStream(""),
			exited: exit.promise,
			get exitCode() {
				return exitCode;
			},
			get killed() {
				return killed;
			},
			kill() {
				if (exitCode !== null) return;
				killed = true;
				exitCode = -1;
				exit.resolve(-1);
			},
		},
		get terminated() {
			return killed;
		},
		finish(code) {
			if (exitCode !== null) return;
			exitCode = code;
			exit.resolve(code);
		},
	};
}

function settledProcess(
	options: { stdout?: string; stderr?: string; exitCode?: number; pid?: number } = {},
): AdbSubprocess {
	const exitCode = options.exitCode ?? 0;
	return {
		pid: options.pid ?? 4100,
		stdout: textStream(options.stdout ?? ""),
		stderr: textStream(options.stderr ?? ""),
		exited: Promise.resolve(exitCode),
		exitCode,
		killed: false,
		kill() {},
	};
}

function commandResult(output = "", exitCode: number | null = 0): AdbCommandResult {
	return {
		output,
		exitCode,
		cancelled: false,
	} as AdbCommandResult;
}

function devicesOutput(devices: readonly Pick<AdbDevice, "serial" | "state">[]): string {
	const lines = devices.map(device => `${device.serial}\t${device.state} product:sdk model:fake transport_id:1`);
	return ["List of devices attached", ...lines, ""].join("\n");
}

function device(serial = DEFAULT_SERIAL, state: AdbDevice["state"] = "device"): AdbDevice {
	return { serial, state };
}

type AdbHandler = (args: readonly string[], options?: AdbCommandOptions) => Promise<AdbCommandResult>;

interface HarnessOptions {
	avds?: readonly string[];
	emulatorPath?: string | null;
	listExitCode?: number;
	listStderr?: string;
	listProcess?: FakeProcessControl;
	executeAdb?: AdbHandler;
	longProcess?: FakeProcessControl;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

interface Harness {
	manager: EmulatorManager;
	adbCalls: string[][];
	spawnCalls: string[][];
	spawnOptions: AdbSpawnOptions[];
	terminatedProcesses: AdbSubprocess[];
	longProcess: FakeProcessControl;
}

function createHarness(options: HarnessOptions = {}): Harness {
	const adbCalls: string[][] = [];
	const spawnCalls: string[][] = [];
	const spawnOptions: AdbSpawnOptions[] = [];
	const terminatedProcesses: AdbSubprocess[] = [];
	const longProcess = options.longProcess ?? runningProcess();
	const avds = options.avds ?? [DEFAULT_AVD];
	let clock = 0;

	const executeAdb: AdbHandler = async (args, commandOptions) => {
		adbCalls.push([...args]);
		if (options.executeAdb) return options.executeAdb(args, commandOptions);
		if (args[0] === "devices") return commandResult(devicesOutput([]));
		return commandResult("error: target unavailable", 1);
	};

	const dependencies: Partial<EmulatorManagerDependencies> = {
		resolveExecutable: (name: AndroidExecutableName) => {
			if (name === "emulator") return options.emulatorPath === undefined ? "/sdk/emulator" : options.emulatorPath;
			return "/sdk/adb";
		},
		executeAdb,
		spawnEmulator: (argv, spawnOption) => {
			spawnCalls.push([...argv]);
			spawnOptions.push(spawnOption);
			if (argv.includes("-list-avds")) {
				if (options.listProcess) return options.listProcess.process;
				return settledProcess({
					stdout: `${avds.join("\n")}\n`,
					stderr: options.listStderr,
					exitCode: options.listExitCode,
				});
			}
			return longProcess.process;
		},
		terminateProcess: async process => {
			terminatedProcesses.push(process);
			if (process === longProcess.process) longProcess.finish(-1);
			else process.kill("SIGKILL");
		},
		now: options.now ?? (() => clock),
		sleep:
			options.sleep ??
			(async ms => {
				clock += ms;
				await Promise.resolve();
			}),
	};

	return {
		manager: new EmulatorManager(dependencies),
		adbCalls,
		spawnCalls,
		spawnOptions,
		terminatedProcesses,
		longProcess,
	};
}

function sequentialDevices(states: readonly (readonly AdbDevice[])[]): AdbHandler {
	let index = 0;
	return async args => {
		if (args[0] === "devices") {
			const devices = states[Math.min(index, states.length - 1)] ?? [];
			index++;
			return commandResult(devicesOutput(devices));
		}
		if (args.at(-2) === "avd" && args.at(-1) === "name") return commandResult(`${DEFAULT_AVD}\n`);
		if (args.at(-1) === "sys.boot_completed") return commandResult("1\n");
		return commandResult();
	};
}

function expectNoKillServer(calls: readonly (readonly string[])[]): void {
	expect(calls.some(args => args.includes("kill-server"))).toBe(false);
}

describe("EmulatorManager.listAvds", () => {
	test("preserves emulator order and uses direct argv", async () => {
		const harness = createHarness({ avds: ["Pixel_8_API_35", "Medium Phone", "Tablet_API_34"] });

		await expect(harness.manager.listAvds()).resolves.toEqual(["Pixel_8_API_35", "Medium Phone", "Tablet_API_34"]);
		expect(harness.spawnCalls).toEqual([["/sdk/emulator", "-list-avds"]]);
	});

	test("reports a missing emulator executable without spawning", async () => {
		const harness = createHarness({ emulatorPath: null });

		await expect(harness.manager.listAvds()).rejects.toBeInstanceOf(ToolError);
		await expect(harness.manager.listAvds()).rejects.toThrow(/emulator|Android SDK/i);
		expect(harness.spawnCalls).toEqual([]);
	});

	test("includes emulator stderr when listing exits non-zero", async () => {
		const harness = createHarness({ listExitCode: 17, listStderr: "SDK image directory is unreadable" });

		await expect(harness.manager.listAvds()).rejects.toBeInstanceOf(ToolError);
		await expect(harness.manager.listAvds()).rejects.toThrow(/SDK image directory is unreadable/);
	});

	test("times out and tree-terminates a list process that never exits", async () => {
		const stdout = hangingStream("Pixel_partial\n");
		const stderr = hangingStream("SDK scan stalled");
		const child = runningProcess(4242, { stdout: stdout.stream, stderr: stderr.stream });
		let clock = 0;
		const harness = createHarness({
			listProcess: child,
			now: () => clock,
			sleep: async ms => {
				clock += ms;
				await Promise.resolve();
			},
		});

		await expect(harness.manager.listAvds()).rejects.toThrow(
			/Timed out after 10 seconds.*Android SDK.*SDK scan stalled.*Pixel_partial/is,
		);
		expect(child.terminated).toBe(true);
		expect(stdout.cancelled).toBe(true);
		expect(stderr.cancelled).toBe(true);
		expect(harness.terminatedProcesses).toEqual([child.process]);
	});

	test("times out and cancels capture when the list process exits without closing stdout", async () => {
		const stdout = hangingStream("Pixel_partial\n");
		const child = runningProcess(4242, { stdout: stdout.stream });
		child.finish(0);
		let clock = 0;
		const harness = createHarness({
			listProcess: child,
			now: () => clock,
			sleep: async ms => {
				clock += ms;
				await Promise.resolve();
			},
		});

		await expect(harness.manager.listAvds()).rejects.toThrow(/Timed out after 10 seconds.*Pixel_partial/is);
		expect(stdout.cancelled).toBe(true);
		expect(harness.terminatedProcesses).toEqual([child.process]);
	});

	test("turns a stream read rejection into a handled listing error", async () => {
		const child = runningProcess(4242, { stdout: rejectingStream(new Error("stdout read failed")) });
		const harness = createHarness({ listProcess: child });

		await expect(harness.manager.listAvds()).rejects.toBeInstanceOf(ToolError);
		expect(harness.terminatedProcesses).toEqual([child.process]);
	});

	test("rejects an unknown AVD before launching it", async () => {
		const harness = createHarness({ avds: ["Known_AVD"] });

		await expect(
			harness.manager.start({ avd: "Missing AVD", waitUntil: "connected", timeoutMs: 1_000 }),
		).rejects.toBeInstanceOf(ToolError);
		expect(harness.spawnCalls.filter(args => args.includes("-avd"))).toEqual([]);
	});
});

describe("EmulatorManager.start", () => {
	test("matches the requested AVD to its actual serial and waits for boot completion", async () => {
		const deviceStates = [
			[],
			[],
			[device(DEFAULT_SERIAL, "offline")],
			[device(DEFAULT_SERIAL)],
			[device(DEFAULT_SERIAL)],
		] as const;
		let devicesIndex = 0;
		const bootValues = ["", "1\n"];
		let bootIndex = 0;
		const harness = createHarness({
			executeAdb: async args => {
				if (args[0] === "devices") {
					const current = deviceStates[Math.min(devicesIndex, deviceStates.length - 1)] ?? [];
					devicesIndex++;
					return commandResult(devicesOutput(current));
				}
				if (args.at(-2) === "avd" && args.at(-1) === "name") return commandResult(`${DEFAULT_AVD}\n`);
				if (args.at(-1) === "sys.boot_completed") {
					const value = bootValues[Math.min(bootIndex, bootValues.length - 1)] ?? "1\n";
					bootIndex++;
					return commandResult(value);
				}
				return commandResult("unexpected command", 1);
			},
		});

		await expect(
			harness.manager.start({ avd: DEFAULT_AVD, waitUntil: "booted", timeoutMs: 10_000 }),
		).resolves.toEqual({
			avd: DEFAULT_AVD,
			serial: DEFAULT_SERIAL,
			state: "booted",
			pid: 4242,
			reused: false,
		});
		expect(harness.spawnCalls).toContainEqual(["/sdk/emulator", "-avd", DEFAULT_AVD]);
		expect(harness.adbCalls).toContainEqual(["-s", DEFAULT_SERIAL, "emu", "avd", "name"]);
		expect(harness.adbCalls).toContainEqual(["-s", DEFAULT_SERIAL, "shell", "getprop", "sys.boot_completed"]);
		expect(bootIndex).toBe(2);
		expect(harness.terminatedProcesses).toEqual([]);
		expect(harness.longProcess.process.exitCode).toBeNull();
	});

	test("reuses one already-online emulator with the requested AVD", async () => {
		const harness = createHarness({ executeAdb: sequentialDevices([[device()]]) });

		await expect(
			harness.manager.start({ avd: DEFAULT_AVD, waitUntil: "connected", timeoutMs: 1_000 }),
		).resolves.toEqual({
			avd: DEFAULT_AVD,
			serial: DEFAULT_SERIAL,
			state: "connected",
			reused: true,
		});
		expect(harness.spawnCalls.filter(args => args.includes("-avd"))).toEqual([]);
	});

	test("rejects ambiguous online emulators with the same AVD name", async () => {
		const serialA = "emulator-5554";
		const serialB = "emulator-5556";
		const harness = createHarness({
			executeAdb: sequentialDevices([[device(serialA), device(serialB)]]),
		});

		await expect(
			harness.manager.start({ avd: DEFAULT_AVD, waitUntil: "connected", timeoutMs: 1_000 }),
		).rejects.toThrow(/multiple|ambiguous|serial/i);
		expect(harness.spawnCalls.filter(args => args.includes("-avd"))).toEqual([]);
	});

	test("coalesces concurrent starts for the same AVD", async () => {
		const readinessEntered = Promise.withResolvers<void>();
		const releaseReadiness = Promise.withResolvers<void>();
		let devicesCalls = 0;
		const harness = createHarness({
			executeAdb: async args => {
				if (args[0] === "devices") {
					devicesCalls++;
					if (devicesCalls === 1) return commandResult(devicesOutput([]));
					readinessEntered.resolve();
					await releaseReadiness.promise;
					return commandResult(devicesOutput([device()]));
				}
				if (args.at(-2) === "avd" && args.at(-1) === "name") return commandResult(`${DEFAULT_AVD}\n`);
				return commandResult();
			},
		});

		const first = harness.manager.start({ avd: DEFAULT_AVD, waitUntil: "connected", timeoutMs: 10_000 });
		await readinessEntered.promise;
		const second = harness.manager.start({ avd: DEFAULT_AVD, waitUntil: "connected", timeoutMs: 10_000 });
		releaseReadiness.resolve();

		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(secondResult).toEqual(firstResult);
		expect(firstResult.reused).toBe(false);
		expect(harness.spawnCalls.filter(args => args.includes("-avd"))).toHaveLength(1);
	});

	test("reports an early emulator exit", async () => {
		const child = runningProcess();
		let sleepCalls = 0;
		const harness = createHarness({
			longProcess: child,
			executeAdb: sequentialDevices([[], []]),
			sleep: async () => {
				sleepCalls++;
				child.finish(23);
				await Promise.resolve();
			},
		});

		await expect(
			harness.manager.start({ avd: DEFAULT_AVD, waitUntil: "connected", timeoutMs: 10_000 }),
		).rejects.toThrow(/exit|23|launch/i);
		expect(sleepCalls).toBeGreaterThan(0);
	});

	test("times out deterministically and tree-terminates the launched process", async () => {
		let clock = 0;
		const harness = createHarness({
			executeAdb: sequentialDevices([[], []]),
			now: () => clock,
			sleep: async ms => {
				clock += ms;
				await Promise.resolve();
			},
		});

		await expect(harness.manager.start({ avd: DEFAULT_AVD, waitUntil: "connected", timeoutMs: 250 })).rejects.toThrow(
			/timed out|timeout/i,
		);
		expect(harness.terminatedProcesses).toEqual([harness.longProcess.process]);
		expect(harness.longProcess.process.exitCode).toBe(-1);
	});

	test("maps caller abort to ToolAbortError and tree-terminates the launched process", async () => {
		const controller = new AbortController();
		let deviceLists = 0;
		const harness = createHarness({
			executeAdb: async args => {
				if (args[0] === "devices") {
					deviceLists++;
					if (deviceLists === 2) controller.abort("test cancellation");
					return commandResult(devicesOutput([]));
				}
				return commandResult();
			},
		});

		await expect(
			harness.manager.start({
				avd: DEFAULT_AVD,
				waitUntil: "connected",
				timeoutMs: 10_000,
				signal: controller.signal,
			}),
		).rejects.toBeInstanceOf(ToolAbortError);
		expect(harness.terminatedProcesses).toEqual([harness.longProcess.process]);
	});
});

describe("EmulatorManager.status and wait", () => {
	test("status rejects zero devices", async () => {
		const harness = createHarness({ executeAdb: sequentialDevices([[]]) });
		await expect(harness.manager.status()).rejects.toBeInstanceOf(ToolError);
	});

	test("status auto-selects the unique online device and enriches its AVD name", async () => {
		const harness = createHarness({ executeAdb: sequentialDevices([[device()]]) });

		await expect(harness.manager.status()).resolves.toMatchObject({
			serial: DEFAULT_SERIAL,
			state: "device",
			avdName: DEFAULT_AVD,
		});
	});

	test("status requires a serial for multiple online devices and accepts an explicit serial", async () => {
		const serialA = "emulator-5554";
		const serialB = "emulator-5556";
		const executeAdb = sequentialDevices([
			[device(serialA), device(serialB)],
			[device(serialA), device(serialB)],
		]);
		const harness = createHarness({ executeAdb });

		await expect(harness.manager.status()).rejects.toThrow(/multiple|serial/i);
		await expect(harness.manager.status(serialB)).resolves.toMatchObject({
			serial: serialB,
			state: "device",
		});
	});

	test("status rejects explicitly selected offline and unauthorized devices", async () => {
		const offline = "emulator-5554";
		const unauthorized = "USB-DEVICE";
		const harness = createHarness({
			executeAdb: sequentialDevices([
				[device(offline, "offline"), device(unauthorized, "unauthorized")],
				[device(offline, "offline"), device(unauthorized, "unauthorized")],
			]),
		});

		await expect(harness.manager.status(offline)).rejects.toThrow(/offline/i);
		await expect(harness.manager.status(unauthorized)).rejects.toThrow(/unauthorized/i);
	});

	test("wait connected observes absent, offline, then online", async () => {
		const harness = createHarness({
			executeAdb: sequentialDevices([[], [device(DEFAULT_SERIAL, "offline")], [device(DEFAULT_SERIAL)]]),
		});

		await expect(harness.manager.wait(DEFAULT_SERIAL, "connected", 10_000)).resolves.toMatchObject({
			serial: DEFAULT_SERIAL,
			state: "device",
		});
	});

	test("wait booted does not complete before sys.boot_completed is 1", async () => {
		const bootValues = ["\n", "0\n", "1\n"];
		let bootCalls = 0;
		const harness = createHarness({
			executeAdb: async args => {
				if (args[0] === "devices") return commandResult(devicesOutput([device()]));
				if (args.at(-2) === "avd" && args.at(-1) === "name") return commandResult(`${DEFAULT_AVD}\n`);
				if (args.at(-1) === "sys.boot_completed") {
					const output = bootValues[Math.min(bootCalls, bootValues.length - 1)] ?? "1\n";
					bootCalls++;
					return commandResult(output);
				}
				return commandResult();
			},
		});

		await expect(harness.manager.wait(undefined, "booted", 10_000)).resolves.toMatchObject({
			serial: DEFAULT_SERIAL,
			state: "device",
		});
		expect(bootCalls).toBe(3);
	});
});

describe("EmulatorManager.stop", () => {
	test("bounds every ADB call by one shared stop deadline", async () => {
		let clock = 1_000;
		let devicesCalls = 0;
		const timeouts: number[] = [];
		const harness = createHarness({
			now: () => clock,
			executeAdb: async (args, options) => {
				if (options?.timeoutMs !== undefined) timeouts.push(options.timeoutMs);
				clock += 100;
				if (args[0] === "devices") {
					devicesCalls++;
					return commandResult(devicesOutput(devicesCalls < 3 ? [device()] : []));
				}
				if (args.at(-2) === "avd" && args.at(-1) === "name") return commandResult(`${DEFAULT_AVD}\n`);
				if (args.at(-2) === "emu" && args.at(-1) === "kill") return commandResult("OK\n");
				return commandResult("unexpected command", 1);
			},
		});

		await expect(harness.manager.stop(DEFAULT_SERIAL)).resolves.toEqual({
			serial: DEFAULT_SERIAL,
			avd: DEFAULT_AVD,
		});
		expect(timeouts.length).toBe(5);
		expect(timeouts.every(timeoutMs => timeoutMs > 0 && timeoutMs <= 10_000)).toBe(true);
		for (let index = 1; index < timeouts.length; index++) {
			expect(timeouts[index]).toBeLessThan(timeouts[index - 1] as number);
		}
	});

	test("stops an externally started emulator and waits for its serial to disappear", async () => {
		let devicesCalls = 0;
		const harness = createHarness({
			executeAdb: async args => {
				if (args[0] === "devices") {
					devicesCalls++;
					return commandResult(devicesOutput(devicesCalls < 3 ? [device()] : []));
				}
				if (args.at(-2) === "avd" && args.at(-1) === "name") return commandResult(`${DEFAULT_AVD}\n`);
				if (args.at(-2) === "emu" && args.at(-1) === "kill") return commandResult("OK\n");
				return commandResult("unexpected command", 1);
			},
		});

		await expect(harness.manager.stop(DEFAULT_SERIAL)).resolves.toEqual({
			serial: DEFAULT_SERIAL,
			avd: DEFAULT_AVD,
		});
		expect(harness.adbCalls).toContainEqual(["-s", DEFAULT_SERIAL, "emu", "kill"]);
		expect(devicesCalls).toBeGreaterThanOrEqual(3);
		expectNoKillServer(harness.adbCalls);
	});

	test("refuses a physical device without sending emu kill", async () => {
		const serial = "R5CT20PHONE";
		const harness = createHarness({
			executeAdb: async args => {
				if (args[0] === "devices") return commandResult(devicesOutput([device(serial)]));
				if (args.at(-2) === "avd" && args.at(-1) === "name") {
					return commandResult("error: unknown command", 1);
				}
				return commandResult();
			},
		});

		await expect(harness.manager.stop(serial)).rejects.toThrow(/emulator|physical|AVD/i);
		expect(harness.adbCalls).not.toContainEqual(["-s", serial, "emu", "kill"]);
		expectNoKillServer(harness.adbCalls);
	});

	test("preserves an identity timeout and does not send emu kill", async () => {
		const harness = createHarness({
			executeAdb: async args => {
				if (args[0] === "devices") return commandResult(devicesOutput([device()]));
				if (args.at(-2) === "avd" && args.at(-1) === "name") {
					return { ...commandResult("identity timed out", null), cancelled: true, timedOut: true };
				}
				return commandResult();
			},
		});

		await expect(harness.manager.stop(DEFAULT_SERIAL)).rejects.toThrow(/timed out.*emulator identity/i);
		expect(harness.adbCalls).not.toContainEqual(["-s", DEFAULT_SERIAL, "emu", "kill"]);
	});

	test("preserves an identity cancellation and does not send emu kill", async () => {
		const harness = createHarness({
			executeAdb: async args => {
				if (args[0] === "devices") return commandResult(devicesOutput([device()]));
				if (args.at(-2) === "avd" && args.at(-1) === "name") {
					return { ...commandResult("identity cancelled", null), cancelled: true };
				}
				return commandResult();
			},
		});

		await expect(harness.manager.stop(DEFAULT_SERIAL)).rejects.toThrow(/cancelled.*emulator identity/i);
		expect(harness.adbCalls).not.toContainEqual(["-s", DEFAULT_SERIAL, "emu", "kill"]);
	});

	test("does not issue identity or kill commands after the stop budget is exhausted", async () => {
		let clock = 0;
		const harness = createHarness({
			now: () => clock,
			executeAdb: async args => {
				clock = 10_000;
				return args[0] === "devices" ? commandResult(devicesOutput([device()])) : commandResult();
			},
		});

		await expect(harness.manager.stop(DEFAULT_SERIAL)).rejects.toThrow(/Timed out after 10 seconds.*emulator stop/i);
		expect(harness.adbCalls).toEqual([["devices", "-l"]]);
	});

	test("actively stops a manager-started emulator without treating its exit as a crash", async () => {
		let deviceLists = 0;
		let stopped = false;
		const child = runningProcess();
		const harness = createHarness({
			longProcess: child,
			executeAdb: async args => {
				if (args[0] === "devices") {
					deviceLists++;
					return commandResult(devicesOutput(deviceLists > 1 && !stopped ? [device()] : []));
				}
				if (args.at(-2) === "avd" && args.at(-1) === "name") return commandResult(`${DEFAULT_AVD}\n`);
				if (args.at(-2) === "emu" && args.at(-1) === "kill") {
					stopped = true;
					child.finish(0);
					return commandResult("OK\n");
				}
				return commandResult();
			},
		});

		await expect(
			harness.manager.start({ avd: DEFAULT_AVD, waitUntil: "connected", timeoutMs: 10_000 }),
		).resolves.toMatchObject({ serial: DEFAULT_SERIAL, reused: false });
		await expect(harness.manager.stop(DEFAULT_SERIAL)).resolves.toEqual({
			serial: DEFAULT_SERIAL,
			avd: DEFAULT_AVD,
		});
		expect(child.process.exitCode).toBe(0);
		expect(harness.terminatedProcesses).toEqual([]);
		expectNoKillServer(harness.adbCalls);
	});
});
