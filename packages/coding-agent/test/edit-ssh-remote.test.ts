import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as capability from "@oh-my-pi/pi-coding-agent/capability";
import type { CapabilityResult, SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	DEFAULT_FUZZY_THRESHOLD,
	EDIT_MODE_STRATEGIES,
	EditTool,
	executePatchSingle,
	executeReplaceSingle,
} from "@oh-my-pi/pi-coding-agent/edit";
import type { WritethroughCallback } from "@oh-my-pi/pi-coding-agent/lsp";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { RemotePathKind } from "@oh-my-pi/pi-coding-agent/ssh/file-transfer";
import * as fileTransfer from "@oh-my-pi/pi-coding-agent/ssh/file-transfer";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const SOURCE: SourceMeta = {
	provider: "ssh-json",
	providerName: "SSH Config",
	path: "/test/ssh.json",
	level: "user",
};

const noopBeginDeferred = (_path: string) => ({
	onDeferredDiagnostics: () => {},
	signal: new AbortController().signal,
	finalize: () => {},
});

function createSession(cwd: string, bridge?: ClientBridge): ToolSession {
	const getArtifactsDir = () => path.join(cwd, "artifacts");
	const getSessionId = () => "session-a";
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir,
		getSessionId,
		localProtocolOptions: { getArtifactsDir, getSessionId },
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		getClientBridge: bridge ? () => bridge : undefined,
	};
}

function makeBridge() {
	const bridge: ClientBridge = {
		capabilities: { writeTextFile: true },
		writeTextFile: async () => {},
	};
	return { bridge, spy: spyOn(bridge, "writeTextFile") };
}

function makeWritethroughMock(): { writethrough: WritethroughCallback; calledWith: string[] } {
	const calledWith: string[] = [];
	const writethrough: WritethroughCallback = async (dst, content) => {
		calledWith.push(dst);
		await Bun.write(dst, content);
		return undefined;
	};
	return { writethrough, calledWith };
}

function mockHosts(): void {
	const result: CapabilityResult<unknown> = {
		items: [],
		all: [],
		warnings: [],
		providers: [SOURCE.provider],
	};
	vi.spyOn(capability, "loadCapability").mockResolvedValue(result);
}

function installRemoteStore(files: Map<string, string>) {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	mockHosts();
	const statSpy = vi.spyOn(fileTransfer, "statRemotePath").mockImplementation(async (_target, remotePath) => {
		return (files.has(remotePath) ? "file" : "missing") as RemotePathKind;
	});
	const readSpy = vi.spyOn(fileTransfer, "readRemoteFile").mockImplementation(async (_target, remotePath) => {
		const content = files.get(remotePath);
		if (content === undefined) throw new Error(`head: cannot open '${remotePath}': No such file or directory`);
		return { bytes: encoder.encode(content), truncated: false };
	});
	const writeSpy = vi.spyOn(fileTransfer, "writeRemoteFile").mockImplementation(async (_target, remotePath, bytes) => {
		files.set(remotePath, decoder.decode(bytes));
	});
	const deleteSpy = vi.spyOn(fileTransfer, "deleteRemoteFile").mockImplementation(async (_target, remotePath) => {
		files.delete(remotePath);
	});
	const moveSpy = vi.spyOn(fileTransfer, "moveRemoteFile").mockImplementation(async (_target, fromPath, toPath) => {
		const content = files.get(fromPath);
		if (content === undefined) throw new Error(`mv: cannot stat '${fromPath}': No such file or directory`);
		files.set(toPath, content);
		files.delete(fromPath);
	});
	return { statSpy, readSpy, writeSpy, deleteSpy, moveSpy };
}

