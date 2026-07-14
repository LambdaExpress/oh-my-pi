import { beforeAll, describe, expect, it } from "bun:test";
import { SshTransferHud } from "@oh-my-pi/pi-coding-agent/modes/components/ssh-transfer-hud";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { buildAsyncResultBlock } from "@oh-my-pi/pi-coding-agent/modes/utils/transcript-render-helpers";
import type { AsyncJobSnapshot, AsyncJobSnapshotItem } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SshTransferToolDetails } from "@oh-my-pi/pi-coding-agent/tools/ssh-transfer";

function details(status: SshTransferToolDetails["status"]): SshTransferToolDetails {
	return {
		operation: "download",
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
		...(status === "failed" || status === "cancelled" ? { error: "cleanup completed" } : {}),
		async: {
			state: status === "completed" ? "completed" : status === "running" ? "running" : "failed",
			jobId: "job-1",
			type: "ssh_transfer",
		},
	};
}

function job(
	status: AsyncJobSnapshotItem["status"],
	options: { settled?: boolean; transferStatus?: SshTransferToolDetails["status"] } = {},
): AsyncJobSnapshotItem {
	return {
		id: "job-1",
		type: "ssh_transfer",
		status,
		label: "download blob",
		startTime: 100,
		toolCallId: "tool-1",
		progress: {
			text: "transfer progress",
			details: { ...details(options.transferStatus ?? status) },
			updatedAt: 200,
		},
		...(options.settled ? { settledAt: 300 } : {}),
	};
}

function render(hud: SshTransferHud): string {
	return hud
		.render(100)
		.map(line => Bun.stripANSI(line))
		.join("\n");
}

describe("SshTransferHud", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("updates one stable row from running progress to the terminal result", () => {
		const hud = new SshTransferHud();
		hud.update(job("running"));
		expect(render(hud)).toContain("25.0%");

		hud.update(job("completed", { settled: true }));
		const terminal = render(hud);
		expect(terminal).toContain("100.0%");
		expect(terminal).not.toContain("25.0%");
		expect(hud.size).toBe(1);

		hud.markPersisted(["job-1"]);
		expect(hud.size).toBe(0);
	});

	it("keeps cancel-only results visible until cleanup settles and is persisted", () => {
		const hud = new SshTransferHud();
		hud.update(job("cancelled", { transferStatus: "running" }));
		expect(render(hud)).toContain("Cancelling · cleanup in progress");
		hud.markPersisted(["job-1"]);
		expect(hud.size).toBe(1);

		hud.update(job("cancelled", { settled: true, transferStatus: "cancelled" }));
		expect(render(hud)).toContain("Error:");
		hud.markPersisted(["job-1"]);
		expect(hud.size).toBe(0);
	});

	it("restores active transfers and only terminal transfers still awaiting delivery", () => {
		const hud = new SshTransferHud();
		const terminal = job("completed", { settled: true });
		const snapshot: AsyncJobSnapshot = {
			running: [job("running")],
			recent: [terminal, { ...terminal, id: "job-2", toolCallId: "tool-2" }],
			delivery: {
				queued: 1,
				delivering: false,
				pendingJobIds: ["job-2"],
			},
		};
		hud.restore(snapshot);
		expect(hud.size).toBe(2);
		const rendered = render(hud);
		expect(rendered).toContain("2 SSH transfers");
	});
	it("rebuilds a persistent cancelled transfer block from async-result details", () => {
		const transfer = details("cancelled");
		const message: CustomMessage = {
			role: "custom",
			customType: "async-result",
			content: "cancelled",
			display: true,
			attribution: "agent",
			details: {
				jobs: [
					{
						jobId: "job-1",
						type: "ssh_transfer",
						status: "cancelled",
						durationMs: 2_000,
						progress: { text: "cancelled", details: transfer, updatedAt: 300 },
						settledAt: 300,
					},
				],
			},
			timestamp: 400,
		};
		const output = buildAsyncResultBlock(message)
			.render(120)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(output).toContain("Background SSH transfer cancelled");
		expect(output).toContain("Download [fixture]");
		expect(output).toContain("128.0KB/s");
		expect(output).toContain("Error: cleanup completed");
	});
});
