/**
 * Render helpers shared between the live transcript ({@link UiHelpers}) and the
 * file/remote-backed {@link ChatTranscriptBuilder}. Both surfaces build the same
 * transcript rows from persisted message entries; holding the row construction
 * here keeps the two byte-for-byte identical.
 */
import { type AgentMessage, isContinuableStreamInterruption } from "@oh-my-pi/pi-agent-core";
import { type Component } from "../tui";
import { TruncatedText } from "../components/truncated-text";
import { formatBytes, formatDuration } from "@oh-my-pi/pi-utils";
import type { JobSnapshot } from "../tools/hub";
import type { DaemonSnapshot } from "../tools/hub";
import {
	type CustomMessage,
	type FileMentionMessage,
	isUserTurnInitiator,
	resolveAbortLabel,
	shouldRenderAbortReason,
} from "./messages";
import { isAdvisorCard } from "./advisor-cards";
import { createIrcMessageCard } from "../tools/hub";
import { formatArtifactErrorNotice, type OutputMeta } from "../tools/output-meta";
import { canonicalizeMessage } from "./thinking-display";
import { ToolActivityContainer } from "../chrome/tool-activity";
import { type TranscriptBlock } from "../chrome/transcript-container";
import { TranscriptStatusBlock, type TranscriptStatusRow } from "../chrome/transcript-status";
import { theme } from "../theme";
import { t } from "../i18n";
import { formatSshTransferSummary, isSshTransferToolDetails } from "../tools/ssh-transfer-summary";

type CustomOrHookMessage = Extract<AgentMessage, { role: "custom" | "hookMessage" }>;
type AssistantAgentMessage = Extract<AgentMessage, { role: "assistant" }>;

/**
 * A user-attributed request that can anchor a completed run: a plain user
 * message, or a custom prompt the user invoked directly (`/skill:`, a
 * writable-collab prompt). Agent redirects, reminders, and auto-continues are
 * not run initiators.
 */
export type CompletedRunRequest = Extract<AgentMessage, { role: "user" }> | CustomMessage;

export interface CompletedRunCollapse {
	/** First message emitted by the run, including any hidden/user-attributed prelude. */
	firstMessage: AgentMessage;
	/** Initial user-attributed request that remains visible after collapse. */
	initialUserMessage: CompletedRunRequest;
	/**
	 * Terminal assistant message that remains visible after collapse: either the
	 * natural final answer or an error following completed activity. Absent when
	 * the run was interrupted (e.g. by a force-flushed follow-up) and therefore
	 * has no terminal assistant message to preserve.
	 */
	finalAssistantMessage?: AssistantAgentMessage;
	/**
	 * Last message of an interrupted run (the abort boundary). Hidden together
	 * with the rest of the span; required when `finalAssistantMessage` is absent.
	 */
	spanEndMessage?: AgentMessage;
	/** Wall-clock time from the first agent_start through the settled agent_end. */
	durationMs: number;
}

export interface CompletedRunSummary {
	/** Preserved request after which the summary row is inserted. */
	afterMessage: CompletedRunRequest;
	/** Non-empty assistant text blocks hidden by the projection. */
	agentTextSegments: number;
	/** Assistant tool-call blocks hidden by the projection. */
	toolCalls: number;
	/** Wall-clock duration of the completed run. */
	durationMs: number;
}

export interface CompletedRunProjection<Context> {
	context: Context;
	summaries: CompletedRunSummary[];
}

export interface DeriveCompletedRunCollapsesOptions {
	/** Include the trailing completed request even when no later user request has started. */
	includeLatest: boolean;
}

export interface CompletedRunAnchor {
	/** Original request that the next continuation still belongs to. */
	initialUserMessage: CompletedRunRequest;
	/** Persisted messages already emitted for the unfinished request. */
	messages: AgentMessage[];
}

