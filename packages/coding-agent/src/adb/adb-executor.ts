import * as fs from "node:fs";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { buildNonInteractiveEnv } from "../exec/non-interactive-env";
import { OutputSink, type OutputSummary, truncateTailBytes } from "../session/streaming-output";

const STREAM_DRAIN_MS = 250;
const TERMINATE_WAIT_MS = 500;
const STDERR_MAX_BYTES = 32 * 1024;
export const DEFAULT_ADB_BINARY_MAX_BYTES = 32 * 1024 * 1024;

export type AndroidExecutableName = "adb" | "emulator";

export interface AdbDevice {
	serial: string;
	state: "device" | "offline" | "unauthorized" | "unknown";
	model?: string;
	product?: string;
	transportId?: string;
	avdName?: string;
}

export interface AdbSpawnOptions {
	cwd?: string;
	env: Record<string, string>;
	stdin: "ignore";
	stdout: "pipe";
	stderr: "pipe";
	windowsHide: boolean;
}

export interface AdbSubprocess {
	readonly pid: number;
	readonly stdout: ReadableStream<Uint8Array> | null;
	readonly stderr: ReadableStream<Uint8Array> | null;
	readonly exited: Promise<number>;
	readonly exitCode: number | null;
	readonly killed: boolean;
	kill(signal?: number | NodeJS.Signals): void;
}

/** Injectable process and filesystem boundary used by the executor's behavioral tests. */
export interface AdbExecutorDependencies {
	resolveExecutable(name: AndroidExecutableName): string | null;
	which(name: string): string | null;
	isFile(candidate: string): boolean;
	spawn(argv: readonly string[], options: AdbSpawnOptions): AdbSubprocess;
	terminateTree(process: AdbSubprocess): Promise<void>;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly platform: NodeJS.Platform;
}

export interface AdbCommandOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	onChunk?: (chunk: string) => void;
	artifactPath?: string;
	artifactId?: string;
	cwd?: string;
	spillThreshold?: number;
	tailBytes?: number;
	headBytes?: number;
	maxColumns?: number;
	chunkThrottleMs?: number;
	maxBinaryBytes?: number;
	dependencies?: Partial<AdbExecutorDependencies>;
}

export interface AdbCommandResult extends OutputSummary {
	exitCode: number | null;
	cancelled: boolean;
	timedOut?: boolean;
	artifactId?: string;
}

export interface AdbBinaryResult {
	bytes: Uint8Array;
	exitCode: number | null;
	cancelled: boolean;
	timedOut?: boolean;
	/** Bounded stderr context; it is never mixed into {@link bytes}. */
	stderr?: string;
}

export class AndroidExecutableNotFoundError extends Error {
	readonly code = "ANDROID_EXECUTABLE_NOT_FOUND";

	constructor(readonly executable: AndroidExecutableName) {
		super(`Android SDK executable not found: ${executable}. Add it to PATH or set ANDROID_SDK_ROOT or ANDROID_HOME.`);
		this.name = "AndroidExecutableNotFoundError";
	}
}

export class AdbBinaryOutputLimitError extends Error {
	readonly code = "ADB_BINARY_OUTPUT_LIMIT";

	constructor(
		readonly limitBytes: number,
		readonly stderr: string,
	) {
		super(`ADB binary output exceeded the ${limitBytes}-byte limit`);
		this.name = "AdbBinaryOutputLimitError";
	}
}

