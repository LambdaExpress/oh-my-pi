import { Process } from "@oh-my-pi/pi-natives";
import { ToolAbortError, ToolError, throwIfAborted } from "../tools/tool-errors";
import {
	type AdbCommandOptions,
	type AdbCommandResult,
	type AdbDevice,
	type AdbSpawnOptions,
	type AdbSubprocess,
	type AndroidExecutableName,
	executeAdb,
	parseAdbDevices,
	parseAvdList,
	resolveAndroidExecutable,
} from "./adb-executor";

const POLL_INTERVAL_MS = 250;
const LIST_AVDS_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 10_000;
const PROCESS_TERMINATE_MS = 2_000;
const CAPTURE_MAX_BYTES = 32 * 1024;
const SDK_CONFIGURATION_HINT =
	"Add the Android SDK emulator directory to PATH, or set ANDROID_SDK_ROOT or ANDROID_HOME (Windows default: %LOCALAPPDATA%\\Android\\Sdk).";

export type EmulatorWaitUntil = "connected" | "booted";

export interface EmulatorStartOptions {
	avd: string;
	waitUntil: EmulatorWaitUntil;
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface EmulatorStartResult {
	avd: string;
	serial: string;
	state: EmulatorWaitUntil;
	pid?: number;
	reused: boolean;
}

export interface EmulatorStopResult {
	serial: string;
	avd: string;
}

export interface EmulatorManagerDependencies {
	resolveExecutable(name: AndroidExecutableName): string | null;
	executeAdb(args: readonly string[], options?: AdbCommandOptions): Promise<AdbCommandResult>;
	spawnEmulator(argv: readonly string[], options: AdbSpawnOptions): AdbSubprocess;
	terminateProcess(process: AdbSubprocess): Promise<void>;
	sleep(ms: number): Promise<void>;
	now(): number;
}

interface BoundedCapture {
	readonly done: Promise<void>;
	readonly settled: boolean;
	cancel(): Promise<void>;
	text(): string;
}

interface EmulatorRecord {
	readonly avd: string;
	generation: number;
	process?: AdbSubprocess;
	pid?: number;
	serial?: string;
	exitPromise?: Promise<number | null>;
	exitSettled: boolean;
	exitCode?: number | null;
	exitError?: string;
	stopping: boolean;
	stderr?: BoundedCapture;
	inFlightStart?: Promise<EmulatorStartResult>;
}

interface AvdIdentity {
	device: AdbDevice;
	avdName: string;
}

function processEnvironment(): Record<string, string> {
	const entries: Array<[string, string]> = [];
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) entries.push([key, value]);
	}
	return Object.fromEntries(entries);
}

function emulatorSpawnOptions(): AdbSpawnOptions {
	return {
		env: processEnvironment(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	};
}

async function terminateProcess(process: AdbSubprocess): Promise<void> {
	const processRef = Process.fromPid(process.pid);
	if (processRef) {
		try {
			const terminated = await processRef.terminate({
				group: true,
				gracefulMs: -1,
				timeoutMs: PROCESS_TERMINATE_MS,
			});
			if (terminated) return;
		} catch {
			// Fall back to the child handle when a native process reference cannot be used.
		}
	}
	try {
		process.kill("SIGKILL");
	} catch {
		return;
	}
	await Promise.race([process.exited.catch(() => undefined), Bun.sleep(PROCESS_TERMINATE_MS)]);
}

const DEFAULT_DEPENDENCIES: EmulatorManagerDependencies = {
	resolveExecutable: name => resolveAndroidExecutable(name),
	executeAdb,
	spawnEmulator: (argv, options) => Bun.spawn([...argv], options) as AdbSubprocess,
	terminateProcess,
	sleep: ms => Bun.sleep(ms),
	now: () => Date.now(),
};

function captureStream(stream: ReadableStream<Uint8Array> | null, retain: boolean): BoundedCapture {
	let text = "";
	if (!stream) {
		const done = Promise.resolve();
		return { done, settled: true, cancel: () => done, text: () => text };
	}
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let settled = false;
	const append = (chunk: string) => {
		if (!retain || !chunk) return;
		text += chunk;
		while (Buffer.byteLength(text, "utf8") > CAPTURE_MAX_BYTES && text.length > 1) {
			text = text.slice(Math.max(1, Math.floor(text.length / 4)));
		}
	};
	const done = (async () => {
		try {
			for (;;) {
				const next = await reader.read();
				if (next.done) break;
				if (next.value) append(decoder.decode(next.value, { stream: true }));
			}
			append(decoder.decode());
		} finally {
			reader.releaseLock();
		}
	})();
	void done.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	return {
		done,
		get settled() {
			return settled;
		},
		async cancel() {
			if (!settled) await reader.cancel().catch(() => undefined);
			await done.catch(() => undefined);
		},
		text: () => text,
	};
}

function outputContext(output: string | undefined): string {
	const text = output?.trim();
	return text ? `\nOutput:\n${text}` : "";
}

function stderrContext(stderr: string | undefined): string {
	const text = stderr?.trim();
	return text ? `\nStderr:\n${text}` : "";
}

function parseAvdName(output: string): string | undefined {
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line === "OK" || line.startsWith("KO:")) continue;
		return line;
	}
	return undefined;
}

