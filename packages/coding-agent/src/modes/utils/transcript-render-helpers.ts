/**
 * Render helpers shared between the live transcript ({@link UiHelpers}) and the
 * file/remote-backed {@link ChatTranscriptBuilder}. Both surfaces build the same
 * transcript rows from persisted message entries; holding the row construction
 * here keeps the two byte-for-byte identical.
 */
import { type AgentMessage, isContinuableStreamInterruption } from "@oh-my-pi/pi-agent-core";
import { type Component, Text, TruncatedText } from "@oh-my-pi/pi-tui";
import { formatBytes, formatDuration } from "@oh-my-pi/pi-utils";
import { t } from "../../i18n";
import {
	type CustomMessage,
	type FileMentionMessage,
	resolveAbortLabel,
	shouldRenderAbortReason,
} from "../../session/messages";
import type { SessionContext } from "../../session/session-context";
import { createIrcMessageCard } from "../../tools/hub";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import { formatSshTransferSummary, isSshTransferToolDetails } from "../../tools/ssh-transfer";
import { canonicalizeMessage } from "../../utils/thinking-display";
import { TranscriptBlock } from "../components/transcript-container";
import { theme } from "../theme/theme";

type CustomOrHookMessage = Extract<AgentMessage, { role: "custom" | "hookMessage" }>;
type AssistantAgentMessage = Extract<AgentMessage, { role: "assistant" }>;

export interface CompletedRunCollapse {
	/** First message emitted by the run, including any hidden/user-attributed prelude. */
	firstMessage: AgentMessage;
	/** Initial user request that remains visible after collapse. */
	initialUserMessage: Extract<AgentMessage, { role: "user" }>;
	/**
	 * Naturally completed assistant answer that remains visible after collapse.
	 * Absent when the run was interrupted (e.g. by a force-flushed follow-up)
	 * and therefore has no natural final reply.
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
	afterMessage: Extract<AgentMessage, { role: "user" }>;
	/** Non-empty assistant text blocks hidden by the projection. */
	agentTextSegments: number;
	/** Assistant tool-call blocks hidden by the projection. */
	toolCalls: number;
	/** Wall-clock duration of the completed run. */
	durationMs: number;
}

export interface CompletedRunProjection {
	context: SessionContext;
	summaries: CompletedRunSummary[];
}

export interface DeriveCompletedRunCollapsesOptions {
	/** Include the trailing completed request even when no later user request has started. */
	includeLatest: boolean;
}

export interface CompletedRunAnchor {
	/** Original request that the next continuation still belongs to. */
	initialUserMessage: Extract<AgentMessage, { role: "user" }>;
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
 * Reconstruct collapsible request spans from the persisted transcript. A request
 * survives aborted turns and compaction dividers until a qualifying final answer
 * appears; a terminal error starts a fresh request at the next user message.
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

function deriveCompletedRunState(
	messages: readonly AgentMessage[],
	options: DeriveCompletedRunCollapsesOptions,
): { collapses: CompletedRunCollapse[]; anchor?: CompletedRunAnchor } {
	const collapses: Array<CompletedRunCollapse & { answerIndex: number }> = [];
	let initialUserMessage: Extract<AgentMessage, { role: "user" }> | undefined;
	let initialUserIndex = -1;
	let terminalError = false;
	let lastUserIndex = -1;

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		if (isNonSyntheticUserMessage(message)) {
			lastUserIndex = index;
			if (!initialUserMessage || terminalError) {
				initialUserMessage = message;
				initialUserIndex = index;
				terminalError = false;
			}
			continue;
		}
		if (!initialUserMessage || message.role !== "assistant") continue;
		if (message.stopReason === "error" && !isContinuableStreamInterruption(message)) {
			terminalError = true;
			continue;
		}
		if (!isCollapsibleRunFinalAssistant(message)) continue;

		collapses.push({
			firstMessage: initialUserMessage,
			initialUserMessage,
			finalAssistantMessage: message,
			durationMs: Math.max(0, message.timestamp - initialUserMessage.timestamp),
			answerIndex: index,
		});
		initialUserMessage = undefined;
		initialUserIndex = -1;
		terminalError = false;
	}

