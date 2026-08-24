import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { BackgroundJobsHubComponent } from "@oh-my-pi/pi-coding-agent/modes/components/background-jobs-hub";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AsyncJobSnapshot, AsyncJobSnapshotItem } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import type { SshTransferToolDetails } from "@oh-my-pi/pi-coding-agent/tools/ssh-transfer";
import type { TUI } from "@oh-my-pi/pi-tui";
import { setLocale } from "../../../src/i18n";

const hubs: BackgroundJobsHubComponent[] = [];

function fakeTui(rows = 30): TUI {
	return { terminal: { rows } } as unknown as TUI;
}

function snapshot(running: AsyncJobSnapshotItem[], recent: AsyncJobSnapshotItem[]): AsyncJobSnapshot {
	return {
		running,
		recent,
		delivery: { queued: 0, delivering: false, pendingJobIds: [] },
	};
}

function renderText(hub: BackgroundJobsHubComponent, width = 140): string {
	return hub
		.render(width)
		.map(line => Bun.stripANSI(line))
		.join("\n");
}

function transferDetails(): SshTransferToolDetails {
	return {
		operation: "upload",
		host: "build-host",
		localPath: "/tmp/release.tar",
		remotePath: "/srv/release.tar",
		status: "completed",
		totalBytes: 1024,
		transferredBytes: 1024,
		percent: 100,
		bytesPerSecond: 512,
		averageBytesPerSecond: 512,
		elapsedMs: 2_000,
		async: { state: "completed", jobId: "upload-1", type: "ssh_transfer" },
	};
}

beforeAll(() => {
	initTheme();
});

afterEach(() => {
	for (const hub of hubs.splice(0)) hub.dispose();
	setLocale(null);
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("BackgroundJobsHubComponent", () => {
	it("opens from /jobs and stops repaint polling when disposed", async () => {
		const showBackgroundJobsHub = vi.fn();
		const controller = new CommandController({ showBackgroundJobsHub } as unknown as InteractiveModeContext);
		await controller.handleJobsCommand();
		expect(showBackgroundJobsHub).toHaveBeenCalledTimes(1);

		vi.useFakeTimers();
		const requestRender = vi.fn();
		const hub = new BackgroundJobsHubComponent({
			ui: fakeTui(),
			getSnapshot: () => snapshot([], []),
			onDone: () => {},
			requestRender,
		});
		hubs.push(hub);
		hub.dispose();
		vi.advanceTimersByTime(1_000);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("shows running and finished jobs with their owner, input, duration, and output", () => {
		setLocale("en");
		vi.useFakeTimers();
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-24T12:01:00Z"));
		const started = Date.now() - 60_000;
		const current = snapshot(
			[
				{
					id: "build-1",
					type: "bash",
					status: "running",
					label: "bun run build",
					input: "bun run build --filter coding-agent",
					ownerId: "BuildAgent",
					startTime: started,
					progress: { text: "Bundling packages/coding-agent", updatedAt: Date.now() },
				},
			],
			[
				{
					id: "upload-1",
					type: "ssh_transfer",
					status: "completed",
					label: "upload release.tar",
					input: "upload /tmp/release.tar /srv/release.tar",
					ownerId: "ReleaseAgent",
					startTime: started - 10_000,
					settledAt: started - 8_000,
					resultText: "upload completed",
					progress: { text: "upload completed", details: { ...transferDetails() }, updatedAt: Date.now() },
				},
			],
		);
		const hub = new BackgroundJobsHubComponent({
			ui: fakeTui(),
			getSnapshot: () => current,
			onDone: () => {},
			requestRender: () => {},
		});
		hubs.push(hub);

		const running = renderText(hub);
		expect(running).toContain("build-1");
		expect(running).toContain("upload-1");
		expect(running).toContain("BuildAgent");
		expect(running).toContain("bun run build --filter coding-agent");
		expect(running).toContain("Bundling packages/coding-agent");
		expect(running).toContain("1m");

		hub.handleInput("j");
		const completed = renderText(hub);
		expect(completed).toContain("ReleaseAgent");
		expect(completed).toContain("/tmp/release.tar");
		expect(completed).toContain("/srv/release.tar");
		expect(completed).toContain("100.0%");
	});

	it("keeps the selected row while a running command moves into finished history", () => {
		setLocale("en");
		vi.useFakeTimers();
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-24T12:00:00Z"));
		const running: AsyncJobSnapshotItem = {
			id: "eval-1",
			type: "eval",
			status: "running",
			label: "aggregate metrics",
			input: "display(await aggregateMetrics())",
			ownerId: "MetricsAgent",
			startTime: Date.now() - 2_000,
			progress: { text: "loaded 20 rows", updatedAt: Date.now() },
		};
		let current = snapshot([running], []);
		const requestRender = vi.fn();
		const hub = new BackgroundJobsHubComponent({
			ui: fakeTui(),
			getSnapshot: () => current,
			onDone: () => {},
			requestRender,
		});
		hubs.push(hub);
		expect(renderText(hub)).toContain("loaded 20 rows");

		current = snapshot(
			[],
			[
				{
					...running,
					status: "failed",
					settledAt: Date.now(),
					errorText: "aggregate failed",
					progress: { text: "aggregate failed", updatedAt: Date.now() },
				},
			],
		);
		vi.advanceTimersByTime(500);
		const completed = renderText(hub);
		expect(requestRender).toHaveBeenCalled();
		expect(completed).toContain("eval-1");
		expect(completed).toContain("MetricsAgent");
		expect(completed).toContain("display(await aggregateMetrics())");
		expect(completed).toContain("aggregate failed");
	});
});
