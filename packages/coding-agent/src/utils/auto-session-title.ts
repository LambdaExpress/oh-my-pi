import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { titleTextFromSkillPrompt } from "@oh-my-pi/pi-tui/chat/skill-title-input";
import { textContent } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { isTitleContextReply } from "../session/messages";
import { formatTitleConversationContext, type TitleConversationTurn } from "../tiny/message-preproc";

const DEFERRED_TITLE_CONTEXT_TURN_LIMIT = 6;

/**
 * Build the recent exchange for a declined first-message title. Unlike replan
 * titles, this path needs the assistant's reply to disambiguate the request.
 * Only successful replies count; tool output and agent-authored prompts do not.
 */
export function buildDeferredTitleContext(messages: readonly AgentMessage[]): string {
	const turns: TitleConversationTurn[] = [];
	let hasReply = false;
	for (let index = messages.length - 1; index >= 0 && turns.length < DEFERRED_TITLE_CONTEXT_TURN_LIMIT; index--) {
		const message = messages[index];
		if (!message) continue;
		let text: string | undefined;
		if (message.role === "user") {
			if (message.attribution === "agent") continue;
			text = textContent(message.content, "\n\n");
		} else if (message.role === "assistant") {
			if (!isTitleContextReply(message)) continue;
			text = textContent(message.content, "\n\n");
			for (const block of message.content) {
				if (block.type !== "thinking" || !block.thinking.trim()) continue;
				text += `${text ? "\n\n" : ""}${block.thinking}`;
			}
		} else {
			text = titleTextFromSkillPrompt(message);
		}
		if (!text?.trim()) continue;
		const role = message.role === "assistant" ? "assistant" : "user";
		turns.push({ role, text });
		if (role === "assistant") hasReply = true;
	}
	if (!hasReply) return "";
	turns.reverse();
	return formatTitleConversationContext(turns);
}