/**
 * Completed-run collapsing needs the full persisted transcript so Alt+O can
 * reconstruct runs from before the latest compaction. Provider context remains
 * compacted; this policy applies only to the interactive display transcript.
 */
export function shouldCollapseCompactedHistoryForDisplay(
	collapseCompacted: boolean,
	collapseCompletedRuns: boolean,
): boolean {
	return collapseCompacted && !collapseCompletedRuns;
}

/**
 * Match the same persisted transcript message across live events and rebuilds.
 * Rebuilds can clone messages while deobfuscating secrets, so object identity is
 * the fast path and role/timestamp plus the role-specific stable id is fallback.
 */
export function isSameTranscriptMessage(candidate: AgentMessage, expected: AgentMessage): boolean {
	if (candidate === expected) return true;
	if (candidate.role !== expected.role || candidate.timestamp !== expected.timestamp) return false;
	if (
		(candidate.role === "custom" || candidate.role === "hookMessage") &&
		(expected.role === "custom" || expected.role === "hookMessage")
	) {
		return candidate.customType === expected.customType;
	}
	if (candidate.role === "toolResult" && expected.role === "toolResult") {
		return candidate.toolCallId === expected.toolCallId;
	}
	if (candidate.role === "assistant" && expected.role === "assistant") {
		return candidate.provider === expected.provider && candidate.model === expected.model;
	}
	return true;
}

function findMessageIndex(messages: readonly AgentMessage[], target: AgentMessage, from: number): number {
	for (let index = from; index < messages.length; index++) {
		if (isSameTranscriptMessage(messages[index]!, target)) return index;
	}
	return -1;
}

function isNonSyntheticUserMessage(message: AgentMessage): message is Extract<AgentMessage, { role: "user" }> {
	return message.role === "user" && message.synthetic !== true;
}

/**
 * Whether `message` starts a user-attributed turn whose completed run the
 * transcript may collapse. A directly-invoked custom prompt counts because the
 * transcript renders it as the request row (see {@link isUserTurnInitiator}).
 */
export function isCompletedRunRequest(message: AgentMessage | undefined): message is CompletedRunRequest {
	if (message?.role === "user") return message.synthetic !== true;
	if (message?.role !== "custom") return false;
	return isUserTurnInitiator(message);
}

export function isCollapsibleRunFinalAssistant(message: AgentMessage | undefined): message is AssistantAgentMessage {
	return (
		message?.role === "assistant" &&
		message.stopReason === "stop" &&
		message.stopDetails?.type !== "pause_turn" &&
		!message.errorMessage &&
		!message.content.some(content => content.type === "toolCall") &&
		message.content.some(content => content.type === "text" && Boolean(canonicalizeMessage(content.text)))
	);
}

/**
 * A natural final answer is always a valid completed-run endpoint. A terminal
 * provider error qualifies only when collapsing would hide earlier assistant
 * text or tool calls; immediate failures remain visible without a 0/0 summary.
 */
export function isCollapsibleCompletedRun(
	messages: readonly AgentMessage[],
	initialUserMessage: CompletedRunRequest,
	finalAssistantMessage: AgentMessage | undefined,
): finalAssistantMessage is AssistantAgentMessage {
	if (finalAssistantMessage?.role !== "assistant") return false;
	if (finalAssistantMessage.stopReason === "stop") {
		return isCollapsibleRunFinalAssistant(finalAssistantMessage);
	}
	if (
		finalAssistantMessage.stopReason !== "error" ||
		isContinuableStreamInterruption(finalAssistantMessage) ||
		finalAssistantMessage.content.some(content => content.type === "toolCall")
	) {
		return false;
	}

	const start = findMessageIndex(messages, initialUserMessage, 0);
	const end = findMessageIndex(messages, finalAssistantMessage, Math.max(0, start));
	if (start < 0 || end <= start) return false;
	for (let index = start + 1; index < end; index++) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		if (
			message.content.some(
				content =>
					content.type === "toolCall" || (content.type === "text" && Boolean(canonicalizeMessage(content.text))),
			)
		) {
			return true;
		}
	}
	return false;
}

