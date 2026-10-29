import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IpcConnection, ipcEndpoint, Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { MessageFramer } from "../src/jsonrpc/message-framing";
import {
	MUX_CONNECT_METHOD,
	MUX_PING_METHOD,
	MUX_RESTART_METHOD,
	MUX_SERVER_EXIT_METHOD,
	type MuxConnectParams,
	type MuxConnectResult,
	type MuxServerExitParams,
} from "../src/lsp/mux/protocol";
import { LspMuxServer } from "../src/lsp/mux/server";
import { findLspProjectRoot } from "../src/lsp/servers";
import { fileToUri } from "../src/lsp/utils";

interface RpcMessage {
	jsonrpc: "2.0";
	id?: string | number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
}

interface FakeState {
	initializeCount: number;
	processId: number | null;
	initializationOptions: unknown;
	didOpen: Record<string, number>;
	didChange: Record<string, number[]>;
	didClose: string[];
	notifications: string[];
}

interface PublishDiagnosticsParams {
	uri: string;
	version?: number;
	diagnostics: Array<{ message: string; severity: number }>;
}

class MuxTestClient {
	readonly #connection: IpcConnection;
	readonly #framer = new MessageFramer(Buffer.alloc(0));
	readonly #pending = new Map<
		string | number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	readonly #notifications = new Map<string, RpcMessage[]>();
	readonly #notificationWaiters = new Map<string, Array<(message: RpcMessage) => void>>();
	readonly #closed = Promise.withResolvers<void>();
	#nextId = 1;

	constructor(connection: IpcConnection) {
		this.#connection = connection;
		connection.startRaw(
			chunk => {
				this.#framer.push(chunk);
				for (const text of this.#framer.drain(() => {})) this.#receive(JSON.parse(text) as RpcMessage);
			},
			reason => {
				this.#failPending(new Error(reason ? `Mux connection closed: ${reason}` : "Mux connection closed"));
				this.#closed.resolve();
			},
		);
	}

	static async connect(endpoint: string): Promise<MuxTestClient> {
		return new MuxTestClient(await IpcConnection.connect(endpoint, { framing: "raw" }));
	}

	request<T>(method: string, params?: unknown, id: string | number = this.#nextId++): Promise<T> {
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		this.#pending.set(id, { resolve, reject });
		this.#write({ jsonrpc: "2.0", id, method, params });
		return promise as Promise<T>;
	}

	notify(method: string, params?: unknown): void {
		this.#write({ jsonrpc: "2.0", method, params });
	}

	sendRaw(bytes: Buffer): void {
		this.#connection.send(bytes);
	}

	async nextNotification<T>(method: string): Promise<T> {
		const queued = this.#notifications.get(method);
		const message = queued?.shift();
		if (message) return message.params as T;
		const { promise, resolve } = Promise.withResolvers<RpcMessage>();
		const waiters = this.#notificationWaiters.get(method);
		if (waiters) waiters.push(resolve);
		else this.#notificationWaiters.set(method, [resolve]);
		return (await withTimeout(promise, `notification ${method}`)).params as T;
	}

	waitForClose(): Promise<void> {
		return withTimeout(this.#closed.promise, "connection close");
	}

	destroy(): void {
		this.#connection.destroy();
	}

	#write(message: RpcMessage): void {
		const json = JSON.stringify(message);
		this.#connection.send(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
	}

	#receive(message: RpcMessage): void {
		if (message.method !== undefined) {
			if (message.id !== undefined) {
				// Reply first, then queue the request so tests can await it via nextNotification.
				this.#write({ jsonrpc: "2.0", id: message.id, result: message.params });
			}
			const waiters = this.#notificationWaiters.get(message.method);
			const waiter = waiters?.shift();
			if (waiter) waiter(message);
			else {
				const queued = this.#notifications.get(message.method);
				if (queued) queued.push(message);
				else this.#notifications.set(message.method, [message]);
			}
			return;
		}
		if (message.id === undefined) return;
		const pending = this.#pending.get(message.id);
		if (!pending) return;
		this.#pending.delete(message.id);
		if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
		else pending.resolve(message.result);
	}