function isRegularFile(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

async function terminateTree(process: AdbSubprocess): Promise<void> {
	const processRef = Process.fromPid(process.pid);
	if (processRef) {
		try {
			const terminated = await processRef.terminate({
				group: true,
				gracefulMs: -1,
				timeoutMs: TERMINATE_WAIT_MS,
			});
			if (terminated) return;
		} catch {
			// Fall through to Bun's direct kill when the native process handle is unavailable.
		}
	}
	try {
		process.kill("SIGKILL");
	} catch {
		return;
	}
	await Promise.race([process.exited.catch(() => undefined), Bun.sleep(TERMINATE_WAIT_MS)]);
}

const DEFAULT_DEPENDENCIES: Omit<AdbExecutorDependencies, "env"> = {
	resolveExecutable: name => resolveAndroidExecutable(name),
	which: name => Bun.which(name),
	isFile: isRegularFile,
	spawn: (argv, options) => Bun.spawn([...argv], options) as AdbSubprocess,
	terminateTree,
	platform: process.platform,
};

function resolveDependencies(overrides?: Partial<AdbExecutorDependencies>): AdbExecutorDependencies {
	const dependencies: AdbExecutorDependencies = { ...DEFAULT_DEPENDENCIES, env: process.env, ...overrides };
	if (!overrides?.resolveExecutable) {
		dependencies.resolveExecutable = name => resolveAndroidExecutable(name, dependencies);
	}
	return dependencies;
}

function envValue(
	env: Readonly<Record<string, string | undefined>>,
	name: string,
	platform: NodeJS.Platform,
): string | undefined {
	if (platform !== "win32") return env[name];
	const normalizedName = name.toLowerCase();
	for (const [key, value] of Object.entries(env)) {
		if (key.toLowerCase() === normalizedName) return value;
	}
	return undefined;
}

function sdkExecutablePath(root: string, name: AndroidExecutableName, platform: NodeJS.Platform): string {
	const join = platform === "win32" ? path.win32.join : path.posix.join;
	const executable = platform === "win32" ? `${name}.exe` : name;
	return name === "adb" ? join(root, "platform-tools", executable) : join(root, "emulator", executable);
}

/** Resolve an Android SDK executable without installing or modifying the SDK. */
export function resolveAndroidExecutable(
	name: AndroidExecutableName,
	dependencies?: Partial<AdbExecutorDependencies>,
): string | null {
	const deps = resolveDependencies(dependencies);
	const pathNames = deps.platform === "win32" ? [name, `${name}.exe`] : [name];
	for (const pathName of pathNames) {
		const resolved = deps.which(pathName);
		if (resolved && deps.isFile(resolved)) return resolved;
	}

	for (const variable of ["ANDROID_SDK_ROOT", "ANDROID_HOME"] as const) {
		const root = envValue(deps.env, variable, deps.platform);
		if (!root) continue;
		const candidate = sdkExecutablePath(root, name, deps.platform);
		if (deps.isFile(candidate)) return candidate;
	}

	if (deps.platform === "win32") {
		const localAppData = envValue(deps.env, "LOCALAPPDATA", deps.platform);
		if (localAppData) {
			const candidate = sdkExecutablePath(path.win32.join(localAppData, "Android", "Sdk"), name, deps.platform);
			if (deps.isFile(candidate)) return candidate;
		}
	}
	return null;
}

interface StreamPump {
	readonly done: Promise<void>;
	cancel(): Promise<void>;
}

function pumpTextStream(stream: ReadableStream<Uint8Array> | null, sink: OutputSink): StreamPump {
	if (!stream) {
		const done = Promise.resolve();
		return { done, cancel: () => done };
	}
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const done = (async () => {
		try {
			for (;;) {
				const next = await reader.read();
				if (next.done) break;
				if (next.value) sink.push(decoder.decode(next.value, { stream: true }));
			}
			const final = decoder.decode();
			if (final) sink.push(final);
		} finally {
			reader.releaseLock();
		}
	})();
	return {
		done,
		async cancel() {
			await reader.cancel().catch(() => undefined);
			await done.catch(() => undefined);
		},
	};
}

async function drainStreams(pumps: readonly StreamPump[], maxWaitMs: number): Promise<void> {
	const drained = Promise.allSettled(pumps.map(pump => pump.done));
	if (maxWaitMs > 0) {
		const completed = await Promise.race([
			drained.then(() => true as const),
			Bun.sleep(maxWaitMs).then(() => false as const),
		]);
		if (completed) return;
	}
	await Promise.allSettled(pumps.map(pump => pump.cancel()));
}

async function terminateAndDrain(
	process: AdbSubprocess,
	terminate: (process: AdbSubprocess) => Promise<void>,
	pumps: readonly StreamPump[],
): Promise<void> {
	try {
		await terminate(process);
	} finally {
		await drainStreams(pumps, STREAM_DRAIN_MS);
	}
}

function parentEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
	const entries: Array<[string, string]> = [];
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) entries.push([key, value]);
	}
	return Object.fromEntries(entries);
}

function createSpawnOptions(options: AdbCommandOptions, deps: AdbExecutorDependencies): AdbSpawnOptions {
	const parentEnv = parentEnvironment(deps.env);
	return {
		cwd: options.cwd,
		env: buildNonInteractiveEnv(parentEnv, parentEnv, deps.platform),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	};
}

type ProcessRaceResult = { kind: "exit"; exitCode: number } | { kind: "aborted" } | { kind: "timeout" };

interface ProcessRace {
	readonly promise: Promise<ProcessRaceResult>;
	cleanup(): void;
}