/**
 * Reconstruct collapsible request spans from the persisted transcript. A request
 * survives aborted turns and compaction dividers until a qualifying final answer
 * appears. A terminal error with prior activity becomes its own completed span
 * when the next user message arrives; an immediate failure only starts a fresh
 * request.
 */
export function deriveCompletedRunCollapses(
	messages: readonly AgentMessage[],
	options: DeriveCompletedRunCollapsesOptions,
): CompletedRunCollapse[] {
	return deriveCompletedRunState(messages, options).collapses;
}

/**
 * Recover the unfinished request at the selected transcript leaf. Tree
 * navigation can move behind an inserted correction, leaving a tool-use run
 * with no natural final answer. The next user continuation must inherit that
 * original request so its eventual collapse covers the whole run.
 */
export function deriveCompletedRunAnchor(messages: readonly AgentMessage[]): CompletedRunAnchor | undefined {
	return deriveCompletedRunState(messages, { includeLatest: true }).anchor;
}

function hasAdvisorContinuationAfter(messages: readonly AgentMessage[], finalAssistantIndex: number): boolean {
	for (let index = finalAssistantIndex + 1; index < messages.length; index++) {
		const message = messages[index]!;
		if (isAdvisorCard(message)) return true;
		if (message.role === "assistant" || isNonSyntheticUserMessage(message)) return false;
	}
	return false;
}

function deriveCompletedRunState(
	messages: readonly AgentMessage[],
	options: DeriveCompletedRunCollapsesOptions,
): { collapses: CompletedRunCollapse[]; anchor?: CompletedRunAnchor } {
	const collapses: Array<CompletedRunCollapse & { answerIndex: number }> = [];
	let initialUserMessage: CompletedRunRequest | undefined;
	let initialUserIndex = -1;
	let terminalError: { message: AssistantAgentMessage; index: number } | undefined;
	let lastUserIndex = -1;

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		if (isCompletedRunRequest(message)) {
			lastUserIndex = index;
			if (!initialUserMessage || terminalError) {
				if (
					initialUserMessage &&
					terminalError &&
					isCollapsibleCompletedRun(messages, initialUserMessage, terminalError.message)
				) {
					collapses.push({
						firstMessage: initialUserMessage,
						initialUserMessage,
						finalAssistantMessage: terminalError.message,
						durationMs: Math.max(0, terminalError.message.timestamp - initialUserMessage.timestamp),
						answerIndex: terminalError.index,
					});
				}
				initialUserMessage = message;
				initialUserIndex = index;
				terminalError = undefined;
			}
			continue;
		}
		if (!initialUserMessage || message.role !== "assistant") continue;
		// A persisted terminal-looking error is only a request boundary if the
		// next non-synthetic user message arrives before the assistant continues.
		// Legacy sessions can lack stopDetails on transient provider failures even
		// though the agent loop auto-resumed immediately; a following assistant
		// message proves that the original request is still in progress.
		if (terminalError) terminalError = undefined;
		if (message.stopReason === "error" && !isContinuableStreamInterruption(message)) {
			terminalError = { message, index };
			continue;
		}
		if (!isCollapsibleRunFinalAssistant(message)) continue;
		// An advisor card turns the preceding natural answer into a provisional
		// final. Keep the original request open until the advisor-triggered
		// assistant flow reaches its own natural answer; repeated advisor cards
		// can therefore extend the same recovered collapse span.
		if (hasAdvisorContinuationAfter(messages, index)) continue;

		collapses.push({
			firstMessage: initialUserMessage,
			initialUserMessage,
			finalAssistantMessage: message,
			durationMs: Math.max(0, message.timestamp - initialUserMessage.timestamp),
			answerIndex: index,
		});
		initialUserMessage = undefined;
		initialUserIndex = -1;
		terminalError = undefined;
	}

	if (
		initialUserMessage &&
		terminalError &&
		isCollapsibleCompletedRun(messages, initialUserMessage, terminalError.message)
	) {
		collapses.push({
			firstMessage: initialUserMessage,
			initialUserMessage,
			finalAssistantMessage: terminalError.message,
			durationMs: Math.max(0, terminalError.message.timestamp - initialUserMessage.timestamp),
			answerIndex: terminalError.index,
		});
	}

	const completed = collapses
		.filter(collapse => options.includeLatest || collapse.answerIndex < lastUserIndex)
		.map(({ answerIndex: _, ...collapse }) => collapse);
	const anchor =
		initialUserMessage && initialUserIndex >= 0 && terminalError === undefined
			? { initialUserMessage, messages: messages.slice(initialUserIndex) }
			: undefined;
	return { collapses: completed, anchor };
}

