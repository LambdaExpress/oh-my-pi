import { describe, expect, it } from "bun:test";
import { listSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

describe("listSessions", () => {
	it("finds messages after a large leading custom notice", async () => {
		const storage = new MemorySessionStorage();
		const sessionDir = "/sessions";
		const sessionPath = `${sessionDir}/new-session.jsonl`;
		const lines = [
			{ type: "title", title: "Generated title" },
			{
				type: "session",
				version: 3,
				id: "new-session",
				timestamp: "2026-07-28T00:00:00.000Z",
				cwd: "/project",
			},
			{ type: "model_change", model: "provider/model" },
			{ type: "custom_message", customType: "xdev-mount-notice", content: "x".repeat(8 * 1024) },
			{ type: "message", message: { role: "user", content: "actual first prompt" } },
			{ type: "message", message: { role: "assistant", content: "completed response" } },
		];
		storage.writeTextSync(sessionPath, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);

		const sessions = await listSessions(sessionDir, storage);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			id: "new-session",
			title: "Generated title",
			firstMessage: "actual first prompt",
			messageCount: 2,
			status: "complete",
		});
	});
});
