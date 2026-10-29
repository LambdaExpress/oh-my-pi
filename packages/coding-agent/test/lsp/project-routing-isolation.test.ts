import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getOrCreateClient, sendRequest, shutdownClientInstance } from "@oh-my-pi/pi-coding-agent/lsp/client";
import * as lspConfig from "@oh-my-pi/pi-coding-agent/lsp/config";
import { waitForDiagnostics } from "@oh-my-pi/pi-coding-agent/lsp/diagnostics";
import { muxServerKey } from "@oh-my-pi/pi-coding-agent/lsp/mux/protocol";
import { findLspProjectRoot, getLspFileCwd } from "@oh-my-pi/pi-coding-agent/lsp/servers";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp/tool";
import type { LspClient, ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";
import { fileToUri } from "@oh-my-pi/pi-coding-agent/lsp/utils";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";
import { MessageFramer } from "../../src/jsonrpc/message-framing";

interface Message {
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
}

interface Peer {
	cwd: string;
	messages: Message[];
	send(message: Message): void;
	next(method: string): Promise<Message>;
}

/** Exercise the real client/framing path while controlling server scheduling. */
function installPeer(options: { holdInitialize?: boolean; holdDiagnostics?: boolean } = {}): Peer[] {
	const peers: Peer[] = [];
	vi.spyOn(ptree, "spawn").mockImplementation(((_command, spawnOptions) => {
		const messages: Message[] = [];
		const waiters = new Map<string, Array<(message: Message) => void>>();
		const encoder = new TextEncoder();
		let controller: ReadableStreamDefaultController<Uint8Array>;
		let exitCode: number | null = null;
		const exited = Promise.withResolvers<number>();
		const stdout = new ReadableStream<Uint8Array>({ start: value => (controller = value) });
		const send = (message: Message): void => {
			const json = JSON.stringify({ jsonrpc: "2.0", ...message });
			controller.enqueue(encoder.encode(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`));
		};
		const exit = (): void => {
			if (exitCode !== null) return;
			exitCode = 0;
			controller.close();
			exited.resolve(0);
		};
		const peer: Peer = {
			cwd: String(spawnOptions?.cwd),
			messages,
			send,
			next(method) {
				const existing = messages.find(message => message.method === method);
				if (existing) return Promise.resolve(existing);
				const pending = Promise.withResolvers<Message>();
				const entries = waiters.get(method) ?? [];
				entries.push(pending.resolve);
				waiters.set(method, entries);
				return pending.promise;
			},
		};
		peers.push(peer);
		const framer = new MessageFramer(Buffer.alloc(0));
		return {
			stdout,
			stdin: {
				write(chunk: string | Uint8Array) {
					const bytes = Buffer.from(chunk);
					framer.push(bytes);
					for (const text of framer.drain(() => {})) {
						const message = JSON.parse(text) as Message;
						messages.push(message);
						for (const resolve of waiters.get(message.method ?? "") ?? []) resolve(message);
						waiters.delete(message.method ?? "");
						if (message.method === "initialize" && !options.holdInitialize) {
							send({ id: message.id, result: { capabilities: { diagnosticProvider: {} } } });
						} else if (message.method === "initialized") {
							send({ method: "$/progress", params: { token: "load", value: { kind: "end" } } });
						} else if (message.method === "textDocument/diagnostic" && !options.holdDiagnostics) {
							send({ id: message.id, result: { kind: "full", items: [] } });
						} else if (message.method === "textDocument/references") {
							const { textDocument, position } = message.params as {
								textDocument: { uri: string };
								position: { line: number; character: number };
							};
							send({
								id: message.id,
								result: [
									{
										uri: textDocument.uri,
										range: { start: position, end: { ...position, character: position.character + 1 } },
									},
								],
							});
						} else if (message.method === "fixture/barrier") {
							send({ id: message.id, result: null });
						} else if (message.method === "shutdown") {
							send({ id: message.id, result: null });
						} else if (message.method === "exit") {
							exit();
						}
					}
					return bytes.length;
				},
				flush: () => 0,
			},
			get exited() {
				return exited.promise;
			},
			get exitCode() {
				return exitCode;
			},
			peekStderr: () => "",
			kill: exit,
		} as unknown as ptree.ChildProcess<"pipe">;
	}) as typeof ptree.spawn);
	return peers;
}

describe("LSP project and request isolation", () => {
	let directory: TempDir;
	let clients: LspClient[];
	const server: ServerConfig = {
		command: "routing-isolation-lsp",
		fileTypes: [".cs", ".ts"],
		rootMarkers: ["services/App.sln", "*.csproj", ".git"],
	};

	beforeAll(() => initTheme());
	beforeEach(() => {
		directory = TempDir.createSync("@omp-lsp-project-isolation-");
		clients = [];
	});
	afterEach(async () => {
		for (const client of clients) await shutdownClientInstance(client);
		lspConfig.configCache.delete(directory.path());
		vi.restoreAllMocks();
		directory.removeSync();
	});

	test("prefers the worktree solution over the nearest project and generic Git marker", async () => {
		const root = path.join(directory.path(), "candidate");
		await Bun.write(path.join(root, ".git"), "gitdir: ../main/.git/worktrees/candidate\n");
		await Bun.write(path.join(root, "App.sln"), "");
		await Bun.write(path.join(root, "DAL", "DAL.csproj"), "<Project />");
		const source = path.join(root, "DAL", "Dispatch.cs");
		expect(findLspProjectRoot(source, server.rootMarkers)).toBe(root);
		expect(findLspProjectRoot(source, ["*.sln", "*.csproj", ".git"])).toBe(root);
	});

	test("never climbs across a Git file or directory to an unrelated project marker", async () => {
		await Bun.write(path.join(directory.path(), "App.sln"), "");
		for (const kind of ["file", "directory"]) {
			const root = path.join(directory.path(), kind);
			if (kind === "file") await Bun.write(path.join(root, ".git"), "gitdir: ../main/.git/worktrees/fixture\n");
			else fs.mkdirSync(path.join(root, ".git"), { recursive: true });
			const source = path.join(root, "src", "Program.cs");
			expect(findLspProjectRoot(source, ["App.sln"])).toBeNull();
			expect(getLspFileCwd(source, { ...server, rootMarkers: ["App.sln"] }, directory.path())).toBe(root);
		}
	});

	test("uses specific basename fallbacks before generic roots but retains exact marker priority", async () => {
		const root = path.join(directory.path(), "candidate");
		await Bun.write(path.join(root, ".git"), "gitdir: ../main/.git/worktrees/candidate\n");
		await Bun.write(path.join(root, "tsconfig.json"), "{}");
		const source = path.join(root, "src", "helper.ts");
		expect(findLspProjectRoot(source, ["app/tsconfig.json", ".git", "."])).toBe(root);
		await Bun.write(path.join(root, "app", "tsconfig.json"), "{}");
		expect(findLspProjectRoot(source, ["app/tsconfig.json", ".git"])).toBe(root);
	});

	test("unmarked external files do not inherit the session workspace", () => {
		const sessionRoot = path.join(directory.path(), "main");
		const source = path.join(directory.path(), "external", "helper.ts");
		expect(getLspFileCwd(source, server, sessionRoot)).toBe(path.dirname(source));
		expect(getLspFileCwd(path.join(sessionRoot, "src", "helper.ts"), server, sessionRoot)).toBe(sessionRoot);
	});

	test("different worktrees carry their own roots through spawn, initialize, and mux identity", async () => {
		const peers = installPeer();
		const keys: string[] = [];
		for (const name of ["first", "second"]) {
			const root = path.join(directory.path(), name);
			await Bun.write(path.join(root, ".git"), `gitdir: ../main/.git/worktrees/${name}\n`);
			await Bun.write(path.join(root, "App.sln"), "");
			const source = path.join(root, "DAL", "Dispatch.cs");
			const cwd = getLspFileCwd(source, server, directory.path());
			const client = await getOrCreateClient(server, cwd);
			clients.push(client);
			const peer = peers.at(-1)!;
			const initialize = (await peer.next("initialize")).params as {
				rootUri: string;
				rootPath: string;
				workspaceFolders: Array<{ uri: string }>;
			};
			expect(peer.cwd).toBe(root);
			expect(initialize.rootPath).toBe(root);
			expect(initialize.rootUri).toBe(fileToUri(root));
			expect(initialize.workspaceFolders.map(folder => folder.uri)).toEqual([fileToUri(root)]);
			keys.push(muxServerKey({ command: server.command, args: [], cwd }));
		}
		expect(clients[0]).not.toBe(clients[1]);
		expect(keys[0]).not.toBe(keys[1]);
	});

	test("cancelling the first initializer does not cancel another file's initialization", async () => {
		const peers = installPeer({ holdInitialize: true });
		const controller = new AbortController();
		const first = getOrCreateClient(server, directory.path(), undefined, controller.signal).catch(error => error);
		const peer = peers[0]!;
		const initialize = await peer.next("initialize");
		const second = getOrCreateClient(server, directory.path(), 1_000);
		controller.abort(new Error("first file cancelled"));
		expect((await first).message).toContain("first file cancelled");
		peer.send({ id: initialize.id, result: { capabilities: { diagnosticProvider: {} } } });
		const client = await second;
		clients.push(client);
		expect(client.status).toBe("ready");
		expect(peers).toHaveLength(1);
		expect(
			await sendRequest(client, "textDocument/diagnostic", { textDocument: { uri: fileToUri("second.ts") } }),
		).toEqual({ kind: "full", items: [] });
	});

	test("a short initialize deadline does not terminate a longer concurrent wait", async () => {
		const peers = installPeer({ holdInitialize: true });
		const first = getOrCreateClient(server, directory.path(), 25).catch(error => error);
		const initialize = await peers[0]!.next("initialize");
		const second = getOrCreateClient(server, directory.path(), 1_000);
		expect((await first).message).toContain("initialize timed out after 25ms");
		peers[0]!.send({ id: initialize.id, result: { capabilities: {} } });
		const client = await second;
		clients.push(client);
		expect(client.status).toBe("ready");
		expect(peers).toHaveLength(1);
	});

	test("aborting one document pull cancels only its request ID", async () => {
		const peers = installPeer({ holdDiagnostics: true });
		const client = await getOrCreateClient(server, directory.path());
		clients.push(client);
		const controller = new AbortController();
		const firstUri = fileToUri(path.join(directory.path(), "first.ts"));
		const secondUri = fileToUri(path.join(directory.path(), "second.ts"));
		const first = waitForDiagnostics(client, firstUri, { timeoutMs: 1_000, signal: controller.signal }).catch(
			error => error,
		);
		const second = waitForDiagnostics(client, secondUri, { timeoutMs: 1_000 });
		await sendRequest(client, "fixture/barrier", {});
		controller.abort(new Error("first diagnostic cancelled"));
		const requests = peers[0]!.messages.filter(message => message.method === "textDocument/diagnostic");
		const secondRequest = requests.find(
			message => (message.params as { textDocument: { uri: string } }).textDocument.uri === secondUri,
		)!;
		peers[0]!.send({ id: secondRequest.id, result: { kind: "full", items: [] } });
		expect(await second).toEqual([]);
		expect((await first).message).toContain("first diagnostic cancelled");
		await peers[0]!.next("$/cancelRequest");
		const cancellations = peers[0]!.messages
			.filter(message => message.method === "$/cancelRequest")
			.map(message => (message.params as { id: number }).id);
		const firstRequestId = requests.find(message => message !== secondRequest)?.id;
		if (typeof firstRequestId !== "number") throw new Error("Expected the client's numeric diagnostic request ID");
		expect(cancellations).toEqual([firstRequestId]);
		expect(client.status).toBe("ready");
	});

	test("file diagnostics explain the tool timeout instead of returning Operation aborted", async () => {
		const peers = installPeer({ holdDiagnostics: true });
		const source = path.join(directory.path(), "helper.ts");
		await Bun.write(source, "export const helper = 1;\n");
		const fileServer = { ...server, fileTypes: [".ts"], rootMarkers: ["."] };
		lspConfig.configCache.set(directory.path(), { servers: { typescript: fileServer } });
		clients.push(await getOrCreateClient(fileServer, directory.path()));
		const deadline = new AbortController();
		const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => (ms === 5_000 ? deadline.signal : originalTimeout(ms)));
		const tool = new LspTool({ cwd: directory.path(), settings: Settings.isolated() } as ToolSession);
		const result = tool
			.execute("timeout-diagnostics", { action: "diagnostics", file: source, timeout: 5 })
			.catch(error => error);
		await peers[0]!.next("textDocument/diagnostic");
		deadline.abort(new DOMException("deadline reached", "TimeoutError"));
		const error = await result;
		expect(error.message).toContain("LSP diagnostics timed out after 5s");
		expect(error.message).toContain("typescript");
		expect(error.message).toContain(directory.path());
	});

	test("C# references and diagnostics state their unverified scope and reload restarts that root", async () => {
		const peers = installPeer({ holdDiagnostics: true });
		const root = path.join(directory.path(), "candidate");
		const source = path.join(root, "DAL", "Dispatch.cs");
		await Bun.write(path.join(root, "App.sln"), "");
		await Bun.write(path.join(root, ".git"), "gitdir: ../main/.git/worktrees/candidate\n");
		await Bun.write(source, "class Dispatch {}\n");
		const csharp = { ...server, command: "fixed-cwd-wrapper.cmd" };
		lspConfig.configCache.set(directory.path(), { servers: { "csharp-ls": csharp } });
		const oldClient = await getOrCreateClient(csharp, root);
		clients.push(oldClient);
		const tool = new LspTool({ cwd: directory.path(), settings: Settings.isolated() } as ToolSession);
		const diagnosticResult = tool.execute("csharp-diagnostics", { action: "diagnostics", file: source });
		const peer = peers[0]!;
		const diagnosticRequest = await peer.next("textDocument/diagnostic");
		peer.send({
			id: diagnosticRequest.id,
			result: {
				kind: "full",
				items: [
					{
						message: "Missing project dependency",
						severity: 1,
						code: "CS0246",
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
					},
				],
			},
		});
		const diagnostics = await diagnosticResult;
		const diagnosticText = diagnostics.content
			.flatMap(block => (block.type === "text" ? [block.text] : []))
			.join("\n");
		expect(diagnosticText).toContain("CS0246");
		expect(diagnosticText).toContain(root);
		expect(diagnosticText).toContain("not verified");
		expect(diagnosticText).toContain("wrapper");
		const references = await tool.execute("csharp-references", {
			action: "references",
			file: source,
			line: 1,
			symbol: "Dispatch",
		});
		const referenceText = references.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
		expect(referenceText).toContain("Found 1 reference(s)");
		expect(referenceText).toContain("may be incomplete");
		const reload = await tool.execute("csharp-reload", { action: "reload", file: source });
		const newClient = await getOrCreateClient(csharp, root);
		clients.push(newClient);
		expect(oldClient.proc.exitCode).not.toBeNull();
		expect(newClient).not.toBe(oldClient);
		expect(peers).toHaveLength(2);
		expect(peers[1]!.cwd).toBe(root);
		expect(reload.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n")).toContain(root);
	});

	test("reload * restarts previously requested external roots rather than a spare main-checkout client", async () => {
		const peers = installPeer();
		const config = { servers: { "csharp-ls": server } };
		lspConfig.configCache.set(directory.path(), config);
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue(config);
		const tool = new LspTool({ cwd: directory.path(), settings: Settings.isolated() } as ToolSession);
		const previous: LspClient[] = [];
		for (const name of ["first", "second"]) {
			const root = path.join(directory.path(), "external", name);
			const source = path.join(root, "DAL", "Dispatch.cs");
			await Bun.write(path.join(root, "App.sln"), "");
			await Bun.write(path.join(root, ".git"), `gitdir: ../../main/.git/worktrees/${name}\n`);
			await Bun.write(source, "class Dispatch {}\n");
			await tool.execute(`activate-${name}`, { action: "capabilities", file: source });
			const client = await getOrCreateClient(server, root);
			previous.push(client);
			clients.push(client);
		}
		const result = await tool.execute("reload-all-roots", { action: "reload", file: "*" });
		expect(result.details?.success).toBe(true);
		expect(peers).toHaveLength(4);
		for (const oldClient of previous) {
			expect(oldClient.proc.exitCode).not.toBeNull();
			const replacement = await getOrCreateClient(server, oldClient.cwd);
			clients.push(replacement);
			expect(replacement).not.toBe(oldClient);
		}
		expect(peers.map(peer => peer.cwd)).not.toContain(directory.path());
	});
});