/**
 * Display-only projection for terminally settled agent runs. Session history,
 * exports, provider context, and persisted JSONL retain every original message.
 */
export function collapseCompletedRuns<Context extends { messages: AgentMessage[]; cacheMissExplainedAt?: boolean[] }>(
	sessionContext: Context,
	collapses: readonly CompletedRunCollapse[],
	boundaryMessages: readonly AgentMessage[] = sessionContext.messages,
): CompletedRunProjection<Context> {
	if (collapses.length === 0) return { context: sessionContext, summaries: [] };

	const source = sessionContext.messages;
	const candidates: Array<{
		start: number;
		request: number;
		answer: number;
		durationMs: number;
		/** Whether the answer message itself is preserved (natural final reply). */
		keepAnswer: boolean;
	}> = [];
	for (const collapse of collapses) {
		const start = findMessageIndex(boundaryMessages, collapse.firstMessage, 0);
		if (start < 0) continue;
		const request = findMessageIndex(boundaryMessages, collapse.initialUserMessage, start);
		if (request < 0) continue;
		const answerTarget = collapse.finalAssistantMessage ?? collapse.spanEndMessage;
		if (!answerTarget) continue;
		const answer = findMessageIndex(boundaryMessages, answerTarget, request);
		if (answer < 0) continue;
		candidates.push({
			start,
			request,
			answer,
			durationMs: collapse.durationMs,
			keepAnswer: Boolean(collapse.finalAssistantMessage),
		});
	}
	candidates.sort((left, right) => left.answer - right.answer || left.start - right.start);
	const spans: typeof candidates = [];
	let previousAnswer = -1;
	for (const candidate of candidates) {
		if (candidate.start <= previousAnswer) continue;
		spans.push(candidate);
		previousAnswer = candidate.answer;
	}
	if (spans.length === 0) return { context: sessionContext, summaries: [] };

	const boundaryIndexBySourceIndex: number[] = [];
	let boundarySearchFrom = 0;
	for (const message of source) {
		const boundaryIndex = findMessageIndex(boundaryMessages, message, boundarySearchFrom);
		boundaryIndexBySourceIndex.push(boundaryIndex);
		if (boundaryIndex >= 0) boundarySearchFrom = boundaryIndex + 1;
	}

	const messages: AgentMessage[] = [];
	const summaries: CompletedRunSummary[] = [];
	const cacheMissExplainedAt: boolean[] | undefined = sessionContext.cacheMissExplainedAt ? [] : undefined;
	const push = (message: AgentMessage, cacheMissExplained = false): void => {
		messages.push(message);
		cacheMissExplainedAt?.push(cacheMissExplained);
	};

	let sourceIndex = 0;
	for (const span of spans) {
		let visibleStart = -1;
		let visibleEnd = -1;
		for (let index = sourceIndex; index < source.length; index++) {
			const boundaryIndex = boundaryIndexBySourceIndex[index]!;
			if (boundaryIndex < span.start || boundaryIndex > span.answer) continue;
			if (visibleStart < 0) visibleStart = index;
			visibleEnd = index;
		}
		if (visibleStart < 0) continue;
		while (sourceIndex < visibleStart) {
			push(source[sourceIndex]!, sessionContext.cacheMissExplainedAt?.[sourceIndex] ?? false);
			sourceIndex++;
		}
		const requestMessage = boundaryMessages[span.request];
		const finalMessage = boundaryMessages[span.answer];
		if (!isCompletedRunRequest(requestMessage) || !finalMessage) {
			sourceIndex = visibleEnd + 1;
			continue;
		}

		const preservedBoundaryIndexes = new Set<number>([span.request]);
		for (let index = span.start; index <= span.answer; index++) {
			const message = boundaryMessages[index];
			if (!message || !isAdvisorCard(message)) continue;
			for (let previousIndex = index - 1; previousIndex >= span.start; previousIndex--) {
				if (!isCollapsibleRunFinalAssistant(boundaryMessages[previousIndex])) continue;
				preservedBoundaryIndexes.add(previousIndex);
				break;
			}
			preservedBoundaryIndexes.add(index);
		}
		if (span.keepAnswer && finalMessage.role === "assistant") {
			preservedBoundaryIndexes.add(span.answer);
		}

		let agentTextSegments = 0;
		let toolCalls = 0;
		for (let index = span.start; index < span.answer; index++) {
			if (preservedBoundaryIndexes.has(index)) continue;
			const message = boundaryMessages[index];
			if (message?.role !== "assistant") continue;
			for (const content of message.content) {
				if (content.type === "text" && canonicalizeMessage(content.text)) agentTextSegments++;
				else if (content.type === "toolCall") toolCalls++;
			}
		}

		for (let boundaryIndex = span.start; boundaryIndex <= span.answer; boundaryIndex++) {
			if (!preservedBoundaryIndexes.has(boundaryIndex)) continue;
			const message = boundaryMessages[boundaryIndex]!;
			const visibleSourceIndex = boundaryIndexBySourceIndex.findIndex(
				(candidateBoundaryIndex, index) =>
					index >= visibleStart && index <= visibleEnd && candidateBoundaryIndex === boundaryIndex,
			);
			if (message.role !== "assistant") {
				push(
					message,
					visibleSourceIndex >= 0 ? (sessionContext.cacheMissExplainedAt?.[visibleSourceIndex] ?? false) : false,
				);
				continue;
			}
			const textContent = message.content.filter(
				content => content.type === "text" && canonicalizeMessage(content.text),
			);
			push(
				textContent.length === message.content.length ? message : { ...message, content: textContent },
				visibleSourceIndex >= 0 ? (sessionContext.cacheMissExplainedAt?.[visibleSourceIndex] ?? false) : false,
			);
		}
		summaries.push({ afterMessage: requestMessage, agentTextSegments, toolCalls, durationMs: span.durationMs });
		sourceIndex = visibleEnd + 1;
	}
	while (sourceIndex < source.length) {
		push(source[sourceIndex]!, sessionContext.cacheMissExplainedAt?.[sourceIndex] ?? false);
		sourceIndex++;
	}

	return {
		context: { ...sessionContext, messages, cacheMissExplainedAt },
		summaries,
	};
}

