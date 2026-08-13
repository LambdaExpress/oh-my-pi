import * as path from "node:path";
import * as timers from "node:timers/promises";
import { logger, ptree, untilAborted } from "@oh-my-pi/pi-utils";
import { NON_INTERACTIVE_ENV } from "../exec/non-interactive-env";
import { DapClient, DapRequestRejectedError } from "./client";
import type {
	DapAttachArguments,
	DapAttachSessionOptions,
	DapBreakpoint,
	DapBreakpointRecord,
	DapCapabilities,
	DapContinueArguments,
	DapDataBreakpoint,
	DapDataBreakpointInfoArguments,
	DapDataBreakpointInfoResponse,
	DapDataBreakpointRecord,
	DapDisassembleArguments,
	DapDisassembledInstruction,
	DapDisassembleResponse,
	DapEvaluateArguments,
	DapEvaluateResponse,
	DapExecutionOutcome,
	DapExecutionStart,
	DapExitedEventBody,
	DapFunctionBreakpoint,
	DapFunctionBreakpointRecord,
	DapInitializeArguments,
	DapInstructionBreakpoint,
	DapInstructionBreakpointRecord,
	DapLaunchArguments,
	DapLaunchSessionOptions,
	DapLoadedSourcesResponse,
	DapModule,
	DapModulesArguments,
	DapModulesResponse,
	DapOutputEventBody,
	DapOutputSegment,
	DapPauseArguments,
	DapReadMemoryArguments,
	DapReadMemoryResponse,
	DapResolvedAdapter,
	DapRunInTerminalArguments,
	DapRunInTerminalResponse,
	DapScope,
	DapScopesArguments,
	DapScopesResponse,
	DapSessionStatus,
	DapSessionSummary,
	DapSetDataBreakpointsArguments,
	DapSetInstructionBreakpointsArguments,
	DapSource,
	DapSourceBreakpoint,
	DapStackFrame,
	DapStackTraceArguments,
	DapStackTraceResponse,
	DapStartDebuggingArguments,
	DapStepArguments,
	DapStopCaptureError,
	DapStopLocation,
	DapStoppedEventBody,
	DapStopSnapshot,
	DapThread,
	DapThreadsResponse,
	DapVariablesArguments,
	DapVariablesResponse,
	DapWaitForExecutionOutcome,
	DapWriteMemoryArguments,
	DapWriteMemoryResponse,
} from "./types";

interface DapBufferedOutputChunk extends DapOutputSegment {
	startByte: number;
	endByte: number;
}

interface DapSession {
	id: string;
	adapter: DapResolvedAdapter;
	cwd: string;
	program?: string;
	client: DapClient;
	status: DapSessionStatus;
	launchedAt: number;
	lastUsedAt: number;
	breakpoints: Map<string, DapBreakpointRecord[]>;
	functionBreakpoints: DapFunctionBreakpointRecord[];
	instructionBreakpoints: DapInstructionBreakpoint[];
	dataBreakpoints: DapDataBreakpoint[];
	/** Serializes breakpoint mutations — see #serializeBreakpointMutation. */
	breakpointMutationQueue: Promise<void>;
	/** Recent categorized output chunks; trimmed from the front when over MAX_OUTPUT_BYTES. */
	outputChunks: DapBufferedOutputChunk[];
	/** Cumulative bytes of output ever received (reported in summaries). */
	outputBytes: number;
	/** Bytes currently buffered in outputChunks. */
	outputBufferedBytes: number;
	outputTruncated: boolean;
	/** Byte offset where the current execution generation began. */
	outputGenerationStartBytes: number;
	outputListeners: Set<() => void>;
	stop: DapStopLocation;
	threads: DapThread[];
	lastStackFrames: DapStackFrame[];
	stopGeneration: number;
	lastStoppedEvent?: DapStoppedEventBody;
	stopOutputTail: string;
	stopOutputSegments: DapOutputSegment[];
	stopOutputTruncated: boolean;
	stopOutputBytes: number;
	exitCode?: number;
	capabilities?: DapCapabilities;
	initializedSeen: boolean;
	needsConfigurationDone: boolean;
	configurationDoneSent: boolean;
	parentSessionId?: string;
	childSessionIds: Set<string>;
	port?: number;
}

interface DapStopCaptureContext {
	sessionId: string;
	stopGeneration: number;
	stoppedEvent: DapStoppedEventBody;
	output: string;
	outputSegments: DapOutputSegment[];
	outputTruncated: boolean;
	outputBytesAtStop: number;
	summaryAtStop: DapSessionSummary;
}

interface DapExecutionRollback {
	status: DapSessionStatus;
	stop: DapStopLocation;
	lastStackFrames: DapStackFrame[];
}

interface DapExecutionRecord {
	executionId: string;
	exposed: boolean;
	rootSessionId: string;
	targetSessionId: string;
	startedAt: number;
	startSnapshot: DapSessionSummary;
	promise: Promise<DapExecutionOutcome>;
	resolve: (outcome: DapExecutionOutcome) => void;
	rollback?: DapExecutionRollback;
	previousOutputGenerationStarts: Map<string, number>;
	outcome?: DapExecutionOutcome;
	stopContext?: DapStopCaptureContext;
	capturePromise?: Promise<DapStopSnapshot>;
}

export interface DapOutputSnapshot {
	snapshot: DapSessionSummary;
	output: string;
	outputSegments: DapOutputSegment[];
	outputTruncated: boolean;
	startByte: number;
	endByte: number;
}

export interface DapOutputWaitResult extends DapOutputSnapshot {
	matched: boolean;
	timedOut: boolean;
}

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 30 * 1000;
const HEARTBEAT_INTERVAL_MS = 5 * 1000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const STOP_CAPTURE_TIMEOUT_MS = 5_000;
const STOP_OUTPUT_LIMIT_BYTES = 16 * 1024;
const STOP_THREAD_LIMIT = 50;
const STOP_STACK_FRAME_LIMIT = 20;
const STOP_SCOPE_LIMIT = 4;
const STOP_VARIABLE_LIMIT = 50;
const STOP_VARIABLE_VALUE_LIMIT = 2_000;
// UV_PROCESS_DETACHED can open a Windows Terminal window; native tree cleanup works without it.
const DETACH_DAP_DEBUGGEE = process.platform !== "win32";

function toErrorMessage(value: unknown): string {
	if (value instanceof Error) return value.message;
	return String(value);
}

interface DapStartRequestFailure {
	rejected: boolean;
	error?: unknown;
	/**
	 * Resolves (never rejects) when the underlying launch/attach request
	 * settles either way. Set by {@link trackDapStartRequest} on each call,
	 * so a single failure object must not be reused across launch attempts.
	 * Consumed by {@link throwPreferredDapStartError} to bound how long to
	 * wait for a delayed adapter-side rejection before falling back to the
	 * cascade error from configurationDone.
	 */
	settled?: Promise<void>;
}

function trackDapStartRequest<T>(promise: Promise<T>, failure: DapStartRequestFailure): Promise<T> {
	const tracked = promise.catch(error => {
		failure.rejected = true;
		failure.error = error;
		throw error;
	});
	failure.settled = tracked.then(
		() => {},
		() => {},
	);
	return tracked;
}

function combineDapStartErrors(command: "launch" | "attach", startError: unknown, configurationError: unknown): Error {
	const startMessage = toErrorMessage(startError);
	const configurationMessage = toErrorMessage(configurationError);
	if (startMessage === configurationMessage) {
		return startError instanceof Error ? startError : new Error(startMessage);
	}
	return new Error(
		`DAP ${command} failed: ${startMessage}\nDAP configurationDone also failed: ${configurationMessage}`,
	);
}

async function throwPreferredDapStartError(
	command: "launch" | "attach",
	startFailure: DapStartRequestFailure,
	configurationError: unknown,
): Promise<never> {
	await Promise.race([startFailure.settled ?? Promise.resolve(), timers.setTimeout(50)]);
	if (startFailure.rejected) {
		throw combineDapStartErrors(command, startFailure.error, configurationError);
	}
	throw configurationError;
}

