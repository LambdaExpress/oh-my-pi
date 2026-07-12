import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { reconstructSessionSshConfigs } from "@oh-my-pi/pi-coding-agent/session/session-ssh-config";
import {
	redactSshSessionAssistantMessage,
	SSH_SESSION_REDACTED,
} from "@oh-my-pi/pi-coding-agent/session/session-ssh-redaction";
import { TempDir } from "@oh-my-pi/pi-utils";

const SENTINEL = "session-ssh-jsonl-sentinel";

function sshSessionAssistant(password: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "ssh-session-call",
				name: "ssh_session",
				arguments: { op: "create", name: "prod", host: "example.com", password },
			},
		],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

describe("session SSH configuration persistence", () => {
	it("keeps plaintext only in SSH state entries and restores it after close, resume, and compaction", async () => {
		const tempDir = TempDir.createSync("@pi-session-ssh-persistence-");
		let manager: SessionManager | undefined;
		try {
			manager = SessionManager.create(tempDir.path(), tempDir.path());
			const upsertId = manager.appendSshConfigUpsert("prod", {
				host: "example.com",
				username: "deploy",
				password: SENTINEL,
			});
			manager.appendMessage(redactSshSessionAssistantMessage(sshSessionAssistant(SENTINEL)));
			await manager.flush();
			const sessionFile = manager.getSessionFile();
			expect(sessionFile).toBeDefined();
			const persisted = await Bun.file(sessionFile!).text();
			expect(persisted).toContain(`"password":"${SENTINEL}"`);
			expect(persisted).toContain(`"password":"${SSH_SESSION_REDACTED}"`);
			expect(persisted.split(SENTINEL)).toHaveLength(2);

			await manager.close();
			manager = await SessionManager.open(sessionFile!, tempDir.path());
			let restored = reconstructSessionSshConfigs(manager.getBranch());
			expect(restored.get("prod")?.config).toEqual({
				host: "example.com",
				username: "deploy",
				password: SENTINEL,
			});

			manager.appendCompaction("summary", "summary", upsertId, 100);
			await manager.flush();
			await manager.close();
			manager = await SessionManager.open(sessionFile!, tempDir.path());
			restored = reconstructSessionSshConfigs(manager.getBranch());
			expect(restored.get("prod")?.config.password).toBe(SENTINEL);
		} finally {
			await manager?.close();
			tempDir.removeSync();
		}
	});

	it("applies tombstones per branch and restores historical aliases in a branched session", async () => {
		const tempDir = TempDir.createSync("@pi-session-ssh-branch-");
		let manager: SessionManager | undefined;
		let branched: SessionManager | undefined;
		try {
			manager = SessionManager.create(tempDir.path(), tempDir.path());
			const upsertId = manager.appendSshConfigUpsert("prod", { host: "example.com", password: SENTINEL });
			const deleteId = manager.appendSshConfigDelete("prod");
			expect(reconstructSessionSshConfigs(manager.getBranch(deleteId)).has("prod")).toBe(false);
			expect(reconstructSessionSshConfigs(manager.getBranch(upsertId)).get("prod")?.config.password).toBe(SENTINEL);

			await manager.flush();
			const originalFile = manager.getSessionFile();
			const branchedFile = manager.createBranchedSession(upsertId);
			expect(branchedFile).toBeDefined();
			await manager.flush();
			await manager.close();
			manager = undefined;

			branched = await SessionManager.open(branchedFile!, tempDir.path());
			expect(reconstructSessionSshConfigs(branched.getBranch()).get("prod")?.config.password).toBe(SENTINEL);
			await branched.close();
			branched = undefined;

			const original = await SessionManager.open(originalFile!, tempDir.path());
			try {
				expect(reconstructSessionSshConfigs(original.getBranch()).has("prod")).toBe(false);
			} finally {
				await original.close();
			}
		} finally {
			await manager?.close();
			await branched?.close();
			tempDir.removeSync();
		}
	});

	it("isolates aliases from a new session", async () => {
		const tempDir = TempDir.createSync("@pi-session-ssh-isolation-");
		const first = SessionManager.inMemory(tempDir.path());
		const second = SessionManager.inMemory(tempDir.path());
		first.appendSshConfigUpsert("only-first", { host: "example.com", password: SENTINEL });
		expect(reconstructSessionSshConfigs(first.getBranch()).has("only-first")).toBe(true);
		expect(reconstructSessionSshConfigs(second.getBranch()).has("only-first")).toBe(false);
		tempDir.removeSync();
	});
});
