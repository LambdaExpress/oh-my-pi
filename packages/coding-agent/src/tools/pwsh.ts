import * as fs from "node:fs";
import type {
	AgentTool,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import { Process } from "@oh-my-pi/pi-natives";
import { getProjectDir, isEnoent } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { hostHasInheritableConsole } from "../eval/py/spawn-options";
import { buildNonInteractiveEnv } from "../exec/non-interactive-env";
import { InternalUrlRouter } from "../internal-urls";
import { highlightCode, type Theme } from "../modes/theme/theme";
import pwshDescription from "../prompts/tools/pwsh.md" with { type: "text" };
import {
	DEFAULT_MAX_BYTES,
	enforceInlineByteCap,
	OutputSink,
	type OutputSummary,
	streamTailUpdates,
	TailBuffer,
} from "../session/streaming-output";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { createShellRenderer } from "./bash";
import { expandInternalUrls, type InternalUrlExpansionOptions } from "./bash-skill-urls";
import {
	type OutputMeta,
	resolveOutputMaxColumns,
	resolveOutputSinkHeadBytes,
	resolveOutputSinkSpillThreshold,
	resolveOutputSinkTailBytes,
} from "./output-meta";
import { resolveToCwd } from "./path-utils";
import { extractPartialJsonString, formatToolWorkingDirectory, replaceTabs } from "./render-utils";
import { ToolAbortError, ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

const PWSH_STREAM_DRAIN_MS = 250;
const PWSH_TERMINATE_WAIT_MS = 500;

const pwshSchema = type({
	script: type("string").describe("PowerShell script to execute"),
	"env?": type({ "[string]": "string" }).describe("extra env vars"),
	"timeout?": type("number").describe("timeout in seconds"),
	"cwd?": type("string").describe("working directory"),
});

export interface PwshToolInput {
	script: string;
	env?: Record<string, string>;
	timeout?: number;
	cwd?: string;
}

export interface PwshToolDetails {
	meta?: OutputMeta;
	timeoutSeconds?: number;
	requestedTimeoutSeconds?: number;
	wallTimeMs?: number;
	exitCode?: number;
}

export interface PwshRenderArgs {
	script?: string;
	__partialJson?: string;
	env?: Record<string, string>;
	timeout?: number;
	cwd?: string;
	[key: string]: unknown;
}

interface PwshRunResult extends OutputSummary {
	exitCode?: number;
}

export function resolvePwshExecutable(): string | null {
	return Bun.which("pwsh") ?? (process.platform === "win32" ? Bun.which("pwsh.exe") : null);
}

export function shouldHidePwshWindow(opts: { platform: NodeJS.Platform; hostHasInheritableConsole: boolean }): boolean {
	if (opts.platform !== "win32") return false;
	return !opts.hostHasInheritableConsole;
}

function quotePwshString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function formatPwshEnvAssignments(env: Record<string, string> | undefined): string {
	if (!env || Object.keys(env).length === 0) return "";
	return Object.entries(env)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, value]) => `$env:${name}=${quotePwshString(value)}`)
		.join("; ");
}

function buildPwshEnvPrologue(env: Record<string, string>): string {
	if (Object.keys(env).length === 0) return "";
	return Object.entries(env)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(
			([name, value]) =>
				`[System.Environment]::SetEnvironmentVariable(${quotePwshString(name)}, ${quotePwshString(value)}, 'Process')`,
		)
		.join("\n");
}

function formatPwshScriptLines(args: PwshRenderArgs | undefined, uiTheme: Theme): string[] {
	const script = replaceTabs(extractPartialJsonString(args?.__partialJson, "script") ?? args?.script ?? "…");
	const displayWorkdir = formatToolWorkingDirectory(args?.cwd, getProjectDir());
	const envAssignments = formatPwshEnvAssignments(args?.env);
	const prefixParts = [uiTheme.symbol("tool.pwsh")];
	if (displayWorkdir) prefixParts.push(`[${displayWorkdir}]`);
	if (envAssignments) prefixParts.push(envAssignments);
	const prefix = uiTheme.fg("dim", `${prefixParts.join(" ")} `);
	const highlightedLines = highlightCode(script, "powershell");
	if (highlightedLines.length === 0) return [prefix.trimEnd()];
	return highlightedLines.map((line, index) => (index === 0 ? `${prefix}${line}` : line));
}

interface PwshStreamPump {
	readonly done: Promise<void>;
	cancel(): Promise<void>;
}