	#failPending(error: Error): void {
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}
}

async function withTimeout<T>(promise: Promise<T>, description: string, timeoutMs = 5_000): Promise<T> {
	// Real IPC/subprocess integration needs a wall-clock failure watchdog; always cancel it when the event wins.
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error(`Timed out waiting for ${description}`)), timeoutMs);
	try {
		return await Promise.race([promise, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

const fixturePath = path.join(import.meta.dir, "fixtures", "fake-lsp-server.ts");
const framingModuleUrl = new URL("../src/jsonrpc/message-framing.ts", import.meta.url).href;
const initializeParams = (processId = 424242, initializationOptions: unknown = {}): Record<string, unknown> => ({
	processId,
	rootUri: null,
	capabilities: {},
	initializationOptions,
});

async function initialize(
	client: MuxTestClient,
	processId = 424242,
	initializationOptions: unknown = {},
): Promise<Record<string, unknown>> {
	const result = await client.request<Record<string, unknown>>(
		"initialize",
		initializeParams(processId, initializationOptions),
	);
	client.notify("initialized", {});
	return result;
}

async function state(client: MuxTestClient): Promise<FakeState> {
	return client.request<FakeState>("test/state");
}

async function pollUntil(check: () => Promise<boolean>, description: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(25);
	}
	throw new Error(`Timed out waiting for ${description}`);
}

describe("LspMuxServer", () => {
	let server: LspMuxServer;
	let tmpDir: string;
	let endpoint: string;
	let connectParams: MuxConnectParams;
	const clients: MuxTestClient[] = [];

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lsp-mux-test-"));
		endpoint = ipcEndpoint(tmpDir, "mux");
		connectParams = { command: process.execPath, args: ["run", fixturePath], cwd: tmpDir };
		server = new LspMuxServer();
		await server.listen(endpoint);
	});

	afterEach(async () => {
		for (const client of clients.splice(0)) client.destroy();
		await server.shutdown();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	async function link(params = connectParams): Promise<{ client: MuxTestClient; connected: MuxConnectResult }> {
		const client = await MuxTestClient.connect(endpoint);
		clients.push(client);
		const connected = await client.request<MuxConnectResult>(MUX_CONNECT_METHOD, params);
		return { client, connected };
	}

	function backpressuredServer(): void {
		connectParams.args = [
			"-e",
			`
				import { MessageFramer } from ${JSON.stringify(framingModuleUrl)};
				setInterval(() => {}, 1_000);
				const framer = new MessageFramer(Buffer.alloc(0));
				for await (const chunk of Bun.stdin.stream()) {
					framer.push(Buffer.from(chunk));
					for (const text of framer.drain(() => {})) {
						const message = JSON.parse(text);
						if (message.method !== "initialize") continue;
						const json = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
						await Bun.write(Bun.stdout, "Content-Length: " + Buffer.byteLength(json) + "\\r\\n\\r\\n" + json);
						await new Promise(() => {});
					}
				}
			`,
		];
	}

	async function blockServerInput(client: MuxTestClient): Promise<void> {
		await initialize(client);
		client.notify("textDocument/didOpen", {
			textDocument: {
				uri: "file:///backpressured.ts",
				languageId: "typescript",
				version: 1,
				text: "x".repeat(4 * 1024 * 1024),
			},
		});
		// A mux-local reply proves the full document reached the mux even though
		// forwarding it cannot finish while the language server refuses stdin.
		expect(await client.request<string>(MUX_PING_METHOD)).toBe("pong");
	}

	it("reaps a disconnected server even when orphan document cleanup cannot flush", async () => {
		const realSetTimeout = globalThis.setTimeout;
		const lingerStarted = Promise.withResolvers<void>();
		const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
			handler: () => void,
			ms?: number,
			...args: unknown[]
		) => {
			if (ms !== 5 * 60 * 1_000) return realSetTimeout(handler, ms, ...args);
			return realSetTimeout(() => {
				handler();
				lingerStarted.resolve();
			}, 50);
		}) as typeof globalThis.setTimeout);
		let child: Process | null = null;
		try {
			backpressuredServer();
			const { client, connected } = await link();
			child = Process.fromPid(connected.pid!);
			expect(child?.status()).toBe(ProcessStatus.Running);
			await blockServerInput(client);
			client.destroy();

			await withTimeout(lingerStarted.promise, "disconnected server linger expiry");
			// Mux shutdown must join an already-started reap, not return early
			// just because that server has entered the stopping state.
			await withTimeout(server.shutdown(), "in-flight server reap during mux shutdown");
			expect(child?.status()).not.toBe(ProcessStatus.Running);
			expect(server.serverKeys).toEqual([]);
			expect(server.sessionCount).toBe(0);
		} finally {
			child?.killTree();
			timers.mockRestore();
		}
	}, 10_000);

	it("bounds shutdown while a language server write is backpressured", async () => {
		let child: Process | null = null;
		try {
			backpressuredServer();
			const { client, connected } = await link();
			child = Process.fromPid(connected.pid!);
			expect(child?.status()).toBe(ProcessStatus.Running);
			await blockServerInput(client);

			await withTimeout(server.shutdown(), "backpressured mux shutdown");
			expect(child?.status()).not.toBe(ProcessStatus.Running);
			expect(server.serverKeys).toEqual([]);
		} finally {
			child?.killTree();
		}
	}, 10_000);

	for (const exitCode of [0, 7]) {
		it(`reaps inherited-pipe descendants after a wrapper exits with code ${exitCode}`, async () => {
			let descendant: Process | null = null;
			try {
				connectParams.args = [
					"-e",
					`
						import { MessageFramer } from ${JSON.stringify(framingModuleUrl)};
						const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1_000)"], {
							stdin: "ignore",
							stdout: "inherit",
							stderr: "inherit",
							windowsHide: true,
							detached: process.platform === "win32",
						});
						const framer = new MessageFramer(Buffer.alloc(0));
						for await (const chunk of Bun.stdin.stream()) {
							framer.push(Buffer.from(chunk));
							for (const text of framer.drain(() => {})) {
								const message = JSON.parse(text);
								if (message.method === "test/wrapperReady") {
									const json = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { pid: child.pid } });
									await Bun.write(Bun.stdout, "Content-Length: " + Buffer.byteLength(json) + "\\r\\n\\r\\n" + json);
								} else if (message.method === "test/exitWrapper") {
									await Bun.write(Bun.stderr, "wrapper diagnostic\\n");
									process.exit(${exitCode});
								}
							}
						}
					`,
				];
				const { client } = await link();
				const ready = await client.request<{ pid: number }>("test/wrapperReady");
				descendant = Process.fromPid(ready.pid);
				expect(descendant?.status()).toBe(ProcessStatus.Running);
				client.notify("test/exitWrapper");

				expect(await client.nextNotification<MuxServerExitParams>(MUX_SERVER_EXIT_METHOD)).toEqual({
					exitCode,
					stderr: "wrapper diagnostic\n",
				});
				await client.waitForClose();
				await pollUntil(
					() => Promise.resolve(descendant?.status() !== ProcessStatus.Running),
					"wrapper descendant termination",
				);
				expect(server.serverKeys).toEqual([]);
			} finally {
				descendant?.killTree();
			}
		}, 10_000);
	}

	it("forwards the real server exit diagnostic before closing the link", async () => {
		connectParams = {
			command: process.execPath,
			args: ["-e", 'process.stderr.write("missing rust-analyzer component\\n"); process.exit(0);'],
			cwd: tmpDir,
		};
		const { client } = await link();

		const exited = await client.nextNotification<MuxServerExitParams>(MUX_SERVER_EXIT_METHOD);
		expect(exited).toEqual({
			exitCode: 0,
			stderr: "missing rust-analyzer component\n",
		});
		await client.waitForClose();
	}, 10_000);

	it("disconnects a malformed link without terminating other sessions", async () => {
		const healthy = await link();
		await initialize(healthy.client);
		const malformed = await MuxTestClient.connect(endpoint);
		clients.push(malformed);
		const closed = malformed.waitForClose();
		malformed.sendRaw(Buffer.alloc(16 * 1024, 97));
		await closed;
		expect(await healthy.client.request<{ alive: boolean }>("test/echo", { alive: true })).toEqual({
			alive: true,
		});
	});

	it("terminates a language server that declares an oversized response", async () => {
		connectParams.args = ["run", path.join(import.meta.dir, "fixtures", "malformed-jsonrpc-peer.ts")];
		const { client } = await link();
		await expect(withTimeout(initialize(client), "invalid server frame")).rejects.toThrow("Mux connection closed");
		await pollUntil(() => Promise.resolve(server.serverKeys.length === 0), "malformed server exit");
		expect(server.sessionCount).toBe(0);
	});

	it("spawns one server per concurrent link", async () => {
		const first = await link();
		const second = await link();
		expect(first.connected.spawned).toBe(true);
		expect(second.connected.spawned).toBe(true);
		expect(second.connected.pid).not.toBe(first.connected.pid);

		const [firstInitialize, secondInitialize] = await Promise.all([
			initialize(first.client),
			initialize(second.client),
		]);
		const firstInfo = firstInitialize.serverInfo as { version: string };
		const secondInfo = secondInitialize.serverInfo as { version: string };
		expect(firstInfo.version).toBe(String(first.connected.pid));
		expect(secondInfo.version).toBe(String(second.connected.pid));
		expect((await state(first.client)).initializeCount).toBe(1);
		expect((await state(second.client)).initializeCount).toBe(1);
	}, 10_000);

	it("rewrites initialize processId to the mux process", async () => {
		const { client } = await link();
		await initialize(client, 424242);
		expect((await state(client)).processId).toBe(process.pid);
	}, 10_000);

	it("isolates equal request ids between sessions", async () => {
		const first = await link();
		const second = await link();
		await Promise.all([initialize(first.client), initialize(second.client)]);
		const [one, two] = await Promise.all([
			first.client.request<{ owner: string }>("test/echo", { owner: "first" }, 7),
			second.client.request<{ owner: string }>("test/echo", { owner: "second" }, 7),
		]);
		expect(one).toEqual({ owner: "first" });
		expect(two).toEqual({ owner: "second" });
	}, 10_000);

	it("isolates open-document overlays between concurrent sessions", async () => {
		const first = await link();
		const second = await link();
		expect(second.connected.pid).not.toBe(first.connected.pid);
		await Promise.all([initialize(first.client), initialize(second.client)]);
		const uri = "file:///shared.ts";
		first.client.notify("textDocument/didOpen", {
			textDocument: { uri, languageId: "typescript", version: 1, text: "first" },
		});
		second.client.notify("textDocument/didOpen", {
			textDocument: { uri, languageId: "typescript", version: 1, text: "second" },
		});

		await pollUntil(async () => {
			const [seenByFirst, seenBySecond] = await Promise.all([
				first.client.request<string | null>("test/documentText", { uri }),
				second.client.request<string | null>("test/documentText", { uri }),
			]);
			return seenByFirst === "first" && seenBySecond === "second";
		}, "session-specific document contents");
	}, 10_000);

	it("replays cached diagnostics when an idle server is reused", async () => {
		const first = await link();
		await initialize(first.client);
		const uri = "file:///diagnostics.ts";
		first.client.notify("textDocument/didOpen", {
			textDocument: { uri, languageId: "typescript", version: 1, text: "x" },
		});
		const publication = await first.client.nextNotification<PublishDiagnosticsParams>(
			"textDocument/publishDiagnostics",
		);
		expect(publication).toMatchObject({
			uri,
			version: 1,
			diagnostics: [{ message: "fake", severity: 2, range: expect.any(Object) }],
		});
		await first.client.request("test/serverStatus", { health: "ok", quiescent: false });
		await first.client.nextNotification("experimental/serverStatus");

		first.client.destroy();
		await pollUntil(() => Promise.resolve(server.sessionCount === 0), "first session close");
		const second = await link();
		expect(second.connected.spawned).toBe(false);
		expect(second.connected.pid).toBe(first.connected.pid);
		await initialize(second.client);
		const replay = await second.client.nextNotification<PublishDiagnosticsParams>("textDocument/publishDiagnostics");
		expect(replay).toMatchObject({
			uri,
			diagnostics: [{ message: "fake", severity: 2, range: expect.any(Object) }],
		});
		expect(
			await second.client.nextNotification<{ health: string; quiescent: boolean }>("experimental/serverStatus"),
		).toEqual({
			health: "ok",
			quiescent: false,
		});
	}, 10_000);

	it("does not hand an idle server to a link with other initialization options", async () => {
		const first = await link({ ...connectParams, initializationOptions: { probe: "A" } });
		await initialize(first.client, 424242, { probe: "A" });
		first.client.destroy();
		await pollUntil(() => Promise.resolve(server.sessionCount === 0), "first session close");

		// A reused server answers `initialize` from cache, so B must get its own process.
		const second = await link({ ...connectParams, initializationOptions: { probe: "B" } });
		expect(second.connected.spawned).toBe(true);
		expect(second.connected.pid).not.toBe(first.connected.pid);
		await initialize(second.client, 424242, { probe: "B" });
		expect((await state(second.client)).initializationOptions).toEqual({ probe: "B" });

		const third = await link({ ...connectParams, initializationOptions: { probe: "A" } });
		expect(third.connected.spawned).toBe(false);
		expect(third.connected.pid).toBe(first.connected.pid);
		await initialize(third.client, 424242, { probe: "A" });
		expect((await state(third.client)).initializationOptions).toEqual({ probe: "A" });
	}, 10_000);

	it("does not reuse an idle server from another file-selected worktree root", async () => {
		const roots = [path.join(tmpDir, "first"), path.join(tmpDir, "second")];
		for (const root of roots) {
			await fs.mkdir(path.join(root, "DAL"), { recursive: true });
			await fs.writeFile(path.join(root, "App.sln"), "");
			await fs.writeFile(path.join(root, "DAL", "DAL.csproj"), "<Project />");
		}
		await fs.writeFile(path.join(roots[0]!, ".git"), "gitdir: ../main/.git/worktrees/first\n");
		await fs.mkdir(path.join(roots[1]!, ".git"));
		const selected = roots.map(root =>
			findLspProjectRoot(path.join(root, "DAL", "Dispatch.cs"), ["services/App.sln", "*.csproj", ".git"]),
		);
		expect(selected).toEqual(roots);
		const first = await link({ ...connectParams, cwd: selected[0]! });
		await first.client.request("initialize", {
			...initializeParams(),
			rootUri: fileToUri(roots[0]!),
			workspaceFolders: [{ uri: fileToUri(roots[0]!), name: "first" }],
		});
		first.client.notify("initialized", {});
		first.client.destroy();
		await pollUntil(() => Promise.resolve(server.sessionCount === 0), "first worktree release");
		const second = await link({ ...connectParams, cwd: selected[1]! });
		expect(second.connected.spawned).toBe(true);
		expect(second.connected.pid).not.toBe(first.connected.pid);
		await initialize(second.client);
		const sameRoot = await link({ ...connectParams, cwd: selected[0]! });
		expect(sameRoot.connected.spawned).toBe(false);
		expect(sameRoot.connected.pid).toBe(first.connected.pid);
	}, 10_000);

	it("intercepts shutdown and exit for only the calling session", async () => {
		const first = await link();
		const second = await link();
		await Promise.all([initialize(first.client), initialize(second.client)]);
		expect(await first.client.request<null>("shutdown")).toBeNull();
		const closed = first.client.waitForClose();
		first.client.notify("exit");
		await closed;
		expect(await second.client.request<{ alive: boolean }>("test/echo", { alive: true })).toEqual({ alive: true });
	}, 10_000);

	it("answers muxPing before a link is bound", async () => {
		const client = await MuxTestClient.connect(endpoint);
		clients.push(client);
		expect(await client.request<string>(MUX_PING_METHOD)).toBe("pong");
	}, 10_000);

	it("restarts only the calling session's server", async () => {
		const first = await link();
		const second = await link();
		await Promise.all([initialize(first.client), initialize(second.client)]);
		const firstClosed = first.client.waitForClose();
		first.client.notify(MUX_RESTART_METHOD);
		await firstClosed;
		expect(await second.client.request<{ alive: boolean }>("test/echo", { alive: true })).toEqual({ alive: true });

		const replacement = await link();
		expect(replacement.connected.spawned).toBe(true);
		expect(replacement.connected.pid).not.toBe(first.connected.pid);
		expect(replacement.connected.pid).not.toBe(second.connected.pid);
	}, 10_000);

	it("survives a language server that exits while documents are open", async () => {
		// Regression: session teardown wrote didClose to the exited child's
		// stdin; that rejection escaped #closeSession (invoked via `void`
		// from the connection close handler) and killed the whole daemon.
		const { client } = await link();
		await initialize(client);
		const uri = "file:///crash.ts";
		client.notify("textDocument/didOpen", {
			textDocument: { uri, languageId: "typescript", version: 1, text: "x" },
		});
		await pollUntil(async () => (await state(client)).didOpen[uri] === 1, "didOpen to reach the server");
		const closed = client.waitForClose();
		client.notify(MUX_RESTART_METHOD);
		await closed;
		await pollUntil(() => Promise.resolve(server.serverKeys.length === 0), "exited server cleanup");
		// The daemon itself must keep serving fresh sessions.
		const fresh = await link();
		await initialize(fresh.client);
		expect(await fresh.client.request<{ alive: boolean }>("test/echo", { alive: true })).toEqual({ alive: true });
	}, 10_000);

	it.skipIf(process.platform === "win32")(
		"contains write failures when a language server stops reading stdin",
		async () => {
			// The server closes stdin, then sends a request (signalling stdin is closed) and stays
			// alive, so tearing down the session's open document fails with EPIPE.
			const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "workspace/applyEdit", params: {} });
			connectParams.command = "sh";
			connectParams.args = [
				"-c",
				'exec 0<&-; printf "%s" "$1"; exec sleep 30',
				"sh",
				`Content-Length: ${Buffer.byteLength(request)}\r\n\r\n${request}`,
			];
			const first = await link();
			first.client.notify("textDocument/didOpen", {
				textDocument: { uri: "file:///epipe.ts", languageId: "typescript", version: 1, text: "x" },
			});
			await first.client.nextNotification("workspace/applyEdit");
			first.client.destroy();
			await pollUntil(() => Promise.resolve(server.sessionCount === 0), "first session close");
			// Teardown must finish and release the server for reuse instead of rejecting mid-cleanup.
			await pollUntil(async () => {
				const next = await link();
				next.client.destroy();
				return next.connected.pid === first.connected.pid;
			}, "idle server reuse");
		},
		10_000,
	);

	it("finishes orphan document closes before reusing a server", async () => {
		const first = await link();
		await initialize(first.client);
		const uris = Array.from({ length: 128 }, (_, index) => `file:///orphan-${index}.ts`);
		for (const uri of uris) {
			first.client.notify("textDocument/didOpen", {
				textDocument: { uri, languageId: "typescript", version: 1, text: "orphan" },
			});
		}
		await first.client.request("test/echo", { barrier: true });
		const firstClosed = first.client.waitForClose();
		first.client.destroy();
		await firstClosed;

		const second = await link();
		expect(second.connected.spawned).toBe(false);
		const uri = uris.at(-1);
		expect(uri).toBeDefined();
		await initialize(second.client);
		second.client.notify("textDocument/didOpen", {
			textDocument: { uri, languageId: "typescript", version: 1, text: "replacement" },
		});
		await second.client.request("test/echo", { barrier: true });
		expect(await second.client.request<string | null>("test/documentText", { uri })).toBe("replacement");
	}, 10_000);
});
