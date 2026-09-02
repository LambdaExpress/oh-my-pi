import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { toolWireSchema, validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import type {
	AdbBinaryResult,
	AdbCommandOptions,
	AdbCommandResult,
	AdbDevice,
	AndroidExecutableName,
} from "@oh-my-pi/pi-coding-agent/adb/adb-executor";
import type {
	EmulatorManager,
	EmulatorStartOptions,
	EmulatorStartResult,
	EmulatorStopResult,
	EmulatorWaitUntil,
} from "@oh-my-pi/pi-coding-agent/adb/emulator-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	AdbTool,
	type AdbToolDependencies,
	type AdbToolDetails,
	adbApproval,
	type adbSchema,
	adbToolRenderer,
} from "@oh-my-pi/pi-coding-agent/tools/adb";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { formatStatusIcon } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

const SERIAL = "emulator serial 5554";
const OTHER_SERIAL = "physical serial 2";
const LISTED_SERIAL = "emulator-5554";
const PNG = Uint8Array.from(
	Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
		"base64",
	),
);
const temporaryDirectories: string[] = [];
const temporaryFiles: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "adb-tool-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all([
		...temporaryFiles.splice(0).map(file => fs.rm(file, { force: true })),
		...temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	]);
});

function session(cwd: string = os.tmpdir(), maxTimeout = 30): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: {
			get(key: string): unknown {
				return key === "tools.maxTimeout" ? maxTimeout : undefined;
			},
		},
	} as ToolSession;
}

function commandResult(output = "ok\n", exitCode = 0): AdbCommandResult {
	return { output, exitCode, cancelled: false } as AdbCommandResult;
}

interface ManagerCalls {
	listAvds: number;
	start: EmulatorStartOptions[];
	status: Array<string | undefined>;
	wait: Array<[string | undefined, EmulatorWaitUntil, number, AbortSignal | undefined]>;
	stop: Array<string | undefined>;
}

interface Harness {
	tool: AdbTool;
	manager: Pick<EmulatorManager, "listAvds" | "start" | "status" | "wait" | "stop">;
	managerCalls: ManagerCalls;
	adbCalls: Array<{ args: string[]; options?: AdbCommandOptions }>;
	binaryCalls: Array<{ args: string[]; options?: AdbCommandOptions }>;
}

function harness(
	options: {
		cwd?: string;
		maxTimeout?: number;
		adbPath?: string | null;
		emulatorPath?: string | null;
		devices?: AdbDevice[];
		commandResult?: AdbCommandResult;
		commandResults?: AdbCommandResult[];
		binaryResult?: AdbBinaryResult;
	} = {},
): Harness {
	const devices = options.devices ?? [{ serial: SERIAL, state: "device", model: "Pixel Test" }];
	const nextCommandResult = options.commandResult ?? commandResult();
	const nextBinaryResult = options.binaryResult ?? { bytes: PNG, exitCode: 0, cancelled: false };
	const managerCalls: ManagerCalls = { listAvds: 0, start: [], status: [], wait: [], stop: [] };
	const adbCalls: Harness["adbCalls"] = [];
	const binaryCalls: Harness["binaryCalls"] = [];

	const select = (requested?: string): AdbDevice => {
		const selected = requested
			? devices.find(device => device.serial === requested)
			: devices.filter(device => device.state === "device").length === 1
				? devices.find(device => device.state === "device")
				: undefined;
		if (!selected) {
			if (!requested && devices.filter(device => device.state === "device").length > 1) {
				throw new ToolError(`Multiple online Android devices: ${devices.map(device => device.serial).join(", ")}`);
			}
			throw new ToolError(`Android device ${requested ?? "selection"} was not found`);
		}
		if (selected.state !== "device") throw new ToolError(`Android device ${selected.serial} is ${selected.state}`);
		return selected;
	};

	const manager = {
		async listAvds() {
			managerCalls.listAvds += 1;
			return ["Pixel 9 Pro API 36", "AVD with spaces"];
		},
		async start(startOptions: EmulatorStartOptions): Promise<EmulatorStartResult> {
			managerCalls.start.push(startOptions);
			return {
				avd: startOptions.avd,
				serial: SERIAL,
				state: startOptions.waitUntil,
				pid: 4321,
				reused: false,
			};
		},
		async status(serial?: string): Promise<AdbDevice> {
			managerCalls.status.push(serial);
			return select(serial);
		},
		async wait(
			serial: string | undefined,
			until: EmulatorWaitUntil,
			timeoutMs: number,
			signal?: AbortSignal,
		): Promise<AdbDevice> {
			managerCalls.wait.push([serial, until, timeoutMs, signal]);
			return select(serial);
		},
		async stop(serial?: string): Promise<EmulatorStopResult> {
			managerCalls.stop.push(serial);
			const selected = select(serial);
			return { serial: selected.serial, avd: "Pixel 9 Pro API 36" };
		},
	} satisfies Pick<EmulatorManager, "listAvds" | "start" | "status" | "wait" | "stop">;

	const dependencies: Partial<AdbToolDependencies> = {
		resolveExecutable(name: AndroidExecutableName) {
			return name === "adb"
				? options.adbPath === undefined
					? "/fake/sdk/platform-tools/adb"
					: options.adbPath
				: options.emulatorPath === undefined
					? "/fake/sdk/emulator/emulator"
					: options.emulatorPath;
		},
		async executeAdb(args: readonly string[], commandOptions?: AdbCommandOptions) {
			adbCalls.push({ args: [...args], options: commandOptions });
			return options.commandResults?.shift() ?? nextCommandResult;
		},
		async executeAdbBinary(args: readonly string[], commandOptions?: AdbCommandOptions) {
			binaryCalls.push({ args: [...args], options: commandOptions });
			return nextBinaryResult;
		},
		emulatorManager: manager,
	};

	return {
		tool: new AdbTool(session(options.cwd, options.maxTimeout), dependencies),
		manager,
		managerCalls,
		adbCalls,
		binaryCalls,
	};
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part): part is { type: string; text: string } => typeof part.text === "string")
		.map(part => part.text)
		.join("\n");
}

