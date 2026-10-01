import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext, RenderSessionContextOptions } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { buildSessionContext, type SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { Container } from "@oh-my-pi/pi-tui";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

function renderLastLine(container: Container, width = 120): string {
	const last = container.children[container.children.length - 1];
	if (!last) return "";
	return last.render(width).join("\n");
}

function renderContainer(container: Container, width = 120): string {
	return container.render(width).join("\n");
}

function createInitialRenderHarness(): { ctx: InteractiveModeContext; helpers: UiHelpers } {
	const ctx = createInteractiveModeContext({
		renderSessionContext: (context: SessionContext, options?: RenderSessionContextOptions) =>
			helpers.renderSessionContext(context, options),
		renderSessionContextIncrementally: (
			context: SessionContext,
			options: RenderSessionContextOptions,
			renderChunk?: () => void,
		) => helpers.renderSessionContextIncrementally(context, options, renderChunk),
		addMessageToChat: (message: AgentMessage) => helpers.addMessageToChat(message),
		settings: Settings.isolated(),
		session: {
			buildTranscriptSessionContext: () => buildSessionContext([]),
			getAsyncJobSnapshot: () => null,
		},
	});
	const helpers = new UiHelpers(ctx);
	return { ctx, helpers };
}

describe("InteractiveMode.showStatus", () => {
	let settingsState: SettingsTestState;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(() => {
		settingsState = beginSettingsTest();
	});

	afterEach(() => {
		restoreSettingsTestState(settingsState);
	});

	test("coalesces immediately-sequential status messages", () => {
		const ctx = createInteractiveModeContext();
		const helpers = new UiHelpers(ctx);

		helpers.showStatus("STATUS_ONE");
		expect(ctx.chatContainer.children).toHaveLength(1);
		expect(renderLastLine(ctx.chatContainer)).toContain("STATUS_ONE");

		helpers.showStatus("STATUS_TWO");
		// second status updates the previous notice instead of appending
		expect(ctx.chatContainer.children).toHaveLength(1);
		expect(renderLastLine(ctx.chatContainer)).toContain("STATUS_TWO");
		expect(renderLastLine(ctx.chatContainer)).not.toContain("STATUS_ONE");
	});

	test("appends a new status line if something else was added in between", () => {
		const ctx = createInteractiveModeContext();
		const helpers = new UiHelpers(ctx);

		helpers.showStatus("STATUS_ONE");
		expect(ctx.chatContainer.children).toHaveLength(1);

		// Something else gets added to the chat in between status updates
		ctx.chatContainer.addChild({ render: () => ["OTHER"], invalidate: () => {} });
		expect(ctx.chatContainer.children).toHaveLength(2);

		helpers.showStatus("STATUS_TWO");
		// adds a fresh notice rather than rewriting the stale one
		expect(ctx.chatContainer.children).toHaveLength(3);
		expect(renderLastLine(ctx.chatContainer)).toContain("STATUS_TWO");
		expect(ctx.chatContainer.children[0]?.render(120).join("\n")).toContain("STATUS_ONE");
	});

	test("preserves startup notifications while rendering the initial transcript", async () => {
		const { ctx, helpers } = createInitialRenderHarness();

		helpers.showWarning("startup notification probe");
		await helpers.renderInitialMessages({ preserveExistingChat: true });

		expect(renderContainer(ctx.chatContainer)).toContain("startup notification probe");
	});

	test("preserves optimistic user signatures when rebuilding transcript state", () => {
		const ctx = createInteractiveModeContext({
			optimisticUserMessageSignature: "hello\u00001",
		});
		const helpers = new UiHelpers(ctx);

		helpers.renderSessionContext(buildSessionContext([]));

		// renderSessionContext must not clear the signature — the message_start
		// handler owns this lifecycle and uses it to guard against clearing the
		// user's in-progress editor draft during an optimistic send (#783).
		expect(ctx.optimisticUserMessageSignature).toBe("hello\u00001");
	});
});
