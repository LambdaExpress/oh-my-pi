import * as fs from "node:fs/promises";
import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	RenderResultOptions,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import { type Component, Text } from "@oh-my-pi/pi-tui";
import { isEnoent, prompt } from "@oh-my-pi/pi-utils";
import type { AsyncJob, AsyncJobManager } from "../async";
import {
	type DapBreakpointRecord,
	type DapCapabilities,
	type DapDataBreakpointInfoResponse,
	type DapDataBreakpointRecord,
	type DapDisassembledInstruction,
	type DapEvaluateArguments,
	type DapEvaluateResponse,
	type DapFunctionBreakpointRecord,
	type DapInstructionBreakpointRecord,
	type DapModule,
	type DapOutputSegment,
	type DapResolvedAdapter,
	type DapScope,
	type DapSessionSummary,
	type DapSource,
	type DapStackFrame,
	type DapStopSnapshot,
	type DapThread,
	type DapVariable,
	type DapWaitForExecutionOutcome,
	dapSessionManager,
	getAdapterConfigs,
	getAvailableAdapters,
	type LaunchProgramKind,
	resolveLaunchOverrides,
	selectAttachAdapter,
	selectLaunchAdapter,
} from "../dap";
import type { Theme, ThemeColor } from "../modes/theme/theme";
import debugDescription from "../prompts/tools/debug.md" with { type: "text" };
import { renderStatusLine } from "../tui";
import { CachedOutputBlock, markFramedBlockComponent } from "../tui/output-block";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { snapshotJobs } from "./hub/jobs";
import type { JobSnapshot } from "./hub/types";
import type { OutputMeta } from "./output-meta";
import { formatPathRelativeToCwd, resolveToCwd } from "./path-utils";
import {
	formatExpandHint,
	formatStatusIcon,
	PREVIEW_LIMITS,
	replaceTabs,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "./render-utils";
import { ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

/**
 * DAP debug actions that only read program state (no mutation, no execution).
 * Execution-side actions (`launch`, `attach`, `continue`, `step_*`, `pause`,
 * `evaluate`, breakpoint mutations, memory writes) are exec-tier.
 */
export const DEBUG_READONLY_ACTIONS: ReadonlySet<string> = new Set([
	"output",
	"adapters",
	"wait_for_stop",
	"threads",
	"stack_trace",
	"scopes",
	"variables",
	"disassemble",
	"read_memory",
	"loaded_sources",
	"modules",
	"sessions",
]);
const debugActionSchema = type.enumerated(
	"adapters",
	"launch",
	"attach",
	"set_breakpoint",
	"remove_breakpoint",
	"set_instruction_breakpoint",
	"remove_instruction_breakpoint",
	"data_breakpoint_info",
	"set_data_breakpoint",
	"remove_data_breakpoint",
	"continue",
	"wait_for_stop",
	"step_over",
	"step_in",
	"step_out",
	"pause",
	"evaluate",
	"stack_trace",
	"threads",
	"scopes",
	"variables",
	"disassemble",
	"read_memory",
	"write_memory",
	"modules",
	"loaded_sources",
	"custom_request",
	"output",
	"terminate",
	"sessions",
);
const debugSchema = type({
	action: debugActionSchema,
	"wait_for_stop?": type("boolean").describe("continue only; defaults to true"),
	"execution_id?": type("string").describe("execution id returned by non-blocking continue"),
	"trigger_job_id?": type("string").describe("optional async Bash job raced with wait_for_stop"),
	"wait_for?": type("string").describe("output only; regex to await in the current execution output"),
	"all_output?": type("boolean").describe("output only; include the full buffered history"),
	"program?": type("string").describe("debug target path; Delve accepts Go package directories"),
	"args?": type("string[]").describe("program arguments"),
	"adapter?": type("string").describe("configured adapter id (gdb, lldb-dap, debugpy, dlv, rdbg, or dap.json entry)"),
	cwd: "string?",
	"file?": type("string").describe("source file"),
	"line?": type("number").describe("source line"),
	"function?": type("string").describe("function name"),
	"name?": type("string").describe("variable or data name"),
	"condition?": type("string").describe("breakpoint condition"),
	hit_condition: "string?",
	"expression?": type("string").describe("expression to evaluate"),
	"context?": type("string").describe("evaluate context: watch | repl | hover | variables | clipboard"),
	frame_id: "number?",
	"scope_id?": type("number").describe("scope variables reference"),
	"variable_ref?": type("number").describe("variable reference"),
	"pid?": type("number").describe("process id for attach"),
	"port?": type("number").describe("remote attach port"),
	"host?": type("string").describe("remote attach host"),
	"levels?": type("number").describe("max stack frames"),
	"memory_reference?": type("string").describe("memory reference or address"),
	instruction_reference: "string?",
	instruction_count: "number?",
	instruction_offset: "number?",
	"count?": type("number").describe("bytes to read"),
	"data?": type("string").describe("base64 memory payload"),
	"data_id?": type("string").describe("data breakpoint id"),
	"access_type?": "'read' | 'write' | 'readWrite'",
	"command?": type("string").describe("custom dap request command"),
	"arguments?": type({
		"[string]": "unknown",
	}).describe("custom request arguments"),
	offset: "number?",
	resolve_symbols: "boolean?",
	allow_partial: "boolean?",
	start_module: "number?",
	module_count: "number?",
	"timeout?": type("number").describe("per-request timeout seconds"),
});

export type DebugParams = typeof debugSchema.infer;
export type DebugAction = DebugParams["action"];

export interface DebugToolDetails {
	action: DebugAction;
	success: boolean;
	snapshot?: DapSessionSummary;
	sessions?: DapSessionSummary[];
	adapters?: DebugAdapterStatus[];
	stackFrames?: DapStackFrame[];
	threads?: DapThread[];
	scopes?: DapScope[];
	variables?: DapVariable[];
	sources?: DapSource[];
	modules?: DapModule[];
	evaluation?: DapEvaluateResponse;
	breakpoints?: DapBreakpointRecord[];
	functionBreakpoints?: DapFunctionBreakpointRecord[];
	instructionBreakpoints?: DapInstructionBreakpointRecord[];
	dataBreakpoints?: DapDataBreakpointRecord[];
	dataBreakpointInfo?: DapDataBreakpointInfoResponse;
	disassembly?: DapDisassembledInstruction[];
	memoryAddress?: string;
	memoryData?: string;
	unreadableBytes?: number;
	bytesWritten?: number;
	customBody?: unknown;
	output?: string;
	outputSegments?: DapOutputSegment[];
	outputMatched?: boolean;
	adapter?: string;
	state?: DapWaitForExecutionOutcome["state"];
	timedOut?: boolean;
	executionId?: string;
	waitReason?: "stopped" | "target_terminal" | "trigger" | "timeout";
	stopSnapshot?: DapStopSnapshot;
	triggerJob?: JobSnapshot;
	nextActions?: DebugNextAction[];
	meta?: OutputMeta;
}

export interface DebugAdapterStatus {
	name: string;
	command: string;
	available: boolean;
	resolvedCommand?: string;
	languages: string[];
	fileTypes: string[];
	hint?: string;
}

export interface DebugNextAction {
	tool: "debug" | "hub";
	input: Record<string, unknown>;
	when: string;
}

type DebugWaitReason = NonNullable<DebugToolDetails["waitReason"]>;

interface TriggerJobContext {
	manager: AsyncJobManager;
	job: AsyncJob;
}

interface CoordinatedWaitResult {
	outcome: DapWaitForExecutionOutcome;
	waitReason: DebugWaitReason;
	triggerJob?: JobSnapshot;
}

type WaitObservation =
	| { kind: "dap"; outcome: DapWaitForExecutionOutcome }
	| { kind: "dap_error"; error: unknown }
	| { kind: "trigger" }
	| { kind: "timeout" };

function waitReasonForOutcome(outcome: DapWaitForExecutionOutcome): DebugWaitReason {
	return outcome.reason === "stopped" ? "stopped" : outcome.reason === "timeout" ? "timeout" : "target_terminal";
}

function snapshotTriggerJob(session: ToolSession, job: AsyncJob): JobSnapshot {
	const snapshot = snapshotJobs(session, [job])[0];
	if (!snapshot) throw new Error(`Failed to snapshot background job "${job.id}".`);
	const boundText = (text: string): string => truncateForPrompt(replaceTabs(text));
	return {
		...snapshot,
		label: truncateToWidth(replaceTabs(snapshot.label), TRUNCATE_LENGTHS.LINE),
		...(snapshot.resultText !== undefined ? { resultText: boundText(snapshot.resultText) } : {}),
		...(snapshot.errorText !== undefined ? { errorText: boundText(snapshot.errorText) } : {}),
		...(snapshot.progress
			? {
					progress: {
						text: boundText(snapshot.progress.text),
						updatedAt: snapshot.progress.updatedAt,
					},
				}
			: {}),
	};
}

function formatTriggerJob(job: JobSnapshot): string {
	const lines = [`Trigger job ${job.id}: ${job.status} (${formatElapsedMs(job.durationMs)} elapsed)`];
	if (job.deadlineAt !== undefined) {
		const remainingMs = job.deadlineAt - (job.settledAt ?? Date.now());
		lines.push(
			`Trigger deadline: ${
				remainingMs > 0 ? `${formatElapsedMs(remainingMs)} remaining` : `${formatElapsedMs(-remainingMs)} overdue`
			}.`,
		);
	} else {
		lines.push("Trigger deadline: none.");
	}
	if (job.resultText !== undefined) lines.push(`Trigger result: ${job.resultText}`);
	if (job.errorText !== undefined) lines.push(`Trigger error: ${job.errorText}`);
	if (job.progress && job.settledAt === undefined) lines.push(`Trigger progress: ${job.progress.text}`);
	return lines.join("\n");
}

function formatElapsedMs(durationMs: number): string {
	if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))}ms`;
	const seconds = durationMs / 1_000;
	return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
}

function nextActionsForOutcome(
	outcome: DapWaitForExecutionOutcome,
	waitReason: DebugWaitReason,
	triggerJob?: JobSnapshot,
): DebugNextAction[] {
	if (outcome.state === "stopped") {
		const actions: DebugNextAction[] = [
			{ tool: "debug", input: { action: "continue", wait_for_stop: false }, when: "Resume after inspection" },
		];
		if (triggerJob?.status === "running") {
			actions.push({
				tool: "hub",
				input: { op: "wait", ids: [triggerJob.id] },
				when: "After resume, collect trigger",
			});
		}
		return actions;
	}
	if (outcome.state !== "running" || (waitReason !== "timeout" && waitReason !== "trigger")) return [];
	const waitInput: Record<string, unknown> = {
		action: "wait_for_stop",
		execution_id: outcome.executionId,
	};
	if (triggerJob?.status === "running") waitInput.trigger_job_id = triggerJob.id;
	return [{ tool: "debug", input: waitInput, when: "Continue observing the same execution" }];
}

function formatNextActions(actions: readonly DebugNextAction[]): string[] {
	if (actions.length === 0) return [];
	return ["Next:", ...actions.map(action => `${action.when}: ${JSON.stringify(action.input)}`)];
}

function applyExecutionOutcomeDetails(details: DebugToolDetails, outcome: DapWaitForExecutionOutcome): void {
	details.snapshot = outcome.snapshot;
	details.state = outcome.state;
	details.timedOut = outcome.timedOut;
	details.executionId = outcome.executionId;
	details.stopSnapshot = outcome.stopSnapshot;
	details.waitReason = waitReasonForOutcome(outcome);
	details.nextActions = nextActionsForOutcome(outcome, details.waitReason);
}

function formatLocation(snapshot: DapSessionSummary | undefined): string | null {
	if (!snapshot?.source?.path || snapshot.line === undefined) {
		return null;
	}
	return `${snapshot.source.path}:${snapshot.line}${snapshot.column !== undefined ? `:${snapshot.column}` : ""}`;
}

function formatSessionSnapshot(snapshot: DapSessionSummary): string[] {
	const lines = [
		`Session ${snapshot.id}`,
		`Adapter: ${snapshot.adapter}`,
		`Status: ${snapshot.status}`,
		`CWD: ${snapshot.cwd}`,
	];
	if (snapshot.program) lines.push(`Program: ${snapshot.program}`);
	if (snapshot.stopReason) lines.push(`Stop reason: ${snapshot.stopReason}`);
	if (snapshot.frameName) lines.push(`Frame: ${snapshot.frameName}`);
	if (snapshot.instructionPointerReference) {
		lines.push(`Instruction pointer: ${snapshot.instructionPointerReference}`);
	}
	const location = formatLocation(snapshot);
	if (location) lines.push(`Location: ${location}`);
	if (snapshot.needsConfigurationDone) {
		lines.push("Configuration: pending configurationDone; set breakpoints, then continue.");
	}
	if (snapshot.exitCode !== undefined) lines.push(`Exit code: ${snapshot.exitCode}`);
	return lines;
}

function formatBreakpoints(filePath: string, breakpoints: DapBreakpointRecord[]): string {
	const lines = [`Breakpoints for ${filePath}:`];
	if (breakpoints.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const breakpoint of breakpoints) {
		lines.push(
			`- line ${breakpoint.line}: ${breakpoint.verified ? "verified" : "pending"}${breakpoint.condition ? ` if ${breakpoint.condition}` : ""}${breakpoint.message ? ` (${breakpoint.message})` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatFunctionBreakpoints(breakpoints: DapFunctionBreakpointRecord[]): string {
	const lines = ["Function breakpoints:"];
	if (breakpoints.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const breakpoint of breakpoints) {
		lines.push(
			`- ${breakpoint.name}: ${breakpoint.verified ? "verified" : "pending"}${breakpoint.condition ? ` if ${breakpoint.condition}` : ""}${breakpoint.message ? ` (${breakpoint.message})` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatStackFrames(frames: DapStackFrame[]): string {
	const lines = ["Stack trace:"];
	if (frames.length === 0) {
		lines.push("(empty)");
		return lines.join("\n");
	}
	for (const frame of frames) {
		const location = frame.source?.path
			? `${frame.source.path}:${frame.line}:${frame.column}`
			: `<unknown>:${frame.line}:${frame.column}`;
		lines.push(`- #${frame.id} ${frame.name} @ ${location}`);
	}
	return lines.join("\n");
}

function formatThreads(threads: DapThread[]): string {
	const lines = ["Threads:"];
	if (threads.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const thread of threads) {
		lines.push(`- ${thread.id}: ${thread.name}`);
	}
	return lines.join("\n");
}

function formatScopes(scopes: DapScope[]): string {
	const lines = ["Scopes:"];
	if (scopes.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const scope of scopes) {
		lines.push(
			`- ${scope.name}: ref=${scope.variablesReference}, expensive=${scope.expensive ? "yes" : "no"}${scope.presentationHint ? `, hint=${scope.presentationHint}` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatVariables(variables: DapVariable[]): string {
	const lines = ["Variables:"];
	if (variables.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const variable of variables) {
		lines.push(
			`- ${variable.name} = ${variable.value}${variable.type ? ` (${variable.type})` : ""}${variable.variablesReference > 0 ? ` [ref=${variable.variablesReference}]` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatSourceLabel(source: DapSource | undefined, line?: number, column?: number): string | null {
	if (!source?.path && !source?.name) {
		return null;
	}
	const base = source.path ?? source.name ?? "<unknown>";
	if (line === undefined) {
		return base;
	}
	return `${base}:${line}${column !== undefined ? `:${column}` : ""}`;
}

function formatDisassembly(instructions: DapDisassembledInstruction[]): string {
	const lines = ["Disassembly:"];
	if (instructions.length === 0) {
		lines.push("(empty)");
		return lines.join("\n");
	}
	const addressWidth = Math.max(...instructions.map(instruction => instruction.address.length));
	const bytesWidth = Math.max(...instructions.map(instruction => instruction.instructionBytes?.length ?? 0), 2);
	for (const instruction of instructions) {
		const location = formatSourceLabel(instruction.location, instruction.line, instruction.column);
		const parts = [
			instruction.address.padEnd(addressWidth),
			(instruction.instructionBytes ?? "").padEnd(bytesWidth),
			instruction.instruction,
		];
		if (instruction.symbol) {
			parts.push(`<${instruction.symbol}>`);
		}
		if (location) {
			parts.push(`[${location}]`);
		}
		lines.push(
			parts
				.filter(part => part.length > 0)
				.join("  ")
				.trimEnd(),
		);
	}
	return lines.join("\n");
}

function formatMemoryRead(address: string, data: string | undefined, unreadableBytes?: number): string {
	const lines = [`Memory at ${address}:`];
	const buffer = data ? Buffer.from(data, "base64") : Buffer.alloc(0);
	if (buffer.length === 0) {
		lines.push("(no readable bytes)");
	} else {
		for (let offset = 0; offset < buffer.length; offset += 16) {
			const chunk = buffer.subarray(offset, offset + 16);
			const hex = Array.from(chunk, byte => byte.toString(16).padStart(2, "0")).join(" ");
			const ascii = Array.from(chunk, byte => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".")).join("");
			lines.push(
				`${(offset === 0 ? address : `+0x${offset.toString(16)}`).padEnd(18)} ${hex.padEnd(47)} |${ascii}|`,
			);
		}
	}
	if (unreadableBytes !== undefined && unreadableBytes > 0) {
		lines.push(`Unreadable bytes: ${unreadableBytes}`);
	}
	return lines.join("\n");
}

function formatTable(headers: string[], rows: string[][]): string {
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...rows.map(row => (row[index] ?? "").length)),
	);
	const formatRow = (row: string[]) => row.map((cell, index) => (cell ?? "").padEnd(widths[index])).join("  ");
	return [formatRow(headers), formatRow(widths.map(width => "-".repeat(width))), ...rows.map(formatRow)].join("\n");
}

function formatModules(modules: DapModule[]): string {
	if (modules.length === 0) {
		return "Modules:\n(none)";
	}
	return [
		"Modules:",
		formatTable(
			["ID", "Name", "Path", "Symbols", "Range"],
			modules.map(module => [
				String(module.id),
				module.name,
				module.path ?? "",
				module.symbolStatus ?? "",
				module.addressRange ?? "",
			]),
		),
	].join("\n");
}

function formatLoadedSources(sources: DapSource[]): string {
	const lines = ["Loaded sources:"];
	if (sources.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const source of sources) {
		const label = source.path ?? source.name ?? "<unknown>";
		lines.push(`- ${label}${source.sourceReference !== undefined ? ` [ref=${source.sourceReference}]` : ""}`);
	}
	return lines.join("\n");
}

function formatInstructionBreakpoints(breakpoints: DapInstructionBreakpointRecord[]): string {
	const lines = ["Instruction breakpoints:"];
	if (breakpoints.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const breakpoint of breakpoints) {
		const location = `${breakpoint.instructionReference}${breakpoint.offset !== undefined ? `+${breakpoint.offset}` : ""}`;
		lines.push(
			`- ${location}: ${breakpoint.verified ? "verified" : "pending"}${breakpoint.condition ? ` if ${breakpoint.condition}` : ""}${breakpoint.hitCondition ? ` after ${breakpoint.hitCondition}` : ""}${breakpoint.message ? ` (${breakpoint.message})` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatDataBreakpointInfo(info: DapDataBreakpointInfoResponse): string {
	const lines = [`Data breakpoint info: ${info.description}`];
	lines.push(`Data ID: ${info.dataId ?? "(not available)"}`);
	if (info.accessTypes && info.accessTypes.length > 0) {
		lines.push(`Access types: ${info.accessTypes.join(", ")}`);
	}
	if (info.canPersist !== undefined) {
		lines.push(`Persistent: ${info.canPersist ? "yes" : "no"}`);
	}
	return lines.join("\n");
}

function formatDataBreakpoints(breakpoints: DapDataBreakpointRecord[]): string {
	const lines = ["Data breakpoints:"];
	if (breakpoints.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const breakpoint of breakpoints) {
		lines.push(
			`- ${breakpoint.dataId}: ${breakpoint.verified ? "verified" : "pending"}${breakpoint.accessType ? ` (${breakpoint.accessType})` : ""}${breakpoint.condition ? ` if ${breakpoint.condition}` : ""}${breakpoint.hitCondition ? ` after ${breakpoint.hitCondition}` : ""}${breakpoint.message ? ` (${breakpoint.message})` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatCustomResponse(command: string, body: unknown): string {
	let serialized = "";
	try {
		serialized = JSON.stringify(body, null, 2) ?? "null";
	} catch {
		serialized = Bun.inspect(body);
	}
	return `${command} response:\n${serialized}`;
}

function formatSessions(sessions: DapSessionSummary[]): string {
	if (sessions.length === 0) {
		return "No debug sessions.";
	}
	return sessions
		.map(session => {
			const location = formatLocation(session);
			return [
				`${session.id}: ${session.status}`,
				`  adapter=${session.adapter}`,
				`  cwd=${session.cwd}`,
				...(session.program ? [`  program=${session.program}`] : []),
				...(location ? [`  location=${location}`] : []),
				...(session.stopReason ? [`  reason=${session.stopReason}`] : []),
			].join("\n");
		})
		.join("\n\n");
}

function formatEvaluation(evaluation: DapEvaluateResponse): string {
	const lines = [`Result: ${evaluation.result}`];
	if (evaluation.type) lines.push(`Type: ${evaluation.type}`);
	if (evaluation.variablesReference > 0) {
		lines.push(`Variables ref: ${evaluation.variablesReference}`);
	}
	return lines.join("\n");
}

function formatOutputSegments(segments: readonly DapOutputSegment[]): string {
	const blocks: string[] = [];
	for (const segment of segments) {
		const category = replaceTabs(segment.category).replaceAll("\r", " ").replaceAll("\n", " ");
		const output = segment.output.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
		const outputLines = output.split("\n");
		while (outputLines.at(-1) === "") outputLines.pop();
		if (outputLines.length === 0) {
			blocks.push(`[${category}]`);
			continue;
		}
		blocks.push(outputLines.map((line, index) => `${index === 0 ? `[${category}] ` : "  "}${line}`).join("\n"));
	}
	return blocks.join("\n");
}

function formatStopSnapshot(snapshot: DapStopSnapshot): string {
	const lines = [
		`Stop snapshot: ${snapshot.complete ? "complete" : "partial"}`,
		`Stopped: session=${snapshot.sessionId}, generation=${snapshot.stopGeneration}, reason=${snapshot.stoppedEvent.reason}` +
			`${snapshot.stoppedEvent.threadId !== undefined ? `, thread=${snapshot.stoppedEvent.threadId}` : ""}`,
		`Threads (${snapshot.threads.length}${snapshot.threadsTruncated ? "+" : ""}):`,
	];
	const append = (text: string): void => {
		lines.push(truncateToWidth(replaceTabs(text), TRUNCATE_LENGTHS.LINE));
	};
	for (const thread of snapshot.threads) append(`- ${thread.id}: ${thread.name}`);
	append(`Stack (${snapshot.stackFrames.length}${snapshot.stackFramesTruncated ? "+" : ""}):`);
	for (const frame of snapshot.stackFrames) {
		const location = frame.source?.path
			? `${shortenPath(frame.source.path)}:${frame.line}:${frame.column}`
			: `<unknown>:${frame.line}:${frame.column}`;
		append(`- #${frame.id} ${frame.name} @ ${location}`);
	}
	append(`Scopes (${snapshot.scopes.length}${snapshot.scopesTruncated ? "+" : ""}):`);
	for (const scopeSnapshot of snapshot.scopes) {
		const { scope, variables } = scopeSnapshot;
		append(
			`- ${scope.name} [ref=${scope.variablesReference}] (${variables.length}${scopeSnapshot.variablesTruncated ? "+" : ""} variables):`,
		);
		for (const variable of variables) {
			append(
				`  ${variable.name} = ${variable.value}` +
					`${variable.type ? ` (${variable.type})` : ""}` +
					`${variable.variablesReference > 0 ? ` [ref=${variable.variablesReference}]` : ""}`,
			);
		}
		if (scopeSnapshot.truncatedValueCount > 0) {
			append(`  ${scopeSnapshot.truncatedValueCount} variable value(s) truncated.`);
		}
	}
	if (snapshot.output.length > 0) {
		append(`Output at stop (generation ${snapshot.stopGeneration})${snapshot.outputTruncated ? " (tail)" : ""}:`);
		const categorizedOutput = formatOutputSegments(snapshot.outputSegments);
		const outputLines = categorizedOutput.split("\n");
		const visibleOutputLines = outputLines.slice(0, PREVIEW_LIMITS.OUTPUT_EXPANDED);
		for (const outputLine of visibleOutputLines) append(outputLine);
		if (outputLines.length > visibleOutputLines.length) {
			append(`… ${outputLines.length - visibleOutputLines.length} more output lines`);
		}
	}
	if (snapshot.errors.length > 0) {
		append("Capture errors:");
		for (const error of snapshot.errors) {
			append(`- ${error.stage}${error.scopeName ? ` (${error.scopeName})` : ""}: ${error.message}`);
		}
	}
	return lines.join("\n");
}

function buildOutcomeText(
	outcome: DapWaitForExecutionOutcome,
	timeoutSec: number,
	verb: string,
	waitReason: DebugWaitReason = waitReasonForOutcome(outcome),
	triggerJob?: JobSnapshot,
): string {
	const lines = [
		`Execution: ${outcome.executionId}`,
		`Winner: ${waitReason}`,
		`Trigger: ${triggerJob ? `${triggerJob.id} (${triggerJob.status})` : "none"}`,
		"",
		...formatSessionSnapshot(outcome.snapshot),
	];
	if (waitReason === "timeout") {
		lines.push(
			`Observation timed out after ${timeoutSec}s. Debug execution and any running trigger remain active. Do not replay the request.`,
		);
	} else if (waitReason === "trigger" && outcome.state === "running") {
		lines.push(
			"Trigger finished before a debugger stop. The debug execution remains active. Inspect the trigger result. Do not replay the request.",
		);
	} else if (outcome.state === "stopped") {
		lines.push(`${verb} stopped at ${formatLocation(outcome.snapshot) ?? "unknown location"}.`);
	} else if (outcome.state === "terminated") {
		lines.push(
			`Program terminated${outcome.snapshot.exitCode !== undefined ? ` with exit code ${outcome.snapshot.exitCode}` : ""}.`,
		);
	} else {
		lines.push("Program is running.");
	}
	if (outcome.stopSnapshot) lines.push("", formatStopSnapshot(outcome.stopSnapshot));
	if (triggerJob) lines.push("", formatTriggerJob(triggerJob));
	const nextActions = nextActionsForOutcome(outcome, waitReason, triggerJob);
	if (nextActions.length > 0) lines.push("", ...formatNextActions(nextActions));
	return lines.join("\n");
}

function getConfiguredAdapters(cwd: string): string {
	const adapters = getAvailableAdapters(cwd).map(adapter => adapter.name);
	const names = adapters.length > 0 ? adapters.join(", ") : "none";
	return truncateToWidth(replaceTabs(names), TRUNCATE_LENGTHS.LONG);
}

const ADAPTER_UNAVAILABLE_MESSAGES: Readonly<Record<string, string>> = {
	debugpy: "adapter 'debugpy' is not available: python not found in PATH",
	dlv: "adapter 'dlv' is not available: install with 'go install github.com/go-delve/delve/cmd/dlv@latest'",
	rdbg: "adapter 'rdbg' is not available: install with 'gem install debug'",
	"js-debug-adapter":
		"adapter 'js-debug-adapter' is not available: download it from https://github.com/microsoft/vscode-js-debug",
};

const ADAPTER_CANONICAL_COMMANDS: Readonly<Record<string, string>> = {
	debugpy: "python",
	dlv: "dlv",
	rdbg: "rdbg",
	"js-debug-adapter": "js-debug-adapter",
};

function formatAdapterUnavailable(
	adapterName: string,
	command: string,
	cwd: string,
	availableAdapters?: string,
): string {
	const displayName = truncateToWidth(replaceTabs(adapterName), TRUNCATE_LENGTHS.SHORT);
	const canonicalCommand = ADAPTER_CANONICAL_COMMANDS[adapterName] ?? adapterName;
	if (command !== canonicalCommand) {
		const displayCommand = truncateToWidth(replaceTabs(shortenPath(command)), TRUNCATE_LENGTHS.CONTENT);
		return `adapter '${displayName}' is not available: configured command '${displayCommand}' did not resolve. Check the DAP adapter config for this workspace.`;
	}
	return (
		ADAPTER_UNAVAILABLE_MESSAGES[adapterName] ??
		`adapter '${displayName}' is not available. Installed adapters: ${availableAdapters ?? getConfiguredAdapters(cwd)}`
	);
}

function getAdapterStatuses(cwd: string): DebugAdapterStatus[] {
	const configs = getAdapterConfigs(cwd);
	const availableAdapters = getAvailableAdapters(cwd);
	const availableByName = new Map(availableAdapters.map(adapter => [adapter.name, adapter]));
	const availableNames =
		availableAdapters.length > 0 ? availableAdapters.map(adapter => adapter.name).join(", ") : "none";
	return Object.entries(configs)
		.map(([name, config]): DebugAdapterStatus => {
			const adapter = availableByName.get(name);
			if (adapter) {
				return {
					name,
					command: config.command,
					available: true,
					resolvedCommand: adapter.resolvedCommand,
					languages: adapter.languages,
					fileTypes: adapter.fileTypes,
				};
			}
			return {
				name,
				command: config.command,
				available: false,
				languages: config.languages ?? [],
				fileTypes: config.fileTypes ?? [],
				hint: formatAdapterUnavailable(name, config.command, cwd, availableNames),
			};
		})
		.sort((left, right) => left.name.localeCompare(right.name));
}

function formatAdapterStatuses(cwd: string, adapters: readonly DebugAdapterStatus[]): string {
	const lines = [`Adapters for ${shortenPath(cwd)}:`];
	for (const adapter of adapters) {
		const name = truncateToWidth(replaceTabs(adapter.name), TRUNCATE_LENGTHS.SHORT);
		if (adapter.available) {
			const command = truncateToWidth(
				replaceTabs(shortenPath(adapter.resolvedCommand ?? adapter.command)),
				TRUNCATE_LENGTHS.CONTENT,
			);
			lines.push(`- ${name}: available (${command})`);
			continue;
		}
		lines.push(`- ${name}: missing`);
		if (adapter.hint) lines.push(`  ${adapter.hint}`);
	}
	return lines.join("\n");
}

async function classifyLaunchProgram(program: string): Promise<LaunchProgramKind> {
	try {
		return (await fs.stat(program)).isDirectory() ? "directory" : "file";
	} catch (error) {
		if (isEnoent(error)) return "missing";
		throw error;
	}
}

function validateLaunchProgram(
	program: string,
	cwd: string,
	programKind: LaunchProgramKind,
	adapter: DapResolvedAdapter,
): void {
	if (programKind !== "directory" || adapter.acceptsDirectoryProgram) return;
	const displayPath = formatPathRelativeToCwd(program, cwd, { trailingSlash: true });
	throw new ToolError(
		`launch program resolves to a directory: ${displayPath}. Pass an executable file path or choose an adapter that supports package directories.`,
	);
}

interface DebugRenderArgs extends Partial<DebugParams> {}

function getActiveSessionSnapshot(): DapSessionSummary {
	const snapshot = dapSessionManager.getActiveSession();
	if (!snapshot) {
		throw new ToolError("No active debug session. Launch or attach first.");
	}
	return snapshot;
}

function requireCapability(capability: keyof DapCapabilities, description: string): DapSessionSummary {
	const snapshot = getActiveSessionSnapshot();
	if (dapSessionManager.getCapabilities()?.[capability] !== true) {
		throw new ToolError(`Current adapter does not support ${description}`);
	}
	return snapshot;
}

function resolveDisassemblyReference(memoryReference: string | undefined): string {
	if (memoryReference) {
		return memoryReference;
	}
	const snapshot = getActiveSessionSnapshot();
	if (snapshot.instructionPointerReference) {
		return snapshot.instructionPointerReference;
	}
	throw new ToolError(
		"disassemble requires memory_reference unless the current stop location has an instruction pointer reference",
	);
}

function summarizeDebugCall(args: DebugRenderArgs): string {
	const action = args.action ? args.action.replaceAll("_", " ") : "request";
	if (args.program) {
		return `${action} ${truncateToWidth(args.program, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.file && args.line !== undefined) {
		return `${action} ${truncateToWidth(`${args.file}:${args.line}`, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.function) {
		return `${action} ${truncateToWidth(args.function, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.expression) {
		return `${action} ${truncateToWidth(args.expression, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.command) {
		return `${action} ${truncateToWidth(args.command, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.memory_reference) {
		return `${action} ${truncateToWidth(args.memory_reference, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.instruction_reference) {
		return `${action} ${truncateToWidth(args.instruction_reference, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.data_id) {
		return `${action} ${truncateToWidth(args.data_id, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.name) {
		return `${action} ${truncateToWidth(args.name, TRUNCATE_LENGTHS.TITLE)}`;
	}
	return action;
}

const DEBUG_ACCENT_FIELDS: Record<string, true> = {
	CWD: true,
	"Data ID": true,
	Execution: true,
	Frame: true,
	Function: true,
	"Instruction pointer": true,
	Location: true,
	Program: true,
	"Session ID": true,
	Variable: true,
	"Variables ref": true,
};

const DEBUG_MUTED_FIELDS: Record<string, true> = {
	"Access types": true,
	"Bytes written": true,
	Configuration: true,
	"Exit code": true,
	Offset: true,
	Persistent: true,
	"Stop reason": true,
	"Stop snapshot": true,
	"Trigger deadline": true,
	Type: true,
	"Unreadable bytes": true,
};

function debugStatusColor(status: string): ThemeColor {
	switch (status.trim().toLowerCase()) {
		case "running":
			return "accent";
		case "stopped":
			return "warning";
		case "terminated":
			return "success";
		case "error":
		case "failed":
		case "missing":
			return "error";
		default:
			return "toolOutput";
	}
}

function styleDebugLines(lines: readonly string[], theme: Theme, isError = false): string[] {
	const styled: string[] = [];
	let outputContinuationColor: ThemeColor | undefined;
	let inNextActions = false;

	for (const line of lines) {
		if (line.length === 0) {
			styled.push(line);
			outputContinuationColor = undefined;
			continue;
		}
		if (isError) {
			styled.push(theme.fg("error", line));
			continue;
		}

		const categoryLine = /^\[([^\]]+)\](?: (.*))?$/.exec(line);
		if (categoryLine) {
			const category = categoryLine[1].toLowerCase();
			let labelColor: ThemeColor = "dim";
			outputContinuationColor = "toolOutput";
			if (category === "stderr") {
				labelColor = "error";
				outputContinuationColor = "error";
			} else if (category === "telemetry") {
				labelColor = "muted";
				outputContinuationColor = "muted";
			} else if (category === "important") {
				labelColor = "warning";
				outputContinuationColor = "warning";
			}
			const label = `[${categoryLine[1]}]`;
			styled.push(
				categoryLine[2] === undefined
					? theme.fg(labelColor, label)
					: `${theme.fg(labelColor, label)} ${theme.fg(outputContinuationColor, categoryLine[2])}`,
			);
			inNextActions = false;
			continue;
		}
		if (outputContinuationColor && line.startsWith("  ")) {
			const indentColor = outputContinuationColor === "toolOutput" ? "dim" : outputContinuationColor;
			styled.push(`${theme.fg(indentColor, line.slice(0, 2))}${theme.fg(outputContinuationColor, line.slice(2))}`);
			continue;
		}
		outputContinuationColor = undefined;

		if (line === "Next:") {
			styled.push(theme.fg("dim", line));
			inNextActions = true;
			continue;
		}
		if (inNextActions) {
			const nextAction = /^(.+?: )(\{.*)$/.exec(line);
			if (nextAction) {
				styled.push(`${theme.fg("dim", nextAction[1])}${theme.fg("toolOutput", nextAction[2])}`);
				continue;
			}
			inNextActions = false;
		}

		const session = /^(Session )(.+)$/.exec(line);
		if (session) {
			styled.push(`${theme.fg("dim", session[1])}${theme.fg("accent", session[2])}`);
			continue;
		}

		const field = /^([A-Za-z][A-Za-z ]*): (.*)$/.exec(line);
		if (field) {
			const label = field[1];
			const value = field[2];
			const prefix = theme.fg("dim", `${label}: `);
			if (label === "Trigger") {
				const trigger = /^(.*?)( \()([^()]*)\)$/.exec(value);
				styled.push(
					value === "none"
						? `${prefix}${theme.fg("muted", value)}`
						: trigger
							? `${prefix}${theme.fg("accent", trigger[1])}${theme.fg("dim", trigger[2])}${theme.fg(
									debugStatusColor(trigger[3]),
									trigger[3],
								)}${theme.fg("dim", ")")}`
							: `${prefix}${theme.fg("accent", value)}`,
				);
				continue;
			}

			let valueColor: ThemeColor = "toolOutput";
			if (DEBUG_ACCENT_FIELDS[label] === true) {
				valueColor = "accent";
			} else if (label === "Status" || label === "Winner") {
				valueColor = debugStatusColor(value);
			} else if (/error/i.test(label)) {
				valueColor = "error";
			} else if (DEBUG_MUTED_FIELDS[label] === true) {
				valueColor = "muted";
			}
			styled.push(`${prefix}${theme.fg(valueColor, value)}`);
			continue;
		}

		if (/^[^\s].*:$/.test(line)) {
			styled.push(theme.fg("dim", line));
			continue;
		}
		const treeLine = /^(\s*(?:[-*] |[│├└─]+\s*))(.*)$/u.exec(line);
		if (treeLine) {
			styled.push(`${theme.fg("dim", treeLine[1])}${theme.fg("toolOutput", treeLine[2])}`);
			continue;
		}

		styled.push(theme.fg("toolOutput", line));
	}

	return styled;
}

export const debugToolRenderer = {
	animatedPartialResult: true,
	renderCall(args: DebugRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
		const text = renderStatusLine({ icon: "pending", title: "Debug", description: summarizeDebugCall(args) }, theme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: DebugToolDetails; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: DebugRenderArgs,
	): Component {
		const outputBlock = new CachedOutputBlock();
		return markFramedBlockComponent({
			render(width: number): readonly string[] {
				const action = (args?.action ?? result.details?.action ?? "debug").replaceAll("_", " ");
				const success = !options.isPartial && !result.isError;
				const statusIcon = success
					? theme.styledSymbol("tool.debug", "accent")
					: formatStatusIcon(options.isPartial ? "running" : "error", theme, options.spinnerFrame);
				const header = `${statusIcon} Debug ${action}`;
				const summaryLines = result.details?.snapshot
					? styleDebugLines(
							formatSessionSnapshot(result.details.snapshot).map(line => replaceTabs(line)),
							theme,
						)
					: [];
				const text = result.content.find(block => block.type === "text")?.text ?? "No output";
				const rawLines = replaceTabs(text).split("\n");
				const previewLimit = options.expanded ? rawLines.length : PREVIEW_LIMITS.COLLAPSED_LINES;
				const displayedLines = styleDebugLines(
					rawLines.slice(0, previewLimit).map(line => truncateToWidth(line, TRUNCATE_LENGTHS.LINE)),
					theme,
					result.isError,
				);
				const remaining = rawLines.length - displayedLines.length;
				if (remaining > 0) {
					displayedLines.push(
						theme.fg("muted", `… ${remaining} more lines ${formatExpandHint(theme, options.expanded, true)}`),
					);
				}
				return outputBlock.render(
					{
						header,
						state: result.isError ? "error" : "success",
						sections: [
							...(summaryLines.length > 0
								? [{ label: theme.fg("toolTitle", "Session"), lines: summaryLines }]
								: []),
							{ label: theme.fg("toolTitle", "Output"), lines: displayedLines },
						],
						width,
						applyBg: false,
					},
					theme,
				);
			},
			invalidate() {
				outputBlock.invalidate();
			},
		});
	},
	mergeCallAndResult: true,
	inline: true,
};

export class DebugTool implements AgentTool<typeof debugSchema, DebugToolDetails> {
	readonly name = "debug";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const rawAction = (args as Partial<DebugParams>).action;
		const action = typeof rawAction === "string" ? rawAction.toLowerCase() : "";
		return DEBUG_READONLY_ACTIONS.has(action) ? "read" : "exec";
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<DebugParams>;
		const lines = [`Action: ${typeof params.action === "string" ? params.action : "(missing)"}`];
		if (typeof params.program === "string" && params.program.length > 0) {
			lines.push(`Program: ${truncateForPrompt(params.program)}`);
		}
		return lines;
	};
	readonly label = "Debug";
	readonly summary = "Debug a running process with DAP (debugger adapter protocol)";
	readonly description: string;
	readonly parameters = debugSchema;
	readonly strict = true;
	readonly interruptible = (params: Partial<DebugParams>): boolean => {
		if (params.action === "wait_for_stop") return true;
		if (params.action === "output" && params.wait_for !== undefined) return true;
		if (params.action === "continue") return params.wait_for_stop !== false;
		return params.action === "step_over" || params.action === "step_in" || params.action === "step_out";
	};

	readonly examples: readonly ToolExample<typeof debugSchema.infer>[] = [
		{
			caption: "Launch and inspect hang",
			note: '1. debug(action: "launch", program: "./my_app")\n2. debug(action: "set_breakpoint", file: "src/main.c", line: 42)\n3. debug(action: "continue")\n4. If the program appears hung: debug(action: "pause")\n5. Inspect state with `threads`, `stack_trace`, `scopes`, and `variables`',
		},
		{
			caption: "Launch a Python script with debugpy",
			call: { action: "launch", adapter: "debugpy", program: "scripts/job.py", args: ["--flag"] },
		},
		{
			caption: "Raw debugger command through repl",
			call: { action: "evaluate", expression: "info registers", context: "repl" },
		},
	];

	readonly concurrency = "exclusive";
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(debugDescription);
	}

	static createIf(session: ToolSession): DebugTool | null {
		return session.settings.get("debug.enabled") ? new DebugTool(session) : null;
	}

	#resolveTriggerJob(triggerJobId: string | undefined): TriggerJobContext | undefined {
		if (triggerJobId === undefined) return undefined;
		const id = triggerJobId.trim();
		if (!id) throw new ToolError("trigger_job_id must be a non-empty background Bash job id");
		const manager = this.session.asyncJobManager;
		if (!manager) throw new ToolError("Background job manager unavailable for this session.");
		const job = manager.getJob(id);
		const ownerId = this.session.getAgentId?.() ?? undefined;
		const scopeId = this.session.getAgentScopeId?.() ?? undefined;
		if (!job || job.ownerId !== ownerId || job.scopeId !== scopeId) {
			throw new ToolError(`Background job "${id}" is not visible to this session.`);
		}
		if (job.type !== "bash") {
			throw new ToolError(`Background job "${id}" has type "${job.type}"; trigger_job_id requires a Bash job.`);
		}
		return { manager, job };
	}

	async #waitForStop(
		executionId: string,
		triggerJobId: string | undefined,
		signal: AbortSignal | undefined,
		timeoutMs: number,
	): Promise<CoordinatedWaitResult> {
		const trigger = this.#resolveTriggerJob(triggerJobId);
		const observationAbort = new AbortController();
		const observationSignal = signal ? AbortSignal.any([signal, observationAbort.signal]) : observationAbort.signal;
		const waitStartedAt = Date.now();
		const deadline = waitStartedAt + timeoutMs;
		const timeout = Promise.withResolvers<WaitObservation>();
		const timeoutId = setTimeout(() => timeout.resolve({ kind: "timeout" }), timeoutMs);
		let triggerConsumed = false;

		if (trigger) {
			trigger.manager.watchJobs([trigger.job.id]);
			trigger.manager.acknowledgeDeliveries([trigger.job.id]);
		}
		try {
			throwIfAborted(signal);
			const dapObservation = dapSessionManager
				.waitForExecution(executionId, observationSignal, Number.POSITIVE_INFINITY)
				.then(
					outcome => ({ kind: "dap" as const, outcome }),
					error => ({ kind: "dap_error" as const, error }),
				);
			const racers: Promise<WaitObservation>[] = [dapObservation, timeout.promise];
			if (trigger) racers.push(trigger.job.promise.then(() => ({ kind: "trigger" as const })));
			const observed = await Promise.race(racers);
			throwIfAborted(signal);
			if (observed.kind === "dap_error") throw observed.error;

			let outcome = observed.kind === "dap" ? observed.outcome : undefined;
			let rawOutcome = dapSessionManager.getExecutionOutcome(executionId);
			if (!outcome && rawOutcome) {
				const materialized = await dapObservation;
				throwIfAborted(signal);
				if (materialized.kind === "dap_error") throw materialized.error;
				outcome = materialized.outcome;
			}
			outcome ??= await dapSessionManager.waitForExecution(executionId, signal, 0);
			rawOutcome = dapSessionManager.getExecutionOutcome(executionId);
			if (rawOutcome && outcome.settledAt !== rawOutcome.settledAt) {
				outcome = await dapSessionManager.waitForExecution(executionId, signal, timeoutMs);
			}

			const triggerJob = trigger ? snapshotTriggerJob(this.session, trigger.job) : undefined;
			const candidates: Array<{ reason: DebugWaitReason; settledAt: number; priority: number }> = [];
			rawOutcome = dapSessionManager.getExecutionOutcome(executionId);
			if (rawOutcome) {
				candidates.push({
					reason: rawOutcome.reason === "stopped" ? "stopped" : "target_terminal",
					settledAt: rawOutcome.settledAt,
					priority: rawOutcome.reason === "stopped" ? 0 : 1,
				});
			}
			if (triggerJob?.settledAt !== undefined) {
				candidates.push({ reason: "trigger", settledAt: triggerJob.settledAt, priority: 2 });
			}
			candidates.push({ reason: "timeout", settledAt: deadline, priority: 3 });
			candidates.sort((left, right) => left.settledAt - right.settledAt || left.priority - right.priority);
			const waitReason = candidates[0]?.reason ?? "timeout";

			if (waitReason === "timeout") {
				outcome = { ...outcome, reason: "timeout", timedOut: true };
			} else if (outcome.reason === "timeout") {
				outcome = { ...outcome, timedOut: false };
			}
			triggerConsumed = triggerJob?.settledAt !== undefined;
			return { outcome, waitReason, ...(triggerJob ? { triggerJob } : {}) };
		} finally {
			clearTimeout(timeoutId);
			observationAbort.abort();
			if (trigger) {
				trigger.manager.unwatchJobs([trigger.job.id]);
				if (triggerConsumed) {
					trigger.manager.acknowledgeDeliveries([trigger.job.id]);
				} else {
					trigger.manager.resumeDeliveries([trigger.job.id]);
				}
			}
		}
	}

	async execute(
		_toolCallId: string,
		params: DebugParams,
		inputSignal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<DebugToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<DebugToolDetails>> {
		const timeoutSec = clampTimeout("debug", params.timeout, this.session.settings.get("tools.maxTimeout"));
		const timeoutSignal = AbortSignal.timeout(timeoutSec * 1000);
		const signal = inputSignal ? AbortSignal.any([inputSignal, timeoutSignal]) : timeoutSignal;
		const details: DebugToolDetails = { action: params.action, success: true };
		const result = toolResult(details);
		if (params.wait_for_stop !== undefined && params.action !== "continue") {
			throw new ToolError("wait_for_stop is only valid for continue");
		}
		if (params.execution_id !== undefined && params.action !== "wait_for_stop") {
			throw new ToolError("execution_id is only valid for wait_for_stop");
		}
		if (params.trigger_job_id !== undefined && params.action !== "wait_for_stop") {
			throw new ToolError("trigger_job_id is only valid for wait_for_stop");
		}
		if (params.wait_for !== undefined && params.action !== "output") {
			throw new ToolError("wait_for is only valid for output");
		}
		if (params.all_output !== undefined && params.action !== "output") {
			throw new ToolError("all_output is only valid for output");
		}
		switch (params.action) {
			case "adapters": {
				const commandCwd = params.cwd ? resolveToCwd(params.cwd, this.session.cwd) : this.session.cwd;
				const adapters = getAdapterStatuses(commandCwd);
				details.adapters = adapters;
				return result.text(formatAdapterStatuses(commandCwd, adapters)).done();
			}
			case "launch": {
				if (!params.program) {
					throw new ToolError("program is required for launch");
				}
				const commandCwd = params.cwd ? resolveToCwd(params.cwd, this.session.cwd) : this.session.cwd;
				const program = resolveToCwd(params.program, commandCwd);
				const programKind = await classifyLaunchProgram(program);
				const selection = selectLaunchAdapter(program, commandCwd, params.adapter, programKind);
				if (selection.kind === "unavailable") {
					throw new ToolError(formatAdapterUnavailable(selection.adapterName, selection.command, commandCwd));
				}
				if (selection.kind === "none") {
					throw new ToolError(
						`No debugger adapter available. Installed adapters: ${getConfiguredAdapters(commandCwd)}`,
					);
				}
				const { adapter } = selection;
				validateLaunchProgram(program, commandCwd, programKind, adapter);
				const extraLaunchArguments = resolveLaunchOverrides(adapter, program, programKind);
				let snapshot = await dapSessionManager.launch(
					{ adapter, program, args: params.args, cwd: commandCwd, extraLaunchArguments },
					signal,
					timeoutSec * 1000,
				);
				if (snapshot.status === "stopped") {
					details.stopSnapshot = await dapSessionManager.captureStopSnapshot(
						snapshot.id,
						signal,
						timeoutSec * 1000,
					);
					snapshot = details.stopSnapshot.summary;
				}
				details.snapshot = snapshot;
				details.adapter = adapter.name;
				return result
					.text(
						[
							...formatSessionSnapshot(snapshot),
							...(details.stopSnapshot ? ["", formatStopSnapshot(details.stopSnapshot)] : []),
						].join("\n"),
					)
					.done();
			}
			case "attach": {
				if (params.pid === undefined && params.port === undefined) {
					throw new ToolError("attach requires pid or port");
				}
				const workspaceCwd = this.session.cwd;
				const runtimeCwd = params.cwd ? resolveToCwd(params.cwd, workspaceCwd) : workspaceCwd;
				const adapter = selectAttachAdapter(workspaceCwd, params.adapter, params.port);
				if (!adapter) {
					if (params.adapter) {
						const command = getAdapterConfigs(workspaceCwd)[params.adapter]?.command ?? params.adapter;
						throw new ToolError(formatAdapterUnavailable(params.adapter, command, workspaceCwd));
					}
					throw new ToolError(
						`No debugger adapter available. Installed adapters: ${getConfiguredAdapters(workspaceCwd)}`,
					);
				}
				let snapshot = await dapSessionManager.attach(
					{ adapter, cwd: runtimeCwd, pid: params.pid, port: params.port, host: params.host },
					signal,
					timeoutSec * 1000,
				);
				if (snapshot.status === "stopped") {
					details.stopSnapshot = await dapSessionManager.captureStopSnapshot(
						snapshot.id,
						signal,
						timeoutSec * 1000,
					);
					snapshot = details.stopSnapshot.summary;
				}
				details.snapshot = snapshot;
				details.adapter = adapter.name;
				return result
					.text(
						[
							...formatSessionSnapshot(snapshot),
							...(details.stopSnapshot ? ["", formatStopSnapshot(details.stopSnapshot)] : []),
						].join("\n"),
					)
					.done();
			}
			case "set_breakpoint": {
				if (params.function) {
					const response = await dapSessionManager.setFunctionBreakpoint(
						params.function,
						params.condition,
						signal,
						timeoutSec * 1000,
					);
					details.snapshot = response.snapshot;
					details.functionBreakpoints = response.breakpoints;
					return result.text(formatFunctionBreakpoints(response.breakpoints)).done();
				}
				if (!params.file || params.line === undefined) {
					throw new ToolError("set_breakpoint requires file+line or function");
				}
				const file = resolveToCwd(params.file, this.session.cwd);
				const response = await dapSessionManager.setBreakpoint(
					file,
					params.line,
					params.condition,
					signal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.breakpoints = response.breakpoints;
				return result.text(formatBreakpoints(response.sourcePath, response.breakpoints)).done();
			}
			case "remove_breakpoint": {
				if (params.function) {
					const response = await dapSessionManager.removeFunctionBreakpoint(
						params.function,
						signal,
						timeoutSec * 1000,
					);
					details.snapshot = response.snapshot;
					details.functionBreakpoints = response.breakpoints;
					return result.text(formatFunctionBreakpoints(response.breakpoints)).done();
				}
				if (!params.file || params.line === undefined) {
					throw new ToolError("remove_breakpoint requires file+line or function");
				}
				const file = resolveToCwd(params.file, this.session.cwd);
				const response = await dapSessionManager.removeBreakpoint(file, params.line, signal, timeoutSec * 1000);
				details.snapshot = response.snapshot;
				details.breakpoints = response.breakpoints;
				return result.text(formatBreakpoints(response.sourcePath, response.breakpoints)).done();
			}
			case "set_instruction_breakpoint": {
				requireCapability("supportsInstructionBreakpoints", "instruction breakpoints");
				if (!params.instruction_reference) {
					throw new ToolError("instruction_reference is required for set_instruction_breakpoint");
				}
				const response = await dapSessionManager.setInstructionBreakpoint(
					params.instruction_reference,
					params.offset,
					params.condition,
					params.hit_condition,
					signal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.instructionBreakpoints = response.breakpoints;
				return result.text(formatInstructionBreakpoints(response.breakpoints)).done();
			}
			case "remove_instruction_breakpoint": {
				requireCapability("supportsInstructionBreakpoints", "instruction breakpoints");
				if (!params.instruction_reference) {
					throw new ToolError("instruction_reference is required for remove_instruction_breakpoint");
				}
				const response = await dapSessionManager.removeInstructionBreakpoint(
					params.instruction_reference,
					params.offset,
					signal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.instructionBreakpoints = response.breakpoints;
				return result.text(formatInstructionBreakpoints(response.breakpoints)).done();
			}
			case "data_breakpoint_info": {
				requireCapability("supportsDataBreakpoints", "data breakpoints");
				if (!params.name) {
					throw new ToolError("name is required for data_breakpoint_info");
				}
				const response = await dapSessionManager.dataBreakpointInfo(
					params.name,
					params.variable_ref ?? params.scope_id,
					params.frame_id,
					signal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.dataBreakpointInfo = response.info;
				return result.text(formatDataBreakpointInfo(response.info)).done();
			}
			case "set_data_breakpoint": {
				requireCapability("supportsDataBreakpoints", "data breakpoints");
				if (!params.data_id) {
					throw new ToolError("data_id is required for set_data_breakpoint");
				}
				const response = await dapSessionManager.setDataBreakpoint(
					params.data_id,
					params.access_type,
					params.condition,
					params.hit_condition,
					signal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.dataBreakpoints = response.breakpoints;
				return result.text(formatDataBreakpoints(response.breakpoints)).done();
			}
			case "remove_data_breakpoint": {
				requireCapability("supportsDataBreakpoints", "data breakpoints");
				if (!params.data_id) {
					throw new ToolError("data_id is required for remove_data_breakpoint");
				}
				const response = await dapSessionManager.removeDataBreakpoint(params.data_id, signal, timeoutSec * 1000);
				details.snapshot = response.snapshot;
				details.dataBreakpoints = response.breakpoints;
				return result.text(formatDataBreakpoints(response.breakpoints)).done();
			}
			case "continue": {
				if (params.wait_for_stop === false) {
					const started = await dapSessionManager.startContinue(signal, timeoutSec * 1000);
					const settled = dapSessionManager.getExecutionOutcome(started.executionId);
					details.snapshot = started.snapshot;
					details.state = started.state;
					details.executionId = started.executionId;
					if (settled) {
						details.waitReason = settled.reason === "stopped" ? "stopped" : "target_terminal";
					}
					const nextActions: DebugNextAction[] = [
						{
							tool: "debug",
							input: {
								action: "wait_for_stop",
								execution_id: started.executionId,
								trigger_job_id: "<background-bash-job-id>",
							},
							when: "After starting async Bash",
						},
					];
					details.nextActions = nextActions;
					return result
						.text(
							[
								`Execution: ${started.executionId}`,
								`Winner: ${details.waitReason ?? "pending"}`,
								"Trigger: none",
								"",
								...formatSessionSnapshot(started.snapshot),
								...formatNextActions(nextActions),
							].join("\n"),
						)
						.done();
				}
				const outcome = await dapSessionManager.continue(signal, timeoutSec * 1000);
				applyExecutionOutcomeDetails(details, outcome);
				return result.text(buildOutcomeText(outcome, timeoutSec, "Continue")).done();
			}
			case "wait_for_stop": {
				const executionId = params.execution_id?.trim();
				if (!executionId) throw new ToolError("execution_id is required for wait_for_stop");
				if (!dapSessionManager.getActiveSession()) {
					throw new ToolError("No active debug session. Launch or attach first.");
				}
				if (!dapSessionManager.hasExecution(executionId)) {
					throw new ToolError(`Unknown debug execution "${executionId}".`);
				}
				const coordinated = await this.#waitForStop(executionId, params.trigger_job_id, signal, timeoutSec * 1000);
				applyExecutionOutcomeDetails(details, coordinated.outcome);
				details.waitReason = coordinated.waitReason;
				details.triggerJob = coordinated.triggerJob;
				details.nextActions = nextActionsForOutcome(
					coordinated.outcome,
					coordinated.waitReason,
					coordinated.triggerJob,
				);
				return result
					.text(
						buildOutcomeText(
							coordinated.outcome,
							timeoutSec,
							"Execution",
							coordinated.waitReason,
							coordinated.triggerJob,
						),
					)
					.done();
			}
			case "step_over": {
				const outcome = await dapSessionManager.stepOver(signal, timeoutSec * 1000);
				applyExecutionOutcomeDetails(details, outcome);
				return result.text(buildOutcomeText(outcome, timeoutSec, "Step over")).done();
			}
			case "step_in": {
				const outcome = await dapSessionManager.stepIn(signal, timeoutSec * 1000);
				applyExecutionOutcomeDetails(details, outcome);
				return result.text(buildOutcomeText(outcome, timeoutSec, "Step in")).done();
			}
			case "step_out": {
				const outcome = await dapSessionManager.stepOut(signal, timeoutSec * 1000);
				applyExecutionOutcomeDetails(details, outcome);
				return result.text(buildOutcomeText(outcome, timeoutSec, "Step out")).done();
			}
			case "pause": {
				const outcome = await dapSessionManager.pause(signal, timeoutSec * 1000);
				applyExecutionOutcomeDetails(details, outcome);
				return result.text(buildOutcomeText(outcome, timeoutSec, "Pause")).done();
			}
			case "evaluate": {
				if (!params.expression) {
					throw new ToolError("expression is required for evaluate");
				}
				const evaluationContext = (params.context as DapEvaluateArguments["context"] | undefined) ?? "repl";
				const response = await dapSessionManager.evaluate(
					params.expression,
					evaluationContext,
					params.frame_id,
					signal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.evaluation = response.evaluation;
				return result.text(formatEvaluation(response.evaluation)).done();
			}
			case "stack_trace": {
				const response = await dapSessionManager.stackTrace(params.levels, signal, timeoutSec * 1000);
				details.snapshot = response.snapshot;
				details.stackFrames = response.stackFrames;
				return result.text(formatStackFrames(response.stackFrames)).done();
			}
			case "threads": {
				const response = await dapSessionManager.threads(signal, timeoutSec * 1000);
				details.snapshot = response.snapshot;
				details.threads = response.threads;
				return result.text(formatThreads(response.threads)).done();
			}
			case "scopes": {
				const response = await dapSessionManager.scopes(params.frame_id, signal, timeoutSec * 1000);
				details.snapshot = response.snapshot;
				details.scopes = response.scopes;
				return result.text(formatScopes(response.scopes)).done();
			}
			case "variables": {
				const variableReference = params.variable_ref ?? params.scope_id;
				if (variableReference === undefined) {
					throw new ToolError("variables requires variable_ref or scope_id");
				}
				const response = await dapSessionManager.variables(variableReference, signal, timeoutSec * 1000);
				details.snapshot = response.snapshot;
				details.variables = response.variables;
				return result.text(formatVariables(response.variables)).done();
			}
			case "disassemble": {
				requireCapability("supportsDisassembleRequest", "disassembly");
				if (params.instruction_count === undefined) {
					throw new ToolError("instruction_count is required for disassemble");
				}
				const response = await dapSessionManager.disassemble(
					resolveDisassemblyReference(params.memory_reference),
					params.instruction_count,
					params.offset,
					params.instruction_offset,
					params.resolve_symbols,
					signal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.disassembly = response.instructions;
				return result.text(formatDisassembly(response.instructions)).done();
			}
			case "read_memory": {
				requireCapability("supportsReadMemoryRequest", "memory reads");
				if (!params.memory_reference) {
					throw new ToolError("memory_reference is required for read_memory");
				}
				if (params.count === undefined) {
					throw new ToolError("count is required for read_memory");
				}
				const response = await dapSessionManager.readMemory(
					params.memory_reference,
					params.count,
					params.offset,
					signal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.memoryAddress = response.address;
				details.memoryData = response.data;
				details.unreadableBytes = response.unreadableBytes;
				return result.text(formatMemoryRead(response.address, response.data, response.unreadableBytes)).done();
			}
			case "write_memory": {
				requireCapability("supportsWriteMemoryRequest", "memory writes");
				if (!params.memory_reference) {
					throw new ToolError("memory_reference is required for write_memory");
				}
				if (!params.data) {
					throw new ToolError("data is required for write_memory");
				}
				const response = await dapSessionManager.writeMemory(
					params.memory_reference,
					params.data,
					params.offset,
					params.allow_partial,
					signal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.bytesWritten = response.bytesWritten;
				return result
					.text(
						[
							"Memory write completed.",
							...(response.bytesWritten !== undefined ? [`Bytes written: ${response.bytesWritten}`] : []),
							...(response.offset !== undefined ? [`Offset: ${response.offset}`] : []),
						].join("\n"),
					)
					.done();
			}
			case "modules": {
				requireCapability("supportsModulesRequest", "module introspection");
				const response = await dapSessionManager.modules(
					params.start_module,
					params.module_count,
					signal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.modules = response.modules;
				return result.text(formatModules(response.modules)).done();
			}
			case "loaded_sources": {
				requireCapability("supportsLoadedSourcesRequest", "loaded sources");
				const response = await dapSessionManager.loadedSources(signal, timeoutSec * 1000);
				details.snapshot = response.snapshot;
				details.sources = response.sources;
				return result.text(formatLoadedSources(response.sources)).done();
			}
			case "custom_request": {
				if (!params.command) {
					throw new ToolError("command is required for custom_request");
				}
				const response = await dapSessionManager.customRequest(
					params.command,
					params.arguments,
					signal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.customBody = response.body;
				return result.text(formatCustomResponse(params.command, response.body)).done();
			}
			case "output": {
				let pattern: RegExp | undefined;
				if (params.wait_for !== undefined) {
					if (params.wait_for.length === 0) throw new ToolError("wait_for must be a non-empty regular expression");
					try {
						pattern = new RegExp(params.wait_for);
					} catch (error) {
						throw new ToolError(
							`Invalid output wait_for regex: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
				if (pattern) {
					const response = await dapSessionManager.waitForOutput(pattern, {
						all: params.all_output,
						signal,
						timeoutMs: timeoutSec * 1000,
					});
					details.snapshot = response.snapshot;
					details.output = response.output;
					details.outputSegments = response.outputSegments;
					details.outputMatched = response.matched;
					details.timedOut = response.timedOut;
					return result
						.text(
							[
								response.matched
									? `Output matched /${params.wait_for}/.`
									: `Output wait timed out after ${timeoutSec}s. Debug target remains ${response.snapshot.status}.`,
								response.outputSegments.length > 0
									? formatOutputSegments(response.outputSegments)
									: "(no output captured)",
							].join("\n"),
						)
						.done();
				}
				const response = dapSessionManager.getOutput({ all: params.all_output });
				details.snapshot = response.snapshot;
				details.output = response.output;
				details.outputSegments = response.outputSegments;
				return result
					.text(
						response.outputSegments.length > 0
							? formatOutputSegments(response.outputSegments)
							: "(no output captured)",
					)
					.done();
			}
			case "terminate": {
				const snapshot = await dapSessionManager.terminate(signal, timeoutSec * 1000);
				if (!snapshot) {
					return result.text("No debug session to terminate.").done();
				}
				details.snapshot = snapshot;
				return result.text(formatSessionSnapshot(snapshot).concat("Debug session terminated.").join("\n")).done();
			}
			case "sessions": {
				const sessions = dapSessionManager.listSessions();
				details.sessions = sessions;
				return result.text(formatSessions(sessions)).done();
			}
			default:
				throw new ToolError(`Unsupported debug action: ${params.action}`);
		}
	}
}