function pumpStream(stream: ReadableStream<Uint8Array> | null, sink: OutputSink): PwshStreamPump {
	if (!stream) {
		const done = Promise.resolve();
		return { done, cancel: () => done };
	}
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const done = (async () => {
		try {
			for (;;) {
				const { done: streamDone, value } = await reader.read();
				if (streamDone) break;
				if (value) sink.push(decoder.decode(value, { stream: true }));
			}
			const rest = decoder.decode();
			if (rest) sink.push(rest);
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

async function drainPwshStreams(pumps: readonly PwshStreamPump[], maxWaitMs: number): Promise<void> {
	const done = Promise.allSettled(pumps.map(pump => pump.done));
	if (maxWaitMs > 0) {
		const timeout = Promise.withResolvers<false>();
		const timer = setTimeout(() => timeout.resolve(false), maxWaitMs);
		try {
			const drained = await Promise.race([done.then(() => true as const), timeout.promise]);
			if (drained) return;
		} finally {
			clearTimeout(timer);
		}
	}
	await Promise.allSettled(pumps.map(pump => pump.cancel()));
}

async function terminatePwshTree(pid: number, fallbackKill: () => void): Promise<void> {
	const processRef = Process.fromPid(pid);
	if (!processRef) {
		fallbackKill();
		return;
	}
	try {
		const terminated = await processRef.terminate({ gracefulMs: -1, timeoutMs: PWSH_TERMINATE_WAIT_MS });
		if (!terminated) fallbackKill();
	} catch {
		fallbackKill();
	}
}

function buildPwshArgs(script: string): string[] {
	const args = ["-NoProfile", "-NonInteractive"];
	if (process.platform === "win32") args.push("-ExecutionPolicy", "Bypass");
	args.push("-Command", script);
	return args;
}

async function savePwshOriginalArtifact(session: ToolSession, originalText: string): Promise<string | undefined> {
	const allocated = await session.allocateOutputArtifact?.("pwsh-original");
	if (!allocated?.path || !allocated.id) return undefined;
	await Bun.write(allocated.path, originalText);
	return allocated.id;
}

export class PwshTool implements AgentTool<typeof pwshSchema, PwshToolDetails> {
	readonly name = "pwsh";
	readonly label = "PowerShell";
	readonly loadMode = "essential";
	readonly approval = "exec" as ToolApprovalDecision;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const rawScript = (args as Partial<PwshToolInput>).script;
		const script = typeof rawScript === "string" ? rawScript : "(missing)";
		return [`Script: ${truncateForPrompt(script)}`];
	};
	readonly description = pwshDescription;
	readonly parameters = pwshSchema;
	readonly concurrency = "shared";
	readonly strict = true;
	readonly #session: ToolSession;
	readonly #pwshPath: string;

	static createIf(session: ToolSession): PwshTool | null {
		const pwshPath = resolvePwshExecutable();
		return pwshPath ? new PwshTool(session, pwshPath) : null;
	}

	constructor(session: ToolSession, pwshPath = resolvePwshExecutable() ?? "pwsh") {
		this.#session = session;
		this.#pwshPath = pwshPath;
	}

	async #buildCompletedResult(
		result: PwshRunResult,
		timeoutSec: number,
		options: { requestedTimeoutSec?: number; wallTimeMs?: number } = {},
	): Promise<AgentToolResult<PwshToolDetails>> {
		const exitCode = result.exitCode;
		const failedExit = exitCode !== undefined && exitCode !== 0;
		const outputLines = [result.output || "(no output)"];
		if (options.wallTimeMs !== undefined)
			outputLines.push("", `Wall time: ${(options.wallTimeMs / 1000).toFixed(2)} seconds`);
		if (failedExit) outputLines.push("", `Command exited with code ${exitCode}`);
		const outputText = outputLines.join("\n");

		const details: PwshToolDetails = { timeoutSeconds: timeoutSec };
		if (options.requestedTimeoutSec !== undefined && options.requestedTimeoutSec !== timeoutSec) {
			details.requestedTimeoutSeconds = options.requestedTimeoutSec;
		}
		if (options.wallTimeMs !== undefined) details.wallTimeMs = options.wallTimeMs;
		if (failedExit) details.exitCode = exitCode;

		const cappedOutputText = await enforceInlineByteCap(outputText, {
			artifactId: result.artifactId,
			saveArtifact: full => savePwshOriginalArtifact(this.#session, full),
		});
		const builder = toolResult(details).text(cappedOutputText).truncationFromSummary(result, { direction: "tail" });
		if (failedExit) builder.error();
		return builder.done();
	}

	async execute(
		_toolCallId: string,
		{ script: rawScript, env: rawEnv, timeout: rawTimeout = 300, cwd }: PwshToolInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<PwshToolDetails>,
	): Promise<AgentToolResult<PwshToolDetails>> {
		if (signal?.aborted) throw new ToolAbortError("PowerShell command aborted");

		const internalUrlOptions: InternalUrlExpansionOptions = {
			skills: this.#session.skills ?? [],
			internalRouter: InternalUrlRouter.instance(),
			localOptions: {
				getArtifactsDir: this.#session.getArtifactsDir,
				getSessionId: this.#session.getSessionId,
			},
		};
		const script = await expandInternalUrls(rawScript, {
			...internalUrlOptions,
			ensureLocalParentDirs: true,
			escapePath: quotePwshString,
		});
		const resolvedEnv = rawEnv
			? Object.fromEntries(
					await Promise.all(
						Object.entries(rawEnv).map(async ([key, value]) => [
							key,
							await expandInternalUrls(value, { ...internalUrlOptions, noEscape: true }),
						]),
					),
				)
			: undefined;

		if (cwd?.includes("://") || cwd?.includes("local:/")) {
			cwd = await expandInternalUrls(cwd, { ...internalUrlOptions, noEscape: true });
		}

		const commandCwd = cwd ? resolveToCwd(cwd, this.#session.cwd) : this.#session.cwd;
		let cwdStat: fs.Stats;
		try {
			cwdStat = await fs.promises.stat(commandCwd);
		} catch (err) {
			if (isEnoent(err)) throw new ToolError(`Working directory does not exist: ${commandCwd}`);
			throw err;
		}
		if (!cwdStat.isDirectory()) throw new ToolError(`Working directory is not a directory: ${commandCwd}`);

		const requestedTimeoutSec = rawTimeout;
		const timeoutSec = clampTimeout("pwsh", requestedTimeoutSec);
		const timeoutMs = timeoutSec * 1000;
		const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES);
		const { path: artifactPath, id: artifactId } = (await this.#session.allocateOutputArtifact?.("pwsh")) ?? {};
		const sink = new OutputSink({
			onChunk: streamTailUpdates(tailBuffer, onUpdate),
			artifactPath,
			artifactId,
			spillThreshold: resolveOutputSinkSpillThreshold(this.#session.settings),
			headBytes: resolveOutputSinkHeadBytes(this.#session.settings),
			tailBytes: resolveOutputSinkTailBytes(this.#session.settings),
			maxColumns: resolveOutputMaxColumns(this.#session.settings),
			chunkThrottleMs: onUpdate ? 50 : 0,
		});

		const abortDeferred = signal ? Promise.withResolvers<"aborted">() : undefined;
		const abortListener = abortDeferred ? () => abortDeferred.resolve("aborted") : undefined;
		if (signal && abortListener) {
			if (signal.aborted) abortListener();
			else signal.addEventListener("abort", abortListener, { once: true });
		}
		const wallTimeStart = performance.now();
		const deadline = wallTimeStart + timeoutMs;
		const commandEnv = buildNonInteractiveEnv(resolvedEnv);
		const commandScript = process.platform === "win32" ? `${buildPwshEnvPrologue(commandEnv)}\n${script}` : script;
		const proc = Bun.spawn([this.#pwshPath, ...buildPwshArgs(commandScript)], {
			cwd: commandCwd,
			...(process.platform === "win32" ? {} : { env: commandEnv }),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: shouldHidePwshWindow({
				platform: process.platform,
				hostHasInheritableConsole: hostHasInheritableConsole(),
			}),
		});
		const processRef = Process.fromPid(proc.pid);
		const rootExited = processRef ? processRef.waitForExit().then(() => proc.exitCode ?? 0) : proc.exited;
		const pumps = [pumpStream(proc.stdout, sink), pumpStream(proc.stderr, sink)];
		const timeoutDeferred = Promise.withResolvers<"timeout">();
		const timeoutTimer = setTimeout(
			() => timeoutDeferred.resolve("timeout"),
			Math.max(0, deadline - performance.now()),
		);

		try {
			const racers: Array<Promise<{ kind: "exit"; exitCode: number } | { kind: "timeout" } | { kind: "aborted" }>> =
				[
					rootExited.then(exitCode => ({ kind: "exit" as const, exitCode })),
					timeoutDeferred.promise.then(() => ({ kind: "timeout" as const })),
				];
			if (abortDeferred) racers.push(abortDeferred.promise.then(() => ({ kind: "aborted" as const })));
			const raced = await Promise.race(racers);

			if (raced.kind !== "exit") {
				await terminatePwshTree(proc.pid, () => proc.kill("SIGKILL"));
				await drainPwshStreams(pumps, PWSH_STREAM_DRAIN_MS);
				const summary = await sink.dump();
				const output = summary.output.trimEnd();
				if (raced.kind === "aborted") {
					throw new ToolAbortError(
						output ? `${output}\n\n[PowerShell command aborted]` : "PowerShell command aborted",
					);
				}
				throw new ToolError(
					output
						? `${output}\n\n[PowerShell timed out after ${timeoutSec} seconds]`
						: `PowerShell timed out after ${timeoutSec} seconds`,
				);
			}

			const drainMs = Math.max(0, Math.min(PWSH_STREAM_DRAIN_MS, deadline - performance.now()));
			await drainPwshStreams(pumps, drainMs);
			const summary = await sink.dump();
			return this.#buildCompletedResult({ ...summary, exitCode: raced.exitCode }, timeoutSec, {
				requestedTimeoutSec,
				wallTimeMs: performance.now() - wallTimeStart,
			});
		} finally {
			clearTimeout(timeoutTimer);
			if (signal && abortListener) signal.removeEventListener("abort", abortListener);
		}
	}
}

export const pwshToolRenderer = createShellRenderer<PwshRenderArgs>({
	resolveTitle: () => "PowerShell",
	resolveCommand: args => args?.script,
	resolveCwd: args => args?.cwd,
	resolveEnv: args => args?.env,
	formatCommandLines: formatPwshScriptLines,
	successIcon: "tool.pwsh",
	showHeader: false,
});
