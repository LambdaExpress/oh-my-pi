import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

/** Custom-role message that carries an advisor card. */
export type AdvisorCardMessage = Extract<AgentMessage, { role: "custom" }>;

/**
 * Whether a message is an advisor card.
 *
 * Advisor cards are custom messages the advisor pipeline injects into the
 * transcript; both the coding agent's queue handling and the terminal
 * transcript rows need to recognize them.
 */
export function isAdvisorCard(message: AgentMessage): message is AdvisorCardMessage {
	return message.role === "custom" && message.customType === "advisor";
}
