import { beforeAll, describe, expect, it } from "bun:test";
import { CustomMessageComponent } from "@oh-my-pi/pi-tui/chat/custom-message";
import { HookMessageComponent } from "@oh-my-pi/pi-tui/chat/hook-message";
import type { CustomMessage, HookMessage } from "@oh-my-pi/pi-tui/chat/messages";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Text } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme();
});

describe("framed message folding", () => {
	it("shows extension and hook message identities and previews in adjacent rows, then restores their bodies", () => {
		const extension: CustomMessage = {
			role: "custom",
			customType: "deployment-alert",
			content: "WARNING: restore the database\nSecond line with details",
			display: true,
			timestamp: 1,
		};
		const hook: HookMessage = {
			role: "hookMessage",
			customType: "preflight-hook",
			content: "Hold deployment\nCheck the logs",
			display: true,
			timestamp: 2,
		};
		const transcript = new TranscriptContainer();
		transcript.setToolRowsFolded(true);
		transcript.addChild(new CustomMessageComponent(extension));
		transcript.addChild(new HookMessageComponent(hook));

		const folded = transcript.renderViewport(120, 20).map(line => Bun.stripANSI(line).trim());
		expect(folded).toHaveLength(2);
		expect(folded[0]).toContain("deployment-alert");
		expect(folded[0]).toContain("WARNING: restore the database");
		expect(folded[1]).toContain("preflight-hook");
		expect(folded[1]).toContain("Hold deployment");

		transcript.setToolRowsFolded(false);
		const unfolded = Bun.stripANSI(transcript.renderViewport(120, 28).join("\n"));
		expect(unfolded).toContain("Second line with details");
		expect(unfolded).toContain("Check the logs");
	});

	it("keeps a renderer-backed alert discoverable and restores its specialized details", () => {
		const message: CustomMessage = {
			role: "custom",
			customType: "release-status",
			content: "WARNING: deploy paused\nContact the operator",
			display: true,
			timestamp: 3,
		};
		const transcript = new TranscriptContainer();
		transcript.addChild(new CustomMessageComponent(message, () => new Text("Specialized error: lock held", 0, 0)));
		transcript.setToolRowsFolded(true);
		const folded = transcript.renderViewport(42, 8).map(line => Bun.stripANSI(line).trim());
		expect(folded).toHaveLength(1);
		expect(folded[0]).toContain("release-status");
		expect(folded[0]).toContain("WARNING:");
		expect(folded[0]).toContain("…");
		expect(Bun.stringWidth(folded[0]!)).toBeLessThanOrEqual(42);

		transcript.setToolRowsFolded(false);
		expect(Bun.stripANSI(transcript.renderViewport(42, 8).join("\n"))).toContain("Specialized error: lock held");
	});
});
