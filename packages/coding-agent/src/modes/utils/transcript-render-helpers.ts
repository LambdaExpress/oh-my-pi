/**
 * Render helpers shared between the live transcript ({@link UiHelpers}) and the
 * file/remote-backed {@link ChatTranscriptBuilder}. Both surfaces build the same
 * transcript rows from persisted message entries; holding the row construction
 * here keeps the two byte-for-byte identical.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type Component, Text } from "@oh-my-pi/pi-tui";
import { formatBytes, formatDuration } from "@oh-my-pi/pi-utils";
import {
	type CustomMessage,
	type FileMentionMessage,
	resolveAbortLabel,
	shouldRenderAbortReason,
} from "../../session/messages";
import type { SessionContext } from "../../session/session-context";
import { createIrcMessageCard } from "../../tools/irc";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
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
	/** Naturally completed assistant answer that remains visible after collapse. */
	finalAssistantMessage: AssistantAgentMessage;
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

function findMessageIndex(messages: AgentMessage[], target: AgentMessage, from: number): number {
	for (let index = from; index < messages.length; index++) {
		if (isSameTranscriptMessage(messages[index]!, target)) return index;
	}
	return -1;
}

/**
 * Display-only projection for naturally completed agent runs. Session history,
 * exports, provider context, and persisted JSONL retain every original message.
 */
export function collapseCompletedRuns(
	sessionContext: SessionContext,
	collapses: readonly CompletedRunCollapse[],
): SessionContext {
	if (collapses.length === 0) return sessionContext;

	const source = sessionContext.messages;
	const spans: Array<{ start: number; request: number; answer: number }> = [];
	let searchFrom = 0;
	for (const collapse of collapses) {
		const start = findMessageIndex(source, collapse.firstMessage, searchFrom);
		if (start < 0) continue;
		const request = findMessageIndex(source, collapse.initialUserMessage, start);
		if (request < 0) continue;
		const answer = findMessageIndex(source, collapse.finalAssistantMessage, request);
		if (answer < 0) continue;
		spans.push({ start, request, answer });
		searchFrom = answer + 1;
	}
	if (spans.length === 0) return sessionContext;

	const messages: AgentMessage[] = [];
	const cacheMissExplainedAt: boolean[] | undefined = sessionContext.cacheMissExplainedAt ? [] : undefined;
	const push = (message: AgentMessage, sourceIndex: number): void => {
		messages.push(message);
		cacheMissExplainedAt?.push(sessionContext.cacheMissExplainedAt?.[sourceIndex] ?? false);
	};

	let sourceIndex = 0;
	for (const span of spans) {
		while (sourceIndex < span.start) {
			push(source[sourceIndex]!, sourceIndex);
			sourceIndex++;
		}
		push(source[span.request]!, span.request);
		const finalMessage = source[span.answer]!;
		if (finalMessage.role !== "assistant") {
			sourceIndex = span.answer + 1;
			continue;
		}
		const textContent = finalMessage.content.filter(
			content => content.type === "text" && canonicalizeMessage(content.text),
		);
		push(
			textContent.length === finalMessage.content.length ? finalMessage : { ...finalMessage, content: textContent },
			span.answer,
		);
		sourceIndex = span.answer + 1;
	}
	while (sourceIndex < source.length) {
		push(source[sourceIndex]!, sourceIndex);
		sourceIndex++;
	}

	return { ...sessionContext, messages, cacheMissExplainedAt };
}

/**
 * Render an `async-result` custom message (a completed background bash/task job,
 * or a batch of them) as a transcript block of one "Background job completed"
 * row per job.
 */
export function buildAsyncResultBlock(message: CustomOrHookMessage): TranscriptBlock {
	const details = (
		message as CustomMessage<{
			jobId?: string;
			type?: "bash" | "task";
			label?: string;
			durationMs?: number;
			jobs?: Array<{ jobId?: string; type?: "bash" | "task"; label?: string; durationMs?: number }>;
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
	const block = new TranscriptBlock();
	for (const job of jobs) {
		const jobId = job.jobId ?? "unknown";
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
 * Whether an assistant turn has visible text or thinking content (after
 * canonicalization) — i.e. content that closes the current read-tool run.
 */
export function assistantHasVisibleContent(message: AssistantAgentMessage): boolean {
	return message.content.some(
		content =>
			(content.type === "text" && canonicalizeMessage(content.text)) ||
			(content.type === "thinking" && canonicalizeMessage(content.thinking)),
	);
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
 * Silent and user-interrupt aborts yield no label. Recovered auto-retry errors
 * collapse to a single non-error note; terminal errors keep the full red presentation.
 */
export function resolveAssistantErrorPresentation(
	message: AssistantAgentMessage,
	retryAttempt = 0,
): AssistantErrorPresentation {
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
