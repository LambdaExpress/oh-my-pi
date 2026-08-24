import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SshTransferToolDetails } from "@oh-my-pi/pi-coding-agent/tools/ssh-transfer";
import type { TUI } from "@oh-my-pi/pi-tui";

function result(percent: number, status: SshTransferToolDetails["status"]) {
	const totalBytes = 1024 * 1024;
	const transferredBytes = (totalBytes * percent) / 100;
	const details: SshTransferToolDetails = {
		operation: "upload",
		host: "fixture",
		localPath: "/tmp/blob.bin",
		remotePath: "/srv/blob.bin",
		status,
		totalBytes,
		transferredBytes,
		percent,
		bytesPerSecond: 256 * 1024,
		averageBytesPerSecond: 256 * 1024,
		elapsedMs: percent * 40,
	};
	return {
		content: [{ type: "text" as const, text: `${percent}%` }],
		details,
	};
}

describe("ToolExecutionComponent SSH transfer repaint", () => {
	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("replaces 25% with 75% and then the final frame without stale rows", () => {
		vi.useFakeTimers();
		const ui = {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		} as unknown as TUI;
		const component = new ToolExecutionComponent(
			"ssh_transfer",
			{ op: "upload", host: "fixture", local_path: "/tmp/blob.bin", remote_path: "/srv/blob.bin" },
			{},
			undefined,
			ui,
		);
		try {
			component.updateResult(result(25, "running"), true, "tool-1");
			const first = component
				.render(100)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(first).toContain("25.0%");

			component.updateResult(result(75, "running"), true, "tool-1");
			const second = component
				.render(100)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(second).toContain("75.0%");
			expect(second).not.toContain("25.0%");

			component.updateResult(result(100, "completed"), false, "tool-1");
			const final = component
				.render(100)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(final).toContain("100.0%");
			expect(final).not.toContain("75.0%");
		} finally {
			component.stopAnimation();
		}
	});
});