async function theme() {
	const result = await getThemeByName("dark");
	if (!result) throw new Error("Expected dark theme");
	return result;
}

function render(component: { render(width: number): readonly string[] }, width = 160): string {
	return Bun.stripANSI(component.render(width).join("\n"));
}

function dynamicApproval(tool: AdbTool, args: unknown) {
	if (typeof tool.approval !== "function") throw new Error("Expected adb approval to be dynamic");
	return tool.approval(args as never);
}

function approvalWrapper(tool: AdbTool): ExtensionToolWrapper<typeof adbSchema, AdbToolDetails> {
	return new ExtensionToolWrapper<typeof adbSchema, AdbToolDetails>(tool, {
		sessionId: "adb-approval-test",
		consumeToolCallEmitted: () => false,
		hasHandlers: () => false,
		hasUI: () => false,
	} as unknown as ExtensionRunner);
}

describe("AdbTool discovery and contract", () => {
	it("registers only when adb exists and does not require the emulator executable", async () => {
		const missing = AdbTool.createIf(session(), {
			resolveExecutable: (name: AndroidExecutableName) => (name === "adb" ? null : "/fake/emulator"),
		});
		expect(missing).toBeNull();

		const online = harness({ emulatorPath: null });
		const tool = AdbTool.createIf(session(), {
			resolveExecutable: (name: AndroidExecutableName) => (name === "adb" ? "/fake/adb" : null),
			executeAdb: async (_args: readonly string[], _options?: AdbCommandOptions) => commandResult(),
			executeAdbBinary: async () => ({ bytes: PNG, exitCode: 0, cancelled: false }),
			emulatorManager: online.manager,
		});
		expect(tool).not.toBeNull();
		const result = await tool!.execute("status-no-emulator", { op: "status" });
		expect(text(result)).toContain(SERIAL);
		expect(online.managerCalls.status).toEqual([undefined]);
	});

	it("publishes the fixed strict, exclusive, merged discoverable surface", () => {
		const { tool } = harness();
		expect(tool).toMatchObject({
			name: "adb",
			label: "ADB",
			loadMode: "discoverable",
			strict: true,
			concurrency: "exclusive",
			mergeCallAndResult: true,
			renderCallBeforeExecution: true,
		});
	});
});