describe("ssh:// edit targets", () => {
	let tmpDir: string;
	let previousEditVariant: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-edit-ssh-"));
		await Settings.init({ inMemory: true, cwd: tmpDir });
		previousEditVariant = Bun.env.PI_EDIT_VARIANT;
	});

	afterEach(async () => {
		if (previousEditVariant === undefined) {
			delete Bun.env.PI_EDIT_VARIANT;
		} else {
			Bun.env.PI_EDIT_VARIANT = previousEditVariant;
		}
		vi.restoreAllMocks();
		resetSettingsForTest();
		await removeWithRetries(tmpDir);
	});

	it("patch updates a remote UTF-8 text file without ACP or LSP writethrough", async () => {
		const files = new Map([["/tmp/a.ts", "old\n"]]);
		installRemoteStore(files);
		const { bridge, spy: bridgeSpy } = makeBridge();
		const { writethrough, calledWith } = makeWritethroughMock();
		const result = await executePatchSingle({
			session: createSession(tmpDir, bridge),
			path: "ssh://icaro/tmp/a.ts",
			params: { op: "update", diff: "@@\n-old\n+new" },
			allowFuzzy: false,
			fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		expect(files.get("/tmp/a.ts")).toBe("new\n");
		expect(result.details?.path).toBe("ssh://icaro/tmp/a.ts");
		expect(result.details?.oldText).toBe("old\n");
		expect(result.details?.newText).toBe("new\n");
		expect(result.details?.diff).toContain("-1|old");
		expect(result.details?.diff).toContain("+1|new");
		expect(bridgeSpy).not.toHaveBeenCalled();
		expect(calledWith).toEqual([]);
	});

	it("patch deletes a remote file through the protocol handler", async () => {
		const files = new Map([["/tmp/a.ts", "delete me\n"]]);
		const { deleteSpy } = installRemoteStore(files);
		const { writethrough, calledWith } = makeWritethroughMock();
		const result = await executePatchSingle({
			session: createSession(tmpDir),
			path: "ssh://icaro/tmp/a.ts",
			params: { op: "delete" },
			allowFuzzy: false,
			fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		expect(files.has("/tmp/a.ts")).toBe(false);
		expect(deleteSpy).toHaveBeenCalledTimes(1);
		expect(result.details?.op).toBe("delete");
		expect(result.details?.path).toBe("ssh://icaro/tmp/a.ts");
		expect(result.details?.oldText).toBe("delete me\n");
		expect(result.details?.newText).toBeUndefined();
		expect(calledWith).toEqual([]);
	});

	it("patch moves a remote file with final content through the SSH move hook", async () => {
		const files = new Map([["/tmp/a.ts", "old\n"]]);
		const { writeSpy, deleteSpy, moveSpy } = installRemoteStore(files);
		const { writethrough } = makeWritethroughMock();
		const result = await executePatchSingle({
			session: createSession(tmpDir),
			path: "ssh://icaro/tmp/a.ts",
			params: { op: "update", rename: "ssh://icaro/tmp/b.ts", diff: "@@\n-old\n+new" },
			allowFuzzy: false,
			fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		expect(files.get("/tmp/b.ts")).toBe("new\n");
		expect(files.has("/tmp/a.ts")).toBe(false);
		expect(writeSpy.mock.calls[0]?.[1]).toBe("/tmp/b.ts");
		expect(deleteSpy.mock.calls[0]?.[1]).toBe("/tmp/a.ts");
		expect(moveSpy).not.toHaveBeenCalled();
		expect(result.details?.path).toBe("ssh://icaro/tmp/b.ts");
		expect(result.details?.sourcePath).toBe("ssh://icaro/tmp/a.ts");
		expect(result.details?.move).toBe("ssh://icaro/tmp/b.ts");
	});

	it("rejects cross-authority remote moves without writing the destination", async () => {
		const files = new Map([["/tmp/a.ts", "old\n"]]);
		const { writeSpy } = installRemoteStore(files);
		const { writethrough } = makeWritethroughMock();
		await expect(
			executePatchSingle({
				session: createSession(tmpDir),
				path: "ssh://icaro/tmp/a.ts",
				params: { op: "update", rename: "ssh://other/tmp/b.ts", diff: "@@\n-old\n+new" },
				allowFuzzy: false,
				fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
				writethrough,
				beginDeferredDiagnosticsForPath: noopBeginDeferred,
			}),
		).rejects.toThrow(/same SSH authority/);
		expect(files.has("/tmp/b.ts")).toBe(false);
		expect(writeSpy).not.toHaveBeenCalled();
	});

	it("replace edits a remote file without ACP or LSP writethrough", async () => {
		const files = new Map([["/tmp/a.ts", "hello old\n"]]);
		installRemoteStore(files);
		const { bridge, spy: bridgeSpy } = makeBridge();
		const { writethrough, calledWith } = makeWritethroughMock();
		const result = await executeReplaceSingle({
			session: createSession(tmpDir, bridge),
			path: "ssh://icaro/tmp/a.ts",
			params: { old_text: "old", new_text: "new", all: false },
			allowFuzzy: false,
			fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		expect(files.get("/tmp/a.ts")).toBe("hello new\n");
		expect(result.details?.path).toBe("ssh://icaro/tmp/a.ts");
		expect(result.details?.oldText).toBe("hello old\n");
		expect(result.details?.newText).toBe("hello new\n");
		expect(result.details?.diff).toContain("-1|hello old");
		expect(result.details?.diff).toContain("+1|hello new");
		expect(bridgeSpy).not.toHaveBeenCalled();
		expect(calledWith).toEqual([]);
	});

	it("apply_patch applies local and remote files and isolates remote failures", async () => {
		Bun.env.PI_EDIT_VARIANT = "apply_patch";
		const localPath = path.join(tmpDir, "local.txt");
		await Bun.write(localPath, "local old\n");
		const files = new Map([["/tmp/remote.txt", "remote old\n"]]);
		installRemoteStore(files);
		const tool = new EditTool(createSession(tmpDir));

		const mixed = await tool.execute("call-1", {
			input: [
				"*** Begin Patch",
				"*** Update File: local.txt",
				"@@",
				"-local old",
				"+local new",
				"*** Update File: ssh://icaro/tmp/remote.txt",
				"@@",
				"-remote old",
				"+remote new",
				"*** End Patch",
			].join("\n"),
		} as never);
		expect(await Bun.file(localPath).text()).toBe("local new\n");
		expect(files.get("/tmp/remote.txt")).toBe("remote new\n");
		expect(mixed.details?.perFileResults).toHaveLength(2);
		expect(mixed.details?.perFileResults?.map(result => result.path)).toEqual([
			localPath,
			"ssh://icaro/tmp/remote.txt",
		]);

		await Bun.write(localPath, "again old\n");
		const failed = await tool.execute("call-2", {
			input: [
				"*** Begin Patch",
				"*** Update File: local.txt",
				"@@",
				"-again old",
				"+again new",
				"*** Update File: ssh://icaro/tmp/missing.txt",
				"@@",
				"-missing old",
				"+missing new",
				"*** End Patch",
			].join("\n"),
		} as never);
		expect(await Bun.file(localPath).text()).toBe("again new\n");
		expect(failed.details?.perFileResults).toHaveLength(2);
		expect(failed.details?.perFileResults?.[0]?.isError).toBeUndefined();
		expect(failed.details?.perFileResults?.[1]?.isError).toBe(true);
		expect(failed.isError).toBeUndefined();
	});

	it("final previews read remote content while streaming previews stay syntax-only", async () => {
		const files = new Map([["/tmp/a.ts", "old\n"]]);
		const { readSpy } = installRemoteStore(files);
		const signal = new AbortController().signal;

		const replacePreview = await EDIT_MODE_STRATEGIES.replace.computeDiffPreview(
			{ path: "ssh://icaro/tmp/a.ts", edits: [{ old_text: "old", new_text: "new" }] } as never,
			{
				cwd: tmpDir,
				signal,
				snapshots: undefined,
				allowFuzzy: false,
				fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
				isStreaming: false,
			} as never,
		);
		expect(replacePreview?.[0]?.diff).toContain("+1|new");

		readSpy.mockClear();
		const streamingPreview = await EDIT_MODE_STRATEGIES.apply_patch.computeDiffPreview(
			{
				input: `${["*** Begin Patch", "*** Update File: ssh://icaro/tmp/a.ts", "@@", "-old", "+new"].join("\n")}\n`,
			} as never,
			{
				cwd: tmpDir,
				signal,
				snapshots: undefined,
				allowFuzzy: false,
				fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
				isStreaming: true,
			} as never,
		);
		expect(streamingPreview?.[0]?.diff).toContain("+new");
		expect(readSpy).not.toHaveBeenCalled();

		const finalPreview = await EDIT_MODE_STRATEGIES.apply_patch.computeDiffPreview(
			{
				input: [
					"*** Begin Patch",
					"*** Update File: ssh://icaro/tmp/a.ts",
					"@@",
					"-old",
					"+new",
					"*** End Patch",
				].join("\n"),
			} as never,
			{
				cwd: tmpDir,
				signal,
				snapshots: undefined,
				allowFuzzy: false,
				fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
				isStreaming: false,
			} as never,
		);
		expect(finalPreview?.[0]?.diff).toContain("+1|new");
		expect(readSpy).toHaveBeenCalled();
	});
});
