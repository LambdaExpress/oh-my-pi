import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import * as lspClient from "@oh-my-pi/pi-coding-agent/lsp/client";
import * as lspConfig from "@oh-my-pi/pi-coding-agent/lsp/config";
import type { LspClient, LspToolDetails, ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";
import { fileToUri } from "@oh-my-pi/pi-coding-agent/lsp/utils";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as piUtils from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils";

// These are integration tests of the tool's real retry timing: the
// REFERENCES_RETRY_DELAY_MS / DEFINITION_COLD_START_RETRY_DELAY_MS sleeps live
// inside the module under test and the reader consumes the fake transport's
// stream on real event-loop turns, so deterministic fake-timer control does
// not apply. Delays are short and bounded (~1s across the whole file).

/** Minimal LSP tool session: production always supplies `settings`; these tests only need cwd + a default settings stub. */
function makeLspSession(cwd: string): ToolSession {
	return { cwd, settings: Settings.isolated() } as ToolSession;
}

function textResult(result: AgentToolResult<LspToolDetails>): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

interface RpcMessage {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message?: string };
}

interface FakeLspServer {
	/** Server -> client: frame and enqueue a JSON-RPC message onto stdout. */
	send(message: RpcMessage): void;
	/** Resolve the process `exited` promise and close stdout. */
	exit(code?: number): void;
}

type FakeLspHandler = (message: RpcMessage, server: FakeLspServer) => void | Promise<void>;

// In-memory LSP transport fake, mirroring the pattern in lsp-regressions.test.ts:
// replaces the real subprocess (`ptree.spawn`) with an in-process JSON-RPC peer.
function installFakeLsp(handler: FakeLspHandler): FakeLspServer {
	const encoder = new TextEncoder();
	let exitCode: number | null = null;
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	const { promise: exited, resolve: resolveExited } = Promise.withResolvers<number>();

	const frame = (message: RpcMessage): Uint8Array => {
		const content = JSON.stringify(message);
		return encoder.encode(`Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n${content}`);
	};

	const stdout = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});

	const server: FakeLspServer = {
		send(message) {
			if (controller && exitCode === null) controller.enqueue(frame(message));
		},
		exit(code = 0) {
			if (exitCode !== null) return;
			exitCode = code;
			controller?.close();
			resolveExited(code);
		},
	};

	// Frame + dispatch the client -> server byte stream. The chain serialises
	// handler runs so message ordering mirrors the wire.
	let pendingBytes = Buffer.alloc(0);
	let chain: Promise<void> = Promise.resolve();
	const feed = (raw: string | Uint8Array): void => {
		const chunk = typeof raw === "string" ? Buffer.from(raw, "utf-8") : Buffer.from(raw);
		pendingBytes = pendingBytes.length === 0 ? chunk : Buffer.concat([pendingBytes, chunk]);
		chain = chain.then(async () => {
			while (true) {
				const headerEnd = pendingBytes.indexOf("\r\n\r\n");
				if (headerEnd === -1) break;
				const match = /Content-Length: (\d+)/i.exec(pendingBytes.toString("utf-8", 0, headerEnd));
				if (!match) {
					pendingBytes = pendingBytes.subarray(headerEnd + 4);
					continue;
				}
				const start = headerEnd + 4;
				const end = start + Number(match[1]);
				if (pendingBytes.length < end) break;
				const message = JSON.parse(pendingBytes.toString("utf-8", start, end)) as RpcMessage;
				pendingBytes = pendingBytes.subarray(end);
				await handler(message, server);
			}
		});
	};

	const proc = {
		get exited() {
			return exited;
		},
		get exitCode() {
			return exitCode;
		},
		stdin: {
			write(chunk: string | Uint8Array) {
				feed(chunk);
				return typeof chunk === "string" ? Buffer.byteLength(chunk, "utf-8") : chunk.byteLength;
			},
			flush: async () => 0,
			end: async () => 0,
		},
		stdout,
		peekStderr: () => "",
		kill() {
			server.exit(0);
		},
	} as unknown as LspClient["proc"];

	vi.spyOn(piUtils.ptree, "spawn").mockReturnValue(proc as unknown as piUtils.ptree.ChildProcess<"pipe">);
	return server;
}

/** Project-aware fake server config: answered over the fake transport, never spawned for real. */
function tsServerConfig(): ServerConfig {
	return {
		command: "typescript-language-server",
		resolvedCommand: process.execPath,
		fileTypes: ["ts"],
		rootMarkers: [],
	};
}

