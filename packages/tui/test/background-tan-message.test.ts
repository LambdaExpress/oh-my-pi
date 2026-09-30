import { beforeAll, describe, expect, it } from "bun:test";
import { createBackgroundTanDispatchBlock } from "@oh-my-pi/pi-tui/chat/background-tan-message";
import { StrippedToolCallsPlaceholder } from "@oh-my-pi/pi-tui/chat/stripped-tool-calls-placeholder";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE, type CustomMessage } from "@oh-my-pi/pi-tui/chat/messages";
import { createIrcMessageCard } from "@oh-my-pi/pi-tui/tools/wait";

function dispatchMessage(details: { jobId: string; work: string; sessionFile: string }): CustomMessage<unknown> {
	return {
		role: "custom",
		customType: BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
		// The persisted content is the full system-notice the model reads; the
		// renderer must NOT surface it in the transcript.
		content: '<system-notice reason="background_task_dispatched">raw block</system-notice>',
		display: true,
		details,
		attribution: "user",
		timestamp: Date.now(),
	} as CustomMessage<unknown>;
}

describe("createBackgroundTanDispatchBlock", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("renders one compact line with the job id and work preview, not the raw notice", () => {
		const block = createBackgroundTanDispatchBlock(
			dispatchMessage({ jobId: "job-42", work: "investigate the cache reuse path", sessionFile: "/x/Tan-1.jsonl" }),
		);

		const lines = block.render(120).filter(line => line.trim().length > 0);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("job-42");
		expect(lines[0]).toContain("investigate the cache reuse path");
		expect(lines[0]).not.toContain("system-notice");
	});

	it("truncates an overlong work preview so the line stays a single pill", () => {
		const block = createBackgroundTanDispatchBlock(
			dispatchMessage({ jobId: "job-7", work: "x".repeat(200), sessionFile: "/x/Tan-2.jsonl" }),
		);

		const line = block.render(120).find(rendered => rendered.includes("job-7")) ?? "";

		expect(line).toContain("…");
		expect(line).not.toContain("x".repeat(80));
	});

	it("keeps single-line activity adjacent to folded messages and restores normal spacing", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(
			createIrcMessageCard({ kind: "incoming", from: "Peer", body: "ready to start" }, () => false, theme),
		);
		transcript.addChild(
			createBackgroundTanDispatchBlock(
				dispatchMessage({ jobId: "job-42", work: "check GPS", sessionFile: "/x/Tan-1.jsonl" }),
			),
		);
		transcript.addChild(new StrippedToolCallsPlaceholder(2, true));

		transcript.setToolRowsFolded(true);
		const folded = transcript.renderViewport(120, 12).map(line => Bun.stripANSI(line).trim());
		expect(folded).toHaveLength(3);
		expect(folded[0]).toContain("Peer: ready to start");
		expect(folded[1]).toContain("job-42");
		expect(folded[2]).toContain("2");

		transcript.setToolRowsFolded(false);
		const expanded = transcript.renderViewport(120, 12).map(line => Bun.stripANSI(line).trim());
		expect(expanded.filter(line => line === "")).toHaveLength(2);
		expect(expanded.some(line => line.includes("ready to start") && !line.includes("IRC"))).toBe(true);
	});
});
