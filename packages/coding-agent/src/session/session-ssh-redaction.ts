import type { AgentEvent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@oh-my-pi/pi-ai";

export const SSH_SESSION_REDACTED = "[REDACTED]";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function redactSshSessionToolArguments(argumentsValue: unknown): unknown {
	if (!isRecord(argumentsValue) || !Object.hasOwn(argumentsValue, "password")) return argumentsValue;
	return { ...argumentsValue, password: SSH_SESSION_REDACTED };
}

function redactToolCall(toolCall: ToolCall, toolCallId?: string): ToolCall {
	if (toolCall.name !== "ssh_session" || (toolCallId !== undefined && toolCall.id !== toolCallId)) return toolCall;
	const argumentsValue = redactSshSessionToolArguments(toolCall.arguments);
	return argumentsValue === toolCall.arguments
		? toolCall
		: { ...toolCall, arguments: argumentsValue as Record<string, unknown> };
}

export function redactSshSessionAssistantMessage(message: AssistantMessage, toolCallId?: string): AssistantMessage {
	let changed = false;
	const content = message.content.map(block => {
		if (block.type !== "toolCall") return block;
		const redacted = redactToolCall(block, toolCallId);
		if (redacted !== block) changed = true;
		return redacted;
	});
	return changed ? { ...message, content } : message;
}

export function redactSshSessionMessage(message: AgentMessage): AgentMessage {
	return message.role === "assistant" ? redactSshSessionAssistantMessage(message) : message;
}

function redactAssistantMessageEvent(event: AssistantMessageEvent): AssistantMessageEvent {
	if (event.type === "done") {
		const message = redactSshSessionAssistantMessage(event.message);
		return message === event.message ? event : { ...event, message };
	}
	if (event.type === "error") {
		const error = redactSshSessionAssistantMessage(event.error);
		return error === event.error ? event : { ...event, error };
	}

	const partial = redactSshSessionAssistantMessage(event.partial);
	if (event.type === "toolcall_end") {
		const toolCall = redactToolCall(event.toolCall);
		return partial === event.partial && toolCall === event.toolCall ? event : { ...event, partial, toolCall };
	}
	if (event.type === "toolcall_delta") {
		const block = event.partial.content[event.contentIndex];
		const delta = block?.type === "toolCall" && block.name === "ssh_session" ? "" : event.delta;
		return partial === event.partial && delta === event.delta ? event : { ...event, partial, delta };
	}
	return partial === event.partial ? event : { ...event, partial };
}

export function redactSshSessionAgentEvent(event: AgentEvent): AgentEvent {
	switch (event.type) {
		case "agent_end": {
			const messages = event.messages.map(redactSshSessionMessage);
			return messages.every((message, index) => message === event.messages[index]) ? event : { ...event, messages };
		}
		case "turn_end": {
			const message = redactSshSessionMessage(event.message);
			return message === event.message ? event : { ...event, message };
		}
		case "message_start":
		case "message_end": {
			const message = redactSshSessionMessage(event.message);
			return message === event.message ? event : { ...event, message };
		}
		case "message_update": {
			const message = redactSshSessionMessage(event.message);
			const assistantMessageEvent = redactAssistantMessageEvent(event.assistantMessageEvent);
			return message === event.message && assistantMessageEvent === event.assistantMessageEvent
				? event
				: { ...event, message, assistantMessageEvent };
		}
		case "tool_execution_start":
		case "tool_execution_update": {
			if (event.toolName !== "ssh_session") return event;
			const args = redactSshSessionToolArguments(event.args);
			return args === event.args ? event : { ...event, args };
		}
		default:
			return event;
	}
}