/**
 * Projection components the completed-run collapse inserts behind a request
 * whose span it hides. Callers consult this set to keep rows that belong to
 * the hidden span — such as the run's context-injection notice — out of the
 * replay, instead of letting them resurface under the summary row.
 */
export const collapsedRunProjections = new WeakSet<Component>();

/** Render one static row describing the completed-run content hidden above it. */
export function createCompletedRunSummary(summary: CompletedRunSummary, toggleKey: string | undefined): Component {
	const textSegments = t("{count} agent text segment{s}", {
		count: summary.agentTextSegments,
		s: summary.agentTextSegments === 1 ? "" : "s",
	});
	const toolCalls = t("{count} tool call{s}", {
		count: summary.toolCalls,
		s: summary.toolCalls === 1 ? "" : "s",
	});
	const duration = t("{time} elapsed", { time: formatDuration(summary.durationMs) });
	const separator = ` ${theme.sep.dot.trim()} `;
	const keyHint = toggleKey ? `${separator}${t("{key} to expand", { key: toggleKey })}` : "";
	const text = t("※ collapsed: {segments}{sep}{calls}{sep}{duration}{hint}", {
		segments: textSegments,
		sep: separator,
		calls: toolCalls,
		duration,
		hint: keyHint,
	});
	return new TruncatedText(theme.fg("dim", theme.italic(text)), 1, 0);
}

