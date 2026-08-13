import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";

/** Stop-details marker for a provider error after assistant content/tool args already streamed. */
export const STREAM_INTERRUPTED_AFTER_CONTENT_STOP_DETAIL = "stream_interrupted_after_content";

/** Detects API-level provider refusals that are terminal errors, not dialogue to replay. */
export function isProviderRefusalMessage(message: AssistantMessage): boolean {
	if (message.stopReason !== "error") return false;
	const stopType = message.stopDetails?.type;
	const stopCategory = message.stopDetails?.category;
	return (
		stopType === "refusal" || stopType === "sensitive" || stopCategory === "refusal" || stopCategory === "sensitive"
	);
}

/** Whether a persisted provider interruption can remain part of a later successful continuation. */
export function isContinuableStreamInterruption(message: AssistantMessage): boolean {
	return (
		message.stopReason === "error" &&
		message.stopDetails?.type === STREAM_INTERRUPTED_AFTER_CONTENT_STOP_DETAIL &&
		!isProviderRefusalMessage(message)
	);
}

/** Removes API-level provider refusals from live provider replay while preserving other messages. */
export function filterProviderReplayMessages(messages: readonly Message[]): Message[] {
	return messages.filter(message => message.role !== "assistant" || !isProviderRefusalMessage(message));
}
