import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import * as lspClient from "@oh-my-pi/pi-coding-agent/lsp/client";
import type { LspClient, LspToolDetails } from "@oh-my-pi/pi-coding-agent/lsp/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as piUtils from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression for the 2026-08-06 lsp issue report: after csharp-ls reports
 * ready, `references` on a symbol with known cross-file callers returned the
 * bare "No references found" twice.
 *
 * Root cause (server side): csharp-ls is the legacy OmniSharp-based C# server.
 * It loads MSBuild projects asynchronously after startup and its didOpen
 * handler only opens documents that are ALREADY in the workspace (the misc
 * document fallback is reachable only through buffer updates, not didOpen).
 * Its references handler (`FindUsagesService`) returns an empty, non-error
 * result for any file whose project is still loading or failed to load — an
 * empty result therefore cannot be distinguished from a genuine absence
 * without server logs, and no $/progress/readiness signal exists to wait on.
 *
 * Client fix: when an empty references result comes back from a csharp-ls
 * server, replace the bare message with an actionable hint instead of making
 * an indexing problem look like a real "no references" answer.
 */

interface RpcMessage {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
}

interface FakeCsharpLs {
	readonly received: RpcMessage[];
	/** textDocument/references requests in arrival order. */
	readonly referencesRequests: RpcMessage[];
}

/**
 * In-process fake LSP server wired through `piUtils.ptree.spawn` (never
 * `mock.module`). Responds to initialize/shutdown/exit and answers every
 * `textDocument/references` request with the configured result, plus an
 * immediate `$/progress` begin/end pair so the client's projectLoaded
 * promise settles without waiting out the 15s auto-resolve timeout.
 */
function installFakeLsp(options: { referencesResult: unknown }): FakeCsharpLs {
	const encoder = new TextEncoder();
	const received: RpcMessage[] = [];
	const referencesRequests: RpcMessage[] = [];
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

	const exit = (code: number): void => {
		if (exitCode !== null) return;
		exitCode = code;
		controller?.close();
		resolveExited(code);
	};

	const send = (message: RpcMessage): void => {
		if (controller && exitCode === null) controller.enqueue(frame(message));
	};

	const handle = (message: RpcMessage): void => {
		if (message.method === "initialize" && message.id !== undefined) {
			send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
			// Settle projectLoaded immediately (csharp-ls emits no $/progress in
			// production; the tests just must not wait the auto-resolve timeout).
			send({ jsonrpc: "2.0", method: "$/progress", params: { token: 1, value: { kind: "begin", title: "load" } } });
			send({ jsonrpc: "2.0", method: "$/progress", params: { token: 1, value: { kind: "end" } } });
		} else if (message.method === "textDocument/references" && message.id !== undefined) {
			referencesRequests.push(message);
			send({ jsonrpc: "2.0", id: message.id, result: options.referencesResult });
		} else if (message.method === "shutdown" && message.id !== undefined) {
			send({ jsonrpc: "2.0", id: message.id, result: null });
		} else if (message.method === "exit") {
			exit(0);
		}
	};

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
				if (!match) break;
				const start = headerEnd + 4;
				const end = start + Number(match[1]);
				if (pendingBytes.length < end) break;
				const message = JSON.parse(pendingBytes.toString("utf-8", start, end)) as RpcMessage;
				pendingBytes = pendingBytes.subarray(end);
				received.push(message);
				handle(message);
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
			exit(0);
		},
	} as unknown as LspClient["proc"];

	vi.spyOn(piUtils.ptree, "spawn").mockReturnValue(proc as unknown as piUtils.ptree.ChildProcess<"pipe">);
	return { received, referencesRequests };
}

function makeSession(cwd: string): ToolSession {
	return { cwd, settings: Settings.isolated() } as ToolSession;
}

function textResult(result: AgentToolResult<LspToolDetails>): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

/** Write a .cs fixture with `UploadInventoryData` on line 45 and the LSP config. */
async function writeCsFixture(tempDir: string, serverName: string, command: string): Promise<void> {
	const lines: string[] = [];
	for (let i = 0; i < 44; i++) lines.push(`// padding ${i + 1}`);
	lines.push("        public void UploadInventoryData() { }");
	await Bun.write(path.join(tempDir, "Inventory.cs"), `${lines.join("\n")}\n`);
	await Bun.write(
		path.join(tempDir, ".omp", "lsp.json"),
		JSON.stringify({
			servers: {
				[serverName]: {
					command,
					fileTypes: [".cs"],
					rootMarkers: ["."],
					languageId: "csharp",
				},
			},
		}),
	);
}

function mockWhich(commands: Record<string, string>): void {
	vi.spyOn(piUtils, "$which").mockImplementation(command => commands[command] ?? null);
}

describe("lsp csharp-ls references", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("replaces the bare empty-references message with an actionable hint for csharp-ls", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-csharp-ls-");
		try {
			await writeCsFixture(tempDir.path(), "csharp-ls", "csharp-ls");
			mockWhich({ "csharp-ls": path.join(tempDir.path(), "bin", "csharp-ls") });
			const server = installFakeLsp({ referencesResult: [] });

			const tool = new LspTool(makeSession(tempDir.path()));
			const result = await tool.execute("call-1", {
				action: "references",
				file: "Inventory.cs",
				line: 45,
				symbol: "UploadInventoryData",
				timeout: 60,
			});

			const text = textResult(result);
			expect(text).toContain("No references found");
			// The hint must say the project may simply not be indexed yet, with
			// something actionable — not the bare message that hid the condition.
			expect(text).toContain("may not have indexed this project");
			expect(text).toContain("Retry after project load completes");
			// The request really went out (and returned empty) — this is not a
			// routing failure masquerading as "no references".
			expect(server.referencesRequests.length).toBeGreaterThan(0);
			// The hint is actionable, so compaction must not elide the result.
			expect(result.useless).toBeUndefined();
		} finally {
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("keeps the bare empty message (and useless marker) for non-csharp-ls servers", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-fake-ts-");
		try {
			await writeCsFixture(tempDir.path(), "fake-ts", "fake-ts");
			mockWhich({ "fake-ts": path.join(tempDir.path(), "bin", "fake-ts") });
			installFakeLsp({ referencesResult: [] });

			const tool = new LspTool(makeSession(tempDir.path()));
			const result = await tool.execute("call-2", {
				action: "references",
				file: "Inventory.cs",
				line: 45,
				symbol: "UploadInventoryData",
				timeout: 60,
			});

			expect(textResult(result)).toBe("No references found");
			expect(result.useless).toBe(true);
		} finally {
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("still returns found references verbatim when csharp-ls answers with locations", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-csharp-ls-found-");
		try {
			await writeCsFixture(tempDir.path(), "csharp-ls", "csharp-ls");
			mockWhich({ "csharp-ls": path.join(tempDir.path(), "bin", "csharp-ls") });
			const uri = `file:///${tempDir.path().replace(/\\/g, "/")}/Inventory.cs`;
			installFakeLsp({
				referencesResult: [
					// A real cross-file call site, not the queried declaration
					// (line 44 is the fixture's line 45).
					{ uri, range: { start: { line: 44, character: 40 }, end: { line: 44, character: 45 } } },
				],
			});

			const tool = new LspTool(makeSession(tempDir.path()));
			const result = await tool.execute("call-3", {
				action: "references",
				file: "Inventory.cs",
				line: 45,
				symbol: "UploadInventoryData",
				timeout: 60,
			});

			expect(textResult(result)).toContain("Found 1 reference(s)");
		} finally {
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});
});