const DEBUGPY_MISSING_MODULE_RE = /No module named ['"]?debugpy['"]?/;

/**
 * Map a generic adapter-side failure into the targeted `pip install debugpy`
 * hint when the adapter is debugpy and stderr/the wrapping error mentions
 * the missing module. Returns null when the heuristic does not apply, so the
 * caller can rethrow the original error untouched.
 */
function mapDebugpyMissingModule(adapterName: string, error: unknown): Error | null {
	if (adapterName !== "debugpy") return null;
	if (!DEBUGPY_MISSING_MODULE_RE.test(toErrorMessage(error))) return null;
	return new Error("adapter 'debugpy' is not available: install with 'pip install debugpy'");
}

function normalizePath(filePath: string): string {
	return path.resolve(filePath);
}

function truncateOutput(session: DapSession, event: DapOutputEventBody): void {
	if (!event.output) return;
	const bytes = Buffer.byteLength(event.output, "utf-8");
	const startByte = session.outputBytes;
	session.outputChunks.push({
		category: event.category ?? "console",
		output: event.output,
		startByte,
		endByte: startByte + bytes,
	});
	session.outputBytes += bytes;
	session.outputBufferedBytes += bytes;
	while (session.outputChunks.length > 1) {
		const front = session.outputChunks[0];
		const frontBytes = front.endByte - front.startByte;
		if (session.outputBufferedBytes - frontBytes < MAX_OUTPUT_BYTES) break;
		session.outputChunks.shift();
		session.outputBufferedBytes -= frontBytes;
		session.outputTruncated = true;
	}
	if (session.outputBufferedBytes > MAX_OUTPUT_BYTES) {
		const front = session.outputChunks[0];
		const frontBytes = front.endByte - front.startByte;
		const excess = session.outputBufferedBytes - MAX_OUTPUT_BYTES;
		const kept = Buffer.from(front.output, "utf-8").subarray(excess).toString("utf-8");
		const keptBytes = Buffer.byteLength(kept, "utf-8");
		session.outputChunks[0] = {
			...front,
			output: kept,
			startByte: front.endByte - keptBytes,
		};
		session.outputBufferedBytes += keptBytes - frontBytes;
		session.outputTruncated = true;
	}
	for (const listener of session.outputListeners) listener();
}

function captureOutput(
	session: DapSession,
	sinceBytes: number,
	limitBytes?: number,
): { output: string; outputSegments: DapOutputSegment[]; truncated: boolean } {
	const requestedStart = Math.min(Math.max(0, sinceBytes), session.outputBytes);
	const earliestBufferedByte = session.outputChunks[0]?.startByte ?? session.outputBytes;
	let truncated = requestedStart < earliestBufferedByte;
	const segments: DapOutputSegment[] = [];
	for (const chunk of session.outputChunks) {
		if (chunk.endByte <= requestedStart) continue;
		const skipBytes = Math.max(0, requestedStart - chunk.startByte);
		const output =
			skipBytes === 0 ? chunk.output : Buffer.from(chunk.output, "utf-8").subarray(skipBytes).toString("utf-8");
		if (output) segments.push({ category: chunk.category, output });
	}
	let keptSegments = segments;
	if (limitBytes !== undefined && limitBytes > 0) {
		let totalBytes = 0;
		for (const segment of segments) totalBytes += Buffer.byteLength(segment.output, "utf-8");
		if (totalBytes > limitBytes) {
			truncated = true;
			let discardBytes = totalBytes - limitBytes;
			let firstKept = 0;
			while (firstKept < segments.length) {
				const segment = segments[firstKept];
				const segmentBytes = Buffer.byteLength(segment.output, "utf-8");
				if (segmentBytes > discardBytes) {
					keptSegments = [
						{
							category: segment.category,
							output: Buffer.from(segment.output, "utf-8").subarray(discardBytes).toString("utf-8"),
						},
						...segments.slice(firstKept + 1),
					];
					break;
				}
				discardBytes -= segmentBytes;
				firstKept += 1;
			}
		}
	}
	return {
		output: keptSegments.map(segment => segment.output).join(""),
		outputSegments: keptSegments,
		truncated,
	};
}

/**
 * Drain a `runInTerminal` debuggee's stdout into the session output buffer.
 *
 * `ptree.spawn` always pipes stdout and only eagerly drains stderr; the exposed
 * stdout stream must be consumed or Bun buffers it unboundedly in this process
 * (a chatty debuggee grows omp toward OOM). The reverse-request path has no
 * terminal surface here, so route the child's stdout through {@link
 * truncateOutput}: this bounds memory at `MAX_OUTPUT_BYTES` and surfaces the
 * program's output to the agent, mirroring the adapter's own `output` events.
 * Runs in the background for the child's lifetime; a killed child or closed pipe
 * ends the loop quietly.
 */
async function drainTerminalStdout(stream: ReadableStream<Uint8Array>, session: DapSession): Promise<void> {
	const decoder = new TextDecoder();
	try {
		for await (const chunk of stream) {
			truncateOutput(session, decoder.decode(chunk, { stream: true }));
		}
		truncateOutput(session, decoder.decode());
	} catch {
		// Child killed or pipe closed mid-stream; nothing more to surface.
	}
}

function summarizeBreakpointCount(breakpoints: Map<string, DapBreakpointRecord[]>): number {
	let total = 0;
	for (const entries of breakpoints.values()) {
		total += entries.length;
	}
	return total;
}

function buildSummary(session: DapSession): DapSessionSummary {
	return {
		id: session.id,
		adapter: session.adapter.name,
		cwd: session.cwd,
		program: session.program,
		status: session.status,
		launchedAt: new Date(session.launchedAt).toISOString(),
		lastUsedAt: new Date(session.lastUsedAt).toISOString(),
		threadId: session.stop.threadId,
		frameId: session.stop.frameId,
		stopReason: session.stop.reason,
		stopDescription: session.stop.description ?? session.stop.text,
		frameName: session.stop.frameName,
		instructionPointerReference: session.stop.instructionPointerReference,
		source: session.stop.source,
		line: session.stop.line,
		column: session.stop.column,
		breakpointFiles: session.breakpoints.size,
		breakpointCount: summarizeBreakpointCount(session.breakpoints),
		functionBreakpointCount: session.functionBreakpoints.length,
		outputBytes: session.outputBytes,
		outputTruncated: session.outputTruncated,
		exitCode: session.exitCode,
		needsConfigurationDone: session.needsConfigurationDone && !session.configurationDoneSent,
		parentSessionId: session.parentSessionId,
		childSessionIds: session.childSessionIds.size > 0 ? [...session.childSessionIds] : undefined,
	};
}

export class DapSessionManager {
	#sessions = new Map<string, DapSession>();
	#activeSessionId: string | null = null;
	#cleanupLoopPromise?: Promise<void>;
	#nextId = 0;
	#nextExecutionId = 0;
	#activeExecutionByRoot = new Map<string, DapExecutionRecord>();
	#executions = new Map<string, DapExecutionRecord>();

	constructor() {
		this.#startCleanupTimer();
	}

	getActiveSession(): DapSessionSummary | null {
		const session = this.#getActiveSessionOrNull();
		return session ? buildSummary(session) : null;
	}

	listSessions(): DapSessionSummary[] {
		return Array.from(this.#sessions.values()).map(buildSummary);
	}

	getCapabilities(): DapCapabilities | null {
		return this.#getActiveSessionOrNull()?.capabilities ?? null;
	}

	async launch(
		options: DapLaunchSessionOptions,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<DapSessionSummary> {
		await this.#ensureLaunchSlot();
		const client = await DapClient.spawn({ adapter: options.adapter, cwd: options.cwd });
		const session = this.#registerSession(client, options.adapter, options.cwd, options.program);
		const initialExecution = this.#beginStartupExecution(session);
		try {
			session.capabilities = await client.initialize(
				this.#buildInitializeArguments(options.adapter),
				signal,
				timeoutMs,
			);
			session.needsConfigurationDone = session.capabilities.supportsConfigurationDoneRequest === true;
			const launchArguments: DapLaunchArguments = {
				...options.adapter.launchDefaults,
				...(options.extraLaunchArguments ?? {}),
				program: options.program,
				cwd: options.cwd,
				...(options.args !== undefined ? { args: options.args } : {}),
			};
			// Establish the startup record before launching so entry stops are
			// latched even when they arrive before the launch response.
			// DAP spec: many adapters do not respond to launch until after
			// configurationDone. Fire launch, complete the config handshake,
			// then await the launch response.
			const launchFailure: DapStartRequestFailure = { rejected: false };
			const launchPromise = trackDapStartRequest(
				client.sendRequest("launch", launchArguments, signal, timeoutMs),
				launchFailure,
			);
			// Mark handled so a fast error response doesn't become an unhandled
			// rejection while we await the config handshake. The actual error
			// still propagates when we await launchPromise below.
			launchPromise.catch(() => {});
			try {
				await this.#completeConfigurationHandshake(session, signal, timeoutMs);
			} catch (error) {
				await throwPreferredDapStartError("launch", launchFailure, error);
			}
			await launchPromise;
			// Try to capture initial stopped state (e.g. stopOnEntry).
			// Timeout is acceptable — the program may simply be running.
			let resultSession = session;
			try {
				const initialOutcome = await this.#waitForRecordOutcome(
					initialExecution,
					signal,
					Math.min(timeoutMs, STOP_CAPTURE_TIMEOUT_MS),
				);
				const stoppedSession =
					initialOutcome?.reason === "stopped" ? this.#sessions.get(initialOutcome.sourceSessionId) : undefined;
				const active = this.#getActiveSessionOrNull();
				resultSession =
					stoppedSession ?? (active && this.#getRootSession(active).id === session.id ? active : session);
				if (resultSession.status === "stopped") {
					await this.#fetchTopFrame(resultSession, signal, Math.min(timeoutMs, STOP_CAPTURE_TIMEOUT_MS));
				}
			} catch {
				if (session.initializedSeen && session.status === "launching") {
					session.status = session.configurationDoneSent ? "running" : "configuring";
				}
			}
			this.#removeExecutionRecord(initialExecution);
			return buildSummary(resultSession);
		} catch (error) {
			this.#removeExecutionRecord(initialExecution);
			await this.#disposeSession(session);
			const mapped = mapDebugpyMissingModule(options.adapter.name, error);
			if (mapped) throw mapped;
			throw error;
		}
	}

	async attach(
		options: DapAttachSessionOptions,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<DapSessionSummary> {
		await this.#ensureLaunchSlot();
		const client = await DapClient.spawn({ adapter: options.adapter, cwd: options.cwd });
		const session = this.#registerSession(client, options.adapter, options.cwd);
		const initialExecution = this.#beginStartupExecution(session);
		try {
			session.capabilities = await client.initialize(
				this.#buildInitializeArguments(options.adapter),
				signal,
				timeoutMs,
			);
			session.needsConfigurationDone = session.capabilities.supportsConfigurationDoneRequest === true;
			const attachArguments: DapAttachArguments = {
				...options.adapter.attachDefaults,
				cwd: options.cwd,
				...(options.pid !== undefined ? { pid: options.pid, processId: options.pid } : {}),
				...(options.port !== undefined ? { port: options.port } : {}),
				...(options.host ? { host: options.host } : {}),
			};
			// See launch(): the startup record makes entry-stop delivery late-readable.
			const attachFailure: DapStartRequestFailure = { rejected: false };
			const attachPromise = trackDapStartRequest(
				client.sendRequest("attach", attachArguments, signal, timeoutMs),
				attachFailure,
			);
			attachPromise.catch(() => {});
			try {
				await this.#completeConfigurationHandshake(session, signal, timeoutMs);
			} catch (error) {
				await throwPreferredDapStartError("attach", attachFailure, error);
			}
			await attachPromise;
			let resultSession = session;
			try {
				const initialOutcome = await this.#waitForRecordOutcome(
					initialExecution,
					signal,
					Math.min(timeoutMs, STOP_CAPTURE_TIMEOUT_MS),
				);
				const stoppedSession =
					initialOutcome?.reason === "stopped" ? this.#sessions.get(initialOutcome.sourceSessionId) : undefined;
				const active = this.#getActiveSessionOrNull();
				resultSession =
					stoppedSession ?? (active && this.#getRootSession(active).id === session.id ? active : session);
				if (resultSession.status === "stopped") {
					await this.#fetchTopFrame(resultSession, signal, Math.min(timeoutMs, STOP_CAPTURE_TIMEOUT_MS));
				}
			} catch {
				if (session.initializedSeen && session.status === "launching") {
					session.status = session.configurationDoneSent ? "running" : "configuring";
				}
			}
			this.#removeExecutionRecord(initialExecution);
			return buildSummary(resultSession);
		} catch (error) {
			this.#removeExecutionRecord(initialExecution);
			await this.#disposeSession(session);
			const mapped = mapDebugpyMissingModule(options.adapter.name, error);
			if (mapped) throw mapped;
			throw error;
		}
	}

	/**
	 * Serialize breakpoint mutations per session: every mutator does a
	 * read-modify-write of session state around an await, and the adapter-side
	 * set*Breakpoints request replaces the whole list — concurrent mutations
	 * would silently drop each other's breakpoints on both sides.
	 */
	#serializeBreakpointMutation<T>(session: DapSession, mutate: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const run = session.breakpointMutationQueue.then(() => {
			// A mutation can sit behind several queued 30s predecessors; honor a
			// caller abort at dequeue instead of running a request nobody awaits.
			if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
			return mutate();
		});
		session.breakpointMutationQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}
	async #syncBreakpointTree(
		origin: DapSession,
		command: string,
		args: unknown,
		prepare: (session: DapSession) => void,
		apply: (session: DapSession, breakpoints: DapBreakpoint[] | undefined) => void,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<void> {
		const sessions = this.#getTreeSessions(origin).filter(
			session => session.status !== "terminated" && session.client.isAlive(),
		);
		for (const session of sessions) prepare(session);
		await this.#serializeBreakpointMutation(
			origin,
			async () => {
				const response = await this.#sendRequestWithConfig<{ breakpoints?: DapBreakpoint[] }>(
					origin,
					command,
					args,
					signal,
					timeoutMs,
				);
				apply(origin, response?.breakpoints);
			},
			signal,
		);
		await Promise.all(
			sessions
				.filter(session => session !== origin)
				.map(async session => {
					try {
						await this.#serializeBreakpointMutation(
							session,
							async () => {
								const response = await this.#sendRequestWithConfig<{ breakpoints?: DapBreakpoint[] }>(
									session,
									command,
									args,
									signal,
									timeoutMs,
								);
								apply(session, response?.breakpoints);
							},
							signal,
						);
					} catch (error) {
						logger.warn("Failed to synchronize breakpoint request with child debug session", {
							sessionId: session.id,
							command,
							error: toErrorMessage(error),
						});
					}
				}),
		);
	}

	async setBreakpoint(
		file: string,
		line: number,
		condition?: string,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	) {
		const session = this.#touchActiveSession();
		const sourcePath = normalizePath(file);
		const root = this.#getRootSession(session);
		const current = [...(root.breakpoints.get(sourcePath) ?? [])].filter(entry => entry.line !== line);
		current.push({ verified: false, line, condition });
		current.sort((left, right) => left.line - right.line);
		const args = {
			source: { path: sourcePath, name: path.basename(sourcePath) },
			breakpoints: current.map<DapSourceBreakpoint>(entry => ({
				line: entry.line,
				...(entry.condition ? { condition: entry.condition } : {}),
			})),
		};
		await this.#syncBreakpointTree(
			session,
			"setBreakpoints",
			args,
			target =>
				target.breakpoints.set(
					sourcePath,
					current.map(entry => ({ ...entry, verified: false })),
				),
			(target, response) => target.breakpoints.set(sourcePath, this.#mapSourceBreakpoints(current, response)),
			signal,
			timeoutMs,
		);
		return {
			snapshot: buildSummary(session),
			breakpoints: session.breakpoints.get(sourcePath) ?? [],
			sourcePath,
		};
	}

	async removeBreakpoint(file: string, line: number, signal?: AbortSignal, timeoutMs: number = 30_000) {
		const session = this.#touchActiveSession();
		const sourcePath = normalizePath(file);
		const root = this.#getRootSession(session);
		const current = [...(root.breakpoints.get(sourcePath) ?? [])].filter(entry => entry.line !== line);
		const args = {
			source: { path: sourcePath, name: path.basename(sourcePath) },
			breakpoints: current.map<DapSourceBreakpoint>(entry => ({
				line: entry.line,
				...(entry.condition ? { condition: entry.condition } : {}),
			})),
		};
		const prepare = (target: DapSession) => {
			if (current.length === 0) target.breakpoints.delete(sourcePath);
			else
				target.breakpoints.set(
					sourcePath,
					current.map(entry => ({ ...entry, verified: false })),
				);
		};
		await this.#syncBreakpointTree(
			session,
			"setBreakpoints",
			args,
			prepare,
			(target, response) => {
				if (current.length === 0) target.breakpoints.delete(sourcePath);
				else target.breakpoints.set(sourcePath, this.#mapSourceBreakpoints(current, response));
			},
			signal,
			timeoutMs,
		);
		return {
			snapshot: buildSummary(session),
			breakpoints: session.breakpoints.get(sourcePath) ?? [],
			sourcePath,
		};
	}

	async setFunctionBreakpoint(name: string, condition?: string, signal?: AbortSignal, timeoutMs: number = 30_000) {
		const session = this.#touchActiveSession();
		const current = this.#getRootSession(session).functionBreakpoints.filter(entry => entry.name !== name);
		current.push({ verified: false, name, condition });
		current.sort((left, right) => left.name.localeCompare(right.name));
		const args = {
			breakpoints: current.map<DapFunctionBreakpoint>(entry => ({
				name: entry.name,
				...(entry.condition ? { condition: entry.condition } : {}),
			})),
		};
		await this.#syncBreakpointTree(
			session,
			"setFunctionBreakpoints",
			args,
			target => {
				target.functionBreakpoints = current.map(entry => ({ ...entry, verified: false }));
			},
			(target, response) => {
				target.functionBreakpoints = this.#mapFunctionBreakpoints(current, response);
			},
			signal,
			timeoutMs,
		);
		return { snapshot: buildSummary(session), breakpoints: session.functionBreakpoints };
	}

	async removeFunctionBreakpoint(name: string, signal?: AbortSignal, timeoutMs: number = 30_000) {
		const session = this.#touchActiveSession();
		const current = this.#getRootSession(session).functionBreakpoints.filter(entry => entry.name !== name);
		const args = {
			breakpoints: current.map<DapFunctionBreakpoint>(entry => ({
				name: entry.name,
				...(entry.condition ? { condition: entry.condition } : {}),
			})),
		};
		await this.#syncBreakpointTree(
			session,
			"setFunctionBreakpoints",
			args,
			target => {
				target.functionBreakpoints = current.map(entry => ({ ...entry, verified: false }));
			},
			(target, response) => {
				target.functionBreakpoints = this.#mapFunctionBreakpoints(current, response);
			},
			signal,
			timeoutMs,
		);
		return { snapshot: buildSummary(session), breakpoints: session.functionBreakpoints };
	}

	async setInstructionBreakpoint(
		instructionReference: string,
		offset?: number,
		condition?: string,
		hitCondition?: string,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	) {
		const session = this.#touchActiveSession();
		const current = this.#getRootSession(session).instructionBreakpoints.filter(
			entry => entry.instructionReference !== instructionReference || entry.offset !== offset,
		);
		current.push({ instructionReference, offset, condition, hitCondition });
		current.sort((left, right) => {
			const referenceOrder = left.instructionReference.localeCompare(right.instructionReference);
			return referenceOrder !== 0 ? referenceOrder : (left.offset ?? 0) - (right.offset ?? 0);
		});
		const args = { breakpoints: current } satisfies DapSetInstructionBreakpointsArguments;
		let responseBreakpoints: DapBreakpoint[] | undefined;
		await this.#syncBreakpointTree(
			session,
			"setInstructionBreakpoints",
			args,
			target => {
				target.instructionBreakpoints = current.map(entry => ({ ...entry }));
			},
			(target, response) => {
				if (target === session) responseBreakpoints = response;
			},
			signal,
			timeoutMs,
		);
		return {
			snapshot: buildSummary(session),
			breakpoints: this.#mapInstructionBreakpoints(current, responseBreakpoints),
		};
	}

	async removeInstructionBreakpoint(
		instructionReference: string,
		offset?: number,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	) {
		const session = this.#touchActiveSession();
		const current = this.#getRootSession(session).instructionBreakpoints.filter(entry => {
			if (entry.instructionReference !== instructionReference) return true;
			return offset !== undefined && entry.offset !== offset;
		});
		const args = { breakpoints: current } satisfies DapSetInstructionBreakpointsArguments;
		let responseBreakpoints: DapBreakpoint[] | undefined;
		await this.#syncBreakpointTree(
			session,
			"setInstructionBreakpoints",
			args,
			target => {
				target.instructionBreakpoints = current.map(entry => ({ ...entry }));
			},
			(target, response) => {
				if (target === session) responseBreakpoints = response;
			},
			signal,
			timeoutMs,
		);
		return {
			snapshot: buildSummary(session),
			breakpoints: this.#mapInstructionBreakpoints(current, responseBreakpoints),
		};
	}

	async dataBreakpointInfo(
		name: string,
		variablesReference?: number,
		frameId?: number,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<{ snapshot: DapSessionSummary; info: DapDataBreakpointInfoResponse }> {
		const session = this.#touchActiveSession();
		const info = await this.#sendRequestWithConfig<DapDataBreakpointInfoResponse>(
			session,
			"dataBreakpointInfo",
			{
				name,
				...(variablesReference !== undefined ? { variablesReference } : {}),
				...(frameId !== undefined ? { frameId } : {}),
			} satisfies DapDataBreakpointInfoArguments,
			signal,
			timeoutMs,
		);
		return { snapshot: buildSummary(session), info };
	}

	async setDataBreakpoint(
		dataId: string,
		accessType?: "read" | "write" | "readWrite",
		condition?: string,
		hitCondition?: string,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	) {
		const session = this.#touchActiveSession();
		const current = this.#getRootSession(session).dataBreakpoints.filter(entry => entry.dataId !== dataId);
		current.push({ dataId, accessType, condition, hitCondition });
		current.sort((left, right) => left.dataId.localeCompare(right.dataId));
		const args = { breakpoints: current } satisfies DapSetDataBreakpointsArguments;
		let responseBreakpoints: DapBreakpoint[] | undefined;
		await this.#syncBreakpointTree(
			session,
			"setDataBreakpoints",
			args,
			target => {
				target.dataBreakpoints = current.map(entry => ({ ...entry }));
			},
			(target, response) => {
				if (target === session) responseBreakpoints = response;
			},
			signal,
			timeoutMs,
		);
		return {
			snapshot: buildSummary(session),
			breakpoints: this.#mapDataBreakpoints(current, responseBreakpoints),
		};
	}

	async removeDataBreakpoint(dataId: string, signal?: AbortSignal, timeoutMs: number = 30_000) {
		const session = this.#touchActiveSession();
		const current = this.#getRootSession(session).dataBreakpoints.filter(entry => entry.dataId !== dataId);
		const args = { breakpoints: current } satisfies DapSetDataBreakpointsArguments;
		let responseBreakpoints: DapBreakpoint[] | undefined;
		await this.#syncBreakpointTree(
			session,
			"setDataBreakpoints",
			args,
			target => {
				target.dataBreakpoints = current.map(entry => ({ ...entry }));
			},
			(target, response) => {
				if (target === session) responseBreakpoints = response;
			},
			signal,
			timeoutMs,
		);
		return {
			snapshot: buildSummary(session),
			breakpoints: this.#mapDataBreakpoints(current, responseBreakpoints),
		};
	}

	async disassemble(
		memoryReference: string,
		instructionCount: number,
		offset?: number,
		instructionOffset?: number,
		resolveSymbols?: boolean,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<{ snapshot: DapSessionSummary; instructions: DapDisassembledInstruction[] }> {
		const session = this.#touchActiveSession();
		const response = await this.#sendRequestWithConfig<DapDisassembleResponse>(
			session,
			"disassemble",
			{
				memoryReference,
				instructionCount,
				...(offset !== undefined ? { offset } : {}),
				...(instructionOffset !== undefined ? { instructionOffset } : {}),
				...(resolveSymbols !== undefined ? { resolveSymbols } : {}),
			} satisfies DapDisassembleArguments,
			signal,
			timeoutMs,
		);
		return { snapshot: buildSummary(session), instructions: response?.instructions ?? [] };
	}

	async readMemory(
		memoryReference: string,
		count: number,
		offset?: number,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<{ snapshot: DapSessionSummary; address: string; data?: string; unreadableBytes?: number }> {
		const session = this.#touchActiveSession();
		const response = await this.#sendRequestWithConfig<DapReadMemoryResponse>(
			session,
			"readMemory",
			{
				memoryReference,
				count,
				...(offset !== undefined ? { offset } : {}),
			} satisfies DapReadMemoryArguments,
			signal,
			timeoutMs,
		);
		return {
			snapshot: buildSummary(session),
			address: response?.address ?? memoryReference,
			data: response?.data,
			unreadableBytes: response?.unreadableBytes,
		};
	}

	async writeMemory(
		memoryReference: string,
		data: string,
		offset?: number,
		allowPartial?: boolean,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<{ snapshot: DapSessionSummary; offset?: number; bytesWritten?: number }> {
		const session = this.#touchActiveSession();
		const response = await this.#sendRequestWithConfig<DapWriteMemoryResponse>(
			session,
			"writeMemory",
			{
				memoryReference,
				data,
				...(offset !== undefined ? { offset } : {}),
				...(allowPartial !== undefined ? { allowPartial } : {}),
			} satisfies DapWriteMemoryArguments,
			signal,
			timeoutMs,
		);
		return {
			snapshot: buildSummary(session),
			offset: response?.offset,
			bytesWritten: response?.bytesWritten,
		};
	}

	async modules(
		startModule?: number,
		moduleCount?: number,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<{ snapshot: DapSessionSummary; modules: DapModule[] }> {
		const session = this.#touchActiveSession();
		const response = await this.#sendRequestWithConfig<DapModulesResponse>(
			session,
			"modules",
			{
				...(startModule !== undefined ? { startModule } : {}),
				...(moduleCount !== undefined ? { moduleCount } : {}),
			} satisfies DapModulesArguments,
			signal,
			timeoutMs,
		);
		return { snapshot: buildSummary(session), modules: response?.modules ?? [] };
	}

	async loadedSources(
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<{ snapshot: DapSessionSummary; sources: DapSource[] }> {
		const session = this.#touchActiveSession();
		const response = await this.#sendRequestWithConfig<DapLoadedSourcesResponse>(
			session,
			"loadedSources",
			{},
			signal,
			timeoutMs,
		);
		return { snapshot: buildSummary(session), sources: response?.sources ?? [] };
	}

	async customRequest(
		command: string,
		args?: Record<string, unknown>,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<{ snapshot: DapSessionSummary; body: unknown }> {
		const session = this.#touchActiveSession();
		const body = await this.#sendRequestWithConfig<unknown>(session, command, args, signal, timeoutMs);
		return { snapshot: buildSummary(session), body };
	}

	async startContinue(signal?: AbortSignal, timeoutMs: number = 30_000): Promise<DapExecutionStart> {
		const session = this.#touchActiveSession();
		this.#assertCanResume(session);
		const threadId = await this.#resolveThreadId(session, signal, timeoutMs);
		return this.#startControlRequest(
			session,
			"continue",
			{ threadId } satisfies DapContinueArguments,
			signal,
			timeoutMs,
		);
	}

	async continue(signal?: AbortSignal, timeoutMs: number = 30_000): Promise<DapWaitForExecutionOutcome> {
		const started = await this.startContinue(signal, timeoutMs);
		return this.waitForExecution(started.executionId, signal, timeoutMs);
	}

	async waitForExecution(
		executionId: string,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<DapWaitForExecutionOutcome> {
		const record = this.#executions.get(executionId);
		if (!record) {
			throw new Error(`Unknown debug execution "${executionId}".`);
		}
		const outcome = await this.#waitForRecordOutcome(record, signal, timeoutMs);
		if (outcome) {
			return this.#materializeExecutionOutcome(record, outcome, signal);
		}
		const target = this.#sessions.get(record.targetSessionId);
		return {
			executionId,
			reason: "timeout",
			state: "running",
			timedOut: true,
			snapshot: target ? buildSummary(target) : record.startSnapshot,
			targetSessionId: record.targetSessionId,
			startedAt: record.startedAt,
		};
	}

	getExecutionOutcome(executionId: string): DapExecutionOutcome | null {
		return this.#executions.get(executionId)?.outcome ?? null;
	}

	hasExecution(executionId: string): boolean {
		return this.#executions.has(executionId);
	}

	async captureStopSnapshot(
		sessionId?: string,
		signal?: AbortSignal,
		timeoutMs: number = STOP_CAPTURE_TIMEOUT_MS,
	): Promise<DapStopSnapshot> {
		const session = sessionId ? this.#sessions.get(sessionId) : this.#touchActiveSession();
		if (!session) throw new Error(`Unknown debug session "${sessionId}".`);
		if (session.status !== "stopped") {
			throw new Error(`Debug session ${session.id} is ${session.status}; a stopped session is required.`);
		}
		const stoppedEvent = session.lastStoppedEvent ?? this.#stoppedEventFromSession(session);
		const context: DapStopCaptureContext = {
			sessionId: session.id,
			stopGeneration: session.stopGeneration,
			stoppedEvent,
			output: session.stopOutputTail,
			outputSegments: session.stopOutputSegments,
			outputTruncated: session.stopOutputTruncated,
			outputBytesAtStop: session.stopOutputBytes,
			summaryAtStop: buildSummary(session),
		};
		return this.#captureStopSnapshot(context, signal, timeoutMs);
	}

	async pause(signal?: AbortSignal, timeoutMs: number = 30_000): Promise<DapWaitForExecutionOutcome> {
		const session = this.#touchActiveSession();
		if (session.status === "stopped") {
			const record = this.#beginControlExecution(session, true);
			this.#settleStoppedExecution(session, session.lastStoppedEvent ?? this.#stoppedEventFromSession(session));
			const outcome = record.outcome;
			if (!outcome) throw new Error("Failed to observe the current stopped debug session.");
			return this.#materializeExecutionOutcome(record, outcome, signal);
		}
		const threadId = await this.#resolveThreadId(session, signal, timeoutMs);
		const started = await this.#startControlRequest(
			session,
			"pause",
			{ threadId } satisfies DapPauseArguments,
			signal,
			timeoutMs,
		);
		return this.waitForExecution(started.executionId, signal, timeoutMs);
	}

	async stepIn(signal?: AbortSignal, timeoutMs: number = 30_000): Promise<DapWaitForExecutionOutcome> {
		return this.#step("stepIn", signal, timeoutMs);
	}

	async stepOut(signal?: AbortSignal, timeoutMs: number = 30_000): Promise<DapWaitForExecutionOutcome> {
		return this.#step("stepOut", signal, timeoutMs);
	}

	async stepOver(signal?: AbortSignal, timeoutMs: number = 30_000): Promise<DapWaitForExecutionOutcome> {
		return this.#step("next", signal, timeoutMs);
	}

	async threads(
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<{ snapshot: DapSessionSummary; threads: DapThread[] }> {
		const anchor = this.#touchActiveSession();
		// A js-debug launch is a session tree: the root may be a threadless
		// launcher while each real thread lives in a child (main script,
		// `[worker N]`, …), and other adapters keep every thread on the root.
		// Querying only the active session would surface just one session's
		// threads, so aggregate across the whole live tree. No topology guess:
		// a threadless launcher simply returns no threads (or an error we skip).
		const targets = this.#liveTreeSessions(anchor);
		const merged: DapThread[] = [];
		const seen = new Set<string>();
		for (const target of targets) {
			let threads: DapThread[];
			try {
				const response = await this.#sendRequestWithConfig<DapThreadsResponse>(
					target,
					"threads",
					undefined,
					signal,
					timeoutMs,
				);
				threads = response?.threads ?? [];
			} catch (error) {
				// Caller cancellation is not an adapter failure: propagate it instead
				// of degrading a cancelled call into a successful partial result.
				if (signal?.aborted) throw error;
				logger.warn("Failed to list threads for debug session", {
					sessionId: target.id,
					error: toErrorMessage(error),
				});
				continue;
			}
			target.threads = threads;
			// DAP thread IDs are scoped per client session, so identical IDs from
			// different sessions (e.g. two identical worker scripts) are distinct
			// live threads and MUST be preserved; only collapse an exact repeat
			// within a single session's response.
			for (const thread of threads) {
				const key = `${target.id}\0${thread.id}`;
				if (seen.has(key)) continue;
				seen.add(key);
				merged.push(thread);
			}
		}
		return { snapshot: buildSummary(anchor), threads: merged };
	}

	async stackTrace(
		frameCount: number | undefined,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<{ snapshot: DapSessionSummary; stackFrames: DapStackFrame[]; totalFrames?: number }> {
		const session = this.#touchActiveSession();
		const threadId = await this.#resolveThreadId(session, signal, timeoutMs);
		const response = await this.#sendRequestWithConfig<DapStackTraceResponse>(
			session,
			"stackTrace",
			{
				threadId,
				...(frameCount !== undefined ? { levels: frameCount } : {}),
			} satisfies DapStackTraceArguments,
			signal,
			timeoutMs,
		);
		session.lastStackFrames = response?.stackFrames ?? [];
		this.#applyTopFrame(session, session.lastStackFrames[0]);
		return {
			snapshot: buildSummary(session),
			stackFrames: session.lastStackFrames,
			totalFrames: response?.totalFrames,
		};
	}

	async scopes(frameId: number | undefined, signal?: AbortSignal, timeoutMs: number = 30_000) {
		const session = this.#touchActiveSession();
		const resolvedFrameId = frameId ?? session.stop.frameId;
		if (resolvedFrameId === undefined) {
			throw new Error("No active stack frame. Run stack_trace first or supply frame_id.");
		}
		const response = await this.#sendRequestWithConfig<DapScopesResponse>(
			session,
			"scopes",
			{ frameId: resolvedFrameId } satisfies DapScopesArguments,
			signal,
			timeoutMs,
		);
		return { snapshot: buildSummary(session), scopes: response?.scopes ?? [] };
	}

	async variables(variableReference: number, signal?: AbortSignal, timeoutMs: number = 30_000) {
		const session = this.#touchActiveSession();
		const response = await this.#sendRequestWithConfig<DapVariablesResponse>(
			session,
			"variables",
			{ variablesReference: variableReference } satisfies DapVariablesArguments,
			signal,
			timeoutMs,
		);
		return { snapshot: buildSummary(session), variables: response?.variables ?? [] };
	}

	async evaluate(
		expression: string,
		context: DapEvaluateArguments["context"],
		frameId: number | undefined,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	) {
		const session = this.#touchActiveSession();
		// Default to the top stopped frame so callers don't need to pass
		// frame_id explicitly for the common case.
		const effectiveFrameId = frameId ?? session.stop.frameId;
		const response = await this.#sendRequestWithConfig<DapEvaluateResponse>(
			session,
			"evaluate",
			{
				expression,
				context,
				...(effectiveFrameId !== undefined ? { frameId: effectiveFrameId } : {}),
			} satisfies DapEvaluateArguments,
			signal,
			timeoutMs,
		);
		return { snapshot: buildSummary(session), evaluation: response };
	}

	getOutput(options: { limitBytes?: number; all?: boolean } = {}): DapOutputSnapshot {
		const session = this.#touchActiveSession();
		const startByte = options.all ? 0 : session.outputGenerationStartBytes;
		const captured = captureOutput(session, startByte, options.limitBytes);
		return {
			snapshot: buildSummary(session),
			output: captured.output,
			outputSegments: captured.outputSegments,
			outputTruncated: captured.truncated,
			startByte,
			endByte: session.outputBytes,
		};
	}

	async waitForOutput(
		pattern: RegExp,
		options: { limitBytes?: number; all?: boolean; signal?: AbortSignal; timeoutMs?: number } = {},
	): Promise<DapOutputWaitResult> {
		const session = this.#touchActiveSession();
		const startByte = options.all ? 0 : session.outputGenerationStartBytes;
		const snapshot = (): DapOutputSnapshot => {
			const captured = captureOutput(session, startByte, options.limitBytes);
			return {
				snapshot: buildSummary(session),
				output: captured.output,
				outputSegments: captured.outputSegments,
				outputTruncated: captured.truncated,
				startByte,
				endByte: session.outputBytes,
			};
		};
		const matches = (output: string): boolean => {
			pattern.lastIndex = 0;
			return pattern.test(output);
		};
		let current = snapshot();
		if (matches(current.output)) return { ...current, matched: true, timedOut: false };

		const observed = Promise.withResolvers<"matched" | "timeout">();
		const listener = (): void => {
			const next = snapshot();
			if (!matches(next.output)) return;
			current = next;
			observed.resolve("matched");
		};
		session.outputListeners.add(listener);
		listener();
		const timer = setTimeout(() => observed.resolve("timeout"), Math.max(0, options.timeoutMs ?? 30_000));
		try {
			const reason = await untilAborted(options.signal, observed.promise);
			current = snapshot();
			return { ...current, matched: reason === "matched", timedOut: reason === "timeout" };
		} finally {
			clearTimeout(timer);
			session.outputListeners.delete(listener);
		}
	}

	async terminate(signal?: AbortSignal, timeoutMs: number = 30_000): Promise<DapSessionSummary | null> {
		const session = this.#getActiveSessionOrNull();
		if (!session) return null;
		this.#touchSessionAndAncestors(session);
		const root = this.#getRootSession(session);
		await this.#terminateSessionTree(root, signal, timeoutMs);
		return buildSummary(session);
	}

	async #terminateSessionTree(session: DapSession, signal?: AbortSignal, timeoutMs: number = 30_000): Promise<void> {
		session.status = "terminated";
		try {
			for (const childId of [...session.childSessionIds]) {
				const child = this.#sessions.get(childId);
				if (child) {
					await this.#terminateSessionTree(child, signal, timeoutMs);
				}
			}
			if (session.capabilities?.supportsTerminateRequest) {
				await session.client.sendRequest("terminate", undefined, signal, timeoutMs).catch(() => undefined);
			}
			await session.client
				.sendRequest("disconnect", { terminateDebuggee: true }, signal, timeoutMs)
				.catch(() => undefined);
		} catch {
			/* Disposal remains mandatory when a caller aborts best-effort DAP shutdown. */
		} finally {
			this.#disposeSession(session);
		}
	}

	#startCleanupTimer(): void {
		if (this.#cleanupLoopPromise) return;
		this.#cleanupLoopPromise = this.#runCleanupLoop();
	}

	async #runCleanupLoop(): Promise<void> {
		for await (const _ of timers.setInterval(CLEANUP_INTERVAL_MS, null, { ref: false })) {
			try {
				this.#cleanupIdleSessions();
			} catch (error) {
				logger.error("DAP idle session cleanup failed", { error: toErrorMessage(error) });
			}
		}
	}

	#cleanupIdleSessions(): void {
		if (this.#sessions.size === 0) return;
		const now = Date.now();
		for (const session of this.#sessions.values()) {
			if (
				session.status === "terminated" ||
				now - session.lastUsedAt > IDLE_TIMEOUT_MS ||
				!session.client.isAlive()
			) {
				this.#disposeSession(session);
			}
		}
	}

	async #startChildSession(
		parent: DapSession,
		request: "launch" | "attach",
		configuration: Record<string, unknown>,
		timeoutMs: number = 30_000,
	): Promise<void> {
		if (parent.adapter.connectMode !== "tcp" || parent.port === undefined) {
			throw new Error(`DAP adapter ${parent.adapter.name} cannot accept child session connections`);
		}
		const cwd = path.resolve(parent.cwd, typeof configuration.cwd === "string" ? configuration.cwd : ".");
		const client = await DapClient.connect({
			adapter: parent.adapter,
			cwd,
			host: "127.0.0.1",
			port: parent.port,
		});
		const child = this.#registerSession(
			client,
			parent.adapter,
			cwd,
			typeof configuration.program === "string" ? configuration.program : undefined,
			parent.id,
		);
		try {
			child.capabilities = await client.initialize(
				this.#buildInitializeArguments(parent.adapter),
				undefined,
				timeoutMs,
			);
			child.needsConfigurationDone = child.capabilities.supportsConfigurationDoneRequest === true;
			const startFailure: DapStartRequestFailure = { rejected: false };
			const startPromise = trackDapStartRequest(
				client.sendRequest(request, { ...configuration, cwd }, undefined, timeoutMs),
				startFailure,
			);
			startPromise.catch(() => {});
			try {
				await this.#completeConfigurationHandshake(child, undefined, timeoutMs);
			} catch (error) {
				await throwPreferredDapStartError(request, startFailure, error);
			}
			await startPromise;
		} catch (error) {
			await this.#disposeSession(child);
			throw error;
		}
	}

	async #applyRootBreakpointsToSession(
		session: DapSession,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<void> {
		const root = this.#getRootSession(session);
		for (const [sourcePath, entries] of root.breakpoints) {
			try {
				const response = await session.client.sendRequest<{ breakpoints?: DapBreakpoint[] }>(
					"setBreakpoints",
					{
						source: { path: sourcePath, name: path.basename(sourcePath) },
						breakpoints: entries.map<DapSourceBreakpoint>(entry => ({
							line: entry.line,
							...(entry.condition ? { condition: entry.condition } : {}),
						})),
					},
					signal,
					timeoutMs,
				);
				session.breakpoints.set(sourcePath, this.#mapSourceBreakpoints(entries, response?.breakpoints));
			} catch (error) {
				logger.warn("Failed to bind source breakpoints in child debug session", {
					sessionId: session.id,
					sourcePath,
					error: toErrorMessage(error),
				});
			}
		}
		if (root.functionBreakpoints.length > 0) {
			try {
				const response = await session.client.sendRequest<{ breakpoints?: DapBreakpoint[] }>(
					"setFunctionBreakpoints",
					{
						breakpoints: root.functionBreakpoints.map<DapFunctionBreakpoint>(entry => ({
							name: entry.name,
							...(entry.condition ? { condition: entry.condition } : {}),
						})),
					},
					signal,
					timeoutMs,
				);
				session.functionBreakpoints = this.#mapFunctionBreakpoints(root.functionBreakpoints, response?.breakpoints);
			} catch (error) {
				logger.warn("Failed to bind function breakpoints in child debug session", {
					sessionId: session.id,
					error: toErrorMessage(error),
				});
			}
		}
		if (root.instructionBreakpoints.length > 0) {
			try {
				await session.client.sendRequest(
					"setInstructionBreakpoints",
					{ breakpoints: root.instructionBreakpoints } satisfies DapSetInstructionBreakpointsArguments,
					signal,
					timeoutMs,
				);
				session.instructionBreakpoints = root.instructionBreakpoints.map(entry => ({ ...entry }));
			} catch (error) {
				logger.warn("Failed to bind instruction breakpoints in child debug session", {
					sessionId: session.id,
					error: toErrorMessage(error),
				});
			}
		}
		if (root.dataBreakpoints.length > 0) {
			try {
				await session.client.sendRequest(
					"setDataBreakpoints",
					{ breakpoints: root.dataBreakpoints } satisfies DapSetDataBreakpointsArguments,
					signal,
					timeoutMs,
				);
				session.dataBreakpoints = root.dataBreakpoints.map(entry => ({ ...entry }));
			} catch (error) {
				logger.debug("Failed to bind data breakpoints in child debug session", {
					sessionId: session.id,
					error: toErrorMessage(error),
				});
			}
		}
	}

	async #ensureLaunchSlot(): Promise<void> {
		for (const session of [...this.#sessions.values()]) {
			if (session.status === "terminated" || !session.client.isAlive()) {
				this.#disposeSession(session);
			}
		}
		const root = [...this.#sessions.values()].find(session => !session.parentSessionId);
		if (!root) return;
		throw new Error(`Debug session ${root.id} is still active. Terminate it before launching another.`);
	}

	#registerSession(
		client: DapClient,
		adapter: DapResolvedAdapter,
		cwd: string,
		program?: string,
		parentSessionId?: string,
	): DapSession {
		const session: DapSession = {
			id: `debug-${++this.#nextId}`,
			adapter,
			cwd,
			program,
			client,
			status: "launching",
			launchedAt: Date.now(),
			lastUsedAt: Date.now(),
			breakpoints: new Map(),
			functionBreakpoints: [],
			instructionBreakpoints: [],
			dataBreakpoints: [],
			breakpointMutationQueue: Promise.resolve(),
			outputChunks: [],
			outputBytes: 0,
			outputBufferedBytes: 0,
			outputTruncated: false,
			outputGenerationStartBytes: 0,
			outputListeners: new Set(),
			stop: {},
			threads: [],
			lastStackFrames: [],
			stopGeneration: 0,
			stopOutputTail: "",
			stopOutputSegments: [],
			stopOutputTruncated: false,
			stopOutputBytes: 0,
			initializedSeen: false,
			needsConfigurationDone: false,
			configurationDoneSent: false,
			parentSessionId,
			childSessionIds: new Set(),
			port: client.port,
		};
		client.onReverseRequest("runInTerminal", async rawArgs => {
			const args = (rawArgs ?? {}) as DapRunInTerminalArguments;
			if (!Array.isArray(args.args) || args.args.length === 0) {
				throw new Error("runInTerminal request did not include a command");
			}
			const env = Object.fromEntries(
				Object.entries(args.env ?? {}).filter((entry): entry is [string, string] => entry[1] !== null),
			);
			const proc = ptree.spawn(args.args, {
				cwd: path.resolve(session.cwd, args.cwd ?? "."),
				stdin: "pipe",
				env: {
					...Bun.env,
					...NON_INTERACTIVE_ENV,
					...env,
				},
				detached: DETACH_DAP_DEBUGGEE,
			});
			// Consume the child's stdout — ptree pipes it but drains only stderr,
			// so an unconsumed stream buffers unboundedly in this process.
			void drainTerminalStdout(proc.stdout, session);
			return { processId: proc.pid } satisfies DapRunInTerminalResponse;
		});
		client.onReverseRequest("startDebugging", async rawArgs => {
			const startArgs = (rawArgs ?? {}) as Partial<DapStartDebuggingArguments>;
			const request = startArgs.request === "attach" ? "attach" : "launch";
			const configuration =
				startArgs.configuration && typeof startArgs.configuration === "object" ? startArgs.configuration : {};
			logger.debug("Adapter requested child debug session", {
				adapter: session.adapter.name,
				sessionId: session.id,
				request,
				name: typeof configuration.name === "string" ? configuration.name : undefined,
			});
			await this.#startChildSession(session, request, configuration);
			return {};
		});
		client.onEvent("output", body => {
			truncateOutput(session, (body as DapOutputEventBody | undefined) ?? { output: "" });
		});
		client.onEvent("initialized", () => {
			session.initializedSeen = true;
			session.status = session.configurationDoneSent ? session.status : "configuring";
		});
		client.onEvent("stopped", body => {
			const stopped = body as DapStoppedEventBody;
			this.#handleStoppedEvent(session, stopped);
			this.#activeSessionId = session.id;
			this.#settleStoppedExecution(session, stopped);
		});
		client.onEvent("continued", body => {
			const continued = body as { threadId?: number } | undefined;
			session.status = "running";
			session.stop = { threadId: continued?.threadId };
			session.lastStackFrames = [];
		});
		client.onEvent("exited", body => {
			session.exitCode = (body as DapExitedEventBody | undefined)?.exitCode;
			this.#handleSessionTermination(session, "exited");
		});
		client.onEvent("terminated", () => {
			this.#handleSessionTermination(session, "terminated");
		});
		this.#sessions.set(session.id, session);
		if (parentSessionId) {
			this.#sessions.get(parentSessionId)?.childSessionIds.add(session.id);
		}
		// Focus follows stops, not registrations: a lazily-attached child (e.g. a
		// js-debug `[worker N]` session) must not steal focus from a sibling that
		// is already stopped at a breakpoint / entry. Only claim focus when no
		// live, stopped session currently holds it.
		if (!this.#hasLiveStoppedActiveSession()) {
			this.#activeSessionId = session.id;
		}
		const heartbeat = setInterval(() => {
			if (!client.isAlive()) {
				this.#handleSessionTermination(session, "adapter_exit");
			}
		}, HEARTBEAT_INTERVAL_MS);
		heartbeat.unref?.();
		void client.proc.exited.finally(() => {
			clearInterval(heartbeat);
			this.#handleSessionTermination(session, "adapter_exit");
		});
		return session;
	}

	#buildInitializeArguments(adapter: DapResolvedAdapter): DapInitializeArguments {
		return {
			clientID: "omp",
			clientName: "Oh My Pi",
			adapterID: adapter.name,
			locale: "en-US",
			linesStartAt1: true,
			columnsStartAt1: true,
			pathFormat: "path",
			supportsRunInTerminalRequest: true,
			supportsStartDebuggingRequest: true,
			supportsMemoryReferences: true,
			supportsVariableType: true,
			supportsInvalidatedEvent: true,
		};
	}

	/**
	 * Wait for the adapter's `initialized` event (if not already received),
	 * then send `configurationDone`. Many adapters block the `launch`/`attach`
	 * response until this handshake completes.
	 */
	async #completeConfigurationHandshake(
		session: DapSession,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<void> {
		if (session.configurationDoneSent) return;
		if (!session.needsConfigurationDone) {
			if (session.parentSessionId) {
				await this.#applyRootBreakpointsToSession(session, signal, timeoutMs);
			}
			return;
		}
		// Wait for the initialized event if we haven't seen it yet.
		if (!session.initializedSeen) {
			try {
				await untilAborted(signal, session.client.waitForEvent("initialized", undefined, signal, timeoutMs));
			} catch {
				// Adapter may not send initialized (e.g. it already terminated).
				// Proceed anyway — the launch/attach response will surface any real error.
				return;
			}
		}
		if (session.parentSessionId) {
			await this.#applyRootBreakpointsToSession(session, signal, timeoutMs);
		}
		await session.client.sendRequest("configurationDone", {}, signal, timeoutMs);
		session.configurationDoneSent = true;
		if (session.status === "configuring") {
			session.status = "running";
		}
	}

	#handleStoppedEvent(session: DapSession, stopped: DapStoppedEventBody): void {
		const stoppedEvent: DapStoppedEventBody = {
			...stopped,
			...(stopped.hitBreakpointIds ? { hitBreakpointIds: [...stopped.hitBreakpointIds] } : {}),
		};
		const output = captureOutput(session, session.outputGenerationStartBytes, STOP_OUTPUT_LIMIT_BYTES);
		session.status = "stopped";
		session.stopGeneration += 1;
		session.lastStoppedEvent = stoppedEvent;
		session.stopOutputTail = output.output;
		session.stopOutputSegments = output.outputSegments;
		session.stopOutputTruncated = output.truncated;
		session.stopOutputBytes = session.outputBytes;
		session.stop = {
			threadId: stopped.threadId,
			reason: stopped.reason,
			description: stopped.description,
			text: stopped.text,
		};
		session.lastStackFrames = [];
	}

	#stoppedEventFromSession(session: DapSession): DapStoppedEventBody {
		return {
			reason: session.stop.reason ?? "stopped",
			threadId: session.stop.threadId,
			description: session.stop.description,
			text: session.stop.text,
		};
	}

	#settleStoppedExecution(session: DapSession, stopped: DapStoppedEventBody): void {
		const rootId = this.#getRootSession(session).id;
		const record = this.#activeExecutionByRoot.get(rootId);
		if (!record || record.outcome) return;
		const stoppedEvent = session.lastStoppedEvent ?? {
			...stopped,
			...(stopped.hitBreakpointIds ? { hitBreakpointIds: [...stopped.hitBreakpointIds] } : {}),
		};
		record.stopContext = {
			sessionId: session.id,
			stopGeneration: session.stopGeneration,
			stoppedEvent,
			output: session.stopOutputTail,
			outputSegments: session.stopOutputSegments,
			outputTruncated: session.stopOutputTruncated,
			outputBytesAtStop: session.stopOutputBytes,
			summaryAtStop: buildSummary(session),
		};
		const outcome: DapExecutionOutcome = {
			executionId: record.executionId,
			reason: "stopped",
			state: "stopped",
			timedOut: false,
			snapshot: buildSummary(session),
			sourceSessionId: session.id,
			targetSessionId: record.targetSessionId,
			startedAt: record.startedAt,
			settledAt: Date.now(),
			stoppedEvent,
		};
		record.outcome = outcome;
		record.resolve(outcome);
	}

	#handleSessionTermination(
		session: DapSession,
		reason: Exclude<DapExecutionOutcome["reason"], "stopped" | "session_disposed">,
	): void {
		if (!this.#sessions.has(session.id)) return;
		session.status = "terminated";
		this.#settleTerminalExecution(session, reason);
		this.#reactivateAfterTermination(session);
	}

	#settleTerminalExecution(session: DapSession, reason: Exclude<DapExecutionOutcome["reason"], "stopped">): void {
		const root = this.#getRootSession(session);
		const record = this.#activeExecutionByRoot.get(root.id);
		if (!record || record.outcome) return;
		const live = this.#getTreeSessions(root).filter(
			candidate => candidate.status !== "terminated" && candidate.client.isAlive(),
		);
		if (record.targetSessionId !== session.id && live.length > 0) return;
		const outcome: DapExecutionOutcome = {
			executionId: record.executionId,
			reason,
			state: "terminated",
			timedOut: false,
			snapshot: buildSummary(session),
			sourceSessionId: session.id,
			targetSessionId: record.targetSessionId,
			startedAt: record.startedAt,
			settledAt: Date.now(),
			...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
		};
		record.outcome = outcome;
		record.resolve(outcome);
	}

	#applyTopFrame(session: DapSession, frame: DapStackFrame | undefined): void {
		if (!frame) return;
		session.stop.frameId = frame.id;
		session.stop.frameName = frame.name;
		session.stop.instructionPointerReference = frame.instructionPointerReference;
		session.stop.source = frame.source;
		session.stop.line = frame.line;
		session.stop.column = frame.column;
	}

	/**
	 * Fetch the top stack frame from the adapter and apply it to the session's
	 * stop location. Called outside the event dispatch loop to avoid deadlocking
	 * the message reader.
	 */
	async #fetchTopFrame(session: DapSession, signal?: AbortSignal, timeoutMs: number = 5_000): Promise<void> {
		if (session.stop.threadId === undefined) return;
		try {
			const response = await session.client.sendRequest<DapStackTraceResponse>(
				"stackTrace",
				{ threadId: session.stop.threadId, levels: 1 } satisfies DapStackTraceArguments,
				signal,
				timeoutMs,
			);
			session.lastStackFrames = response?.stackFrames ?? [];
			this.#applyTopFrame(session, session.lastStackFrames[0]);
		} catch (error) {
			logger.debug("Failed to capture stopped frame", {
				sessionId: session.id,
				error: toErrorMessage(error),
			});
		}
	}

	async #step(
		command: "stepIn" | "stepOut" | "next",
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<DapWaitForExecutionOutcome> {
		const session = this.#touchActiveSession();
		this.#assertCanResume(session);
		const threadId = await this.#resolveThreadId(session, signal, timeoutMs);
		const started = await this.#startControlRequest(
			session,
			command,
			{ threadId } satisfies DapStepArguments,
			signal,
			timeoutMs,
		);
		return this.waitForExecution(started.executionId, signal, timeoutMs);
	}

	#assertCanResume(session: DapSession): void {
		if (session.status === "running") {
			const current = this.#activeExecutionByRoot.get(this.#getRootSession(session).id);
			const suffix = current?.exposed && !current.outcome ? ` under execution ${current.executionId}` : "";
			throw new Error(`Debug target ${session.id} is already running${suffix}.`);
		}
		if (session.status === "terminated") {
			throw new Error(`Debug target ${session.id} has terminated.`);
		}
	}

	#beginStartupExecution(session: DapSession): DapExecutionRecord {
		const root = this.#getRootSession(session);
		const current = this.#activeExecutionByRoot.get(root.id);
		if (current) this.#removeExecutionRecord(current);
		return this.#createExecutionRecord(`startup:${session.id}`, false, root, session);
	}

	#beginControlExecution(session: DapSession, preserveStoppedState = false): DapExecutionRecord {
		const root = this.#getRootSession(session);
		const current = this.#activeExecutionByRoot.get(root.id);
		if (current && !current.outcome) {
			throw new Error(
				current.exposed
					? `Debug execution ${current.executionId} is still running. Wait for it before another control action.`
					: `Debug session ${root.id} is still starting.`,
			);
		}
		if (current) this.#removeExecutionRecord(current);
		const rollback: DapExecutionRollback = {
			status: session.status,
			stop: {
				...session.stop,
				...(session.stop.source ? { source: { ...session.stop.source } } : {}),
			},
			lastStackFrames: [...session.lastStackFrames],
		};
		const record = this.#createExecutionRecord(`exec_${++this.#nextExecutionId}`, true, root, session, rollback);
		if (!preserveStoppedState) {
			session.stop = {};
			session.lastStackFrames = [];
			session.status = "running";
		}
		return record;
	}

	#createExecutionRecord(
		executionId: string,
		exposed: boolean,
		root: DapSession,
		target: DapSession,
		rollback?: DapExecutionRollback,
	): DapExecutionRecord {
		const { promise, resolve } = Promise.withResolvers<DapExecutionOutcome>();
		const previousOutputGenerationStarts = new Map<string, number>();
		for (const treeSession of this.#getTreeSessions(root)) {
			previousOutputGenerationStarts.set(treeSession.id, treeSession.outputGenerationStartBytes);
			treeSession.outputGenerationStartBytes = treeSession.outputBytes;
		}
		const record: DapExecutionRecord = {
			executionId,
			exposed,
			rootSessionId: root.id,
			targetSessionId: target.id,
			startedAt: Date.now(),
			startSnapshot: buildSummary(target),
			promise,
			resolve,
			rollback,
			previousOutputGenerationStarts,
		};
		this.#activeExecutionByRoot.set(root.id, record);
		if (exposed) this.#executions.set(executionId, record);
		return record;
	}

	async #startControlRequest(
		session: DapSession,
		command: "continue" | "stepIn" | "stepOut" | "next" | "pause",
		args: DapContinueArguments | DapStepArguments | DapPauseArguments,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<DapExecutionStart> {
		await this.#ensureConfigurationDone(session, signal, timeoutMs);
		const record = this.#beginControlExecution(session);
		try {
			await session.client.sendRequest(command, args, signal, timeoutMs);
			this.#touchSessionAndAncestors(session);
		} catch (error) {
			this.#throwControlRequestFailure(record, error);
		}
		const target = this.#sessions.get(record.targetSessionId);
		const snapshot = record.outcome?.snapshot ?? (target ? buildSummary(target) : record.startSnapshot);
		const state =
			record.outcome?.state ??
			(target?.status === "stopped" ? "stopped" : target?.status === "terminated" ? "terminated" : "running");
		return {
			executionId: record.executionId,
			snapshot,
			state,
			startedAt: record.startedAt,
		};
	}

	#throwControlRequestFailure(record: DapExecutionRecord, error: unknown): never {
		if (error instanceof DapRequestRejectedError) {
			const target = this.#sessions.get(record.targetSessionId);
			if (target && record.rollback) {
				target.status = record.rollback.status;
				target.stop = record.rollback.stop;
				target.lastStackFrames = record.rollback.lastStackFrames;
			}
			for (const [sessionId, startByte] of record.previousOutputGenerationStarts) {
				const session = this.#sessions.get(sessionId);
				if (session) session.outputGenerationStartBytes = startByte;
			}
			this.#removeExecutionRecord(record);
			throw error;
		}
		throw new Error(
			`${toErrorMessage(error)} Debug execution ${record.executionId} may have started; ` +
				`call wait_for_stop with execution_id="${record.executionId}".`,
			{ cause: error },
		);
	}

	async #waitForRecordOutcome(
		record: DapExecutionRecord,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<DapExecutionOutcome | null> {
		if (record.outcome) return record.outcome;
		if (!Number.isFinite(timeoutMs)) {
			return untilAborted(signal, record.promise);
		}
		if (timeoutMs <= 0) return null;
		const timeout = Promise.withResolvers<null>();
		const timer = setTimeout(() => timeout.resolve(null), timeoutMs);
		try {
			return await untilAborted(signal, Promise.race([record.promise, timeout.promise]));
		} finally {
			clearTimeout(timer);
		}
	}

	async #materializeExecutionOutcome(
		record: DapExecutionRecord,
		outcome: DapExecutionOutcome,
		signal?: AbortSignal,
	): Promise<DapWaitForExecutionOutcome> {
		if (outcome.reason !== "stopped" || !record.stopContext) {
			return outcome;
		}
		let capturePromise = record.capturePromise;
		if (!capturePromise) {
			capturePromise = this.#captureStopSnapshot(record.stopContext, undefined, STOP_CAPTURE_TIMEOUT_MS);
			record.capturePromise = capturePromise;
		}
		try {
			const stopSnapshot = await untilAborted(signal, capturePromise);
			return {
				...outcome,
				snapshot: stopSnapshot.summary,
				stopSnapshot,
			};
		} catch (error) {
			if (!signal?.aborted && record.capturePromise === capturePromise) record.capturePromise = undefined;
			throw error;
		}
	}

	async #captureStopSnapshot(
		context: DapStopCaptureContext,
		signal?: AbortSignal,
		timeoutMs: number = STOP_CAPTURE_TIMEOUT_MS,
	): Promise<DapStopSnapshot> {
		const deadline = Date.now() + Math.max(1, Math.min(timeoutMs, STOP_CAPTURE_TIMEOUT_MS));
		const requestTimeout = (): number => Math.max(1, deadline - Date.now());
		const errors: DapStopCaptureError[] = [];
		let summary = context.summaryAtStop;
		let threads: DapThread[] = [];
		let threadsTruncated = false;
		let stackFrames: DapStackFrame[] = [];
		let stackFramesTruncated = false;
		let totalFrames: number | undefined;
		const scopes: DapStopSnapshot["scopes"] = [];
		let scopesTruncated = false;

		const addStateError = (): void => {
			if (errors.some(error => error.stage === "state")) return;
			errors.push({
				stage: "state",
				message:
					`Stopped state changed while capturing ${context.sessionId} ` + `generation ${context.stopGeneration}.`,
			});
		};
		const finish = (): DapStopSnapshot => {
			const session = this.#sessions.get(context.sessionId);
			if (session?.status !== "stopped" || session.stopGeneration !== context.stopGeneration) {
				addStateError();
			} else {
				session.threads = threads;
				session.lastStackFrames = stackFrames;
				this.#applyTopFrame(session, stackFrames[0]);
				summary = buildSummary(session);
			}
			return {
				complete: errors.length === 0,
				sessionId: context.sessionId,
				stopGeneration: context.stopGeneration,
				stoppedEvent: context.stoppedEvent,
				capturedAt: Date.now(),
				summary,
				threads,
				threadsTruncated,
				stackFrames,
				stackFramesTruncated,
				...(totalFrames !== undefined ? { totalFrames } : {}),
				scopes,
				scopesTruncated,
				output: context.output,
				outputSegments: context.outputSegments,
				outputTruncated: context.outputTruncated,
				outputBytesAtStop: context.outputBytesAtStop,
				errors,
			};
		};
		const session = this.#sessions.get(context.sessionId);
		if (session?.status !== "stopped" || session.stopGeneration !== context.stopGeneration) {
			addStateError();
			return finish();
		}

		try {
			const response = await session.client.sendRequest<DapThreadsResponse>(
				"threads",
				undefined,
				signal,
				requestTimeout(),
			);
			if (!this.#isStopContextCurrent(context)) return finish();
			const freshThreads = response?.threads ?? [];
			threadsTruncated = freshThreads.length > STOP_THREAD_LIMIT;
			threads = freshThreads.slice(0, STOP_THREAD_LIMIT);
		} catch (error) {
			this.#throwIfCaptureAborted(signal);
			errors.push({ stage: "threads", message: toErrorMessage(error) });
		}

		const threadId = context.stoppedEvent.threadId ?? threads[0]?.id;
		if (threadId === undefined) {
			errors.push({ stage: "stack_trace", message: "Debugger reported no stopped thread." });
			return finish();
		}
		try {
			const response = await session.client.sendRequest<DapStackTraceResponse>(
				"stackTrace",
				{ threadId, startFrame: 0, levels: STOP_STACK_FRAME_LIMIT } satisfies DapStackTraceArguments,
				signal,
				requestTimeout(),
			);
			if (!this.#isStopContextCurrent(context)) return finish();
			const freshFrames = response?.stackFrames ?? [];
			totalFrames = response?.totalFrames;
			stackFramesTruncated =
				freshFrames.length > STOP_STACK_FRAME_LIMIT ||
				(totalFrames !== undefined && totalFrames > STOP_STACK_FRAME_LIMIT);
			stackFrames = freshFrames.slice(0, STOP_STACK_FRAME_LIMIT);
		} catch (error) {
			this.#throwIfCaptureAborted(signal);
			errors.push({ stage: "stack_trace", message: toErrorMessage(error) });
		}

		const topFrame = stackFrames[0];
		if (!topFrame) return finish();
		let selectedScopes: DapScope[] = [];
		try {
			const response = await session.client.sendRequest<DapScopesResponse>(
				"scopes",
				{ frameId: topFrame.id } satisfies DapScopesArguments,
				signal,
				requestTimeout(),
			);
			if (!this.#isStopContextCurrent(context)) return finish();
			const scopePriority = (scope: DapScope): number =>
				scope.presentationHint === "arguments" ? 0 : scope.presentationHint === "locals" ? 1 : 2;
			const nonExpensive = (response?.scopes ?? [])
				.filter(scope => !scope.expensive)
				.map((scope, index) => ({ scope, index }))
				.sort((left, right) => scopePriority(left.scope) - scopePriority(right.scope) || left.index - right.index)
				.map(entry => entry.scope);
			scopesTruncated = nonExpensive.length > STOP_SCOPE_LIMIT;
			selectedScopes = nonExpensive.slice(0, STOP_SCOPE_LIMIT);
		} catch (error) {
			this.#throwIfCaptureAborted(signal);
			errors.push({ stage: "scopes", message: toErrorMessage(error) });
			return finish();
		}

		for (const scope of selectedScopes) {
			try {
				const response = await session.client.sendRequest<DapVariablesResponse>(
					"variables",
					{
						variablesReference: scope.variablesReference,
						...(session.capabilities?.supportsVariablePaging ? { start: 0, count: STOP_VARIABLE_LIMIT } : {}),
					} satisfies DapVariablesArguments,
					signal,
					requestTimeout(),
				);
				if (!this.#isStopContextCurrent(context)) return finish();
				const freshVariables = response?.variables ?? [];
				let truncatedValueCount = 0;
				const variables = freshVariables.slice(0, STOP_VARIABLE_LIMIT).map(variable => {
					if (variable.value.length <= STOP_VARIABLE_VALUE_LIMIT) return variable;
					truncatedValueCount += 1;
					return {
						...variable,
						value: variable.value.slice(0, STOP_VARIABLE_VALUE_LIMIT),
					};
				});
				scopes.push({
					scope,
					variables,
					variablesTruncated: freshVariables.length > STOP_VARIABLE_LIMIT,
					truncatedValueCount,
				});
			} catch (error) {
				this.#throwIfCaptureAborted(signal);
				errors.push({
					stage: "variables",
					message: toErrorMessage(error),
					scopeName: scope.name,
					variablesReference: scope.variablesReference,
				});
				scopes.push({
					scope,
					variables: [],
					variablesTruncated: false,
					truncatedValueCount: 0,
				});
			}
		}
		return finish();
	}

	#isStopContextCurrent(context: DapStopCaptureContext): boolean {
		const session = this.#sessions.get(context.sessionId);
		return session?.status === "stopped" && session.stopGeneration === context.stopGeneration;
	}

	#throwIfCaptureAborted(signal?: AbortSignal): void {
		if (!signal?.aborted) return;
		throw signal.reason instanceof Error ? signal.reason : new Error("Debug stop snapshot aborted.");
	}

	#removeExecutionRecord(record: DapExecutionRecord): void {
		if (this.#activeExecutionByRoot.get(record.rootSessionId) === record) {
			this.#activeExecutionByRoot.delete(record.rootSessionId);
		}
		if (record.exposed && this.#executions.get(record.executionId) === record) {
			this.#executions.delete(record.executionId);
		}
	}

	async #resolveThreadId(session: DapSession, signal?: AbortSignal, timeoutMs: number = 30_000): Promise<number> {
		if (session.stop.threadId !== undefined) {
			return session.stop.threadId;
		}
		if (session.threads.length > 0) {
			return session.threads[0].id;
		}
		const response = await session.client.sendRequest<DapThreadsResponse>("threads", undefined, signal, timeoutMs);
		session.threads = response?.threads ?? [];
		const threadId = session.threads[0]?.id;
		if (threadId === undefined) {
			throw new Error("Debugger reported no threads.");
		}
		return threadId;
	}

	async #sendRequestWithConfig<TBody>(
		session: DapSession,
		command: string,
		args: unknown,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<TBody> {
		await this.#ensureConfigurationDone(session, signal, timeoutMs);
		const body = await session.client.sendRequest<TBody>(command, args, signal, timeoutMs);
		this.#touchSessionAndAncestors(session);
		return body;
	}

	async #ensureConfigurationDone(
		session: DapSession,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<void> {
		if (!session.needsConfigurationDone || session.configurationDoneSent) {
			return;
		}
		await session.client.sendRequest("configurationDone", {}, signal, timeoutMs);
		session.configurationDoneSent = true;
		if (session.status === "configuring") {
			session.status = "running";
		}
	}

	#mapSourceBreakpoints(
		input: DapBreakpointRecord[],
		responseBreakpoints: DapBreakpoint[] | undefined,
	): DapBreakpointRecord[] {
		return input.map((entry, index) => ({
			line: entry.line,
			condition: entry.condition,
			id: responseBreakpoints?.[index]?.id,
			verified: responseBreakpoints?.[index]?.verified ?? false,
			message: responseBreakpoints?.[index]?.message,
		}));
	}

	#mapFunctionBreakpoints(
		input: DapFunctionBreakpointRecord[],
		responseBreakpoints: DapBreakpoint[] | undefined,
	): DapFunctionBreakpointRecord[] {
		return input.map((entry, index) => ({
			name: entry.name,
			condition: entry.condition,
			id: responseBreakpoints?.[index]?.id,
			verified: responseBreakpoints?.[index]?.verified ?? false,
			message: responseBreakpoints?.[index]?.message,
		}));
	}

	#mapInstructionBreakpoints(
		input: DapInstructionBreakpoint[],
		responseBreakpoints: DapBreakpoint[] | undefined,
	): DapInstructionBreakpointRecord[] {
		return input.map((entry, index) => ({
			instructionReference: responseBreakpoints?.[index]?.instructionReference ?? entry.instructionReference,
			offset: responseBreakpoints?.[index]?.offset ?? entry.offset,
			condition: entry.condition,
			hitCondition: entry.hitCondition,
			id: responseBreakpoints?.[index]?.id,
			verified: responseBreakpoints?.[index]?.verified ?? false,
			message: responseBreakpoints?.[index]?.message,
		}));
	}

	#mapDataBreakpoints(
		input: DapDataBreakpoint[],
		responseBreakpoints: DapBreakpoint[] | undefined,
	): DapDataBreakpointRecord[] {
		return input.map((entry, index) => ({
			dataId: entry.dataId,
			accessType: entry.accessType,
			condition: entry.condition,
			hitCondition: entry.hitCondition,
			id: responseBreakpoints?.[index]?.id,
			verified: responseBreakpoints?.[index]?.verified ?? false,
			message: responseBreakpoints?.[index]?.message,
		}));
	}

	#touchActiveSession(): DapSession {
		const session = this.#getActiveSessionOrThrow();
		this.#touchSessionAndAncestors(session);
		if (session.status !== "terminated" && !session.client.isAlive()) {
			session.status = "terminated";
		}
		return session;
	}

	#getActiveSessionOrNull(): DapSession | null {
		if (!this.#activeSessionId) {
			return null;
		}
		const session = this.#sessions.get(this.#activeSessionId) ?? null;
		if (!session) {
			this.#activeSessionId = null;
		}
		return session;
	}

	/** True when the current active session is live and paused at a stop. */
	#hasLiveStoppedActiveSession(): boolean {
		const active = this.#getActiveSessionOrNull();
		return active !== null && active.status === "stopped" && active.client.isAlive();
	}

	#getActiveSessionOrThrow(): DapSession {
		const session = this.#getActiveSessionOrNull();
		if (!session) {
			throw new Error("No active debug session. Launch or attach first.");
		}
		return session;
	}

	#getRootSession(session: DapSession): DapSession {
		let root = session;
		while (root.parentSessionId) {
			const parent = this.#sessions.get(root.parentSessionId);
			if (!parent) break;
			root = parent;
		}
		return root;
	}

	#getTreeSessions(session: DapSession): DapSession[] {
		const sessions: DapSession[] = [];
		const pending = [this.#getRootSession(session)];
		while (pending.length > 0) {
			const current = pending.pop();
			if (!current) continue;
			sessions.push(current);
			for (const childId of current.childSessionIds) {
				const child = this.#sessions.get(childId);
				if (child) pending.push(child);
			}
		}
		return sessions;
	}

	/**
	 * Live (non-terminated, connected) sessions in `session`'s tree, or the
	 * session itself when the tree has collapsed. Used to fan `threads` out
	 * across the whole tree; a threadless session just reports no threads, so
	 * this makes no assumption about which node owns them.
	 */
	#liveTreeSessions(session: DapSession): DapSession[] {
		const live = this.#getTreeSessions(session).filter(
			candidate => candidate.status !== "terminated" && candidate.client.isAlive(),
		);
		return live.length > 0 ? live : [session];
	}

	#touchSessionAndAncestors(session: DapSession): void {
		const now = Date.now();
		let current: DapSession | undefined = session;
		while (current) {
			current.lastUsedAt = now;
			current = current.parentSessionId ? this.#sessions.get(current.parentSessionId) : undefined;
		}
	}

	/** Point the active session at a live tree member when the active one terminates. */
	#reactivateAfterTermination(session: DapSession): void {
		if (this.#activeSessionId !== session.id) return;
		const live = this.#getTreeSessions(session).filter(
			candidate => candidate.status !== "terminated" && candidate.client.isAlive(),
		);
		if (live.length === 0) return;
		const replacement =
			live.find(candidate => candidate.status === "stopped") ??
			live.find(candidate => candidate.parentSessionId !== undefined) ??
			live[0];
		this.#activeSessionId = replacement.id;
	}

	#disposeSession(session: DapSession): void {
		if (!this.#sessions.has(session.id)) return;
		const rootId = this.#getRootSession(session).id;
		session.status = "terminated";
		this.#settleTerminalExecution(session, "session_disposed");
		this.#reactivateAfterTermination(session);
		for (const childId of [...session.childSessionIds]) {
			const child = this.#sessions.get(childId);
			if (child) this.#disposeSession(child);
		}
		this.#sessions.delete(session.id);
		if (session.parentSessionId) {
			this.#sessions.get(session.parentSessionId)?.childSessionIds.delete(session.id);
		}
		if (this.#activeSessionId === session.id) {
			const parent = session.parentSessionId ? this.#sessions.get(session.parentSessionId) : undefined;
			this.#activeSessionId = parent?.id ?? this.#sessions.values().next().value?.id ?? null;
		}
		if (!session.parentSessionId) {
			const record = this.#activeExecutionByRoot.get(rootId);
			if (record) this.#removeExecutionRecord(record);
		}
		void session.client.dispose().catch(() => {});
	}
}

export const dapSessionManager = new DapSessionManager();