	const completed = collapses
		.filter(collapse => options.includeLatest || collapse.answerIndex < lastUserIndex)
		.map(({ answerIndex: _, ...collapse }) => collapse);
	const anchor =
		initialUserMessage && initialUserIndex >= 0 && !terminalError
			? { initialUserMessage, messages: messages.slice(initialUserIndex) }
			: undefined;
	return { collapses: completed, anchor };
}

/**
 * Display-only projection for naturally completed agent runs. Session history,
 * exports, provider context, and persisted JSONL retain every original message.
 */
export function collapseCompletedRuns(
	sessionContext: SessionContext,
	collapses: readonly CompletedRunCollapse[],
	boundaryMessages: readonly AgentMessage[] = sessionContext.messages,
): CompletedRunProjection {
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
		if (requestMessage?.role !== "user" || !finalMessage) {
			sourceIndex = visibleEnd + 1;
			continue;
		}

		let agentTextSegments = 0;
		let toolCalls = 0;
		for (let index = span.start; index < span.answer; index++) {
			const message = boundaryMessages[index];
			if (message?.role !== "assistant") continue;
			for (const content of message.content) {
				if (content.type === "text" && canonicalizeMessage(content.text)) agentTextSegments++;
				else if (content.type === "toolCall") toolCalls++;
			}
		}

		const visibleRequestIndex = boundaryIndexBySourceIndex.findIndex(
			(boundaryIndex, index) => index >= visibleStart && index <= visibleEnd && boundaryIndex === span.request,
		);
		push(
			requestMessage,
			visibleRequestIndex >= 0 ? (sessionContext.cacheMissExplainedAt?.[visibleRequestIndex] ?? false) : false,
		);
		if (span.keepAnswer && finalMessage.role === "assistant") {
			const textContent = finalMessage.content.filter(
				content => content.type === "text" && canonicalizeMessage(content.text),
			);
			const visibleAnswerIndex = boundaryIndexBySourceIndex.findIndex(
				(boundaryIndex, index) => index >= visibleStart && index <= visibleEnd && boundaryIndex === span.answer,
			);
			push(
				textContent.length === finalMessage.content.length
					? finalMessage
					: { ...finalMessage, content: textContent },
				visibleAnswerIndex >= 0 ? (sessionContext.cacheMissExplainedAt?.[visibleAnswerIndex] ?? false) : false,
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

interface AsyncResultTranscriptJob {
	jobId?: string;
	type?: string;
	label?: string;
	status?: string;
	durationMs?: number;
	progressDetails?: unknown;
}

function normalizeAsyncResultJob(value: unknown): AsyncResultTranscriptJob {
	if (value === null || typeof value !== "object") return {};
	const progress =
		"progress" in value && value.progress !== null && typeof value.progress === "object" ? value.progress : undefined;
	return {
		...("jobId" in value && typeof value.jobId === "string" ? { jobId: value.jobId } : {}),
		...("type" in value && typeof value.type === "string" ? { type: value.type } : {}),
		...("label" in value && typeof value.label === "string" ? { label: value.label } : {}),
		...("status" in value && typeof value.status === "string" ? { status: value.status } : {}),
		...("durationMs" in value && typeof value.durationMs === "number" ? { durationMs: value.durationMs } : {}),
		...(progress && "details" in progress ? { progressDetails: progress.details } : {}),
	};
}

/**
 * Render an `async-result` custom message (a completed background bash/task job,
 * or a batch of them) as a transcript block of one "Background job completed"
 * row per job.
 */
export function buildAsyncResultBlock(message: CustomOrHookMessage): TranscriptBlock {
	const details = message.details;
	const rawJobs =
		details !== null &&
		typeof details === "object" &&
		"jobs" in details &&
		Array.isArray(details.jobs) &&
		details.jobs.length > 0
			? details.jobs
			: [details];
	const jobs = rawJobs.map(normalizeAsyncResultJob);
	const block = new TranscriptBlock();
	for (const job of jobs) {
		const jobId = job.jobId ?? "unknown";
		if (job.type === "ssh_transfer" && isSshTransferToolDetails(job.progressDetails)) {
			const statusLine =
				job.progressDetails.status === "completed"
					? theme.fg("success", `${theme.status.success} Background SSH transfer completed`)
					: job.progressDetails.status === "cancelled"
						? theme.fg("muted", `${theme.status.aborted} Background SSH transfer cancelled`)
						: theme.fg("error", `${theme.status.error} Background SSH transfer failed`);
			const header = `${statusLine} ${theme.fg("dim", "[ssh_transfer]")} ${theme.fg("accent", jobId)}`;
			block.addChild(new Text(`${header}\n${formatSshTransferSummary(job.progressDetails)}`, 1, 0));
			continue;
		}
		const typeLabel = job.type ? `[${job.type}]` : "[job]";
		const duration = typeof job.durationMs === "number" ? formatDuration(job.durationMs) : undefined;
		const line = [
			theme.fg("success", `${theme.status.done} Background job completed`),
			theme.fg("dim", typeLabel),
			theme.fg("accent", jobId),
			duration ? theme.fg("dim", `(${duration})`) : undefined,
		]
			.filter(Boolean)
			.join(" ");
		block.addChild(new Text(line, 1, 0));
	}
	return block;
}

/**
 * Render a live IRC traffic custom message (`irc:incoming` / `irc:autoreply` /
 * `irc:relay`) as a transcript card. `getExpanded` supplies the live
 * expanded-state getter for the cached card.
 */
export function buildIrcMessageCard(message: CustomOrHookMessage, getExpanded: () => boolean): Component {
	const details = (
		message as CustomMessage<{ from?: string; to?: string; message?: string; body?: string; replyTo?: string }>
	).details;
	const kind =
		message.customType === "irc:incoming"
			? ("incoming" as const)
			: message.customType === "irc:autoreply"
				? ("autoreply" as const)
				: ("relay" as const);
	return createIrcMessageCard(
		{
			kind,
			from: details?.from,
			to: details?.to,
			body: kind === "incoming" ? details?.message : details?.body,
			replyTo: details?.replyTo,
			timestamp: message.timestamp,
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
	const block = new TranscriptBlock();
	for (const file of files) {
		let suffix: string;
		if (file.skippedReason === "tooLarge" || file.skippedReason === "binary") {
			const size = typeof file.byteSize === "number" ? formatBytes(file.byteSize) : "unknown size";
			suffix = file.skippedReason === "binary" ? `(skipped: binary, ${size})` : `(skipped: ${size})`;
		} else {
			suffix = file.image
				? "(image)"
				: file.lineCount === undefined
					? "(unknown lines)"
					: `(${file.lineCount} lines)`;
		}
		const text = `${theme.fg("dim", `${theme.tree.last} `)}${theme.fg("muted", "Read")} ${theme.fg(
			"accent",
			file.path,
		)} ${theme.fg("dim", suffix)}`;
		block.addChild(new Text(text, indent, 0));
	}
	return block;
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

	return { beforeTools: displaySegment(beforeTools), afterToolCalls, hasToolCalls: true };
}

/**
 * Normalize raw tool-call arguments to a plain record, collapsing non-object or
 * array values to an empty object.
 */
export function normalizeToolArgs(args: unknown): Record<string, unknown> {
	return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

export type AssistantErrorPresentation =
	| { kind: "none" }
	| { kind: "full"; text: string; isError: true }
	| { kind: "compact-recovered"; text: string; isError: false };

function sanitizeRecoveredRetryNote(note: string): string {
	const normalized = replaceTabs(note).replace(/\s+/g, " ").trim();
	return truncateToWidth(normalized || "retried", TRUNCATE_LENGTHS.CONTENT);
}

/**
 * Resolve the turn-ending assistant error presentation, if any.
 * Silent and user-interrupt aborts yield no label. Recovered retry attempts
 * render a compact note; attempts superseded by an exhausted budget are hidden
 * while the final terminal error keeps its full presentation.
 */
export function resolveAssistantErrorPresentation(
	message: AssistantAgentMessage,
	retryAttempt = 0,
): AssistantErrorPresentation {
	if (message.retryRecovery?.status === "superseded") return { kind: "none" };
	if (message.retryRecovery?.status === "recovered") {
		return {
			kind: "compact-recovered",
			text: sanitizeRecoveredRetryNote(message.retryRecovery.note),
			isError: false,
		};
	}
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
