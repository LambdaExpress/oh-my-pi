import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import * as capability from "@oh-my-pi/pi-coding-agent/capability";
import type { CapabilityResult } from "@oh-my-pi/pi-coding-agent/capability/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getFileSnapshotStore } from "@oh-my-pi/pi-coding-agent/edit/file-snapshot-store";
import { canonicalSshResourceKey, parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls";
import * as fileTransfer from "@oh-my-pi/pi-coding-agent/ssh/file-transfer";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ReadToolDetails } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

const HASHLINE_HEADER = /^\[(ssh:\/\/icaro\/tmp\/app\.ts)#([0-9A-F]{4})\]/m;

function createSession(): ToolSession {
	const settings = Settings.isolated();
	settings.set("read.summarize.enabled", false);
	return {
		cwd: os.tmpdir(),
		hasEditTool: true,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	};
}

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("\n");
}

describe("read ssh:// hashline snapshots", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("records full remote content under the canonical SSH key for range reads", async () => {
		vi.spyOn(capability, "loadCapability").mockResolvedValue({
			items: [],
			all: [],
			warnings: [],
			providers: [],
		} as CapabilityResult<unknown>);
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("file");
		const fullText = "one\ntwo\nthree\n";
		vi.spyOn(fileTransfer, "readRemoteFile").mockResolvedValue({
			bytes: new TextEncoder().encode(fullText),
			truncated: false,
		});

		const session = createSession();
		const result = await new ReadTool(session).execute("call", { path: "ssh://icaro/tmp/app.ts:1-2" });
		const output = textOutput(result);
		const header = HASHLINE_HEADER.exec(output);

		expect(header?.[1]).toBe("ssh://icaro/tmp/app.ts");
		const tag = header?.[2];
		expect(tag).toBeDefined();
		expect(result.details?.resolvedPath).toBeUndefined();
		expect(result.details?.meta?.source).toEqual({ type: "internal", value: "ssh://icaro/tmp/app.ts" });
		const canonicalKey = canonicalSshResourceKey(parseInternalUrl("ssh://icaro/tmp/app.ts"));
		expect(getFileSnapshotStore(session).byHash(canonicalKey, tag ?? "")?.text).toBe(fullText);
	});
});
