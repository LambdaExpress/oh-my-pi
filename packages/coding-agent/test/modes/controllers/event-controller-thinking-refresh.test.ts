import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function createFixture(opts: { effectiveHideThinkingBlock: boolean }) {
	const requestRender = vi.fn();
	const requestComponentRender = vi.fn();
	const statusLineInvalidate = vi.fn();
	const updateEditorBorderColor = vi.fn();

	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		settings,
		ui: { requestRender, requestComponentRender },
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

	it("uses a destructive render when effective thinking visibility changes", async () => {
		const { controller, requestRender, statusLineInvalidate, updateEditorBorderColor } = createFixture({
			effectiveHideThinkingBlock: true,
		});

		await dispatchThinkingLevelChanged(controller, { thinkingLevel: ThinkingLevel.Medium });

		expect(statusLineInvalidate).toHaveBeenCalledTimes(1);
		expect(updateEditorBorderColor).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledWith(true);
	});

	it("uses a non-destructive render when effective visibility does not change", async () => {
		const { controller, requestRender } = createFixture({
			effectiveHideThinkingBlock: false,
		});

		await dispatchThinkingLevelChanged(controller, { thinkingLevel: ThinkingLevel.High });

		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledWith();
	});
});
