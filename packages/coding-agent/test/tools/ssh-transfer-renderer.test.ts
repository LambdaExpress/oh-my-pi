import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	formatSshTransferSummary,
	type SshTransferToolDetails,
	sshTransferToolRenderer,
} from "@oh-my-pi/pi-coding-agent/tools/ssh-transfer";

function transferDetails(overrides: Partial<SshTransferToolDetails> = {}): SshTransferToolDetails {
	return {
		operation: "upload",
		host: "fixture",
		localPath: "/tmp/blob.bin",
		remotePath: "/srv/blob.bin",
		status: "running",
		totalBytes: 1024 * 1024,
		transferredBytes: 512 * 1024,
		percent: 50,
		bytesPerSecond: 256 * 1024,
		averageBytesPerSecond: 256 * 1024,
		elapsedMs: 2_000,
		...overrides,
	};
}

describe("SSH transfer rendering", () => {
	let uiTheme: Theme;

	beforeAll(async () => {
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		uiTheme = loaded;
		setThemeInstance(loaded);
	});

	it("renders a deterministic bar, percentage, size, and speed", () => {
		const summary = formatSshTransferSummary(transferDetails());
		expect(summary).toContain("█████░░░░░  50.0%");
		expect(summary).toContain("512.0KB / 1.0MB");
		expect(summary).toContain("256.0KB/s");
	});

	it("sanitizes hostile fields and derives the Error line from details.error", () => {
		const summary = formatSshTransferSummary(
			transferDetails({
				host: "bad\n\thost\u001b[31m",
				localPath: "/tmp/source\nname",
				remotePath: "/srv/target\tname",
				status: "failed",
				error: "permission\n\tdenied\u001b[0m",
			}),
		);
		const lines = summary.split("\n");
		expect(lines).toHaveLength(3);
		expect(summary).not.toContain("\u001b");
		expect(summary).toContain("bad\\n   host");
		expect(summary).toContain("Error: permission\\n   denied");
	});

	it("keeps every ANSI-stripped line within a narrow render width", () => {
		const width = 34;
		const component = sshTransferToolRenderer.renderResult(
			{ content: [{ type: "text", text: "ignored" }], details: transferDetails() },
			{ expanded: false, isPartial: true },
			uiTheme,
			{ op: "upload", host: "fixture" },
		);
		const lines = component.render(width).map(line => Bun.stripANSI(line));
		expect(lines.every(line => Bun.stringWidth(line) <= width)).toBe(true);
		expect(lines.join("\n")).toContain("50.0%");
	});
});