/**
 * Render an `async-result` custom message (a completed background bash/task job,
 * or a batch of them) as a transcript block of one "Background job completed"
 * row per job.
 */
export function buildAsyncResultBlock(message: CustomOrHookMessage): ToolActivityContainer {
	const details = (
		message as CustomMessage<{
			jobId?: string;
			type?: JobSnapshot["type"];
			label?: string;
			durationMs?: number;
			jobs?: Array<{
				jobId?: string;
				type?: JobSnapshot["type"];
				label?: string;
				durationMs?: number;
				progress?: { details?: unknown };
				meta?: OutputMeta;
			}>;
			meta?: OutputMeta;
		}>
	).details;
	const jobs =
		details?.jobs && details.jobs.length > 0
			? details.jobs
			: [
					{
						jobId: details?.jobId,
						type: details?.type,
						label: details?.label,
						durationMs: details?.durationMs,
					},
				];
	const rows: TranscriptStatusRow[] = [];
	for (const job of jobs) {
		const jobId = job.jobId ?? "unknown";
		const progressDetails = job.progress?.details;
		if (job.type === "ssh_transfer" && isSshTransferToolDetails(progressDetails)) {
			const statusLine =
				progressDetails.status === "completed"
					? theme.fg("success", `${theme.status.success} ${t("Background SSH transfer completed")}`)
					: progressDetails.status === "cancelled"
						? theme.fg("muted", `${theme.status.aborted} ${t("Background SSH transfer cancelled")}`)
						: theme.fg("error", `${theme.status.error} ${t("Background SSH transfer failed")}`);
			const header = `${statusLine} ${theme.fg("dim", "[ssh_transfer]")} ${theme.fg("accent", jobId)}`;
			rows.push({ parts: [`${header}\n${formatSshTransferSummary(progressDetails)}`] });
			continue;
		}
		const typeLabel = job.type ? `[${job.type}]` : "[job]";
		const duration = typeof job.durationMs === "number" ? formatDuration(job.durationMs) : undefined;
		rows.push({
			parts: [
				theme.fg("success", `${theme.status.done} ${t("Background job completed")}`),
				theme.fg("dim", typeLabel),
				theme.fg("accent", jobId),
				duration ? theme.fg("dim", `(${duration})`) : undefined,
			],
		});
		if (job.meta?.artifactError) {
			rows.push({ parts: [theme.fg("warning", formatArtifactErrorNotice(job.meta.artifactError))] });
		}
	}
	if (details?.meta?.artifactError) {
		rows.push({ parts: [theme.fg("warning", formatArtifactErrorNotice(details.meta.artifactError))] });
	}
	return new ToolActivityContainer(new TranscriptStatusBlock(rows));
}

/**
 * Render a `launch-completion` custom message (terminal supervised-process
 * exits from the launch broker) as a transcript block of one compact
 * "Supervised process ..." row per daemon, matching background-job rows.
 */