function raceProcess(process: AdbSubprocess, options: AdbCommandOptions): ProcessRace {
	const racers: Array<Promise<ProcessRaceResult>> = [
		process.exited.then(exitCode => ({ kind: "exit" as const, exitCode })),
	];
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let abortListener: (() => void) | undefined;

	if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
		const deferred = Promise.withResolvers<ProcessRaceResult>();
		timeout = setTimeout(() => deferred.resolve({ kind: "timeout" }), options.timeoutMs);
		racers.push(deferred.promise);
	}
	if (options.signal) {
		const deferred = Promise.withResolvers<ProcessRaceResult>();
		abortListener = () => deferred.resolve({ kind: "aborted" });
		if (options.signal.aborted) abortListener();
		else options.signal.addEventListener("abort", abortListener, { once: true });
		racers.push(deferred.promise);
	}

	return {
		promise: Promise.race(racers),
		cleanup() {
			clearTimeout(timeout);
			if (abortListener) options.signal?.removeEventListener("abort", abortListener);
		},
	};
}

export async function executeAdb(args: readonly string[], options: AdbCommandOptions = {}): Promise<AdbCommandResult> {
	const deps = resolveDependencies(options.dependencies);
	const executable = deps.resolveExecutable("adb");
	if (!executable) throw new AndroidExecutableNotFoundError("adb");

	const sink = new OutputSink({
		artifactPath: options.artifactPath,
		artifactId: options.artifactId,
		spillThreshold: options.spillThreshold,
		tailBytes: options.tailBytes,
		headBytes: options.headBytes,
		maxColumns: options.maxColumns,
		onChunk: options.onChunk,
		chunkThrottleMs: options.chunkThrottleMs,
	});
	let process: AdbSubprocess | undefined;
	let completed = false;
	let race: ProcessRace | undefined;

	try {
		if (options.signal?.aborted) {
			return {
				exitCode: null,
				cancelled: true,
				...(await sink.dump("ADB command cancelled")),
			};
		}
		process = deps.spawn([executable, ...args], createSpawnOptions(options, deps));
		const pumps = [pumpTextStream(process.stdout, sink), pumpTextStream(process.stderr, sink)];
		race = raceProcess(process, options);
		const result = await race.promise;

		if (result.kind !== "exit") {
			await terminateAndDrain(process, deps.terminateTree, pumps);
			completed = true;
			return {
				exitCode: process.exitCode,
				cancelled: true,
				...(result.kind === "timeout" ? { timedOut: true } : {}),
				...(await sink.dump(
					result.kind === "timeout"
						? `ADB command timed out after ${Math.round((options.timeoutMs ?? 0) / 1000)} seconds`
						: "ADB command cancelled",
				)),
			};
		}

		await drainStreams(pumps, STREAM_DRAIN_MS);
		completed = true;
		return {
			exitCode: result.exitCode,
			cancelled: false,
			...(await sink.dump()),
		};
	} finally {
		race?.cleanup();
		if (process && !completed && process.exitCode === null) {
			await deps.terminateTree(process).catch(() => undefined);
		}
		await sink.dispose();
	}
}

interface BinaryCapture {
	readonly done: Promise<void>;
	readonly chunks: Uint8Array[];
	readonly totalBytes: () => number;
	cancel(): Promise<void>;
}

function captureBinaryStream(
	stream: ReadableStream<Uint8Array> | null,
	maxBytes: number,
	onOverflow: () => void,
): BinaryCapture {
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	let overflowed = false;
	if (!stream) {
		const done = Promise.resolve();
		return { done, chunks, totalBytes: () => totalBytes, cancel: () => done };
	}
	const reader = stream.getReader();
	const done = (async () => {
		try {
			for (;;) {
				const next = await reader.read();
				if (next.done) break;
				if (!next.value || overflowed) continue;
				if (totalBytes + next.value.byteLength > maxBytes) {
					overflowed = true;
					onOverflow();
					continue;
				}
				chunks.push(next.value);
				totalBytes += next.value.byteLength;
			}
		} finally {
			reader.releaseLock();
		}
	})();
	return {
		done,
		chunks,
		totalBytes: () => totalBytes,
		async cancel() {
			await reader.cancel().catch(() => undefined);
			await done.catch(() => undefined);
		},
	};
}

interface StderrCapture extends StreamPump {
	text(): string;
}

