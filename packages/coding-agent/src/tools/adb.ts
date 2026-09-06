import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import {
	type AdbBinaryResult,
	type AdbCommandOptions,
	type AdbCommandResult,
	type AdbDevice,
	type AndroidExecutableName,
	executeAdb,
	executeAdbBinary,
	parseAdbDevices,
	resolveAndroidExecutable,
} from "../adb/adb-executor";
import {
	EmulatorManager,
	type EmulatorStartResult,
	type EmulatorStopResult,
	type EmulatorWaitUntil,
} from "../adb/emulator-manager";
import { AdbUiAutomation } from "../adb/ui-automation";
import type { AdbUiClickResult, AdbUiObservation, AdbUiWaitUntil } from "../adb/ui-types";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { decodeStreamedToolArgs } from "../modes/controllers/tool-args-reveal";
import type { Theme } from "../modes/theme/theme";
import adbDescription from "../prompts/tools/adb.md" with { type: "text" };
import { DEFAULT_MAX_BYTES, OutputSink, streamTailUpdates, TailBuffer } from "../session/streaming-output";
import { renderStatusLine } from "../tui";
import { CachedOutputBlock, markFramedBlockComponent } from "../tui/output-block";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import {
	formatStyledTruncationWarning,
	type OutputMeta,
	resolveOutputMaxColumns,
	resolveOutputSinkHeadBytes,
	resolveOutputSinkSpillThreshold,
	resolveOutputSinkTailBytes,
	stripOutputNotice,
} from "./output-meta";
import { capPreviewLines, replaceTabs } from "./render-utils";
import { ToolAbortError, ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

const deviceField = type("string > 0").describe("adb device serial; omit only when exactly one device is online");
const timeoutField = type("number > 0").describe("timeout in seconds");
const linesField = type("1 <= number.integer <= 10000").describe("maximum recent log lines");
const coordinateField = type("number.integer >= 0").describe("non-negative screen coordinate");
const durationField = type("1 <= number.integer <= 60000").describe("swipe duration in milliseconds");
const nonEmptyString = type("string > 0");
const UIAUTOMATOR_DUMP_COMMAND = /^\s*uiautomator\s+dump(?:\s|$)/;
const UIAUTOMATOR_IDLE_TIMEOUT = /ERROR:\s*could not get idle state\./i;
const UIAUTOMATOR_RETRY_DELAY_MS = 500;

const uiSelectorSchema = type({
	"text?": "string",
	"textContains?": nonEmptyString,
	"resourceId?": nonEmptyString,
	"description?": "string",
	"className?": nonEmptyString,
	"packageName?": nonEmptyString,
	"enabled?": "boolean",
	"checked?": "boolean",
	"focused?": "boolean",
	"selected?": "boolean",
	"+": "reject",
}).describe("non-empty AND selector; exact strings except textContains (substring)");
const uiTargetSchema = uiSelectorSchema.or(
	type({ ref: nonEmptyString.describe("element ref from the latest observation on this device"), "+": "reject" }),
);
const observeSchema = type({
	op: "'observe'",
	"device?": deviceField,
	"timeout?": timeoutField,
	"+": "reject",
});
const clickSchema = type({
	op: "'click'",
	"device?": deviceField,
	selector: uiTargetSchema,
	"longClick?": "boolean",
	"timeout?": timeoutField,
	"+": "reject",
});
const uiWaitSchema = type({
	op: "'wait'",
	"device?": deviceField,
	until: "'visible' | 'hidden' | 'enabled' | 'disabled'",
	selector: uiSelectorSchema,
	"timeout?": timeoutField,
	"+": "reject",
});
const devicesSchema = type({ op: "'devices'", "+": "reject" });
const avdsSchema = type({ op: "'avds'", "+": "reject" });
const statusSchema = type({ op: "'status'", "device?": deviceField, "+": "reject" });
const waitSchema = type({
	op: "'wait'",
	"device?": deviceField,
	until: "'connected' | 'booted'",
	"timeout?": timeoutField,
	"+": "reject",
});
const startSchema = type({
	op: "'start'",
	avd: nonEmptyString.describe("exact configured AVD name"),
	"waitUntil?": type("'connected' | 'booted'").describe("defaults to booted"),
	"timeout?": timeoutField,
	"+": "reject",
});
const stopSchema = type({ op: "'stop'", "device?": deviceField, "+": "reject" });
const shellSchema = type({
	op: "'shell'",
	"device?": deviceField,
	command: nonEmptyString.describe("single command passed to adb shell"),
	"timeout?": timeoutField,
	"+": "reject",
});
const logcatSchema = type({
	op: "'logcat'",
	"device?": deviceField,
	"lines?": linesField,
	"filter?": nonEmptyString.describe("one logcat filter expression"),
	"follow?": "boolean",
	"timeout?": timeoutField,
	"+": "reject",
});
const screenshotSchema = type({ op: "'screenshot'", "device?": deviceField, "timeout?": timeoutField, "+": "reject" });
const pushSchema = type({
	op: "'push'",
	"device?": deviceField,
	localPath: nonEmptyString,
	remotePath: nonEmptyString,
	"timeout?": timeoutField,
	"+": "reject",
});
const pullSchema = type({
	op: "'pull'",
	"device?": deviceField,
	remotePath: nonEmptyString,
	localPath: nonEmptyString,
	"timeout?": timeoutField,
	"+": "reject",
});
const installSchema = type({
	op: "'install'",
	"device?": deviceField,
	apkPath: nonEmptyString,
	"timeout?": timeoutField,
	"+": "reject",
});
const uninstallSchema = type({
	op: "'uninstall'",
	"device?": deviceField,
	package: nonEmptyString,
	"timeout?": timeoutField,
	"+": "reject",
});
const launchSchema = type({
	op: "'launch'",
	"device?": deviceField,
	package: nonEmptyString,
	"activity?": nonEmptyString,
	"timeout?": timeoutField,
	"+": "reject",
});
const tapSchema = type({
	op: "'input'",
	"device?": deviceField,
	action: "'tap'",
	x: coordinateField,
	y: coordinateField,
	"timeout?": timeoutField,
	"+": "reject",
});
const swipeSchema = type({
	op: "'input'",
	"device?": deviceField,
	action: "'swipe'",
	x1: coordinateField,
	y1: coordinateField,
	x2: coordinateField,
	y2: coordinateField,
	durationMs: durationField,
	"timeout?": timeoutField,
	"+": "reject",
});
const textSchema = type({
	op: "'input'",
	"device?": deviceField,
	action: "'text'",
	text: nonEmptyString,
	"timeout?": timeoutField,
	"+": "reject",
});
const keyeventSchema = type({
	op: "'input'",
	"device?": deviceField,
	action: "'keyevent'",
	key: type("string > 0").or("number.integer >= 0"),
	"timeout?": timeoutField,
	"+": "reject",
});

export const adbSchema = devicesSchema
	.or(observeSchema)
	.or(clickSchema)
	.or(avdsSchema)
	.or(statusSchema)
	.or(waitSchema)
	.or(uiWaitSchema)
	.or(startSchema)
	.or(stopSchema)
	.or(shellSchema)
	.or(logcatSchema)
	.or(screenshotSchema)
	.or(pushSchema)
	.or(pullSchema)
	.or(installSchema)
	.or(uninstallSchema)
	.or(launchSchema)
	.or(tapSchema)
	.or(swipeSchema)
	.or(textSchema)
	.or(keyeventSchema);

export type AdbToolParams = typeof adbSchema.infer;
export type AdbParams = AdbToolParams;
export type AdbOperation = AdbToolParams["op"];

export interface AdbToolDetails {
	op: AdbOperation;
	serial?: string;
	avd?: string;
	state?: EmulatorWaitUntil | AdbUiWaitUntil;
	path?: string;
	bytes?: number;
	mimeType?: "image/png";
	width?: number;
	height?: number;
	devices?: AdbDevice[];
	avds?: string[];
	device?: AdbDevice;
	localPath?: string;
	remotePath?: string;
	package?: string;
	activity?: string;
	observation?: AdbUiObservation;
	click?: AdbUiClickResult;
	meta?: OutputMeta;
}
export type AdbDetails = AdbToolDetails;

type AdbEmulatorManager = Pick<EmulatorManager, "listAvds" | "start" | "status" | "wait" | "stop">;

export interface AdbToolDependencies {
	resolveExecutable(name: AndroidExecutableName): string | null;
	executeAdb(args: readonly string[], options?: AdbCommandOptions): Promise<AdbCommandResult>;
	executeAdbBinary(args: readonly string[], options?: AdbCommandOptions): Promise<AdbBinaryResult>;
	emulatorManager: AdbEmulatorManager;
}

const READ_OPERATIONS: Partial<Record<AdbOperation, true>> = {
	devices: true,
	avds: true,
	status: true,
	wait: true,
	logcat: true,
	screenshot: true,
	observe: true,
};
const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const DEFAULT_LOGCAT_LINES = 200;
const ALLOWED_FIELDS_BY_OPERATION: Record<AdbOperation, readonly string[]> = {
	devices: ["op"],
	avds: ["op"],
	status: ["op", "device"],
	observe: ["op", "device", "timeout"],
	click: ["op", "device", "selector", "longClick", "timeout"],
	wait: ["op", "device", "until", "selector", "timeout"],
	start: ["op", "avd", "waitUntil", "timeout"],
	stop: ["op", "device"],
	shell: ["op", "device", "command", "timeout"],
	logcat: ["op", "device", "lines", "filter", "follow", "timeout"],
	screenshot: ["op", "device", "timeout"],
	push: ["op", "device", "localPath", "remotePath", "timeout"],
	pull: ["op", "device", "remotePath", "localPath", "timeout"],
	install: ["op", "device", "apkPath", "timeout"],
	uninstall: ["op", "device", "package", "timeout"],
	launch: ["op", "device", "package", "activity", "timeout"],
	input: ["op", "device", "action", "timeout"],
};
const ALLOWED_FIELDS_BY_INPUT_ACTION: Record<string, readonly string[]> = {
	tap: ["x", "y"],
	swipe: ["x1", "y1", "x2", "y2", "durationMs"],
	text: ["text"],
	keyevent: ["key"],
};

export function adbApproval(args: unknown): ToolApprovalDecision {
	const op = args && typeof args === "object" && "op" in args && typeof args.op === "string" ? args.op : "";
	return READ_OPERATIONS[op as AdbOperation] ? "read" : "exec";
}

function promptValue(value: unknown): string {
	return truncateForPrompt(String(value));
}

export function formatApprovalDetails(args: unknown): string[] {
	if (!args || typeof args !== "object") return [];
	const params = args as Record<string, unknown>;
	const lines: string[] = [];
	if (typeof params.op === "string") lines.push(`Operation: ${promptValue(params.op)}`);
	const labels: ReadonlyArray<readonly [string, string]> = [
		["device", "Serial"],
		["avd", "AVD"],
		["until", "Wait until"],
		["waitUntil", "Wait until"],
		["command", "Command"],
		["lines", "Lines"],
		["filter", "Filter"],
		["follow", "Follow"],
		["localPath", "Local path"],
		["remotePath", "Remote path"],
		["apkPath", "APK path"],
		["package", "Package"],
		["activity", "Activity"],
		["action", "Input action"],
		["selector", "Selector"],
		["longClick", "Long click"],
		["x", "X"],
		["y", "Y"],
		["x1", "X1"],
		["y1", "Y1"],
		["x2", "X2"],
		["y2", "Y2"],
		["durationMs", "Duration ms"],
		["text", "Text"],
		["key", "Key"],
		["timeout", "Timeout seconds"],
	];
	for (const [key, label] of labels) {
		if (params[key] !== undefined) {
			const value = key === "selector" ? JSON.stringify(params[key]) : params[key];
			lines.push(`${label}: ${promptValue(value)}`);
		}
	}
	return lines;
}

function ensureNonEmpty(value: string, field: string): void {
	if (value.trim().length === 0) throw new ToolError(`ADB ${field} must be non-empty.`);
}

function ensureFinite(value: number, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): void {
	if (!Number.isFinite(value) || value < minimum || value > maximum) {
		throw new ToolError(`ADB ${field} must be a finite number from ${minimum} through ${maximum}.`);
	}
}

function validateParams(params: AdbToolParams): void {
	const op = (params as { op?: unknown }).op;
	if (typeof op !== "string" || !(op in ALLOWED_FIELDS_BY_OPERATION)) {
		throw new ToolError(`Unknown ADB operation: ${String(op)}.`);
	}
	const allowed = [...ALLOWED_FIELDS_BY_OPERATION[op as AdbOperation]];
	if (op === "input") {
		const action = (params as { action?: unknown }).action;
		if (typeof action !== "string" || !(action in ALLOWED_FIELDS_BY_INPUT_ACTION)) {
			throw new ToolError(`Unknown ADB input action: ${String(action)}.`);
		}
		allowed.push(...(ALLOWED_FIELDS_BY_INPUT_ACTION[action] ?? []));
	}
	for (const field of Object.keys(params)) {
		if (field !== "i" && !allowed.includes(field)) {
			throw new ToolError(`Field ${JSON.stringify(field)} is not valid for ADB ${op}.`);
		}
	}
	if ("device" in params && params.device !== undefined) ensureNonEmpty(params.device, "device serial");
	if ("timeout" in params && params.timeout !== undefined) {
		ensureFinite(params.timeout, "timeout", Number.MIN_VALUE, Number.MAX_VALUE);
	}
	if ("selector" in params && Object.keys(params.selector).length === 0) {
		throw new ToolError("ADB selector must contain at least one element attribute or ref.");
	}
	switch (params.op) {
		case "start":
			ensureNonEmpty(params.avd, "AVD name");
			break;
		case "shell":
			ensureNonEmpty(params.command, "shell command");
			break;
		case "logcat":
			if (params.lines !== undefined) ensureFinite(params.lines, "logcat lines", 1, 10_000);
			if (params.filter !== undefined) ensureNonEmpty(params.filter, "logcat filter");
			break;
		case "push":
		case "pull":
			ensureNonEmpty(params.localPath, "local path");
			ensureNonEmpty(params.remotePath, "remote path");
			break;
		case "install":
			ensureNonEmpty(params.apkPath, "APK path");
			break;
		case "uninstall":
			ensureNonEmpty(params.package, "package");
			break;
		case "launch":
			ensureNonEmpty(params.package, "package");
			if (params.activity !== undefined) ensureNonEmpty(params.activity, "activity");
			break;
		case "input":
			switch (params.action) {
				case "tap":
					ensureFinite(params.x, "tap x");
					ensureFinite(params.y, "tap y");
					break;
				case "swipe":
					ensureFinite(params.x1, "swipe x1");
					ensureFinite(params.y1, "swipe y1");
					ensureFinite(params.x2, "swipe x2");
					ensureFinite(params.y2, "swipe y2");
					ensureFinite(params.durationMs, "swipe duration", 1, 60_000);
					break;
				case "text":
					ensureNonEmpty(params.text, "input text");
					break;
				case "keyevent":
					if (typeof params.key === "string") ensureNonEmpty(params.key, "key event");
					else ensureFinite(params.key, "key event");
					break;
			}
			break;
	}
}

function formatDevice(device: AdbDevice): string {
	const labels = [device.model && `model:${device.model}`, device.product && `product:${device.product}`].filter(
		Boolean,
	);
	return `${device.serial}\t${device.state}${labels.length > 0 ? ` ${labels.join(" ")}` : ""}`;
}

function operationContext(details: AdbToolDetails): string {
	const values: string[] = [];
	if (details.serial) values.push(`serial ${JSON.stringify(details.serial)}`);
	if (details.localPath) values.push(`local path ${JSON.stringify(details.localPath)}`);
	if (details.remotePath) values.push(`remote path ${JSON.stringify(details.remotePath)}`);
	if (details.package) values.push(`package ${JSON.stringify(details.package)}`);
	if (details.activity) values.push(`activity ${JSON.stringify(details.activity)}`);
	return values.length > 0 ? ` for ${values.join(", ")}` : "";
}

function outputContext(output: string | undefined, artifactId?: string): string {
	const text = output?.trim();
	const artifact = artifactId ? ` Full output: artifact://${artifactId}.` : "";
	return `${text ? ` Output: ${text}` : ""}${artifact}`;
}

function pngDimensions(bytes: Uint8Array): { width?: number; height?: number } {
	if (bytes.byteLength < 24) return {};
	if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return {};
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const width = view.getUint32(16, false);
	const height = view.getUint32(20, false);
	return width > 0 && height > 0 ? { width, height } : {};
}

function hasPngSignature(bytes: Uint8Array): boolean {
	if (bytes.byteLength < PNG_SIGNATURE.byteLength) return false;
	for (let index = 0; index < PNG_SIGNATURE.byteLength; index++) {
		if (bytes[index] !== PNG_SIGNATURE[index]) return false;
	}
	return true;
}

export class AdbTool implements AgentTool<typeof adbSchema, AdbToolDetails> {
	readonly name = "adb";
	readonly label = "ADB";
	readonly summary =
		"Observe Android UI, click elements, wait for UI state, and manage devices, apps, files, and AVDs";
	readonly loadMode = "discoverable" as const;
	readonly parameters = adbSchema;
	readonly strict = true;
	readonly concurrency = "exclusive" as const;
	readonly mergeCallAndResult = true;
	readonly renderCallBeforeExecution = true;
	readonly approval = adbApproval;
	readonly formatApprovalDetails = formatApprovalDetails;
	readonly description = prompt.render(adbDescription);
	readonly renderCall = (args: AdbToolParams, options: RenderResultOptions, renderTheme: unknown): Component =>
		adbToolRenderer.renderCall(args, options, renderTheme as Theme);
	readonly renderResult = (
		result: AgentToolResult<AdbToolDetails>,
		options: RenderResultOptions,
		renderTheme: unknown,
		args?: AdbToolParams,
	): Component => adbToolRenderer.renderResult(result, options, renderTheme as Theme, args);

	readonly #dependencies: AdbToolDependencies;
	readonly #ui: AdbUiAutomation;

	constructor(
		private readonly session: ToolSession,
		dependencies: Partial<AdbToolDependencies> = {},
	) {
		const resolveExecutable = dependencies.resolveExecutable ?? (name => resolveAndroidExecutable(name));
		const textExecutor = dependencies.executeAdb ?? executeAdb;
		this.#dependencies = {
			resolveExecutable,
			executeAdb: textExecutor,
			executeAdbBinary: dependencies.executeAdbBinary ?? executeAdbBinary,
			emulatorManager:
				dependencies.emulatorManager ?? new EmulatorManager({ resolveExecutable, executeAdb: textExecutor }),
		};
		this.#ui = new AdbUiAutomation({
			runBinary: (args, timeoutMs, signal) =>
				this.#runBinary(args, { op: "observe", serial: args[1] }, timeoutMs, signal),
			runText: (args, timeoutMs, signal) => this.#runText(args, { op: "click", serial: args[1] }, timeoutMs, signal),
		});
	}

	static createIf(session: ToolSession, dependencies: Partial<AdbToolDependencies> = {}): AdbTool | null {
		const resolver = dependencies.resolveExecutable ?? (name => resolveAndroidExecutable(name));
		return resolver("adb") ? new AdbTool(session, dependencies) : null;
	}

	async execute(
		_toolCallId: string,
		params: AdbToolParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<AdbToolDetails>,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<AdbToolDetails>> {
		try {
			params = adbSchema.assert(params);
		} catch (error) {
			throw new ToolError(`Invalid ADB arguments: ${error instanceof Error ? error.message : String(error)}`);
		}
		validateParams(params);
		const timeoutSec =
			"timeout" in params
				? clampTimeout("adb", params.timeout, this.session.settings.get("tools.maxTimeout"))
				: clampTimeout("adb", undefined, this.session.settings.get("tools.maxTimeout"));
		const timeoutMs = timeoutSec * 1000;

		if (params.op === "observe" || params.op === "click" || (params.op === "wait" && "selector" in params)) {
			return this.#uiOperation(params, timeoutMs, signal);
		}
		switch (params.op) {
			case "devices": {
				const details: AdbToolDetails = { op: params.op };
				const result = await this.#runText(["devices", "-l"], details, timeoutMs, signal, onUpdate);
				const devices = parseAdbDevices(result.output);
				details.devices = devices;
				const text = devices.length > 0 ? devices.map(formatDevice).join("\n") : "No Android devices attached.";
				return toolResult(details).text(text).truncationFromSummary(result, { direction: "tail" }).done();
			}
			case "avds": {
				const avds = await this.#runManager(params.op, {}, signal, () =>
					this.#dependencies.emulatorManager.listAvds(),
				);
				return toolResult<AdbToolDetails>({ op: params.op, avds })
					.text(avds.length > 0 ? avds.join("\n") : "No Android Virtual Devices configured.")
					.done();
			}
			case "status": {
				const device = await this.#runManager(params.op, {}, signal, () =>
					this.#dependencies.emulatorManager.status(params.device),
				);
				return toolResult<AdbToolDetails>({
					op: params.op,
					serial: device.serial,
					avd: device.avdName,
					device,
				})
					.text(formatDevice(device))
					.done();
			}
			case "wait": {
				const base = params.device ? { serial: params.device } : {};
				const device = await this.#runManager(params.op, base, signal, () =>
					this.#dependencies.emulatorManager.wait(params.device, params.until, timeoutMs, signal),
				);
				return toolResult<AdbToolDetails>({
					op: params.op,
					serial: device.serial,
					avd: device.avdName,
					state: params.until,
					device,
				})
					.text(`Device ${device.serial} is ${params.until}.`)
					.done();
			}
			case "start": {
				this.#ui.invalidate();
				const result = await this.#runManager(params.op, { avd: params.avd }, signal, () =>
					this.#dependencies.emulatorManager.start({
						avd: params.avd,
						waitUntil: params.waitUntil ?? "booted",
						timeoutMs,
						signal,
					}),
				);
				return this.#startResult(result);
			}
			case "stop": {
				this.#ui.invalidate(params.device);
				const result = await this.#runManager(
					params.op,
					params.device ? { serial: params.device } : {},
					signal,
					() => this.#dependencies.emulatorManager.stop(params.device),
				);
				return this.#stopResult(result);
			}
			case "shell":
				return this.#deviceText(params, timeoutMs, signal, onUpdate, device => [
					"-s",
					device.serial,
					"shell",
					params.command,
				]);
			case "logcat":
				return this.#deviceText(params, timeoutMs, signal, onUpdate, device => {
					const args = ["-s", device.serial, "logcat"];
					if (params.follow) {
						if (params.lines !== undefined) args.push("-T", String(params.lines));
					} else {
						args.push("-d", "-t", String(params.lines ?? DEFAULT_LOGCAT_LINES));
					}
					if (params.filter) args.push(params.filter);
					return args;
				});
			case "screenshot":
				return this.#screenshot(params, timeoutMs, signal);
			case "push":
				return this.#deviceText(
					params,
					timeoutMs,
					signal,
					onUpdate,
					device => ["-s", device.serial, "push", params.localPath, params.remotePath],
					{ localPath: params.localPath, remotePath: params.remotePath },
				);
			case "pull":
				return this.#deviceText(
					params,
					timeoutMs,
					signal,
					onUpdate,
					device => ["-s", device.serial, "pull", params.remotePath, params.localPath],
					{ localPath: params.localPath, remotePath: params.remotePath },
				);
			case "install":
				return this.#deviceText(
					params,
					timeoutMs,
					signal,
					onUpdate,
					device => ["-s", device.serial, "install", params.apkPath],
					{ localPath: params.apkPath },
				);
			case "uninstall":
				return this.#deviceText(
					params,
					timeoutMs,
					signal,
					onUpdate,
					device => ["-s", device.serial, "uninstall", params.package],
					{ package: params.package },
				);
			case "launch":
				return this.#deviceText(
					params,
					timeoutMs,
					signal,
					onUpdate,
					device =>
						params.activity
							? ["-s", device.serial, "shell", "am", "start", "-n", `${params.package}/${params.activity}`]
							: [
									"-s",
									device.serial,
									"shell",
									"monkey",
									"-p",
									params.package,
									"-c",
									"android.intent.category.LAUNCHER",
									"1",
								],
					{ package: params.package, activity: params.activity },
				);
			case "input":
				return this.#deviceText(params, timeoutMs, signal, onUpdate, device => {
					const prefix = ["-s", device.serial, "shell", "input", params.action];
					switch (params.action) {
						case "tap":
							return [...prefix, String(params.x), String(params.y)];
						case "swipe":
							return [
								...prefix,
								String(params.x1),
								String(params.y1),
								String(params.x2),
								String(params.y2),
								String(params.durationMs),
							];
						case "text":
							return [...prefix, params.text];
						case "keyevent":
							return [...prefix, String(params.key)];
					}
				});
		}
	}

	async #uiOperation(
		params: Extract<AdbToolParams, { op: "observe" | "click" } | { op: "wait"; selector: unknown }>,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<AdbToolDetails>> {
		const deadline = performance.now() + timeoutMs;
		const device = await this.#runManager(params.op, { serial: params.device }, signal, () =>
			this.#dependencies.emulatorManager.wait(params.device, "connected", timeoutMs, signal),
		);
		const remaining = deadline - performance.now();
		if (remaining <= 0)
			throw new ToolError(`ADB ${params.op} timed out for serial ${JSON.stringify(device.serial)}.`);
		const details: AdbToolDetails = { op: params.op, serial: device.serial, avd: device.avdName, device };
		return this.#runManager(params.op, details, signal, async () => {
			if (params.op === "click") {
				const click = await this.#ui.click(
					device.serial,
					params.selector,
					params.longClick ?? false,
					remaining,
					signal,
				);
				details.click = click;
				return toolResult(details)
					.text(
						`${params.longClick ? "Long-clicked" : "Clicked"} ${click.element.ref} at (${click.x}, ${click.y}). Observe or wait for the expected UI state to verify the effect.`,
					)
					.done();
			}
			let observation: AdbUiObservation;
			if (params.op === "wait") {
				const result = await this.#ui.wait(device.serial, params.selector, params.until, remaining, signal);
				observation = result.observation;
				details.state = result.until;
			} else {
				observation = await this.#ui.observe(device.serial, remaining, signal);
			}
			details.observation = observation;
			return this.#observationResult(details, observation);
		});
	}

	async #observationResult(
		details: AdbToolDetails,
		observation: AdbUiObservation,
	): Promise<AgentToolResult<AdbToolDetails>> {
		const { path: artifactPath, id: artifactId } = (await this.session.allocateOutputArtifact?.("adb")) ?? {};
		const sink = new OutputSink({
			artifactPath,
			artifactId,
			spillThreshold: resolveOutputSinkSpillThreshold(this.session.settings),
			tailBytes: resolveOutputSinkTailBytes(this.session.settings),
			headBytes: resolveOutputSinkHeadBytes(this.session.settings),
			maxColumns: resolveOutputMaxColumns(this.session.settings),
		});
		try {
			sink.push(
				`${JSON.stringify({ serial: observation.serial, snapshot: observation.snapshot, rotation: observation.rotation, elements: observation.elements.length, until: details.state })}\n`,
			);
			for (const element of observation.elements) sink.push(`${JSON.stringify(element)}\n`);
			const result = await sink.dump();
			return toolResult(details).text(result.output).truncationFromSummary(result, { direction: "tail" }).done();
		} finally {
			await sink.dispose();
		}
	}

	#startResult(result: EmulatorStartResult): AgentToolResult<AdbToolDetails> {
		const reused = result.reused ? "reused" : `started${result.pid === undefined ? "" : ` (pid ${result.pid})`}`;
		return toolResult<AdbToolDetails>({
			op: "start",
			serial: result.serial,
			avd: result.avd,
			state: result.state,
		})
			.text(`AVD ${result.avd} ${reused} as ${result.serial}; device is ${result.state}.`)
			.done();
	}

	#stopResult(result: EmulatorStopResult): AgentToolResult<AdbToolDetails> {
		return toolResult<AdbToolDetails>({ op: "stop", serial: result.serial, avd: result.avd })
			.text(`Stopped AVD ${result.avd} (${result.serial}).`)
			.done();
	}

	async #deviceText(
		params: Exclude<
			AdbToolParams,
			{ op: "devices" | "avds" | "status" | "wait" | "start" | "stop" | "screenshot" | "observe" | "click" }
		>,
		timeoutMs: number,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<AdbToolDetails> | undefined,
		buildArgs: (device: AdbDevice) => string[],
		extraDetails: Partial<AdbToolDetails> = {},
	): Promise<AgentToolResult<AdbToolDetails>> {
		const requestedDevice = "device" in params ? params.device : undefined;
		const selected = await this.#runManager(
			params.op,
			requestedDevice ? { serial: requestedDevice } : {},
			signal,
			() => this.#dependencies.emulatorManager.status(requestedDevice),
		);
		const details: AdbToolDetails = {
			op: params.op,
			serial: selected.serial,
			avd: selected.avdName,
			device: selected,
			...extraDetails,
		};
		if (!READ_OPERATIONS[params.op]) this.#ui.invalidate(selected.serial);
		const args = buildArgs(selected);
		const startedAt = Date.now();
		let result = await this.#runText(args, details, timeoutMs, signal, onUpdate);
		if (
			params.op === "shell" &&
			UIAUTOMATOR_DUMP_COMMAND.test(params.command) &&
			UIAUTOMATOR_IDLE_TIMEOUT.test(result.output)
		) {
			const remainingBeforeDelay = timeoutMs - (Date.now() - startedAt);
			if (remainingBeforeDelay > UIAUTOMATOR_RETRY_DELAY_MS) {
				await Bun.sleep(UIAUTOMATOR_RETRY_DELAY_MS);
				signal?.throwIfAborted();
				const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt));
				result = await this.#runText(args, details, remaining, signal, onUpdate);
			}
			if (UIAUTOMATOR_IDLE_TIMEOUT.test(result.output)) {
				throw new ToolError(
					`ADB shell failed${operationContext(details)}: Android's UI hierarchy never became idle. Pause continuously updating UI or animations, then retry uiautomator dump.${outputContext(result.output, result.artifactId)}`,
				);
			}
		}
		return toolResult(details)
			.text(result.output || "(no output)")
			.truncationFromSummary(result, { direction: "tail" })
			.done();
	}

	async #screenshot(
		params: Extract<AdbToolParams, { op: "screenshot" }>,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<AdbToolDetails>> {
		const selected = await this.#runManager(params.op, params.device ? { serial: params.device } : {}, signal, () =>
			this.#dependencies.emulatorManager.status(params.device),
		);
		const details: AdbToolDetails = {
			op: params.op,
			serial: selected.serial,
			avd: selected.avdName,
			device: selected,
		};
		const result = await this.#runBinary(
			["-s", selected.serial, "exec-out", "screencap", "-p"],
			details,
			timeoutMs,
			signal,
		);
		if (!hasPngSignature(result.bytes)) {
			throw new ToolError(
				`ADB screenshot failed${operationContext(details)}: output was not a PNG.${outputContext(result.stderr)}`,
			);
		}
		const screenshotPath = path.join(
			os.tmpdir(),
			`omp-adb-screenshot-${process.pid}-${Date.now()}-${randomUUID()}.png`,
		);
		try {
			await Bun.write(screenshotPath, result.bytes);
		} catch (error) {
			throw new ToolError(
				`ADB screenshot failed${operationContext(details)} while writing ${JSON.stringify(screenshotPath)}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		const dimensions = pngDimensions(result.bytes);
		details.path = screenshotPath;
		details.bytes = result.bytes.byteLength;
		details.mimeType = "image/png";
		details.width = dimensions.width;
		details.height = dimensions.height;
		const dimensionText = dimensions.width && dimensions.height ? ` (${dimensions.width}x${dimensions.height})` : "";
		const data = Buffer.from(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength).toString(
			"base64",
		);
		return toolResult(details)
			.content([
				{
					type: "text",
					text: `Android screenshot saved to ${screenshotPath} (${result.bytes.byteLength} bytes${dimensionText}).`,
				},
				{ type: "image", data, mimeType: "image/png" },
			])
			.done();
	}

	async #runText(
		args: readonly string[],
		details: AdbToolDetails,
		timeoutMs: number,
		signal: AbortSignal | undefined,
		onUpdate?: AgentToolUpdateCallback<AdbToolDetails>,
	): Promise<AdbCommandResult> {
		const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES);
		const { path: artifactPath, id: artifactId } = (await this.session.allocateOutputArtifact?.("adb")) ?? {};
		let result: AdbCommandResult;
		try {
			result = await this.#dependencies.executeAdb(args, {
				timeoutMs,
				signal,
				artifactPath,
				artifactId,
				spillThreshold: resolveOutputSinkSpillThreshold(this.session.settings),
				tailBytes: resolveOutputSinkTailBytes(this.session.settings),
				headBytes: resolveOutputSinkHeadBytes(this.session.settings),
				maxColumns: resolveOutputMaxColumns(this.session.settings),
				onChunk: streamTailUpdates(tailBuffer, onUpdate, details),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (signal?.aborted || error instanceof ToolAbortError) {
				throw new ToolAbortError(`ADB ${details.op} aborted${operationContext(details)}: ${message}`, {
					cause: error,
				});
			}
			throw new ToolError(`ADB ${details.op} failed${operationContext(details)}: ${message}`);
		}
		if (result.cancelled) {
			const context = outputContext(result.output, result.artifactId);
			if (signal?.aborted)
				throw new ToolAbortError(`ADB ${details.op} aborted${operationContext(details)}.${context}`);
			if (result.timedOut) {
				throw new ToolError(`ADB ${details.op} timed out${operationContext(details)}.${context}`);
			}
			throw new ToolError(`ADB ${details.op} was cancelled${operationContext(details)}.${context}`);
		}
		if (result.exitCode !== 0) {
			throw new ToolError(
				`ADB ${details.op} failed${operationContext(details)} with exit code ${result.exitCode ?? "unknown"}.${outputContext(
					result.output,
					result.artifactId,
				)}`,
			);
		}
		return result;
	}

	async #runBinary(
		args: readonly string[],
		details: AdbToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AdbBinaryResult> {
		let result: AdbBinaryResult;
		try {
			result = await this.#dependencies.executeAdbBinary(args, { timeoutMs, signal });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (signal?.aborted || error instanceof ToolAbortError) {
				throw new ToolAbortError(`ADB ${details.op} aborted${operationContext(details)}: ${message}`, {
					cause: error,
				});
			}
			throw new ToolError(`ADB ${details.op} failed${operationContext(details)}: ${message}`);
		}
		if (result.cancelled) {
			const context = outputContext(result.stderr);
			if (signal?.aborted)
				throw new ToolAbortError(`ADB ${details.op} aborted${operationContext(details)}.${context}`);
			if (result.timedOut) throw new ToolError(`ADB ${details.op} timed out${operationContext(details)}.${context}`);
			throw new ToolError(`ADB ${details.op} was cancelled${operationContext(details)}.${context}`);
		}
		if (result.exitCode !== 0) {
			throw new ToolError(
				`ADB ${details.op} failed${operationContext(details)} with exit code ${result.exitCode ?? "unknown"}.${outputContext(
					result.stderr,
				)}`,
			);
		}
		return result;
	}

	async #runManager<T>(
		op: AdbOperation,
		context: Partial<AdbToolDetails>,
		signal: AbortSignal | undefined,
		action: () => Promise<T>,
	): Promise<T> {
		try {
			return await action();
		} catch (error) {
			const details: AdbToolDetails = { op, ...context };
			const message = error instanceof Error ? error.message : String(error);
			if (signal?.aborted || error instanceof ToolAbortError) {
				throw new ToolAbortError(`ADB ${op} aborted${operationContext(details)}: ${message}`, { cause: error });
			}
			throw new ToolError(`ADB ${op} failed${operationContext(details)}: ${message}`);
		}
	}
}

interface AdbRenderArgs extends Record<string, unknown> {
	op?: string;
	device?: string;
	avd?: string;
	until?: string;
	waitUntil?: string;
	command?: string;
	action?: string;
	package?: string;
	activity?: string;
	localPath?: string;
	remotePath?: string;
	apkPath?: string;
	filter?: string;
	lines?: number;
	follow?: boolean;
	selector?: unknown;
	longClick?: boolean;
	__partialJson?: string;
}

interface AdbRenderContext {
	visualLines?: string[];
	skippedCount?: number;
	totalVisualLines?: number;
}

function renderDescription(args: AdbRenderArgs | undefined, details?: AdbToolDetails): string {
	const serial = details?.serial ?? (typeof args?.device === "string" ? args.device : undefined);
	const avd = details?.avd ?? (typeof args?.avd === "string" ? args.avd : undefined);
	const state =
		details?.state ??
		(typeof args?.until === "string" ? args.until : typeof args?.waitUntil === "string" ? args.waitUntil : undefined);
	const values = [
		serial && `[${replaceTabs(serial)}]`,
		avd && `AVD ${replaceTabs(avd)}`,
		state && replaceTabs(state),
	].filter((value): value is string => !!value);
	return values.join(" ");
}

function renderArgumentLines(args: AdbRenderArgs | undefined, details?: AdbToolDetails): string[] {
	const op = details?.op ?? args?.op ?? "…";
	const lines = [replaceTabs(String(op))];
	const fields: Array<[string, unknown]> = [
		["command", args?.command],
		["action", args?.action],
		["package", details?.package ?? args?.package],
		["activity", details?.activity ?? args?.activity],
		["local", details?.localPath ?? args?.localPath ?? args?.apkPath],
		["remote", details?.remotePath ?? args?.remotePath],
		["filter", args?.filter],
		["lines", args?.lines],
		["follow", args?.follow],
		["selector", args?.selector === undefined ? undefined : JSON.stringify(args.selector)],
		["longClick", args?.longClick],
	];
	for (const [label, value] of fields) {
		if (value !== undefined) lines.push(`${label}: ${replaceTabs(String(value))}`);
	}
	if (details?.mimeType) lines.push(`mime: ${details.mimeType}`);
	if (details?.bytes !== undefined) lines.push(`bytes: ${details.bytes}`);
	if (details?.width !== undefined && details.height !== undefined) {
		lines.push(`dimensions: ${details.width}x${details.height}`);
	}
	return lines;
}

function hasStreamedRenderArgs(args: unknown): boolean {
	return !!args && typeof args === "object" && "__partialJson" in args;
}

function decodeAdbRenderArgs(args: AdbRenderArgs): AdbRenderArgs {
	const partialJson = args.__partialJson;
	if (!partialJson) return args;
	return decodeStreamedToolArgs(partialJson, { rawInput: false, fullArgs: args });
}

function renderAdbCall(args: AdbRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
	const outputBlock = new CachedOutputBlock();
	return markFramedBlockComponent({
		render: (width: number): readonly string[] => {
			const running = options.spinnerFrame !== undefined;
			const header = renderStatusLine(
				{
					icon: running ? "running" : "pending",
					spinnerFrame: options.spinnerFrame,
					title: "ADB",
					description: renderDescription(args) || undefined,
				},
				uiTheme,
			);
			return outputBlock.render(
				{
					header,
					state: running ? "running" : "pending",
					sections: [
						{
							lines: capPreviewLines(
								renderArgumentLines(args).map(line => uiTheme.fg("toolOutput", line)),
								uiTheme,
								{ expanded: options.expanded },
							),
						},
					],
					width,
				},
				uiTheme,
			);
		},
		invalidate: () => outputBlock.invalidate(),
	});
}

export const adbToolRenderer = {
	animatedPendingPreview: true,
	renderCallBeforeExecution: true,
	renderCall(args: AdbRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		return renderAdbCall(decodeAdbRenderArgs(args), options, uiTheme);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: AdbToolDetails; isError?: boolean },
		options: RenderResultOptions & { renderContext?: AdbRenderContext },
		uiTheme: Theme,
		args?: AdbRenderArgs,
	): Component {
		const decodedArgs = args ? decodeAdbRenderArgs(args) : undefined;
		const outputBlock = new CachedOutputBlock();
		const details = result.details;
		const isPartial = options.isPartial === true;
		const isError = result.isError === true;
		return markFramedBlockComponent({
			render: (width: number): readonly string[] => {
				const running = isPartial && options.spinnerFrame !== undefined;
				const header = renderStatusLine(
					{
						icon: running ? "running" : isPartial ? "pending" : isError ? "error" : "success",
						spinnerFrame: options.spinnerFrame,
						title: "ADB",
						description: renderDescription(decodedArgs, details) || undefined,
					},
					uiTheme,
				);
				const rawText = result.content.find(content => content.type === "text")?.text ?? "";
				const output = replaceTabs(stripOutputNotice(rawText, details?.meta).trimEnd());
				const outputLines: string[] = [];
				if (output) {
					if (options.expanded) {
						outputLines.push(...output.split("\n").map(line => uiTheme.fg("toolOutput", line)));
					} else if (options.renderContext?.visualLines) {
						const {
							visualLines,
							skippedCount = 0,
							totalVisualLines = visualLines.length,
						} = options.renderContext;
						if (skippedCount > 0) {
							outputLines.push(
								uiTheme.fg(
									"dim",
									`… (${skippedCount} earlier lines, showing ${visualLines.length} of ${totalVisualLines}) (ctrl+o to expand)`,
								),
							);
						}
						outputLines.push(...visualLines.map(line => uiTheme.fg("toolOutput", replaceTabs(line))));
					} else {
						const rawLines = output.split("\n");
						outputLines.push(...rawLines.slice(0, 8).map(line => uiTheme.fg("toolOutput", line)));
						if (rawLines.length > 8) {
							outputLines.push(uiTheme.fg("dim", `… (${rawLines.length - 8} more lines) (ctrl+o to expand)`));
						}
					}
				}
				if (details?.path && !output.includes(details.path)) {
					outputLines.push(uiTheme.fg("toolOutput", `Screenshot: ${replaceTabs(details.path)}`));
				}
				const warning = formatStyledTruncationWarning(details?.meta, uiTheme);
				if (warning) outputLines.push(warning);
				return outputBlock.render(
					{
						header,
						state: running ? "running" : isPartial ? "pending" : isError ? "error" : "success",
						sections: [
							{
								lines: capPreviewLines(
									renderArgumentLines(decodedArgs, details).map(line => uiTheme.fg("toolOutput", line)),
									uiTheme,
									{ expanded: options.expanded },
								),
							},
							{ label: uiTheme.fg("toolTitle", "Output"), lines: outputLines },
						],
						width,
					},
					uiTheme,
				);
			},
			invalidate: () => outputBlock.invalidate(),
		});
	},
	mergeCallAndResult: true,
	forceFirstResultViewportRepaint: hasStreamedRenderArgs,
	forceResultViewportRepaintOnSettle: true,
};