export function buildLaunchCompletionBlock(message: CustomOrHookMessage): ToolActivityContainer {
	const details = (message as CustomMessage<{ daemons?: DaemonSnapshot[] }>).details;
	const rows: TranscriptStatusRow[] = [];
	const daemons = details?.daemons ?? [];
	if (daemons.length === 0 && typeof message.content === "string") {
		rows.push({ parts: [theme.fg("dim", `${theme.status.done} ${message.content}`)] });
	}
	for (const daemon of daemons) {
		const failed = daemon.state === "failed" || (daemon.exitCode !== undefined && daemon.exitCode !== 0);
		const duration =
			daemon.exitedAt !== undefined && daemon.startedAt !== undefined
				? formatDuration(daemon.exitedAt - daemon.startedAt)
				: undefined;
		rows.push({
			parts: [
				failed
					? theme.fg("error", `${theme.status.error} ${t("Supervised process failed")}`)
					: theme.fg("success", `${theme.status.done} ${t("Supervised process completed")}`),
				theme.fg("accent", daemon.name),
				daemon.exitCode !== undefined ? theme.fg("dim", t("(exit {code})", { code: daemon.exitCode })) : undefined,
				duration ? theme.fg("dim", `(${duration})`) : undefined,
			],
		});
	}
	return new ToolActivityContainer(new TranscriptStatusBlock(rows));
}

/**
 * Render a live IRC traffic custom message (`irc:incoming` / `irc:autoreply` /
 * `irc:relay`) as a transcript card. `getExpanded` supplies the live
 * expanded-state getter for the cached card.
 */
export function buildIrcMessageCard(message: CustomOrHookMessage, getExpanded: () => boolean): Component {
	const details = (
		message as CustomMessage<{
			from?: string;
			to?: string;
			message?: string;
			body?: string;
			replyTo?: string;
			pool?: string;
			mode?: string;
		}>
	).details;
	const kind =
		message.customType === "irc:incoming"
			? ("incoming" as const)
			: message.customType === "irc:autoreply"
				? ("autoreply" as const)
				: message.customType === "irc:workpool"
					? ("workpool" as const)
					: ("relay" as const);
	return createIrcMessageCard(
		{
			kind,
			from: details?.from,
			to: details?.to,
			body: kind === "incoming" ? details?.message : details?.body,
			replyTo: details?.replyTo,
			timestamp: message.timestamp,
			pool: details?.pool,
			mode: details?.mode,
		},
		getExpanded,
		theme,
	);
}

/**
 * Render a `fileMention` message's files as a transcript block of "Read <path>"
 * rows. `indent` sets the left pad: the live chat renders within an outer gutter
 * (0), the transcript viewer renders body rows without one so rows own their pad
 * (1).
 */
export function buildFileMentionBlock(files: FileMentionMessage["files"], indent: number): TranscriptBlock {
	const rows: TranscriptStatusRow[] = [];
	for (const file of files) {
		let suffix: string;
		if (file.skippedReason === "tooLarge" || file.skippedReason === "binary") {
			const size = typeof file.byteSize === "number" ? formatBytes(file.byteSize) : t("unknown size");
			suffix =
				file.skippedReason === "binary"
					? t("(skipped: binary, {size})", { size })
					: t("(skipped: {size})", { size });
		} else {
			suffix = file.image
				? t("(image)")
				: file.lineCount === undefined
					? t("(unknown lines)")
					: t("({count} lines)", { count: file.lineCount });
		}
		rows.push({
			parts: [
				`${theme.fg("dim", `${theme.tree.last} `)}${theme.fg("muted", "Read")}`,
				theme.fg("accent", file.path),
				theme.fg("dim", suffix),
			],
			indent,
		});
	}
	return new TranscriptStatusBlock(rows);
}

/**
 * Whether an assistant turn has visible text, thinking, or image content — i.e.
 * content that closes the current read-tool run.
 */
export function assistantHasVisibleContent(message: AssistantAgentMessage): boolean {
	return message.content.some(
		content =>
			content.type === "image" ||
			(content.type === "text" && canonicalizeMessage(content.text)) ||
			(content.type === "thinking" && canonicalizeMessage(content.thinking)),
	);
}