function captureStderr(stream: ReadableStream<Uint8Array> | null): StderrCapture {
	let text = "";
	if (!stream) {
		const done = Promise.resolve();
		return { done, cancel: () => done, text: () => text };
	}
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const append = (chunk: string) => {
		if (!chunk) return;
		text = truncateTailBytes(text + chunk, STDERR_MAX_BYTES).text;
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
	return {
		done,
		text: () => text,
		async cancel() {
			await reader.cancel().catch(() => undefined);
			await done.catch(() => undefined);
		},
	};
}

function joinChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
	if (chunks.length === 0) return new Uint8Array();
	if (chunks.length === 1) return chunks[0] as Uint8Array;
	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

export async function executeAdbBinary(
	args: readonly string[],
	options: AdbCommandOptions = {},
): Promise<AdbBinaryResult> {
	const deps = resolveDependencies(options.dependencies);
	const executable = deps.resolveExecutable("adb");
	if (!executable) throw new AndroidExecutableNotFoundError("adb");
	if (options.signal?.aborted) {
		return { bytes: new Uint8Array(), exitCode: null, cancelled: true };
	}

	const maxBytes = Math.max(1, Math.floor(options.maxBinaryBytes ?? DEFAULT_ADB_BINARY_MAX_BYTES));
	let process: AdbSubprocess | undefined;
	let completed = false;
	let race: ProcessRace | undefined;

	try {
		process = deps.spawn([executable, ...args], createSpawnOptions(options, deps));
		const overflow = Promise.withResolvers<ProcessRaceResult>();
		let outputExceeded = false;
		const stdout = captureBinaryStream(process.stdout, maxBytes, () => {
			outputExceeded = true;
			overflow.resolve({ kind: "aborted" });
		});
		const stderr = captureStderr(process.stderr);
		race = raceProcess(process, options);
		const result = await Promise.race([race.promise, overflow.promise]);

		if (result.kind !== "exit" || outputExceeded) {
			await terminateAndDrain(process, deps.terminateTree, [stdout, stderr]);
			completed = true;
			if (outputExceeded) throw new AdbBinaryOutputLimitError(maxBytes, stderr.text());
			return {
				bytes: new Uint8Array(),
				exitCode: process.exitCode,
				cancelled: true,
				...(result.kind === "timeout" ? { timedOut: true } : {}),
				...(stderr.text() ? { stderr: stderr.text() } : {}),
			};
		}

		await drainStreams([stdout, stderr], STREAM_DRAIN_MS);
		completed = true;
		if (outputExceeded) throw new AdbBinaryOutputLimitError(maxBytes, stderr.text());
		return {
			bytes: joinChunks(stdout.chunks, stdout.totalBytes()),
			exitCode: result.exitCode,
			cancelled: false,
			...(stderr.text() ? { stderr: stderr.text() } : {}),
		};
	} finally {
		race?.cleanup();
		if (process && !completed && process.exitCode === null) {
			await deps.terminateTree(process).catch(() => undefined);
		}
	}
}

const ADB_NOISE_PREFIXES = [
	"*",
	"adb server",
	"adb:",
	"adb.exe:",
	"daemon ",
	"error:",
	"warning:",
	"failed to ",
	"could not ",
	"cannot connect ",
	"more than one ",
	"no devices",
	"this adb server",
	"server version ",
];

function isAdbNoise(line: string): boolean {
	const lower = line.toLowerCase();
	if (lower.startsWith("list of devices attached")) return true;
	return ADB_NOISE_PREFIXES.some(prefix => lower.startsWith(prefix));
}

export function parseAdbDevices(output: string): AdbDevice[] {
	const devices: AdbDevice[] = [];
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || isAdbNoise(line)) continue;
		const fields = line.split(/\s+/);
		if (fields.length < 2) continue;
		const [serial, rawState] = fields;
		if (!serial || !rawState) continue;

		let state: AdbDevice["state"];
		switch (rawState) {
			case "device":
			case "offline":
			case "unauthorized":
				state = rawState;
				break;
			default:
				state = "unknown";
				break;
		}

		const device: AdbDevice = { serial, state };
		for (let index = 2; index < fields.length; index++) {
			const field = fields[index];
			const separator = field?.indexOf(":") ?? -1;
			if (!field || separator <= 0 || separator === field.length - 1) continue;
			const key = field.slice(0, separator);
			const value = field.slice(separator + 1);
			switch (key) {
				case "model":
					device.model = value;
					break;
				case "product":
					device.product = value;
					break;
				case "transport_id":
					device.transportId = value;
					break;
			}
		}
		devices.push(device);
	}
	return devices;
}

export function parseAvdList(output: string): string[] {
	const avds: string[] = [];
	for (const line of output.split(/\r?\n/)) {
		const avd = line.trim();
		if (avd) avds.push(avd);
	}
	return avds;
}