describe("AdbTool schema and device selection", () => {
	it("lists and parses devices without routing the host-wide query through device selection", async () => {
		const tool = harness({
			commandResult: commandResult(
				`List of devices attached\n${LISTED_SERIAL}\tdevice product:sdk model:Pixel_Test transport_id:1\n`,
			),
		});
		const result = await tool.tool.execute("devices", { op: "devices" });
		expect(tool.adbCalls[0]?.args).toEqual(["devices", "-l"]);
		expect(tool.managerCalls.status).toHaveLength(0);
		expect(result.details?.devices).toEqual([
			expect.objectContaining({ serial: LISTED_SERIAL, state: "device", model: "Pixel_Test" }),
		]);
		expect(text(result)).toContain(LISTED_SERIAL);
	});

	it("exposes only the approved operations and rejects unknown or cross-operation fields", async () => {
		const { tool } = harness();
		const schema = toolWireSchema(tool);
		const valid = [
			{ op: "devices" },
			{ op: "avds" },
			{ op: "status", device: SERIAL },
			{ op: "wait", until: "booted", timeout: 5 },
			{ op: "start", avd: "AVD with spaces", waitUntil: "connected" },
			{ op: "stop" },
			{ op: "shell", command: "printf '%s' 'one two'" },
			{ op: "logcat", lines: 25, filter: "Activity Manager:*", follow: true },
			{ op: "screenshot" },
			{ op: "push", localPath: "local path/a.txt", remotePath: "/sdcard/remote path/a.txt" },
			{ op: "pull", remotePath: "/sdcard/remote path/a.txt", localPath: "local path/a.txt" },
			{ op: "install", apkPath: "build outputs/app debug.apk" },
			{ op: "uninstall", package: "com.example.app" },
			{ op: "launch", package: "com.example.app", activity: ".Main Activity" },
			{ op: "input", action: "tap", x: 10, y: 20 },
			{ op: "input", action: "swipe", x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 500 },
			{ op: "input", action: "text", text: "hello world" },
			{ op: "input", action: "keyevent", key: "KEYCODE HOME" },
		];
		for (const args of valid) expect(validateJsonSchemaValue(schema, args).success, JSON.stringify(args)).toBe(true);

		const invalid = [
			{},
			{ op: "unknown" },
			{ op: "devices", extra: true },
			{ op: "status", command: "id" },
			{ op: "wait", until: "ready" },
			{ op: "start" },
			{ op: "shell" },
			{ op: "push", localPath: "a" },
			{ op: "pull", remotePath: "a" },
			{ op: "install", apkPath: "a.apk", package: "com.bad" },
			{ op: "launch" },
			{ op: "input", action: "tap", x: 1 },
			{ op: "input", action: "swipe", x1: 1, y1: 2, x2: 3, y2: 4, text: "wrong" },
			{ op: "input", action: "text", key: "wrong" },
			{ op: "input", action: "keyevent", key: "HOME", x: 1 },
		];
		for (const args of invalid)
			expect(validateJsonSchemaValue(schema, args).success, JSON.stringify(args)).toBe(false);

		for (const args of [{ op: "shell" }, { op: "start" }, { op: "input", action: "tap", x: 1 }]) {
			await expect(tool.execute("invalid-runtime", args as never), JSON.stringify(args)).rejects.toThrow();
		}
		await expect(tool.execute("unknown-runtime", { op: "devices", extra: true } as never)).rejects.toThrow();
		await expect(
			tool.execute("cross-branch-runtime", { op: "input", action: "tap", x: 1, y: 2, key: "HOME" } as never),
		).rejects.toThrow();
		expect(tool.parameters({ op: "devices", extra: true }) instanceof type.errors).toBe(true);
	});

	it("selects the sole online device, rejects ambiguous selection, and reports offline devices", async () => {
		const online = harness();
		await online.tool.execute("unique", { op: "shell", command: "id" });
		expect(online.managerCalls.status).toEqual([undefined]);
		expect(online.adbCalls[0]?.args.slice(0, 2)).toEqual(["-s", SERIAL]);

		const ambiguous = harness({
			devices: [
				{ serial: SERIAL, state: "device" },
				{ serial: OTHER_SERIAL, state: "device" },
			],
		});
		await expect(ambiguous.tool.execute("ambiguous", { op: "shell", command: "id" })).rejects.toThrow(/multiple/i);
		expect(ambiguous.adbCalls).toHaveLength(0);

		const offline = harness({ devices: [{ serial: SERIAL, state: "offline" }] });
		await expect(offline.tool.execute("offline", { op: "shell", device: SERIAL, command: "id" })).rejects.toThrow(
			new RegExp(`${SERIAL}.*offline`, "i"),
		);
		expect(offline.adbCalls).toHaveLength(0);
	});
});