function bootCompleted(output: string): boolean {
	return output.split(/\r?\n/).some(line => line.trim() === "1");
}

function describeDevices(devices: readonly AdbDevice[]): string {
	if (devices.length === 0) return "none";
	return [...devices]
		.sort((left, right) => left.serial.localeCompare(right.serial))
		.map(device => `${device.serial} (${device.state}${device.model ? `, ${device.model}` : ""})`)
		.join(", ");
}

function timeoutSeconds(timeoutMs: number): number {
	return Math.max(0, Math.round(timeoutMs / 1000));
}

/** Manages existing Android Virtual Devices without owning successful emulator lifetimes. */
export class EmulatorManager {
	readonly #dependencies: EmulatorManagerDependencies;
	readonly #records = new Map<string, EmulatorRecord>();
	#operationTail: Promise<void> = Promise.resolve();

	constructor(overrides: Partial<EmulatorManagerDependencies> = {}) {
		this.#dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
	}

	async listAvds(): Promise<string[]> {
		const executable = this.#dependencies.resolveExecutable("emulator");
		if (!executable) {
			throw new ToolError(`Android emulator executable was not found. ${SDK_CONFIGURATION_HINT}`);
		}
		const deadline = this.#dependencies.now() + LIST_AVDS_TIMEOUT_MS;

		let child: AdbSubprocess;
		try {
			child = this.#dependencies.spawnEmulator([executable, "-list-avds"], emulatorSpawnOptions());
		} catch (error) {
			throw new ToolError(
				`Failed to launch the Android emulator while listing AVDs. ${SDK_CONFIGURATION_HINT}${stderrContext(
					error instanceof Error ? error.message : String(error),
				)}`,
			);
		}
		let stdout: BoundedCapture | undefined;
		let stderr: BoundedCapture | undefined;
		try {
			stdout = captureStream(child.stdout, true);
			stderr = captureStream(child.stderr, true);
		} catch (error) {
			await this.#terminateAndDrainListProcess(
				child,
				[stdout].filter(capture => capture !== undefined),
				deadline,
			);
			throw new ToolError(
				`Android emulator output capture failed while listing AVDs. ${SDK_CONFIGURATION_HINT}${stderrContext(
					error instanceof Error ? error.message : String(error),
				)}`,
			);
		}
		const completed = Promise.all([child.exited, stdout.done, stderr.done]).then(
			([exitCode]) => ({ kind: "completed" as const, exitCode }),
			error => ({ kind: "failed" as const, error }),
		);
		let budget = this.#remaining(deadline);
		let outcome: Awaited<typeof completed> | { kind: "timed-out" } = { kind: "timed-out" };
		while (budget > 0) {
			const waitMs = Math.min(POLL_INTERVAL_MS, budget);
			const next = await Promise.race([
				completed,
				this.#dependencies.sleep(waitMs).then(
					() => ({ kind: "pending" as const }),
					error => ({ kind: "failed" as const, error }),
				),
			]);
			if (next.kind !== "pending") {
				outcome = next;
				break;
			}
			budget = Math.min(budget - waitMs, this.#remaining(deadline));
		}
		if (outcome.kind === "timed-out") {
			await this.#terminateAndDrainListProcess(child, [stdout, stderr], deadline);
			throw new ToolError(
				`Timed out after ${timeoutSeconds(LIST_AVDS_TIMEOUT_MS)} seconds while listing Android Virtual Devices. ${SDK_CONFIGURATION_HINT}${stderrContext(stderr.text())}${outputContext(stdout.text())}`,
			);
		}
		if (outcome.kind === "failed") {
			await this.#terminateAndDrainListProcess(child, [stdout, stderr], deadline);
			throw new ToolError(
				`Android emulator failed while listing AVDs. ${SDK_CONFIGURATION_HINT}${stderrContext(
					outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
				)}${stderrContext(stderr.text())}${outputContext(stdout.text())}`,
			);
		}
		const exitCode = outcome.exitCode;
		if (exitCode !== 0) {
			throw new ToolError(
				`Android emulator could not list AVDs (exit code ${exitCode}). ${SDK_CONFIGURATION_HINT}${stderrContext(
					stderr.text() || stdout.text(),
				)}`,
			);
		}
		return parseAvdList(stdout.text());
	}

	async #terminateAndDrainListProcess(
		child: AdbSubprocess,
		captures: readonly BoundedCapture[],
		deadline: number,
	): Promise<void> {
		const terminate = this.#dependencies.terminateProcess(child);
		const cancel = captures.filter(capture => !capture.settled).map(capture => capture.cancel());
		const drained = Promise.allSettled([terminate, ...cancel, ...captures.map(capture => capture.done)]);
		await Promise.race([drained, this.#dependencies.sleep(this.#remaining(deadline)).catch(() => undefined)]);
	}

	start(options: EmulatorStartOptions): Promise<EmulatorStartResult> {
		let record = this.#records.get(options.avd);
		if (!record) {
			record = {
				avd: options.avd,
				generation: 0,
				exitSettled: false,
				stopping: false,
			};
			this.#records.set(options.avd, record);
		}
		if (record.inFlightStart) return record.inFlightStart;

		const startPromise = this.#serialize(() => this.#start(record as EmulatorRecord, options));
		record.inFlightStart = startPromise;
		void startPromise
			.finally(() => {
				if (record?.inFlightStart === startPromise) record.inFlightStart = undefined;
			})
			.catch(() => undefined);
		return startPromise;
	}

	async status(serial?: string): Promise<AdbDevice> {
		const devices = await this.#devices("device status");
		const selected = this.#selectOnlineDevice(devices, serial);
		const avdName = await this.#tryAvdName(selected.serial, undefined, undefined);
		return avdName ? { ...selected, avdName } : selected;
	}

	async wait(
		serial: string | undefined,
		until: EmulatorWaitUntil,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AdbDevice> {
		if (timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
			throw new ToolError("Emulator wait timeout must be a positive finite number of milliseconds.");
		}
		const deadline = this.#dependencies.now() + timeoutMs;
		let selectedSerial = serial;
		let lastDevices: AdbDevice[] = [];
		let stage = "device wait";

		for (;;) {
			throwIfAborted(signal);
			if (this.#dependencies.now() >= deadline) {
				throw new ToolError(
					`Timed out after ${timeoutSeconds(timeoutMs)} seconds during ${stage}. Current devices: ${describeDevices(lastDevices)}. ` +
						"Run adb devices -l and specify a serial when multiple devices are online.",
				);
			}
			lastDevices = await this.#devices(stage, signal, this.#remaining(deadline));
			let device: AdbDevice | undefined;
			if (selectedSerial) {
				device = lastDevices.find(candidate => candidate.serial === selectedSerial);
			} else {
				const online = lastDevices.filter(candidate => candidate.state === "device");
				if (online.length > 1) throw this.#multipleDevicesError(lastDevices);
				if (online.length === 1) {
					device = online[0];
					selectedSerial = device?.serial;
				}
			}

			if (device?.state === "device") {
				if (until === "connected") return device;
				stage = "boot wait";
				const result = await this.#tryAdb(
					["-s", device.serial, "shell", "getprop", "sys.boot_completed"],
					stage,
					signal,
					this.#remaining(deadline),
				);
				if (result && bootCompleted(result.output)) return device;
			} else {
				stage = "device wait";
			}
			await this.#pause(Math.min(POLL_INTERVAL_MS, this.#remaining(deadline)), signal);
		}
	}

	stop(serial?: string): Promise<EmulatorStopResult> {
		return this.#serialize(() => this.#stop(serial));
	}

	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#operationTail.then(operation, operation);
		this.#operationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async #start(record: EmulatorRecord, options: EmulatorStartOptions): Promise<EmulatorStartResult> {
		if (!options.avd) throw new ToolError("An exact AVD name is required.");
		if (options.timeoutMs <= 0 || !Number.isFinite(options.timeoutMs)) {
			throw new ToolError("Emulator start timeout must be a positive finite number of milliseconds.");
		}
		throwIfAborted(options.signal);
		const deadline = this.#dependencies.now() + options.timeoutMs;
		const avds = await this.listAvds();
		throwIfAborted(options.signal);
		if (!avds.includes(options.avd)) {
			throw new ToolError(
				`Unknown Android Virtual Device ${JSON.stringify(options.avd)}. Available AVDs: ${
					avds.length > 0 ? avds.map(avd => JSON.stringify(avd)).join(", ") : "none"
				}. Run emulator -list-avds and use an exact name.`,
			);
		}

		const initialDevices = await this.#devices("emulator launch", options.signal, this.#remaining(deadline));
		const initialMatches = await this.#avdMatches(initialDevices, options.avd, options.signal, deadline);
		if (initialMatches.length > 1) throw this.#ambiguousAvdError(options.avd, initialMatches);
		const existing = initialMatches[0];
		if (existing?.device.state === "device") {
			const device = await this.#waitForKnownDevice(
				existing.device.serial,
				options.waitUntil,
				options.timeoutMs,
				deadline,
				options.signal,
			);
			return { avd: options.avd, serial: device.serial, state: options.waitUntil, reused: true };
		}

		const executable = this.#dependencies.resolveExecutable("emulator");
		if (!executable) {
			throw new ToolError(
				`Android emulator executable was not found during emulator launch. ${SDK_CONFIGURATION_HINT}`,
			);
		}
		record.generation += 1;
		const generation = record.generation;
		record.stopping = false;
		record.serial = undefined;
		record.exitSettled = false;
		record.exitCode = undefined;
		record.exitError = undefined;

		let child: AdbSubprocess;
		try {
			child = this.#dependencies.spawnEmulator([executable, "-avd", options.avd], emulatorSpawnOptions());
		} catch (error) {
			throw new ToolError(
				`Failed during emulator launch for AVD ${JSON.stringify(options.avd)}.${stderrContext(
					error instanceof Error ? error.message : String(error),
				)}`,
			);
		}
		record.process = child;
		record.pid = child.pid;
		const stdout = captureStream(child.stdout, false);
		const stderr = captureStream(child.stderr, true);
		record.stderr = stderr;
		record.exitPromise = child.exited.then(
			exitCode => {
				if (record.generation === generation) {
					record.exitSettled = true;
					record.exitCode = exitCode;
					if (record.process === child) record.process = undefined;
				}
				return exitCode;
			},
			error => {
				if (record.generation === generation) {
					record.exitSettled = true;
					record.exitCode = null;
					record.exitError = error instanceof Error ? error.message : String(error);
					if (record.process === child) record.process = undefined;
				}
				return null;
			},
		);
		void Promise.allSettled([record.exitPromise, stdout.done, stderr.done]);
		(child as AdbSubprocess & { unref?: () => void }).unref?.();

		try {
			const device = await this.#waitForLaunchedAvd(record, generation, options, deadline);
			record.serial = device.serial;
			return {
				avd: options.avd,
				serial: device.serial,
				state: options.waitUntil,
				pid: child.pid,
				reused: false,
			};
		} catch (error) {
			await this.#cleanupLaunch(record, generation, child);
			throw error;
		}
	}

	async #waitForLaunchedAvd(
		record: EmulatorRecord,
		generation: number,
		options: EmulatorStartOptions,
		deadline: number,
	): Promise<AdbDevice> {
		let lastDevices: AdbDevice[] = [];
		let stage = "device wait";
		for (;;) {
			throwIfAborted(options.signal);
			if (record.generation !== generation) {
				throw new ToolError(`Emulator launch for AVD ${JSON.stringify(options.avd)} was superseded.`);
			}
			if (record.exitSettled) {
				await Promise.race([record.stderr?.done ?? Promise.resolve(), this.#dependencies.sleep(POLL_INTERVAL_MS)]);
				throw new ToolError(
					`Android emulator exited early during emulator launch for AVD ${JSON.stringify(options.avd)}${
						record.exitCode === null || record.exitCode === undefined ? "" : ` (exit code ${record.exitCode})`
					}.${stderrContext(record.stderr?.text() || record.exitError)}`,
				);
			}
			if (this.#dependencies.now() >= deadline) {
				throw new ToolError(
					`Timed out after ${timeoutSeconds(options.timeoutMs)} seconds during ${stage} for AVD ${JSON.stringify(
						options.avd,
					)}. Current devices: ${describeDevices(lastDevices)}.${stderrContext(record.stderr?.text())}`,
				);
			}

			lastDevices = await this.#devices(stage, options.signal, this.#remaining(deadline));
			const matches = await this.#avdMatches(lastDevices, options.avd, options.signal, deadline);
			if (matches.length > 1) throw this.#ambiguousAvdError(options.avd, matches);
			const match = matches[0];
			if (match) record.serial = match.device.serial;
			if (match?.device.state === "device") {
				if (options.waitUntil === "connected") return match.device;
				stage = "boot wait";
				const result = await this.#tryAdb(
					["-s", match.device.serial, "shell", "getprop", "sys.boot_completed"],
					stage,
					options.signal,
					this.#remaining(deadline),
				);
				if (result && bootCompleted(result.output)) return match.device;
			} else {
				stage = "device wait";
			}
			await this.#pause(Math.min(POLL_INTERVAL_MS, this.#remaining(deadline)), options.signal, record.exitPromise);
		}
	}

	async #waitForKnownDevice(
		serial: string,
		until: EmulatorWaitUntil,
		timeoutMs: number,
		deadline: number,
		signal?: AbortSignal,
	): Promise<AdbDevice> {
		let lastDevices: AdbDevice[] = [];
		let stage = "device wait";
		for (;;) {
			throwIfAborted(signal);
			if (this.#dependencies.now() >= deadline) {
				throw new ToolError(
					`Timed out after ${timeoutSeconds(timeoutMs)} seconds during ${stage} for ${serial}. Current devices: ${describeDevices(
						lastDevices,
					)}.`,
				);
			}
			lastDevices = await this.#devices(stage, signal, this.#remaining(deadline));
			const device = lastDevices.find(candidate => candidate.serial === serial);
			if (device?.state === "device") {
				if (until === "connected") return device;
				stage = "boot wait";
				const result = await this.#tryAdb(
					["-s", serial, "shell", "getprop", "sys.boot_completed"],
					stage,
					signal,
					this.#remaining(deadline),
				);
				if (result && bootCompleted(result.output)) return device;
			} else {
				stage = "device wait";
			}
			await this.#pause(Math.min(POLL_INTERVAL_MS, this.#remaining(deadline)), signal);
		}
	}

	async #stop(serial?: string): Promise<EmulatorStopResult> {
		const deadline = this.#dependencies.now() + STOP_TIMEOUT_MS;
		let selectedSerial = serial;
		let lastDevices: AdbDevice[] = [];
		const remaining = (): number => {
			const timeoutMs = this.#remaining(deadline);
			if (timeoutMs > 0) return timeoutMs;
			throw new ToolError(
				`Timed out after ${timeoutSeconds(STOP_TIMEOUT_MS)} seconds during emulator stop${
					selectedSerial ? ` for ${selectedSerial}` : ""
				}. Current devices: ${describeDevices(lastDevices)}.`,
			);
		};
		const devices = await this.#devices("emulator stop", undefined, remaining());
		lastDevices = devices;
		const selected = this.#selectOnlineDevice(devices, serial);
		selectedSerial = selected.serial;
		const identity = await this.#probeAvdName(selected.serial, remaining());
		if (!identity) {
			remaining();
			throw new ToolError(
				`Device ${selected.serial} is not an Android emulator: adb emu avd name did not return an AVD name. ` +
					"Physical devices cannot be stopped by this operation.",
			);
		}
		const record = this.#records.get(identity);
		if (record) record.stopping = true;
		try {
			await this.#adb(["-s", selected.serial, "emu", "kill"], "emulator stop", undefined, remaining());
			for (;;) {
				if (!lastDevices.some(device => device.serial === selected.serial)) {
					return { serial: selected.serial, avd: identity };
				}
				await this.#pause(Math.min(POLL_INTERVAL_MS, remaining()));
				lastDevices = await this.#devices("emulator stop", undefined, remaining());
			}
		} catch (error) {
			if (record) record.stopping = false;
			throw error;
		}
	}

	async #cleanupLaunch(record: EmulatorRecord, generation: number, child: AdbSubprocess): Promise<void> {
		if (record.generation !== generation) return;
		record.stopping = true;
		await this.#dependencies.terminateProcess(child).catch(() => undefined);
		await Promise.race([
			child.exited.catch(() => undefined),
			this.#dependencies.sleep(PROCESS_TERMINATE_MS).catch(() => undefined),
		]);
	}

	async #devices(phase: string, signal?: AbortSignal, timeoutMs?: number): Promise<AdbDevice[]> {
		const result = await this.#adb(["devices", "-l"], phase, signal, timeoutMs);
		return parseAdbDevices(result.output);
	}

	async #avdMatches(
		devices: readonly AdbDevice[],
		avd: string,
		signal: AbortSignal | undefined,
		deadline: number,
	): Promise<AvdIdentity[]> {
		const identities = await Promise.all(
			devices.map(async device => {
				const avdName = await this.#tryAvdName(device.serial, signal, this.#remaining(deadline));
				return avdName ? { device, avdName } : undefined;
			}),
		);
		return identities.filter((identity): identity is AvdIdentity => identity?.avdName === avd);
	}

	async #tryAvdName(serial: string, signal?: AbortSignal, timeoutMs?: number): Promise<string | undefined> {
		const result = await this.#tryAdb(["-s", serial, "emu", "avd", "name"], "emulator identity", signal, timeoutMs);
		return result ? parseAvdName(result.output) : undefined;
	}

	async #probeAvdName(serial: string, timeoutMs: number): Promise<string | undefined> {
		const result = await this.#adb(
			["-s", serial, "emu", "avd", "name"],
			"emulator identity",
			undefined,
			timeoutMs,
			true,
		);
		return result.exitCode === 0 ? parseAvdName(result.output) : undefined;
	}

	async #tryAdb(
		args: readonly string[],
		phase: string,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<AdbCommandResult | undefined> {
		try {
			return await this.#adb(args, phase, signal, timeoutMs);
		} catch (error) {
			if (error instanceof ToolAbortError) throw error;
			return undefined;
		}
	}

	async #adb(
		args: readonly string[],
		phase: string,
		signal?: AbortSignal,
		timeoutMs?: number,
		allowNonZero = false,
	): Promise<AdbCommandResult> {
		throwIfAborted(signal);
		let result: AdbCommandResult;
		try {
			result = await this.#dependencies.executeAdb(args, {
				...(timeoutMs === undefined ? {} : { timeoutMs: Math.max(1, Math.floor(timeoutMs)) }),
				...(signal ? { signal } : {}),
			});
		} catch (error) {
			if (error instanceof ToolAbortError || error instanceof ToolError) throw error;
			throw new ToolError(
				`ADB command failed during ${phase}: ${error instanceof Error ? error.message : String(error)}. ` +
					"Verify adb is installed and run adb devices -l.",
			);
		}
		if (result.cancelled) {
			if (signal?.aborted) throw new ToolAbortError(undefined, { cause: signal.reason });
			if (result.timedOut) {
				throw new ToolError(`ADB command timed out during ${phase}.${outputContext(result.output)}`);
			}
			throw new ToolError(`ADB command was cancelled during ${phase}.${outputContext(result.output)}`);
		}
		if (result.exitCode !== 0 && !allowNonZero) {
			throw new ToolError(
				`ADB command failed during ${phase} with exit code ${result.exitCode ?? "unknown"}.${outputContext(result.output)}`,
			);
		}
		return result;
	}

	#selectOnlineDevice(devices: readonly AdbDevice[], serial?: string): AdbDevice {
		if (serial) {
			const selected = devices.find(device => device.serial === serial);
			if (!selected) {
				throw new ToolError(
					`Android device ${serial} was not found. Current devices: ${describeDevices(devices)}. Run adb devices -l.`,
				);
			}
			if (selected.state !== "device") {
				throw new ToolError(
					`Android device ${serial} is ${selected.state} and cannot be used. Current devices: ${describeDevices(devices)}.`,
				);
			}
			return selected;
		}
		const online = devices.filter(device => device.state === "device");
		if (online.length === 1) return online[0] as AdbDevice;
		if (online.length > 1) throw this.#multipleDevicesError(devices);
		throw new ToolError(
			`No online Android devices are available. Current devices: ${describeDevices(devices)}. ` +
				"Start an emulator or authorize a device, then run adb devices -l.",
		);
	}

	#multipleDevicesError(devices: readonly AdbDevice[]): ToolError {
		const online = devices
			.filter(device => device.state === "device")
			.map(device => device.serial)
			.sort()
			.join(", ");
		return new ToolError(
			`Multiple Android devices are online (${online}); specify a serial. Current devices: ${describeDevices(devices)}.`,
		);
	}

	#ambiguousAvdError(avd: string, matches: readonly AvdIdentity[]): ToolError {
		const serials = matches
			.map(match => match.device.serial)
			.sort()
			.join(", ");
		return new ToolError(
			`Multiple emulator instances match AVD ${JSON.stringify(avd)} (${serials}); specify a serial instead of choosing one implicitly.`,
		);
	}

	#remaining(deadline: number): number {
		return Math.max(0, deadline - this.#dependencies.now());
	}

	async #pause(ms: number, signal?: AbortSignal, exitPromise?: Promise<number | null>): Promise<void> {
		throwIfAborted(signal);
		const sleepers: Array<Promise<unknown>> = [this.#dependencies.sleep(Math.max(0, ms))];
		if (exitPromise) sleepers.push(exitPromise);
		let abortListener: (() => void) | undefined;
		if (signal) {
			const aborted = Promise.withResolvers<void>();
			abortListener = () => aborted.resolve();
			signal.addEventListener("abort", abortListener, { once: true });
			sleepers.push(aborted.promise);
		}
		try {
			await Promise.race(sleepers);
			throwIfAborted(signal);
		} finally {
			if (abortListener) signal?.removeEventListener("abort", abortListener);
		}
	}
}
