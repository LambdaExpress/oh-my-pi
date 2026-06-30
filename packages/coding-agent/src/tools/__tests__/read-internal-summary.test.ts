import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as capability from "../../capability";
import type { SSHHost } from "../../capability/ssh";
import type { CapabilityResult } from "../../capability/types";
import { Settings } from "../../config/settings";
import { InternalUrlRouter } from "../../internal-urls/router";
import type { InternalResource, ProtocolHandler } from "../../internal-urls/types";
import type { ToolSession } from "../../sdk";
import * as fileTransfer from "../../ssh/file-transfer";
import { ReadTool, type ReadToolDetails } from "../read";

function makeSettings(): Settings {
	return Settings.isolated({
		"read.summarize.enabled": true,
		"read.summarize.minTotalLines": 1,
		"read.summarize.minBodyLines": 2,
		"read.summarize.minCommentLines": 2,
		"read.summarize.unfoldUntil": 0,
		"read.summarize.unfoldLimit": 80,
		"read.defaultLimit": 500,
		readLineNumbers: false,
		"edit.mode": "replace",
	});
}

function makeSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		hasEditTool: false,
		settings: makeSettings(),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		...overrides,
	} as ToolSession;
}

function textOf(result: AgentToolResult<ReadToolDetails>): string {
	const block = result.content.find(content => content.type === "text");
	return block?.type === "text" ? block.text : "";
}

function codeFixture(label: string): string {
	return `export function alpha(value: string): string {
	const clean = value.trim();
	const fallback = clean || "${label}";
	const sentinel = "${label}-sentinel-7";
	const combined = fallback + ":" + sentinel;
	return combined.toUpperCase();
}

export class Beta {
	render(input: number): number {
		const doubled = input * 2;
		const shifted = doubled + 1;
		const squared = shifted * shifted;
		return squared;
	}
}
`;
}

function mockHosts(hosts: SSHHost[] = []): void {
	const result: CapabilityResult<SSHHost> = {
		items: hosts,
		all: hosts,
		warnings: [],
		providers: hosts.length ? ["ssh-json"] : [],
	};
	vi.spyOn(capability, "loadCapability").mockResolvedValue(result as CapabilityResult<unknown>);
}

function mockRemoteText(content: string): void {
	vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("file");
	vi.spyOn(fileTransfer, "readRemoteFile").mockResolvedValue({
		bytes: new TextEncoder().encode(content),
		truncated: false,
	});
}

describe("read internal URL structural summaries", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		InternalUrlRouter.resetForTests();
	});

	it("summarizes an ssh:// TypeScript resource when no selector is present", async () => {
		const content = codeFixture("ssh");
		mockHosts();
		mockRemoteText(content);
		const tool = new ReadTool(makeSession(process.cwd()));

		const result = await tool.execute("read-ssh-summary", { path: "ssh://icaro/tmp/example.ts" });
		const text = textOf(result);

		expect(result.details?.summary?.elidedSpans).toBeGreaterThan(0);
		expect(result.details?.summary?.elidedLines).toBeGreaterThan(0);
		expect(result.details?.displayContent?.text).toContain("export function alpha");
		expect(text).toContain("re-read needed ranges");
		expect(text).toContain("ssh://icaro/tmp/example.ts:");
		expect(text).not.toContain("ssh-sentinel-7");
		expect(result.details?.meta?.source).toEqual({ type: "internal", value: "ssh://icaro/tmp/example.ts" });
	});

	it("does not summarize ssh:// raw or range selectors", async () => {
		const content = codeFixture("ssh");
		mockHosts();
		mockRemoteText(content);
		const tool = new ReadTool(makeSession(process.cwd()));

		const raw = await tool.execute("read-ssh-raw", { path: "ssh://icaro/tmp/example.ts:raw" });
		const range = await tool.execute("read-ssh-range", { path: "ssh://icaro/tmp/example.ts:1-5" });

		expect(raw.details?.summary).toBeUndefined();
		expect(range.details?.summary).toBeUndefined();
		expect(textOf(raw)).toContain("ssh-sentinel-7");
		expect(textOf(range)).not.toContain("re-read needed ranges");
	});

	it("summarizes a non-ssh in-memory internal URL resource without sourcePath", async () => {
		const memContent = codeFixture("memtest");
		const handler: ProtocolHandler = {
			scheme: "memory",
			immutable: true,
			async resolve(url): Promise<InternalResource> {
				return {
					url: url.href,
					content: memContent,
					contentType: "text/plain",
					size: Buffer.byteLength(memContent, "utf-8"),
				};
			},
		};
		InternalUrlRouter.instance().register(handler);
		const tool = new ReadTool(makeSession(process.cwd()));

		const result = await tool.execute("read-memory-summary", { path: "memory://host/src/example.ts" });
		const text = textOf(result);

		expect(result.details?.summary?.elidedSpans).toBeGreaterThan(0);
		expect(result.details?.resolvedPath).toBeUndefined();
		expect(result.details?.meta?.source).toEqual({ type: "internal", value: "memory://host/src/example.ts" });
		expect(text).toContain("memory://host/src/example.ts:");
		expect(text).not.toContain("memtest-sentinel-7");
	});

	it("leaves internal directory listings unsummarized", async () => {
		const dirListing = "child.ts\nREADME.md";
		const handler: ProtocolHandler = {
			scheme: "rule",
			immutable: true,
			async resolve(url): Promise<InternalResource> {
				return {
					url: url.href,
					content: dirListing,
					contentType: "text/plain",
					size: Buffer.byteLength(dirListing, "utf-8"),
					isDirectory: true,
				};
			},
		};
		InternalUrlRouter.instance().register(handler);
		const tool = new ReadTool(makeSession(process.cwd()));

		const result = await tool.execute("read-internal-directory", { path: "rule://host/src" });
		const text = textOf(result);

		expect(result.details?.summary).toBeUndefined();
		expect(text).toContain("child.ts");
		expect(text).not.toContain("re-read needed ranges");
	});

	it("continues to summarize local:// files through the real-file path", async () => {
		using tmp = TempDir.createSync("@omp-read-local-summary-");
		const localRoot = path.join(tmp.path(), "local");
		await Bun.write(path.join(localRoot, "example.ts"), codeFixture("local"));
		const tool = new ReadTool(
			makeSession(tmp.path(), {
				localProtocolOptions: {
					getArtifactsDir: () => tmp.path(),
					getSessionId: () => "read-local-summary",
				},
			}),
		);

		const result = await tool.execute("read-local-summary", { path: "local://example.ts" });

		expect(result.details?.summary?.elidedSpans).toBeGreaterThan(0);
		expect(result.details?.meta?.source?.type).toBe("path");
		expect(textOf(result)).not.toContain("local-sentinel-7");
	});
});
