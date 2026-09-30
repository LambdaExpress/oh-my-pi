import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
// The coding-agent-only renderers (ssh_transfer among them) register themselves
// into pi-tui's shared registry; a test that drives `ToolExecutionComponent`
// directly must load them explicitly.
import "@oh-my-pi/pi-coding-agent/tools/local-renderers";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { SshTransferToolDetails } from "@oh-my-pi/pi-tui/tools/ssh-transfer-summary";
import type { TUI } from "@oh-my-pi/pi-tui";

function result(
	percent: number,
	status: SshTransferToolDetails["status"],
	overrides: Partial<SshTransferToolDetails> = {},
) {
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
		...overrides,
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

	it("keeps the upload filename and advancing progress bar on one folded row", () => {
		const component = new ToolExecutionComponent(
			"ssh_transfer",
			{
				op: "upload",
				host: "fixture",
				local_path: "C:\\build\\output\\archives\\upload.zip",
				remote_path: "/srv/renamed.zip",
			},
			{},
			undefined,
			{ requestRender() {}, requestComponentRender() {}, resetDisplay() {} } as unknown as TUI,
		);
		component.setToolRowsFolded(true);
		try {
			const pending = component.render(100).map(Bun.stripANSI);
			expect(pending).toHaveLength(1);
			expect(pending[0]).toMatch(/:\s*fixture\s/);
			expect(pending[0]).toContain("upload.zip");

			component.updateResult(result(25, "running", { localPath: "C:\\build\\output\\archives\\upload.zip" }), true);
			const first = component.render(100).map(Bun.stripANSI);
			expect(first).toHaveLength(1);
			expect(first[0]).toMatch(/:\s*fixture\s+Upload\b/);
			expect(first[0]).toContain("25.0%");
			expect(first[0]).toContain("██░░░░░░░░");
			expect(first[0]).toContain("upload.zip");

			component.updateResult(result(75, "running", { localPath: "C:\\build\\output\\archives\\upload.zip" }), true);
			const second = component.render(100).map(Bun.stripANSI);
			expect(second).toHaveLength(1);
			expect(second[0]).toContain("75.0%");
			expect(second[0]).toContain("███████░░░");
			expect(second[0]).not.toContain("25.0%");

			component.updateResult(result(100, "completed", { localPath: "C:\\build\\output\\archives\\upload.zip" }));
			const completed = component.render(100).map(Bun.stripANSI);
			expect(completed).toHaveLength(1);
			expect(completed[0]).toMatch(/:\s*fixture\s+Upload\b/);
			expect(completed[0]).toContain("100.0%");
			expect(completed[0]).toContain("██████████");
			expect(completed[0]).toContain("upload.zip");
		} finally {
			component.stopAnimation();
		}
	});

	it("shows the remote download filename and live progress through a folded xd dispatch", () => {
		const args = {
			op: "download" as const,
			host: "fixture",
			local_path: "C:\\downloads\\saved.bin",
			remote_path: `/srv/${"long-directory/".repeat(10)}download.tar`,
		};
		const component = new ToolExecutionComponent(
			"write",
			{ path: "xd://ssh_transfer", content: JSON.stringify(args) },
			{},
			undefined,
			{ requestRender() {}, requestComponentRender() {}, resetDisplay() {} } as unknown as TUI,
		);
		component.setToolRowsFolded(true);
		try {
			const pending = Bun.stripANSI(component.render(100)[0]!);
			expect(pending).toMatch(/:\s*fixture\s/);
			expect(pending).toContain("download.tar");
			const snapshot = result(50, "running", {
				operation: "download",
				localPath: args.local_path,
				remotePath: args.remote_path,
				async: { state: "running", jobId: "download-job", type: "ssh_transfer" },
			});
			component.updateResult(
				{
					content: snapshot.content,
					details: { xdev: { tool: "ssh_transfer", mode: "execute", args, inner: snapshot.details } },
				},
				true,
			);
			const rows = component.render(80).map(Bun.stripANSI);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatch(/:\s*fixture\s+Download\b/);
			expect(rows[0]).toContain("50.0%");
			expect(rows[0]).toContain("█████░░░░░");
			expect(rows[0]).toContain("download.tar");
			expect(rows[0]).not.toContain("saved.bin");
			expect(Bun.stringWidth(rows[0]!)).toBeLessThanOrEqual(80);

			const final = result(100, "completed", {
				operation: "download",
				localPath: args.local_path,
				remotePath: args.remote_path,
			});
			component.updateResult({
				content: final.content,
				details: { xdev: { tool: "ssh_transfer", mode: "execute", args, inner: final.details } },
			});
			const completed = Bun.stripANSI(component.render(80)[0]!);
			expect(completed).toMatch(/:\s*fixture\s+Download\b/);
			expect(completed).toContain("100.0%");
		} finally {
			component.stopAnimation();
		}
	});

	it("keeps a folded SSH transfer documentation request free of invented transfer progress", () => {
		const component = new ToolExecutionComponent(
			"write",
			{ path: "xd://ssh_transfer", content: "?" },
			{},
			undefined,
			{ requestRender() {}, requestComponentRender() {}, resetDisplay() {} } as unknown as TUI,
		);
		component.setToolRowsFolded(true);
		component.updateResult({
			content: [{ type: "text", text: "Upload or download a file" }],
			details: { xdev: { tool: "ssh_transfer", mode: "help" } },
		});
		const rows = component.render(100).map(Bun.stripANSI);
		expect(rows).toHaveLength(1);
		expect(rows[0]).not.toMatch(/%|█|░/);
	});
});