describe("AdbTool argv and command behavior", () => {
	it("passes serials, AVDs, commands, APKs and paths with spaces as individual argv elements", async () => {
		const cwd = await temporaryDirectory();
		const localPush = path.join(cwd, "folder with spaces", "push file.txt");
		const localPull = path.join(cwd, "folder with spaces", "pull file.txt");
		const apk = path.join(cwd, "build outputs", "app debug.apk");
		const remotePush = "/sdcard/folder with spaces/push file.txt";
		const remotePull = "/sdcard/folder with spaces/pull file.txt";
		const shellCommand = "printf '%s' 'hello world'";
		const tool = harness({ cwd });

		const operations = [
			{ args: { op: "shell", device: SERIAL, command: shellCommand }, values: [shellCommand] },
			{
				args: { op: "logcat", device: SERIAL, lines: 42, filter: "Activity Manager:*" },
				values: ["42", "Activity Manager:*"],
			},
			{
				args: { op: "push", device: SERIAL, localPath: localPush, remotePath: remotePush },
				values: [localPush, remotePush],
			},
			{
				args: { op: "pull", device: SERIAL, remotePath: remotePull, localPath: localPull },
				values: [remotePull, localPull],
			},
			{ args: { op: "install", device: SERIAL, apkPath: apk }, values: [apk] },
			{ args: { op: "uninstall", device: SERIAL, package: "com.example.app" }, values: ["com.example.app"] },
			{
				args: { op: "launch", device: SERIAL, package: "com.example.app", activity: ".MainActivity" },
				values: ["com.example.app/.MainActivity"],
			},
			{ args: { op: "input", device: SERIAL, action: "text", text: "hello world" }, values: ["hello world"] },
		] as const;

		for (const operation of operations) {
			const before = tool.adbCalls.length;
			await tool.tool.execute(`argv-${before}`, operation.args as never);
			const argv = tool.adbCalls[before]?.args;
			expect(argv?.slice(0, 2)).toEqual(["-s", SERIAL]);
			for (const value of operation.values) expect(argv?.filter(arg => arg === value)).toHaveLength(1);
		}
		expect(tool.managerCalls.status).toEqual(Array.from({ length: operations.length }, () => SERIAL));
	});

	it("builds every input action without concatenating user-controlled argv", async () => {
		const tool = harness();
		const cases = [
			[{ op: "input", action: "tap", x: 10, y: 20 }, ["shell", "input", "tap", "10", "20"]],
			[
				{ op: "input", action: "swipe", x1: 1, y1: 2, x2: 30, y2: 40, durationMs: 550 },
				["shell", "input", "swipe", "1", "2", "30", "40", "550"],
			],
			[{ op: "input", action: "text", text: "hello world" }, ["shell", "input", "text", "hello world"]],
			[{ op: "input", action: "keyevent", key: "KEYCODE HOME" }, ["shell", "input", "keyevent", "KEYCODE HOME"]],
		] as const;
		for (const [args, tail] of cases) {
			await tool.tool.execute(`input-${args.action}`, args as never);
			expect(tool.adbCalls.at(-1)?.args).toEqual(["-s", SERIAL, ...tail]);
		}
	});

	it("returns successful output and turns every nonzero result into contextual errors", async () => {
		const cwd = await temporaryDirectory();
		const cases = [
			{ op: "shell", command: "echo ok" },
			{ op: "logcat", filter: "My App:*" },
			{
				op: "push",
				localPath: path.join(cwd, "local file"),
				remotePath: "/sdcard/remote file",
				context: "local file",
			},
			{
				op: "pull",
				remotePath: "/sdcard/remote file",
				localPath: path.join(cwd, "local file"),
				context: "remote file",
			},
			{ op: "install", apkPath: path.join(cwd, "app debug.apk"), context: "app debug.apk" },
			{ op: "uninstall", package: "com.example.app", context: "com.example.app" },
			{ op: "launch", package: "com.example.app", activity: ".MainActivity", context: "com.example.app" },
			{ op: "input", action: "keyevent", key: "KEYCODE_HOME" },
		] as const;

		for (const args of cases) {
			const { context, ...params } = args as (typeof cases)[number] & { context?: string };
			const success = harness({ cwd, commandResult: commandResult(`success-${args.op}`) });
			const result = await success.tool.execute(`success-${args.op}`, { ...params, device: SERIAL } as never);
			expect(text(result)).toContain(`success-${args.op}`);

			const failure = harness({ cwd, commandResult: commandResult("permission denied from adb", 23) });
			let thrown: unknown;
			try {
				await failure.tool.execute(`failure-${args.op}`, { ...params, device: SERIAL } as never);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(Error);
			const message = String((thrown as Error).message);
			expect(message.toLowerCase()).toContain(args.op);
			expect(message).toContain(SERIAL);
			if (context) expect(message).toContain(context);
			expect(message).toContain("permission denied from adb");
		}
	});

	it("retries a transient UIAutomator idle timeout and fails truthfully when it persists", async () => {
		vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
		const idleTimeout = commandResult("ERROR: could not get idle state.\n");
		const recovered = harness({
			commandResults: [idleTimeout, commandResult("UI hierarchy dumped to: /sdcard/window.xml\n")],
		});
		const recoveredResult = await recovered.tool.execute("uiautomator-recovers", {
			op: "shell",
			device: SERIAL,
			command: "uiautomator dump /sdcard/window.xml",
			timeout: 30,
		});
		expect(text(recoveredResult)).toContain("UI hierarchy dumped");
		expect(recovered.adbCalls).toHaveLength(2);

		const persistent = harness({ commandResults: [idleTimeout, idleTimeout] });
		await expect(
			persistent.tool.execute("uiautomator-still-busy", {
				op: "shell",
				device: SERIAL,
				command: "uiautomator dump /sdcard/window.xml",
				timeout: 30,
			}),
		).rejects.toThrow(/UI hierarchy.*never became idle/i);
		expect(persistent.adbCalls).toHaveLength(2);
	});

	it("uses a finite logcat dump by default and only follows when requested", async () => {
		const tool = harness();
		await tool.tool.execute("logcat-dump", { op: "logcat" });
		expect(tool.adbCalls[0]?.args).toContain("-d");
		await tool.tool.execute("logcat-follow", { op: "logcat", follow: true });
		expect(tool.adbCalls[1]?.args).not.toContain("-d");
	});
});

describe("AdbTool emulator manager delegation", () => {
	it("delegates avds, status, wait, start, and stop with clamped timeouts and defaults", async () => {
		const tool = harness({ maxTimeout: 7 });
		const signal = new AbortController().signal;
		expect(text(await tool.tool.execute("avds", { op: "avds" }))).toContain("AVD with spaces");
		await tool.tool.execute("status", { op: "status", device: SERIAL });
		await tool.tool.execute("wait", { op: "wait", device: SERIAL, until: "connected", timeout: 99 }, signal);
		const started = await tool.tool.execute("start", { op: "start", avd: "AVD with spaces", timeout: 3 }, signal);
		await tool.tool.execute("stop", { op: "stop", device: SERIAL });

		expect(tool.managerCalls.listAvds).toBe(1);
		expect(tool.managerCalls.status).toEqual([SERIAL]);
		expect(tool.managerCalls.wait).toEqual([[SERIAL, "connected", 7_000, signal]]);
		expect(tool.managerCalls.start).toEqual([
			{ avd: "AVD with spaces", waitUntil: "booted", timeoutMs: 3_000, signal },
		]);
		expect(tool.managerCalls.stop).toEqual([SERIAL]);
		expect(text(started)).toContain("AVD with spaces");
		expect(text(started)).toContain("booted");
	});
});

describe("AdbTool screenshots", () => {
	it("preserves arbitrary PNG bytes on disk and returns a PNG image block with dimensions", async () => {
		const cwd = await temporaryDirectory();
		const tool = harness({ cwd, binaryResult: { bytes: PNG, exitCode: 0, cancelled: false } });
		const result = await tool.tool.execute("screenshot", { op: "screenshot", device: SERIAL });
		const image = result.content.find(part => part.type === "image") as
			| { type: "image"; data: string; mimeType: string }
			| undefined;
		const details = result.details as AdbToolDetails & {
			screenshotPath?: string;
			path?: string;
			mimeType?: string;
			width?: number;
			height?: number;
			widthPx?: number;
			heightPx?: number;
		};
		const screenshotPath = details.screenshotPath ?? details.path;

		expect(tool.binaryCalls).toHaveLength(1);
		expect(tool.binaryCalls[0]?.args).toEqual(["-s", SERIAL, "exec-out", "screencap", "-p"]);
		expect(screenshotPath).toBeDefined();
		temporaryFiles.push(screenshotPath!);
		expect(path.extname(screenshotPath!)).toBe(".png");
		expect(path.dirname(screenshotPath!)).not.toBe(cwd);
		expect(await fs.readFile(screenshotPath!)).toEqual(Buffer.from(PNG));
		expect([...PNG.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(PNG).toContain(0);
		expect(PNG.some(byte => byte > 0x7f)).toBe(true);
		expect(image).toEqual({ type: "image", data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" });
		expect(details.mimeType).toBe("image/png");
		expect(details.width ?? details.widthPx).toBe(1);
		expect(details.height ?? details.heightPx).toBe(1);
		expect(text(result)).not.toContain("�");
	});
});

describe("AdbTool approval", () => {
	it("assigns read tier to observation and exec tier to mutations", () => {
		const { tool } = harness();
		for (const op of ["devices", "avds", "status", "wait", "logcat", "screenshot"] as const) {
			expect(dynamicApproval(tool, { op })).toBe("read");
			expect(adbApproval({ op } as never)).toBe("read");
		}
		for (const args of [
			{ op: "start", avd: "AVD with spaces" },
			{ op: "install", apkPath: "app debug.apk" },
			{ op: "shell", command: "id" },
		] as const) {
			expect(dynamicApproval(tool, args)).toBe("exec");
			expect(adbApproval(args as never)).toBe("exec");
		}
	});

	it("prompts start/install in write mode, allows yolo, and preserves explicit prompt/deny policy", () => {
		const { tool } = harness();
		for (const args of [
			{ op: "start", avd: "AVD with spaces" },
			{ op: "install", apkPath: "app debug.apk" },
		]) {
			expect(resolveApproval(tool, args, "write")).toMatchObject({ policy: "prompt", tier: "exec" });
			expect(resolveApproval(tool, args, "yolo")).toMatchObject({ policy: "allow", tier: "exec" });
			expect(resolveApproval(tool, args, "yolo", { adb: "prompt" }).policy).toBe("prompt");
			expect(resolveApproval(tool, args, "yolo", { adb: "deny" }).policy).toBe("deny");
		}
	});

	it("gates real wrapped start/install execution before fake mutations", async () => {
		const fake = harness();
		const wrapped = approvalWrapper(fake.tool);
		const settings = Settings.isolated({ "tools.approvalMode": "write" });
		const context = { settings } as AgentToolContext;
		const calls = [
			{ id: "start", args: { op: "start", avd: "AVD with spaces" } },
			{ id: "install", args: { op: "install", apkPath: "app debug.apk" } },
		] as const;

		for (const call of calls) {
			await expect(wrapped.execute(`write-${call.id}`, call.args, undefined, undefined, context)).rejects.toThrow(
				/requires approval but no interactive UI available/,
			);
		}
		expect(fake.managerCalls.start).toHaveLength(0);
		expect(fake.managerCalls.status).toHaveLength(0);
		expect(fake.adbCalls).toHaveLength(0);

		settings.override("tools.approvalMode", "yolo");
		for (const call of calls) {
			await wrapped.execute(`yolo-${call.id}`, call.args, undefined, undefined, context);
		}
		expect(fake.managerCalls.start).toHaveLength(1);
		expect(fake.managerCalls.status).toEqual([undefined]);
		expect(fake.adbCalls).toHaveLength(1);
		expect(fake.adbCalls[0]?.args).toEqual(["-s", SERIAL, "install", "app debug.apk"]);

		settings.override("tools.approval", { adb: "prompt" });
		for (const call of calls) {
			await expect(wrapped.execute(`prompt-${call.id}`, call.args, undefined, undefined, context)).rejects.toThrow(
				/requires approval but no interactive UI available/,
			);
		}
		expect(fake.managerCalls.start).toHaveLength(1);
		expect(fake.managerCalls.status).toEqual([undefined]);
		expect(fake.adbCalls).toHaveLength(1);

		settings.override("tools.approval", { adb: "deny" });
		for (const call of calls) {
			await expect(wrapped.execute(`deny-${call.id}`, call.args, undefined, undefined, context)).rejects.toThrow(
				/blocked by user policy/,
			);
		}
		expect(fake.managerCalls.start).toHaveLength(1);
		expect(fake.managerCalls.status).toEqual([undefined]);
		expect(fake.adbCalls).toHaveLength(1);
	});
});

describe("AdbTool conditional Android SDK lifecycle", () => {
	it.skipIf(process.env.ADB_E2E !== "1")(
		"starts or reuses an AVD, observes Android, captures PNG bytes, and stops it",
		async () => {
			if (process.platform !== "win32") {
				console.warn("[ADB_E2E conditional skip] This scenario requires Windows.");
				return;
			}

			const avd = process.env.ADB_E2E_AVD?.trim() || "Medium_Phone";
			const tool = AdbTool.createIf(session(os.tmpdir(), 360));
			if (!tool) {
				console.warn(
					"[ADB_E2E conditional skip] adb was not found; configure PATH, ANDROID_SDK_ROOT, or ANDROID_HOME.",
				);
				return;
			}

			let avds: string[];
			try {
				const listed = await tool.execute("e2e-avds", { op: "avds" });
				avds = listed.details?.avds ?? [];
			} catch (error) {
				console.warn(
					`[ADB_E2E conditional skip] Android SDK emulator prerequisites are unavailable: ${error instanceof Error ? error.message : String(error)}`,
				);
				return;
			}
			if (!avds.includes(avd)) {
				console.warn(
					`[ADB_E2E conditional skip] Required AVD ${JSON.stringify(avd)} is absent; available AVDs: ${avds.length > 0 ? avds.join(", ") : "none"}.`,
				);
				return;
			}

			const initiallyListed = await tool.execute("e2e-initial-devices", { op: "devices" });
			const initialSerials = new Set((initiallyListed.details?.devices ?? []).map(device => device.serial));
			const initialOnline = (initiallyListed.details?.devices ?? []).filter(device => device.state === "device");
			let existingTargetSerial: string | undefined;
			for (const device of initialOnline) {
				const status = await tool.execute(`e2e-status-${device.serial}`, { op: "status", device: device.serial });
				if (status.details?.avd === avd) existingTargetSerial = device.serial;
			}

			let cleanupSerial: string | undefined;
			let startAttempted = false;
			let bodyFailed = false;
			let bodyError: unknown;
			try {
				await (async () => {
					const configuredPhysicalSerial = process.env.ADB_E2E_PHYSICAL_SERIAL?.trim();
					if (configuredPhysicalSerial) {
						const configuredDevice = initialOnline.find(device => device.serial === configuredPhysicalSerial);
						if (!configuredDevice) {
							console.info(
								`[ADB_E2E condition not met] ADB_E2E_PHYSICAL_SERIAL ${JSON.stringify(configuredPhysicalSerial)} was not an online device; stop rejection was not exercised.`,
							);
						} else {
							let physicalIdentityConfirmed = false;
							try {
								const qemu = await tool.execute("e2e-physical-qemu", {
									op: "shell",
									device: configuredPhysicalSerial,
									command: "getprop ro.kernel.qemu",
									timeout: 15,
								});
								const qemuValue = text(qemu).trim();
								if (qemuValue === "1") {
									console.info(
										`[ADB_E2E condition not met] ADB_E2E_PHYSICAL_SERIAL ${JSON.stringify(configuredPhysicalSerial)} reports ro.kernel.qemu=1; stop rejection was not exercised.`,
									);
								} else {
									const status = await tool.execute("e2e-physical-status", {
										op: "status",
										device: configuredPhysicalSerial,
									});
									if (
										status.details?.serial !== configuredPhysicalSerial ||
										status.details.avd !== undefined
									) {
										console.info(
											`[ADB_E2E condition not met] ADB_E2E_PHYSICAL_SERIAL ${JSON.stringify(configuredPhysicalSerial)} did not have an unambiguous non-AVD status; stop rejection was not exercised.`,
										);
									} else {
										physicalIdentityConfirmed = true;
									}
								}
							} catch (error) {
								console.info(
									`[ADB_E2E condition not met] ADB_E2E_PHYSICAL_SERIAL ${JSON.stringify(configuredPhysicalSerial)} could not be confirmed as a physical device; stop rejection was not exercised: ${error instanceof Error ? error.message : String(error)}`,
								);
							}
							if (physicalIdentityConfirmed) {
								await expect(
									tool.execute("e2e-refuse-physical-stop", { op: "stop", device: configuredPhysicalSerial }),
								).rejects.toThrow(/not an Android emulator|Physical devices cannot be stopped/i);
							}
						}
					} else {
						console.info(
							"[ADB_E2E condition not met] Set ADB_E2E_PHYSICAL_SERIAL to an online physical device serial to exercise stop rejection.",
						);
					}

					let started: AgentToolResult<AdbToolDetails>;
					try {
						startAttempted = true;
						started = await tool.execute("e2e-start", {
							op: "start",
							avd,
							waitUntil: "booted",
							timeout: 300,
						});
					} catch (error) {
						console.warn(
							`[ADB_E2E conditional skip] AVD ${JSON.stringify(avd)} could not boot; verify emulator and virtualization prerequisites: ${error instanceof Error ? error.message : String(error)}`,
						);
						return;
					}
					const serial = started.details?.serial;
					expect(serial).toBeDefined();
					expect(started.details?.avd).toBe(avd);
					const reused = text(started).includes(" reused as ");
					console.info(`[ADB_E2E] ${reused ? "reused" : "started"} ${avd} as ${serial}.`);
					if (existingTargetSerial) {
						expect(reused).toBe(true);
						expect(serial).toBe(existingTargetSerial);
					}
					if (serial && initialSerials.has(serial)) {
						expect(reused).toBe(true);
						expect(existingTargetSerial).toBe(serial);
					}
					if (
						!serial ||
						started.details?.avd !== avd ||
						(initialSerials.has(serial) && (!reused || serial !== existingTargetSerial))
					) {
						throw new Error(
							`ADB start did not return a safely identified serial for AVD ${JSON.stringify(avd)}.`,
						);
					}
					cleanupSerial = serial;

					const sdk = await tool.execute("e2e-sdk", {
						op: "shell",
						device: serial,
						command: "getprop ro.build.version.sdk",
						timeout: 15,
					});
					expect(text(sdk).trim()).toMatch(/^\d+$/);

					const screenshot = await tool.execute("e2e-screenshot", {
						op: "screenshot",
						device: serial,
						timeout: 30,
					});
					const image = screenshot.content.find(part => part.type === "image");
					const screenshotPath = screenshot.details?.path;
					expect(image?.mimeType).toBe("image/png");
					expect(screenshot.details?.mimeType).toBe("image/png");
					expect(screenshotPath).toBeDefined();
					if (!screenshotPath) throw new Error("ADB screenshot did not return a file path.");
					temporaryFiles.push(screenshotPath);
					const diskBytes = await fs.readFile(screenshotPath);
					expect([...diskBytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
					expect(diskBytes.byteLength).toBeGreaterThan(8);
					expect(screenshot.details?.bytes).toBe(diskBytes.byteLength);
				})();
			} catch (error) {
				bodyFailed = true;
				bodyError = error;
			}

			let cleanupFailed = false;
			let cleanupError: unknown;
			try {
				const cleanupDeadline = Date.now() + 15_000;
				const cleanupSignal = (maximumMs: number): AbortSignal =>
					AbortSignal.timeout(Math.max(1, Math.min(maximumMs, cleanupDeadline - Date.now())));

				if (startAttempted && !cleanupSerial) {
					const listed = await tool.execute("e2e-cleanup-devices", { op: "devices" }, cleanupSignal(5_000));
					const candidates: string[] = [];
					for (const device of listed.details?.devices ?? []) {
						if (initialSerials.has(device.serial) || device.state !== "device") continue;
						try {
							const status = await tool.execute(
								`e2e-cleanup-status-${device.serial}`,
								{ op: "status", device: device.serial },
								cleanupSignal(5_000),
							);
							if (status.details?.serial === device.serial && status.details.avd === avd) {
								candidates.push(device.serial);
							}
						} catch (error) {
							console.warn(
								`[ADB_E2E cleanup condition not met] Device ${JSON.stringify(device.serial)} could not be identified as AVD ${JSON.stringify(avd)} and will not be stopped: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
					}
					if (candidates.length === 1) {
						cleanupSerial = candidates[0];
						console.info(
							`[ADB_E2E cleanup] Identified post-start AVD ${JSON.stringify(avd)} as ${cleanupSerial}.`,
						);
					} else if (candidates.length > 1) {
						throw new Error(
							`ADB cleanup found multiple new serials for AVD ${JSON.stringify(avd)} and will not guess: ${candidates.join(", ")}.`,
						);
					}
				}

				if (cleanupSerial) {
					await tool.execute("e2e-stop", { op: "stop", device: cleanupSerial }, cleanupSignal(10_000));
					let stillListed = true;
					while (Date.now() < cleanupDeadline) {
						const listed = await tool.execute("e2e-stop-poll", { op: "devices" }, cleanupSignal(5_000));
						stillListed = (listed.details?.devices ?? []).some(device => device.serial === cleanupSerial);
						if (!stillListed) break;
						await Bun.sleep(250);
					}
					expect(stillListed).toBe(false);
				}
			} catch (error) {
				cleanupFailed = true;
				cleanupError = error;
			}

			if (bodyFailed) {
				if (cleanupFailed) {
					throw new AggregateError([bodyError, cleanupError], "ADB E2E body and cleanup both failed");
				}
				throw bodyError;
			}
			if (cleanupFailed) throw cleanupError;
		},
		360_000,
	);
});

describe("AdbTool renderer", () => {
	it("renders partial, queued, running, successful, and failed merged lifecycle states", async () => {
		const uiTheme = await theme();
		expect(adbToolRenderer.mergeCallAndResult).toBe(true);
		expect(adbToolRenderer.renderCallBeforeExecution).toBe(true);

		const partial = render(
			adbToolRenderer.renderCall(
				{ __partialJson: `{"op":"shell","device":"${SERIAL}","command":"echo partial` },
				{ expanded: false, isPartial: true, executionStarted: false },
				uiTheme,
			),
		);
		expect(partial).toContain("ADB");
		expect(partial).toContain("shell");
		expect(partial).toContain("echo partial");
		expect(partial).toContain(Bun.stripANSI(formatStatusIcon("pending", uiTheme)));

		const running = render(
			adbToolRenderer.renderResult(
				{ content: [{ type: "text", text: "streaming log line" }], details: { op: "logcat", serial: SERIAL } },
				{ expanded: false, isPartial: true, spinnerFrame: 1, executionStarted: true },
				uiTheme,
				{ op: "logcat", device: SERIAL, follow: true },
			),
		);
		expect(running).toContain("ADB");
		expect(running).toContain("logcat");
		expect(running).toContain("streaming log line");
		expect(running).toContain(Bun.stripANSI(formatStatusIcon("running", uiTheme, 1)));

		const success = render(
			adbToolRenderer.renderResult(
				{ content: [{ type: "text", text: "Success" }], details: { op: "install", serial: SERIAL } },
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "install", device: SERIAL, apkPath: "app debug.apk" },
			),
		);
		expect(success).toContain("install");
		expect(success).toContain("Success");
		expect(success).toContain(Bun.stripANSI(formatStatusIcon("success", uiTheme)));

		const failure = render(
			adbToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "permission denied" }],
					details: { op: "push", serial: SERIAL },
					isError: true,
				},
				{ expanded: true, isPartial: false },
				uiTheme,
				{ op: "push", device: SERIAL, localPath: "local path", remotePath: "/remote path" },
			),
		);
		expect(failure).toContain("push");
		expect(failure).toContain("permission denied");
		expect(failure).toContain(Bun.stripANSI(formatStatusIcon("error", uiTheme)));
	});

	it("renders start boot state, screenshot metadata, and collapsed/expanded output", async () => {
		const uiTheme = await theme();
		const start = render(
			adbToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "Started AVD with spaces; booted" }],
					details: { op: "start", serial: SERIAL, avd: "AVD with spaces", state: "booted" },
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "start", avd: "AVD with spaces", waitUntil: "booted" },
			),
		);
		expect(start).toContain("start");
		expect(start).toContain("AVD with spaces");
		expect(start).toContain("booted");

		const screenshot = render(
			adbToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "Screenshot saved" }],
					details: {
						op: "screenshot",
						serial: SERIAL,
						path: "/tmp/adb shot.png",
						mimeType: "image/png",
						width: 1,
						height: 1,
					},
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "screenshot", device: SERIAL },
			),
		);
		expect(screenshot).toContain("screenshot");
		expect(screenshot).toContain("image/png");
		expect(screenshot).toMatch(/1\s*[×x]\s*1/);

		const output = Array.from({ length: 30 }, (_, index) => `adb output line ${index + 1}`).join("\n");
		const result = {
			content: [{ type: "text", text: output }],
			details: { op: "shell", serial: SERIAL },
		} satisfies { content: Array<{ type: string; text?: string }>; details: AdbToolDetails };
		const args = { op: "shell", device: SERIAL, command: "long command" };
		const collapsed = render(
			adbToolRenderer.renderResult(result, { expanded: false, isPartial: false }, uiTheme, args),
			100,
		);
		const expanded = render(
			adbToolRenderer.renderResult(result, { expanded: true, isPartial: false }, uiTheme, args),
			100,
		);
		expect(collapsed).toContain("adb output line 1");
		expect(collapsed).not.toContain("adb output line 30");
		expect(collapsed.toLowerCase()).toMatch(/more lines|earlier line/);
		expect(expanded).toContain("adb output line 1");
		expect(expanded).toContain("adb output line 30");
		expect(expanded.toLowerCase()).not.toMatch(/more lines|earlier line/);
	});
});