/**
 * Split mixed assistant turns into visible text before tool execution and
 * visible text segments that must render immediately after the preceding tool.
 * Cursor can return intro text, tool calls, progress text, and the final answer
 * in one assistant message; keeping every text block in the leading assistant
 * block buries post-tool text above tool results in the transcript.
 */
export function splitAssistantMessageToolTimeline(message: AssistantAgentMessage): {
	beforeTools: AssistantAgentMessage;
	afterToolCalls: ReadonlyMap<string, AssistantAgentMessage>;
	hasToolCalls: boolean;
	lastToolCallId?: string;
} {
	const beforeTools: AssistantAgentMessage["content"] = [];
	const afterToolCalls = new Map<string, AssistantAgentMessage>();
	let pendingAfterTool: AssistantAgentMessage["content"] = [];
	let lastToolCallId: string | undefined;
	let sawToolCall = false;

	const displaySegment = (content: AssistantAgentMessage["content"]): AssistantAgentMessage => ({
		...message,
		content,
		stopReason: "stop",
		errorMessage: undefined,
		retryRecovery: undefined,
	});

	const flushPendingAfterTool = () => {
		if (!lastToolCallId || pendingAfterTool.length === 0) return;
		afterToolCalls.set(lastToolCallId, displaySegment(pendingAfterTool));
		pendingAfterTool = [];
	};

	for (const content of message.content) {
		if (content.type === "toolCall") {
			flushPendingAfterTool();
			sawToolCall = true;
			lastToolCallId = content.id;
			continue;
		}
		if (sawToolCall) {
			pendingAfterTool.push(content);
		} else {
			beforeTools.push(content);
		}
	}
	flushPendingAfterTool();

	if (!sawToolCall) {
		return { beforeTools: message, afterToolCalls, hasToolCalls: false };
	}

	return { beforeTools: displaySegment(beforeTools), afterToolCalls, hasToolCalls: true, lastToolCallId };
}

/**
 * Normalize raw tool-call arguments to a plain record, collapsing non-object or
 * array values to an empty object.
 */
export function normalizeToolArgs(args: unknown): Record<string, unknown> {
	return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

export type AssistantErrorPresentation = { kind: "none" } | { kind: "full"; text: string; isError: true };

/**
 * Resolve the turn-ending assistant error presentation, if any.
 * Silent and user-interrupt aborts yield no label. Successful retries preserve
 * the original error; attempts superseded by an exhausted budget are hidden
 * while the final terminal error keeps its full presentation.
 */
export function resolveAssistantErrorPresentation(
	message: AssistantAgentMessage,
	retryAttempt = 0,
): AssistantErrorPresentation {
	if (message.retryRecovery?.status === "superseded") return { kind: "none" };
	if (message.stopReason === "aborted") {
		if (!shouldRenderAbortReason(message)) return { kind: "none" };
		return { kind: "full", text: resolveAbortLabel(message, retryAttempt), isError: true };
	}
	if (message.stopReason === "error") {
		return { kind: "full", text: message.errorMessage || "Error", isError: true };
	}
	if (message.errorMessage && shouldRenderAbortReason(message)) {
		return { kind: "full", text: message.errorMessage, isError: true };
	}
	return { kind: "none" };
}

/**
 * Whether an assistant turn's `usage` reflects work the operator was billed
 * for. Empty automated turns from providers that emit `usage: 0` collapse to
 * `false`, but any input, output, cache, or premium request keeps the row so
 * cost transparency survives — the live path and the resume/rebuild path
 * agree turn-by-turn.
 */
export function assistantUsageIsBilled(usage: AssistantAgentMessage["usage"]): boolean {
	if (usage.input > 0 || usage.output > 0) return true;
	if (usage.cacheRead > 0 || usage.cacheWrite > 0) return true;
	if ((usage.premiumRequests ?? 0) > 0) return true;
	return false;
}
