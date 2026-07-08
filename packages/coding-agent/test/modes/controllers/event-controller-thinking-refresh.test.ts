import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AUTO_THINKING } from "@oh-my-pi/pi-coding-agent/thinking";

function createFixture(opts: { effectiveHideThinkingBlock: boolean }) {
	const requestRender = vi.fn();
	const requestComponentRender = vi.fn();
	const refreshDisplay = vi.fn();
	const resetDisplay = vi.fn();
	const statusLineInvalidate = vi.fn();
	const updateEditorBorderColor = vi.fn();

	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		settings,
		ui: { requestRender, requestComponentRender, refreshDisplay, resetDisplay },
		statusLine: { invalidate: statusLineInvalidate },
		updateEditorTopBorder: vi.fn(),
		updateEditorBorderColor,
		chatContainer: { children: [] },
		effectiveHideThinkingBlock: opts.effectiveHideThinkingBlock,
	} as unknown as InteractiveModeContext;

	const controller = new EventController(ctx);
	return {
		controller,
		requestRender,
		refreshDisplay,
		resetDisplay,
		statusLineInvalidate,
		updateEditorBorderColor,
	};
}

async function dispatchThinkingLevelChanged(
	controller: EventController,
	event: Omit<Extract<AgentSessionEvent, { type: "thinking_level_changed" }>, "type">,
): Promise<void> {
	await controller.handleEvent({ type: "thinking_level_changed", ...event });
}

describe("EventController thinking_level_changed refresh semantics", () => {
	beforeEach(async () => {
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("uses a non-destructive refresh when auto thinking changes effective visibility", async () => {
		const { controller, requestRender, refreshDisplay, resetDisplay, statusLineInvalidate, updateEditorBorderColor } =
			createFixture({ effectiveHideThinkingBlock: true });

		await dispatchThinkingLevelChanged(controller, {
			thinkingLevel: ThinkingLevel.Medium,
			configured: AUTO_THINKING,
		});

		expect(statusLineInvalidate).toHaveBeenCalledTimes(1);
		expect(updateEditorBorderColor).toHaveBeenCalledTimes(1);
		expect(refreshDisplay).toHaveBeenCalledTimes(1);
		expect(refreshDisplay).toHaveBeenCalledWith("auto-thinking-visibility-change");
		expect(resetDisplay).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("uses the ordinary render path when effective visibility does not change", async () => {
		const { controller, requestRender, refreshDisplay, resetDisplay } = createFixture({
			effectiveHideThinkingBlock: false,
		});

		await dispatchThinkingLevelChanged(controller, { thinkingLevel: ThinkingLevel.High });

		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(refreshDisplay).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("keeps non-auto effective visibility changes on the destructive reset path", async () => {
		const { controller, requestRender, refreshDisplay, resetDisplay } = createFixture({
			effectiveHideThinkingBlock: true,
		});

		await dispatchThinkingLevelChanged(controller, { thinkingLevel: ThinkingLevel.Low });

		expect(resetDisplay).toHaveBeenCalledTimes(1);
		expect(refreshDisplay).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
	});
});
