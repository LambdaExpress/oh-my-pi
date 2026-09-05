import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EditSession, type EditVirtualResource } from "@oh-my-pi/pi-natives";
import type { SSHHost } from "@oh-my-pi/pi-coding-agent/capability/ssh";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool, getEditStore, type EditToolDetails } from "@oh-my-pi/pi-coding-agent/edit";
import {
	canonicalSshResourceKey,
	InternalUrlRouter,
	type InternalResource,
	type InternalUrl,
	type ProtocolHandler,
	type ResolveContext,
	type WriteContext,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import * as lspConfig from "@oh-my-pi/pi-coding-agent/lsp/config";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

type Mutation = { op: "write"; key: string; content: string } | { op: "delete"; key: string };

class FakeSshProtocolHandler implements ProtocolHandler {
	readonly scheme = "ssh";
	readonly immutable = false;
	readonly files: Map<string, string>;
	readonly mutations: Mutation[] = [];
	readonly moves: Array<{ from: string; to: string; content: string | undefined }> = [];
	readonly contexts: Array<ResolveContext | WriteContext | undefined> = [];
	readonly canonicalKeys: string[] = [];

	constructor(files: Readonly<Record<string, string>>) {
		this.files = new Map(Object.entries(files));
	}

	canonicalKey(url: InternalUrl): string {
		const key = canonicalSshResourceKey(url);
		this.canonicalKeys.push(key);
		return key;
	}

	async stat(url: InternalUrl, context?: ResolveContext): Promise<"file" | "missing"> {
		this.contexts.push(context);
		return this.files.has(this.canonicalKey(url)) ? "file" : "missing";
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		this.contexts.push(context);
		const key = this.canonicalKey(url);
		const content = this.files.get(key);
		if (content === undefined) throw new Error(`File not found: ${key}`);
		return {
			url: key,
			content,
			contentType: "text/plain",
			size: Buffer.byteLength(content),
		};
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<void> {
		this.contexts.push(context);
		const key = this.canonicalKey(url);
		this.files.set(key, content);
		this.mutations.push({ op: "write", key, content });
	}

	async delete(url: InternalUrl, context?: WriteContext): Promise<void> {
		this.contexts.push(context);
		const key = this.canonicalKey(url);
		if (!this.files.delete(key)) throw new Error(`File not found: ${key}`);
		this.mutations.push({ op: "delete", key });
	}

	async move(
		fromUrl: InternalUrl,
		toUrl: InternalUrl,
		content: string | undefined,
		context?: WriteContext,
	): Promise<void> {
		const from = this.canonicalKey(fromUrl);
		const to = this.canonicalKey(toUrl);
		this.moves.push({ from, to, content });
		const persisted = content ?? this.files.get(from);
		if (persisted === undefined) throw new Error(`File not found: ${from}`);
		await this.write(toUrl, persisted, context);
		await this.delete(fromUrl, context);
	}
}

interface SessionOptions {
	bridge?: ClientBridge;
	sshHosts?: readonly SSHHost[];
	enableLsp?: boolean;
}

function createSession(cwd: string, options: SessionOptions = {}): ToolSession {
	const getArtifactsDir = () => path.join(cwd, "artifacts");
	const getSessionId = () => "session-a";
	return {
		cwd,
		hasUI: false,
		enableLsp: options.enableLsp ?? false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir,
		getSessionId,
		localProtocolOptions: { getArtifactsDir, getSessionId },
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated({
			"edit.enforceSeenLines": false,
			"lsp.diagnosticsOnEdit": true,
			"lsp.formatOnWrite": true,
		}),
		getClientBridge: options.bridge ? () => options.bridge : undefined,
		getSessionSshHosts: options.sshHosts ? async () => options.sshHosts : undefined,
	} as ToolSession;
}

function installRemoteStore(files: Readonly<Record<string, string>>): FakeSshProtocolHandler {
	const handler = new FakeSshProtocolHandler(files);
	InternalUrlRouter.instance().register(handler);
	return handler;
}

function makeBridge() {
	const write = vi.fn(async () => {});
	return {
		bridge: {
			capabilities: { writeTextFile: true },
			writeTextFile: write,
		},
		write,
	};
}

function details(result: { details?: unknown }): EditToolDetails {
	return result.details as EditToolDetails;
}

const SOURCE = "ssh://icaro/tmp/a.ts";
const DESTINATION = "ssh://icaro/tmp/b.ts";

let tmpDir: string;

beforeEach(async () => {
	resetSettingsForTest();
	InternalUrlRouter.resetForTests();
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-edit-ssh-"));
	await Settings.init({ inMemory: true, cwd: tmpDir });
});

afterEach(async () => {
	vi.restoreAllMocks();
	InternalUrlRouter.resetForTests();
	resetSettingsForTest();
	await removeWithRetries(tmpDir);
});

describe("EditTool ssh:// targets", () => {
	it("preloads and replaces a remote resource without local ACP or LSP routing", async () => {
		const handler = installRemoteStore({ [SOURCE]: "hello old\n" });
		const { bridge, write: bridgeWrite } = makeBridge();
		const getServers = spyOn(lspConfig, "getServersForFile").mockImplementation(() => {
			throw new Error("remote edits must not consult local LSP routing");
		});
		const preload = spyOn(EditSession.prototype, "preloadVirtualResource");

		const result = await new EditTool(createSession(tmpDir, { bridge, enableLsp: true }), "replace").execute(
			"replace",
			{
				path: SOURCE,
				old_string: "old",
				new_string: "new",
			},
		);

		expect(result.isError).not.toBe(true);
		expect(handler.files.get(SOURCE)).toBe("hello new\n");
		expect(details(result)).toMatchObject({
			path: SOURCE,
			oldText: "hello old\n",
			newText: "hello new\n",
		});
		expect(preload).toHaveBeenCalledWith({
			canonicalUrl: SOURCE,
			displayUrl: SOURCE,
			content: "hello old\n",
		} satisfies EditVirtualResource);
		expect(bridgeWrite).not.toHaveBeenCalled();
		expect(getServers).not.toHaveBeenCalled();
	});

	it("applies patch mode through the remote protocol handler", async () => {
		const handler = installRemoteStore({ [SOURCE]: "old\n" });

		const result = await new EditTool(createSession(tmpDir), "patch").execute("patch", {
			path: SOURCE,
			edits: [{ op: "update", diff: "@@\n-old\n+new" }],
		});

		expect(result.isError).not.toBe(true);
		expect(handler.files.get(SOURCE)).toBe("new\n");
		expect(details(result).diff).toContain("+1|new");
		expect(handler.mutations).toEqual([{ op: "write", key: SOURCE, content: "new\n" }]);
	});

	it("applies a key-oriented hashline update to a remote resource", async () => {
		const handler = installRemoteStore({ [SOURCE]: "one\ntwo\n" });
		const session = createSession(tmpDir);
		const tag = getEditStore(session).recordSnapshotForKey(SOURCE, "one\ntwo\n", [1, 2]);

		const result = await new EditTool(session, "hashline").execute("hashline", {
			input: `[${SOURCE}#${tag}]\nPUT 2.=2:\n+TWO`,
		});

		expect(result.isError).not.toBe(true);
		expect(handler.files.get(SOURCE)).toBe("one\nTWO\n");
		expect(result.content.map(part => (part.type === "text" ? part.text : "")).join("\n")).toContain(`[${SOURCE}#`);
	});

	it("REM deletes the remote resource and invalidates its retained snapshot", async () => {
		const original = "alpha\nbeta\n";
		const handler = installRemoteStore({ [SOURCE]: original });
		const session = createSession(tmpDir);
		const tag = getEditStore(session).recordSnapshotForKey(SOURCE, original, [1, 2]);

		const removed = await new EditTool(session, "hashline").execute("remove", {
			input: `[${SOURCE}#${tag}]\nREM`,
		});
		expect(removed.isError).not.toBe(true);
		expect(handler.files.has(SOURCE)).toBe(false);
		expect(handler.mutations).toEqual([{ op: "delete", key: SOURCE }]);

		handler.files.set(SOURCE, `inserted\n${original}`);
		handler.mutations.length = 0;
		const stale = await new EditTool(session, "hashline").execute("stale-after-remove", {
			input: `[${SOURCE}#${tag}]\nPUT 2.=2:\n+BETA`,
		});
		expect(stale.isError).toBe(true);
		expect(handler.files.get(SOURCE)).toBe(`inserted\n${original}`);
		expect(handler.mutations).toEqual([]);
	});

	it("MV writes the edited destination before deleting the source", async () => {
		const handler = installRemoteStore({ [SOURCE]: "old\n" });
		const session = createSession(tmpDir);
		const tag = getEditStore(session).recordSnapshotForKey(SOURCE, "old\n", [1]);

		const result = await new EditTool(session, "hashline").execute("move", {
			input: `[${SOURCE}#${tag}]\nPUT 1.=1:\n+new\nMV ${DESTINATION}`,
		});

		expect(result.isError).not.toBe(true);
		expect(handler.files.has(SOURCE)).toBe(false);
		expect(handler.files.get(DESTINATION)).toBe("new\n");
		expect(handler.moves).toEqual([{ from: SOURCE, to: DESTINATION, content: "new\n" }]);
		expect(handler.mutations).toEqual([
			{ op: "write", key: DESTINATION, content: "new\n" },
			{ op: "delete", key: SOURCE },
		]);
		expect(details(result)).toMatchObject({ path: DESTINATION, sourcePath: SOURCE, move: DESTINATION });
	});

	it("emits a final remote preview from the EditTool argument stream", async () => {
		installRemoteStore({ [SOURCE]: "old\n" });
		const tool = new EditTool(createSession(tmpDir), "replace");
		const finalPreview = Promise.withResolvers<{
			files: Array<{ path: string; diff?: string }>;
			streaming: boolean;
		}>();
		const args = { path: SOURCE, old_string: "old", new_string: "new" };
		const stream = tool.openArgStream({
			toolCallId: "preview",
			toolName: "edit",
			emit: update => {
				if (update && typeof update === "object" && "streaming" in update && update.streaming === false) {
					finalPreview.resolve(update as never);
				}
			},
		});
		stream.push(JSON.stringify(args));
		stream.end(args);

		const preview = await finalPreview.promise;
		const result = await tool.execute("preview", args);
		expect(result.isError).not.toBe(true);
		expect(preview.streaming).toBe(false);
		expect(preview.files[0]).toMatchObject({ path: SOURCE });
		expect(preview.files[0]?.diff).toContain("+1|new");
	});

	it("rejects cross-authority and remote-to-local moves before any mutation", async () => {
		for (const [name, destination] of [
			["cross-authority", "ssh://other/tmp/b.ts"],
			["remote-to-local", path.join(tmpDir, "local.ts")],
		] as const) {
			const safe = "ssh://icaro/tmp/safe.ts";
			const handler = installRemoteStore({ [safe]: "safe old\n", [SOURCE]: "old\n" });
			const input = [
				"*** Begin Patch",
				`*** Update File: ${safe}`,
				"@@",
				"-safe old",
				"+safe new",
				`*** Update File: ${SOURCE}`,
				`*** Move to: ${destination}`,
				"@@",
				"-old",
				"+new",
				"*** End Patch",
			].join("\n");

			const result = await new EditTool(createSession(tmpDir), "apply_patch").execute(name, { input });

			expect(result.isError).toBe(true);
			expect(handler.files.get(safe)).toBe("safe old\n");
			expect(handler.files.get(SOURCE)).toBe("old\n");
			expect(handler.mutations).toEqual([]);
			expect(handler.moves).toEqual([]);
			expect(await Bun.file(path.join(tmpDir, "local.ts")).exists()).toBe(false);
		}
	});

	it("keeps session-alias credentials out of canonical keys and tool output", async () => {
		const password = "edit-session-password-sentinel";
		const host: SSHHost = {
			name: "icaro",
			connectionId: "session-revision",
			host: "192.0.2.70",
			username: "deploy",
			password,
			_source: {
				provider: "ssh-session",
				providerName: "Session SSH",
				level: "user",
				path: "session://session-a/revision-a",
			},
		};
		const handler = installRemoteStore({ [SOURCE]: "old\n" });

		const result = await new EditTool(createSession(tmpDir, { sshHosts: [host] }), "replace").execute("alias", {
			path: SOURCE,
			old_string: "old",
			new_string: "new",
		});

		expect(result.isError).not.toBe(true);
		expect(handler.contexts.some(context => context?.sshHosts?.[0]?.password === password)).toBe(true);
		expect(handler.canonicalKeys).not.toHaveLength(0);
		expect(handler.canonicalKeys.every(key => key === SOURCE && !key.includes(password))).toBe(true);
		expect(JSON.stringify(result)).not.toContain(password);
	});
});
