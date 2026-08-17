/**
 * Regression: a completed background SSH transfer consumed via `hub wait` /
 * `hub jobs` (which acknowledges the async delivery, so no `async-result`
 * follow-up is ever injected) must still clear its row from the SSH transfer
 * HUD. The hub tool execution end is the only transcript-side signal in that
 * flow — before the fix the HUD kept rendering the settled 100% progress bar
 * below the transcript forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SshTransferHud } from "@oh-my-pi/pi-coding-agent/modes/components/ssh-transfer-hud";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AsyncJobSnapshotItem } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SshTransferToolDetails } from "@oh-my-pi/pi-coding-agent/tools/ssh-transfer";

function transferDetails(status: SshTransferToolDetails["status"]): SshTransferToolDetails {
	return {
		operation: "upload",
		host: "fixture",
		localPath: "/tmp/blob.bin",
		remotePath: "/srv/blob.bin",
		status,
		totalBytes: 1024 * 1024,
		transferredBytes: status === "completed" ? 1024 * 1024 : 256 * 1024,
		percent: status === "completed" ? 100 : 25,
		bytesPerSecond: 128 * 1024,
		averageBytesPerSecond: 128 * 1024,
		elapsedMs: 2_000,
		async: {
			state: status === "completed" ? "completed" : "running",
			jobId: "bg_1",
			type: "ssh_transfer",
		},
	};
}

function transferJob(
	status: AsyncJobSnapshotItem["status"],
	options: { settled?: boolean } = {},
): AsyncJobSnapshotItem {
	return {
		id: "bg_1",
		type: "ssh_transfer",
		status,
		label: "upload blob",
		startTime: 100,
		toolCallId: "tool-1",
		progress: {
			text: "transfer progress",
			details: { ...transferDetails(status === "running" ? "running" : "completed") },
			updatedAt: 200,
		},
		...(options.settled ? { settledAt: 300 } : {}),
	};
}

describe("EventController SSH transfer HUD persistence", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	function createFixture() {
		const sshTransferHud = new SshTransferHud();
		const ctx = {
			isInitialized: true,
			init: vi.fn(async () => {}),
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
			statusLine: { invalidate: vi.fn() },
			updateEditorTopBorder: vi.fn(),
			toolOutputExpanded: false,
			transcriptMessageComponents: new WeakMap(),
			pendingTools: new Map(),
			chatContainer: { addChild: vi.fn() },
			sshTransferHud,
			sshTransferContainer: { clear: vi.fn(), addChild: vi.fn() },
			session: { getToolByName: () => undefined, hasBuiltInTool: () => true, isStreaming: true },
			showWarning: vi.fn(),
			viewSession: { getToolByName: () => undefined, hasBuiltInTool: () => true, isStreaming: false },
			sessionManager: { getCwd: () => process.cwd() },
			setTodos: vi.fn(),
			addMessageToChat: vi.fn(),
			optimisticCustomMessageSignature: undefined,
		} as unknown as InteractiveModeContext;
		return { controller: new EventController(ctx), sshTransferHud };
	}

	it("clears a settled transfer from the HUD when hub wait consumed its delivery", async () => {
		const { controller, sshTransferHud } = createFixture();
		sshTransferHud.update(transferJob("completed", { settled: true }));
		expect(sshTransferHud.size).toBe(1);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "hub-1",
			toolName: "hub",
			isError: false,
			result: {
				content: [{ type: "text", text: "## Completed (1)" }],
				details: {
					op: "wait",
					jobs: [
						{
							id: "bg_1",
							type: "ssh_transfer",
							status: "completed",
							label: "upload blob",
							startTime: 100,
							settledAt: 300,
						},
					],
				},
			},
		});

		expect(sshTransferHud.size).toBe(0);
	});

	it("keeps running transfers when a hub wait snapshot only covers active jobs", async () => {
		const { controller, sshTransferHud } = createFixture();
		sshTransferHud.update(transferJob("running"));
		expect(sshTransferHud.size).toBe(1);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "hub-1",
			toolName: "hub",
			isError: false,
			result: {
				content: [{ type: "text", text: "## Still Running (1)" }],
				details: {
					op: "wait",
					jobs: [
						{
							id: "bg_1",
							type: "ssh_transfer",
							status: "running",
							label: "upload blob",
							startTime: 100,
						},
					],
				},
			},
		});

		expect(sshTransferHud.size).toBe(1);
	});

	it("clears the HUD when the async-result follow-up lands instead", async () => {
		const { controller, sshTransferHud } = createFixture();
		sshTransferHud.update(transferJob("completed", { settled: true }));
		expect(sshTransferHud.size).toBe(1);

		await controller.handleEvent({
			type: "message_start",
			message: {
				role: "custom",
				customType: "async-result",
				content: [],
				display: true,
				attribution: "agent",
				details: {
					jobs: [{ jobId: "bg_1", status: "completed", settledAt: 300 }],
				},
				timestamp: 400,
			},
		} as never);

		expect(sshTransferHud.size).toBe(0);
	});
});
