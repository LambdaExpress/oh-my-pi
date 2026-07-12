import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { RawSseDebugBuffer } from "@oh-my-pi/pi-coding-agent/debug/raw-sse-buffer";
import { createReportBundle } from "@oh-my-pi/pi-coding-agent/debug/report-bundle";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const model: Model<"anthropic-messages"> = buildModel({
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalXdgStateHome = process.env.XDG_STATE_HOME;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
let cleanupRoot: string | undefined;

afterEach(async () => {
	if (originalXdgStateHome === undefined) {
		delete process.env.XDG_STATE_HOME;
	} else {
		process.env.XDG_STATE_HOME = originalXdgStateHome;
	}
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	if (cleanupRoot) {
		await removeWithRetries(cleanupRoot);
		cleanupRoot = undefined;
	}
});

describe("raw SSE report bundle", () => {
	it("includes captured raw SSE text and dropped-record disclosure", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-raw-sse-report-"));
		const xdgStateHome = path.join(cleanupRoot, "state");
		await fs.mkdir(path.join(xdgStateHome, "omp"), { recursive: true });
		process.env.XDG_STATE_HOME = xdgStateHome;
		setAgentDir(fallbackAgentDir);

		const buffer = new RawSseDebugBuffer();
		buffer.recordResponse(
			{ status: 200, requestId: "req_report", headers: {}, metadata: { lastTransport: "sse" } },
			model,
		);
		for (let i = 0; i < 1_001; i++) {
			buffer.recordEvent(
				{ event: "message_delta", data: `{"i":${i}}`, raw: ["event: message_delta", `data: {"i":${i}}`] },
				model,
			);
		}
		const rawSseText = buffer.toRawText();
		expect(rawSseText).toContain(": omp-debug-dropped records=");
		expect(rawSseText).toContain("event: message_delta");

		const result = await createReportBundle({ sessionFile: undefined, rawSseText });

		expect(result.files).toContain("raw-sse.txt");
		const archive = new Bun.Archive(await Bun.file(result.path).bytes());
		const files = await archive.files();
		expect(await files.get("raw-sse.txt")?.text()).toBe(rawSseText);
	});

	it("exact-replaces session SSH passwords across main, subagent, raw SSE, and config payloads", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ssh-report-"));
		const xdgStateHome = path.join(cleanupRoot, "state");
		await fs.mkdir(path.join(xdgStateHome, "omp"), { recursive: true });
		process.env.XDG_STATE_HOME = xdgStateHome;
		setAgentDir(path.join(cleanupRoot, "agent"));
		const password = "report-session-ssh-password-sentinel";
		const timestamp = "2026-07-12T00:00:00.000Z";
		const sessionFile = path.join(cleanupRoot, "main.jsonl");
		const sessionLines = [
			JSON.stringify({ type: "session", version: 3, id: "main", timestamp, cwd: cleanupRoot }),
			JSON.stringify({
				type: "ssh_config_change",
				operation: "upsert",
				name: "prod",
				config: { host: "example.com", password },
				id: "ssh-main",
				parentId: null,
				timestamp,
			}),
			JSON.stringify({
				type: "message",
				id: "message-main",
				parentId: "ssh-main",
				timestamp,
				message: { role: "user", content: [{ type: "text", text: `ordinary main ${password}` }] },
			}),
		];
		await Bun.write(sessionFile, `${sessionLines.join("\n")}\n`);
		await Bun.write(
			path.join(cleanupRoot, "subagent.jsonl"),
			`${JSON.stringify({ type: "session", version: 3, id: "sub", timestamp, cwd: cleanupRoot })}\n${JSON.stringify({
				type: "message",
				id: "message-sub",
				parentId: null,
				timestamp,
				message: { role: "user", content: [{ type: "text", text: `ordinary sub ${password}` }] },
			})}\n`,
		);

		const result = await createReportBundle({
			sessionFile,
			rawSseText: `data: {"password":"${password}"}`,
			settings: { diagnostic: `settings ${password}` },
		});
		const archive = new Bun.Archive(await Bun.file(result.path).bytes());
		const files = await archive.files();
		for (const [name, file] of files) {
			const text = await file.text();
			expect(text, name).not.toContain(password);
		}
		expect(await files.get("session.jsonl")?.text()).toContain("ssh_config_change");
		expect(await files.get("session.jsonl")?.text()).toContain("[REDACTED]");
		expect(await files.get("session.jsonl")?.text()).toContain("ordinary main");
		expect(await files.get("subagents/subagent.jsonl")?.text()).toContain("ordinary sub");
		expect(await Bun.file(sessionFile).text()).toContain(password);
	});
});
