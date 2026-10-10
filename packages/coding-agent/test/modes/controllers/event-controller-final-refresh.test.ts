import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "final answer" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1_000,
		...overrides,
	};
}

function createFixture(opts: {
	streamingMessage: AssistantMessage;
	isTtsrAbortPending?: boolean;
	retryAttempt?: number;
}) {
	const streamingComponent = new AssistantMessageComponent();
	streamingComponent.updateContent(opts.streamingMessage);
	const requestRender = vi.fn();

	const ctx = createInteractiveModeContext({
		settings,
		ui: { requestRender },
		streamingComponent,
		streamingMessage: opts.streamingMessage,
		session: {
			isTtsrAbortPending: opts.isTtsrAbortPending ?? false,
			retryAttempt: opts.retryAttempt ?? 0,
			getAsyncJobSnapshot: () => null,
		},
	});
	ctx.chatContainer.addChild(streamingComponent);
	const renderedFrames: string[] = [];
	requestRender.mockImplementation(() => {
		renderedFrames.push(Bun.stripANSI(ctx.chatContainer.render(120).join("\n")));
	});

	const controller = new EventController(ctx);
	return {
		controller,
		ctx,
		streamingComponent,
		requestRender,
		renderedFrames,
	};
}

async function dispatchMessageEnd(controller: EventController, message: AssistantMessage): Promise<void> {
	await controller.handleEvent({ type: "message_end", message } as Extract<
		AgentSessionEvent,
		{ type: "message_end" }
	>);
}

beforeAll(async () => {
	await initTheme();
});

describe("EventController message_end final refresh", () => {
	beforeEach(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
	});

	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("requests a render after finalizing the assistant component", async () => {
		const message = makeAssistantMessage();
		const { controller, ctx, streamingComponent, requestRender } = createFixture({ streamingMessage: message });
		expect(streamingComponent.isTranscriptBlockFinalized()).toBe(false);

		await dispatchMessageEnd(controller, message);

		expect(streamingComponent.isTranscriptBlockFinalized()).toBe(true);
		expect(Bun.stripANSI(ctx.chatContainer.render(120).join("\n"))).toContain("final answer");
		expect(requestRender).toHaveBeenCalledWith();
	});

	it("requests a render after adding a billed usage row", async () => {
		settings.set("display.showTokenUsage", true);
		const message = makeAssistantMessage({
			usage: {
				input: 0,
				output: 42,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 42,
				cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, total: 1 },
			},
			duration: 1200,
			ttft: 150,
		});
		const { controller, ctx, renderedFrames } = createFixture({ streamingMessage: message });
		expect(Bun.stripANSI(ctx.chatContainer.render(120).join("\n"))).not.toContain(`${theme.icon.output} 42`);

		await dispatchMessageEnd(controller, message);

		const rendered = Bun.stripANSI(ctx.chatContainer.render(120).join("\n"));
		expect(rendered).toContain("final answer");
		expect(rendered).toContain(`${theme.icon.output} 42`);
		expect(renderedFrames.some(frame => frame.includes(`${theme.icon.output} 42`))).toBe(true);
	});
});