function mockTsConfig(server: ServerConfig): void {
	vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
		servers: { "typescript-language-server": server },
		idleTimeoutMs: undefined,
	});
	vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["typescript-language-server", server]]);
}

/** Complete the initialize handshake and finish the first loading cycle so projectLoaded resolves fast. */
function answerInitialize(message: RpcMessage, srv: FakeLspServer): void {
	srv.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
	srv.send({
		jsonrpc: "2.0",
		method: "$/progress",
		params: { token: "workspace", value: { kind: "begin" } },
	});
	srv.send({
		jsonrpc: "2.0",
		method: "$/progress",
		params: { token: "workspace", value: { kind: "end" } },
	});
}

describe("lsp cold-start retries", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("references converges on the complete result set after a partial cold-start answer", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-cold-refs-");
		try {
			const sourcePath = path.join(tempDir.path(), "src", "main.ts");
			const callerPath = path.join(tempDir.path(), "src", "caller.ts");
			await Bun.write(sourcePath, "export function greet() {}\n");
			await Bun.write(callerPath, 'import { greet } from "./main";\ngreet();\n');

			const selfUri = fileToUri(sourcePath);
			const callerUri = fileToUri(callerPath);
			const decl = { uri: selfUri, range: { start: { line: 0, character: 15 }, end: { line: 0, character: 20 } } };
			const selfCall = { uri: selfUri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } };
			const crossCall = {
				uri: callerUri,
				range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
			};

			let referenceRequests = 0;
			installFakeLsp((message, srv) => {
				if (message.method === "initialize") {
					answerInitialize(message, srv);
				} else if (message.method === "textDocument/references") {
					referenceRequests++;
					// Cold start: the first answer is partial (self-file only); the
					// cross-file caller appears once the project finished indexing.
					srv.send({
						jsonrpc: "2.0",
						id: message.id,
						result: referenceRequests === 1 ? [decl, selfCall] : [decl, selfCall, crossCall],
					});
				} else if (message.method === "shutdown") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: null });
				} else if (message.method === "exit") {
					srv.exit(0);
				}
			});

			mockTsConfig(tsServerConfig());

			const tool = new LspTool(makeLspSession(tempDir.path()));
			const result = await tool.execute("cold-refs-test", {
				action: "references",
				file: sourcePath,
				line: 1,
				symbol: "greet",
				timeout: 10,
			});
			const output = textResult(result);

			expect(referenceRequests).toBe(3);
			expect(output).toContain("Found 3 reference(s)");
			expect(output).toContain("caller.ts");
		} finally {
			vi.restoreAllMocks();
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("references accepts two identical consecutive result sets as stable", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-cold-refs-stable-");
		try {
			const sourcePath = path.join(tempDir.path(), "src", "main.ts");
			await Bun.write(sourcePath, "export function greet() {}\n");

			const selfUri = fileToUri(sourcePath);
			const decl = { uri: selfUri, range: { start: { line: 0, character: 15 }, end: { line: 0, character: 20 } } };
			const selfCall = { uri: selfUri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } };

			let referenceRequests = 0;
			installFakeLsp((message, srv) => {
				if (message.method === "initialize") {
					answerInitialize(message, srv);
				} else if (message.method === "textDocument/references") {
					referenceRequests++;
					srv.send({ jsonrpc: "2.0", id: message.id, result: [decl, selfCall] });
				} else if (message.method === "shutdown") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: null });
				} else if (message.method === "exit") {
					srv.exit(0);
				}
			});

			mockTsConfig(tsServerConfig());

			const tool = new LspTool(makeLspSession(tempDir.path()));
			const result = await tool.execute("stable-refs-test", {
				action: "references",
				file: sourcePath,
				line: 1,
				symbol: "greet",
				timeout: 10,
			});
			const output = textResult(result);

			// Two consecutive identical sets settle the retry loop.
			expect(referenceRequests).toBe(2);
			expect(output).toContain("Found 2 reference(s)");
		} finally {
			vi.restoreAllMocks();
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("definition retries once after an empty cold-start answer", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-cold-def-");
		try {
			const sourcePath = path.join(tempDir.path(), "src", "main.ts");
			await Bun.write(sourcePath, "export function greet() {}\n");

			const selfUri = fileToUri(sourcePath);
			const decl = { uri: selfUri, range: { start: { line: 0, character: 15 }, end: { line: 0, character: 20 } } };

			let definitionRequests = 0;
			installFakeLsp((message, srv) => {
				if (message.method === "initialize") {
					answerInitialize(message, srv);
				} else if (message.method === "textDocument/definition") {
					definitionRequests++;
					// First answer arrives before the project finished loading.
					srv.send({
						jsonrpc: "2.0",
						id: message.id,
						result: definitionRequests === 1 ? null : [decl],
					});
				} else if (message.method === "shutdown") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: null });
				} else if (message.method === "exit") {
					srv.exit(0);
				}
			});

			mockTsConfig(tsServerConfig());

			const tool = new LspTool(makeLspSession(tempDir.path()));
			const result = await tool.execute("cold-def-test", {
				action: "definition",
				file: sourcePath,
				line: 1,
				symbol: "greet",
				timeout: 10,
			});
			const output = textResult(result);

			expect(definitionRequests).toBe(2);
			expect(output).toContain("Found 1 definition(s)");
		} finally {
			vi.restoreAllMocks();
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("definition answers immediately when the server is already warm", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-warm-def-");
		try {
			const sourcePath = path.join(tempDir.path(), "src", "main.ts");
			await Bun.write(sourcePath, "export function greet() {}\n");

			const selfUri = fileToUri(sourcePath);
			const decl = { uri: selfUri, range: { start: { line: 0, character: 15 }, end: { line: 0, character: 20 } } };

			let definitionRequests = 0;
			installFakeLsp((message, srv) => {
				if (message.method === "initialize") {
					answerInitialize(message, srv);
				} else if (message.method === "textDocument/definition") {
					definitionRequests++;
					srv.send({ jsonrpc: "2.0", id: message.id, result: [decl] });
				} else if (message.method === "shutdown") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: null });
				} else if (message.method === "exit") {
					srv.exit(0);
				}
			});

			mockTsConfig(tsServerConfig());

			const tool = new LspTool(makeLspSession(tempDir.path()));
			const result = await tool.execute("warm-def-test", {
				action: "definition",
				file: sourcePath,
				line: 1,
				symbol: "greet",
				timeout: 10,
			});
			const output = textResult(result);

			// Non-empty first answer: no retry, no settle delay, one request.
			expect(definitionRequests).toBe(1);
			expect(output).toContain("Found 1 definition(s)");
		} finally {
			vi.restoreAllMocks();
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	// Integration test for the reader's $/progress handling: the begin frame is
	// enqueued on a fake transport stream and consumed by the client's message
	// reader on a later event-loop turn, so the wait below uses short real-clock
	// polls — the reader exposes no event to await, and fake timers cannot drive
	// the stream machinery. The production retry delays under test are also real
	// (REFERENCES_RETRY_DELAY_MS / DEFINITION_COLD_START_RETRY_DELAY_MS).
	it("re-arms projectLoaded when a new loading cycle begins after the first settled", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-rearm-");
		try {
			const server = installFakeLsp((message, srv) => {
				if (message.method === "initialize") {
					answerInitialize(message, srv);
				} else if (message.method === "shutdown") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: null });
				} else if (message.method === "exit") {
					srv.exit(0);
				}
			});

			const client = await lspClient.getOrCreateClient(tsServerConfig(), tempDir.path(), 1_000);
			// First loading cycle completes; waitForProjectLoaded returns promptly.
			await lspClient.waitForProjectLoaded(client);

			// A second cycle starts (on-demand project load / post-reload reload).
			server.send({
				jsonrpc: "2.0",
				method: "$/progress",
				params: { token: "load-2", value: { kind: "begin" } },
			});
			// Wait until the reader processed the begin (token registered and the
			// projectLoaded promise re-armed).
			for (let i = 0; i < 200; i++) {
				if (client.activeProgressTokens.has("load-2")) break;
				await Bun.sleep(5);
			}
			expect(client.activeProgressTokens.has("load-2")).toBe(true);

			let settled = false;
			const waiting = lspClient.waitForProjectLoaded(client).then(() => {
				settled = true;
			});
			await Bun.sleep(30);
			// Still pending: the wait must cover the new cycle, not the stale
			// first-cycle promise.
			expect(settled).toBe(false);

			server.send({
				jsonrpc: "2.0",
				method: "$/progress",
				params: { token: "load-2", value: { kind: "end" } },
			});
			await waiting;
			expect(settled).toBe(true);
		} finally {
			vi.restoreAllMocks();
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});
});
