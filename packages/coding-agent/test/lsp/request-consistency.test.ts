import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	beginPendingDiskWrite,
	endPendingDiskWrite,
	ensureFileOpen,
	FileChangeType,
	getOrCreateClient,
	notifyWorkspaceWatchedFiles,
	reconcileFileFromDisk,
	refreshFile,
	sendRequest,
	shutdownClientInstance,
	syncContent,
} from "@oh-my-pi/pi-coding-agent/lsp/client";
import { configCache } from "@oh-my-pi/pi-coding-agent/lsp/config";
import { getDiagnosticsForFile } from "@oh-my-pi/pi-coding-agent/lsp/diagnostics";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp/tool";
import type { Diagnostic, LspClient, ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";
import { fileToUri, uriToFile } from "@oh-my-pi/pi-coding-agent/lsp/utils";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { LspToolDetails } from "@oh-my-pi/pi-tui/tools/lsp";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";
import { Project, ts } from "ts-morph";
import { MessageFramer } from "../../src/jsonrpc/message-framing";

interface RpcMessage {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
}

class ProtocolClock {
	now = Date.now();
	readonly scheduled: Array<{ at: number; run: () => void }> = [];

	install(): void {
		vi.spyOn(Date, "now").mockImplementation(() => this.now);
		vi.spyOn(Bun, "sleep").mockImplementation(((ms: number) => {
			this.now += ms;
			for (let i = this.scheduled.length - 1; i >= 0; i--) {
				const event = this.scheduled[i]!;
				if (event.at > this.now) continue;
				this.scheduled.splice(i, 1);
				event.run();
			}
			return Promise.resolve();
		}) as typeof Bun.sleep);
	}

	after(ms: number, run: () => void): void {
		this.scheduled.push({ at: this.now + ms, run });
	}
}

interface PeerOptions {
	rootMarker?: string;
	diagnosticError?: string;
	clock?: ProtocolClock;
	diagnosticDelayMs?: number;
}

/** A real framed JSON-RPC peer backed by TypeScript's semantic checker, not canned diagnostics. */
function installProtocolPeer(options: PeerOptions = {}): void {
	vi.spyOn(ptree, "spawn").mockImplementation(((_command, spawnOptions) => {
		const cwd = String(spawnOptions?.cwd);
		const project = new Project({
			useInMemoryFileSystem: true,
			compilerOptions: {
				noLib: true,
				strict: true,
				module: ts.ModuleKind.ESNext,
				moduleResolution: ts.ModuleResolutionKind.Bundler,
			},
		});
		const sourcePath = (uri: string): string => `/${path.relative(cwd, uriToFile(uri)).replaceAll("\\", "/")}`;
		// Like a project-aware server, load unopened callers into the initial program.
		for (const filePath of new Bun.Glob("**/*.ts").scanSync({ cwd, absolute: true, onlyFiles: true })) {
			project.createSourceFile(sourcePath(fileToUri(filePath)), fs.readFileSync(filePath, "utf-8"));
		}
		const encoder = new TextEncoder();
		let controller: ReadableStreamDefaultController<Uint8Array>;
		let exitCode: number | null = null;
		const exited = Promise.withResolvers<number>();
		const stdout = new ReadableStream<Uint8Array>({
			start: value => {
				controller = value;
			},
		});
		const send = (message: RpcMessage): void => {
			if (exitCode !== null) return;
			const json = JSON.stringify({ jsonrpc: "2.0", ...message });
			controller.enqueue(encoder.encode(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`));
		};
		const exit = (): void => {
			if (exitCode !== null) return;
			exitCode = 0;
			controller.close();
			exited.resolve(0);
		};
		const diagnostics = (uri: string): Diagnostic[] => {
			// Rust root-routing cases use an actual workspace marker rather than TS syntax.
			if (uri.endsWith(".rs")) return [];
			const source = project.getSourceFileOrThrow(sourcePath(uri));
			return source.getPreEmitDiagnostics().flatMap(diagnostic => {
				if (diagnostic.getSourceFile()?.getFilePath() !== source.getFilePath()) return [];
				const start = diagnostic.getStart() ?? 0;
				return [
					{
						range: {
							start: source.compilerNode.getLineAndCharacterOfPosition(start),
							end: source.compilerNode.getLineAndCharacterOfPosition(start + (diagnostic.getLength() ?? 0)),
						},
						message: ts.flattenDiagnosticMessageText(diagnostic.compilerObject.messageText, "\n"),
						code: diagnostic.getCode(),
						severity: 1,
						source: "ts",
					},
				];
			});
		};
		const handle = (message: RpcMessage): void => {
			const respond = (result: unknown): void => send({ id: message.id, result });
			switch (message.method) {
				case "initialize":
					respond({ capabilities: { diagnosticProvider: {}, definitionProvider: true } });
					break;
				case "initialized":
					send({ method: "$/progress", params: { token: "load", value: { kind: "end" } } });
					break;
				case "textDocument/didOpen": {
					const { textDocument } = message.params as {
						textDocument: { uri: string; text: string; version: number };
					};
					if (!textDocument.uri.endsWith(".rs")) {
						project.createSourceFile(sourcePath(textDocument.uri), textDocument.text, { overwrite: true });
					}
					break;
				}
				case "textDocument/didChange": {
					const { textDocument, contentChanges } = message.params as {
						textDocument: { uri: string; version: number };
						contentChanges: Array<{ text: string }>;
					};
					if (!textDocument.uri.endsWith(".rs")) {
						project.createSourceFile(sourcePath(textDocument.uri), contentChanges[0]!.text, { overwrite: true });
					}
					break;
				}
				case "textDocument/didClose": {
					const { textDocument } = message.params as { textDocument: { uri: string } };
					const source = project.getSourceFile(sourcePath(textDocument.uri));
					if (source) project.removeSourceFile(source);
					break;
				}
				case "textDocument/diagnostic": {
					const { textDocument } = message.params as { textDocument: { uri: string } };
					const error =
						options.diagnosticError ??
						(options.rootMarker && !fs.existsSync(path.join(cwd, options.rootMarker))
							? `Cargo workspace is unavailable at ${cwd}`
							: undefined);
					if (error) {
						send({ id: message.id, error: { code: -32_001, message: error } });
						break;
					}
					const report = (): void => respond({ kind: "full", items: diagnostics(textDocument.uri) });
					if (options.clock && options.diagnosticDelayMs) options.clock.after(options.diagnosticDelayMs, report);
					else report();
					break;
				}
				case "textDocument/definition": {
					const { textDocument, position } = message.params as {
						textDocument: { uri: string };
						position: { line: number; character: number };
					};
					const source = project.getSourceFileOrThrow(sourcePath(textDocument.uri));
					const offset = source.compilerNode.getPositionOfLineAndCharacter(position.line, position.character);
					const definitions =
						project.getLanguageService().compilerObject.getDefinitionAtPosition(source.getFilePath(), offset) ??
						[];
					respond(
						definitions.map(definition => {
							const target = project.getSourceFileOrThrow(definition.fileName);
							return {
								uri: fileToUri(path.join(cwd, definition.fileName.slice(1))),
								range: {
									start: target.compilerNode.getLineAndCharacterOfPosition(definition.textSpan.start),
									end: target.compilerNode.getLineAndCharacterOfPosition(
										definition.textSpan.start + definition.textSpan.length,
									),
								},
							};
						}),
					);
					break;
				}
				case "textDocument/references": {
					const { textDocument, position } = message.params as {
						textDocument: { uri: string };
						position: { line: number; character: number };
					};
					const source = project.getSourceFileOrThrow(sourcePath(textDocument.uri));
					const offset = source.compilerNode.getPositionOfLineAndCharacter(position.line, position.character);
					const groups =
						project.getLanguageService().compilerObject.findReferences(source.getFilePath(), offset) ?? [];
					respond(
						groups.flatMap(group =>
							group.references.map(reference => {
								const target = project.getSourceFileOrThrow(reference.fileName);
								return {
									uri: fileToUri(path.join(cwd, reference.fileName.slice(1))),
									range: {
										start: target.compilerNode.getLineAndCharacterOfPosition(reference.textSpan.start),
										end: target.compilerNode.getLineAndCharacterOfPosition(
											reference.textSpan.start + reference.textSpan.length,
										),
									},
								};
							}),
						),
					);
					break;
				}
				case "shutdown":
					respond(null);
					break;
				case "exit":
					exit();
					break;
			}
		};
		const framer = new MessageFramer(Buffer.alloc(0));
		return {
			get exited() {
				return exited.promise;
			},
			get exitCode() {
				return exitCode;
			},
			stdin: {
				write(chunk: string | Uint8Array) {
					const bytes = Buffer.from(chunk);
					framer.push(bytes);
					for (const text of framer.drain(() => {})) handle(JSON.parse(text) as RpcMessage);
					return bytes.length;
				},
				flush: () => 0,
				end: () => 0,
			},
			stdout,
			peekStderr: () => "",
			kill: exit,
		} as unknown as ptree.ChildProcess<"pipe">;
	}) as typeof ptree.spawn);
}

const previousDeclarations = [
	'export interface WorkerInitPayload { kind: "attach"; }',
	"export function analyzeModuleSource() { return { bindings: 0 }; }",
].join("\n");
const currentDeclarations = [
	'export interface WorkerInitPayload { kind: "attach"; viewport?: { width: number }; }',
	"export function analyzeModuleSource() { return { bindings: 0, firstStatementOffset: 0 }; }",
	"export function added() {}",
].join("\n");
const consumer = [
	'import { added, analyzeModuleSource, type WorkerInitPayload } from "./source";',
	"added();",
	"declare const payload: WorkerInitPayload;",
	"payload.viewport;",
	"analyzeModuleSource().firstStatementOffset;",
].join("\n");

function textOf(result: AgentToolResult<LspToolDetails>): string {
	return result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
}

describe("LSP 请求的一致工作区与依赖快照", () => {
	let directory: TempDir;
	let clients: LspClient[];
	let server: ServerConfig;
	let tool: LspTool;

	beforeAll(() => initTheme());
	beforeEach(() => {
		directory = TempDir.createSync("@omp-lsp-request-consistency-");
		clients = [];
		server = { command: "fake-semantic-lsp", fileTypes: [".ts", ".rs"], rootMarkers: ["Cargo.toml"] };
		configCache.set(directory.path(), { servers: { semantic: server } });
		tool = new LspTool({ cwd: directory.path(), settings: Settings.isolated() } as ToolSession);
	});
	afterEach(async () => {
		for (const client of clients) await shutdownClientInstance(client);
		configCache.delete(directory.path());
		vi.restoreAllMocks();
		directory.removeSync();
	});

	async function trackSource(
		text = previousDeclarations,
	): Promise<{ client: LspClient; source: string; main: string }> {
		const source = path.join(directory.path(), "source.ts");
		const main = path.join(directory.path(), "main.ts");
		await Bun.write(source, text);
		await Bun.write(main, consumer);
		const client = await getOrCreateClient(server, directory.path());
		clients.push(client);
		await ensureFileOpen(client, source);
		return { client, source, main };
	}

	test("完成外部并行编辑后诊断导入模块的新导出与类型，仍保留真正的缺失导出错误", async () => {
		installProtocolPeer();
		const { source, main } = await trackSource();
		const before = textOf(await tool.execute("before", { action: "diagnostics", file: main }));
		expect(before).toContain("(2305)");
		expect(before).toContain("(2339)");
		await Promise.all([Bun.write(source, currentDeclarations), Bun.write(main, `\n${consumer}`)]);
		const refreshed = await tool.execute("after", { action: "diagnostics", file: main });
		expect(refreshed.details?.success).toBe(true);
		expect(textOf(refreshed)).toBe("OK");

		await Bun.write(source, previousDeclarations);
		const missing = textOf(await tool.execute("missing", { action: "diagnostics", file: main }));
		expect(missing).toContain("(2305)");
		expect(missing).toContain("(2339)");
	});

	test("导航请求直接解析外部编辑后的依赖声明，无需先诊断依赖或重启服务器", async () => {
		installProtocolPeer();
		const { source, main } = await trackSource();
		await ensureFileOpen(clients[0]!, main);
		await Bun.write(source, currentDeclarations);
		const result = await tool.execute("definition", { action: "definition", file: main, line: 1, symbol: "added" });
		expect(textOf(result)).toContain("source.ts:3:17");
	});

	test("从未手动打开的引用调用方被外部编辑后，位置与源码片段都来自当前版本", async () => {
		installProtocolPeer();
		const source = path.join(directory.path(), "source.ts");
		const main = path.join(directory.path(), "main.ts");
		const original = 'import { old } from "./source";\nold();\n';
		await Bun.write(source, "export function old() {}\n");
		await Bun.write(main, original);
		const client = await getOrCreateClient(server, directory.path());
		clients.push(client);
		const before = await tool.execute("references-before", {
			action: "references",
			file: source,
			line: 1,
			symbol: "old",
		});
		expect(textOf(before)).toContain("main.ts:2:1");
		await Bun.write(main, `\n\n${original}`);
		const after = await tool.execute("references-after", {
			action: "references",
			file: source,
			line: 1,
			symbol: "old",
		});
		expect(textOf(after)).toContain("main.ts:4:1");
		expect(textOf(after)).toContain("4: old();");
		expect(textOf(after)).not.toContain("main.ts:2:1");
	});

	test("写入期间保留领先磁盘的依赖与目标覆盖层，提交后才接纳外部磁盘更新", async () => {
		installProtocolPeer();
		const { client, source, main } = await trackSource();
		beginPendingDiskWrite(source);
		beginPendingDiskWrite(main);
		try {
			await syncContent(client, source, currentDeclarations);
			await syncContent(client, main, consumer);
			const pending = await tool.execute("pending", { action: "diagnostics", file: main });
			expect(textOf(pending)).toBe("OK");
			expect(await Bun.file(source).text()).toBe(previousDeclarations);
		} finally {
			endPendingDiskWrite(source);
			endPendingDiskWrite(main);
		}
		const committed = textOf(await tool.execute("committed", { action: "diagnostics", file: main }));
		expect(committed).toContain("(2305)");
	});

	test("导入诊断的共享入口同样刷新写入透传正在使用的依赖快照", async () => {
		installProtocolPeer();
		const { client, source, main } = await trackSource();
		await syncContent(client, main, consumer);
		await Bun.write(source, currentDeclarations);
		const fresh = await getDiagnosticsForFile(main, directory.path(), [["semantic", server]], { timeoutMs: 1_000 });
		expect(fresh?.errored).toBe(false);
		expect(fresh?.messages).toEqual([]);
		await Bun.write(source, previousDeclarations);
		const missing = await getDiagnosticsForFile(main, directory.path(), [["semantic", server]], { timeoutMs: 1_000 });
		expect(missing?.errored).toBe(true);
		expect(missing?.messages.join("\n")).toContain("(2305)");
	});

	test("透传诊断保留已经同步的内存目标，依赖变化也不会把磁盘旧文本覆盖回来", async () => {
		installProtocolPeer();
		const { client, source, main } = await trackSource(currentDeclarations);
		await syncContent(client, main, `${consumer}\nconst wrong: number = "text";\n`);
		const overlay = await getDiagnosticsForFile(main, directory.path(), [["semantic", server]], {
			timeoutMs: 1_000,
		});
		expect(overlay?.errored).toBe(true);
		expect(overlay?.messages.join("\n")).toContain("(2322)");
		expect(await Bun.file(main).text()).toBe(consumer);

		await Bun.write(source, previousDeclarations);
		const changedDependency = await getDiagnosticsForFile(main, directory.path(), [["semantic", server]], {
			timeoutMs: 1_000,
		});
		expect(changedDependency?.messages.join("\n")).toContain("(2305)");
		expect(changedDependency?.messages.join("\n")).toContain("(2322)");
	});

	test("磁盘协调后的显式刷新不产生重复文档版本", async () => {
		installProtocolPeer();
		const { client, source } = await trackSource();
		await Bun.write(source, currentDeclarations);
		await reconcileFileFromDisk(client, source);
		const version = client.openFiles.get(fileToUri(source))!.version;
		await refreshFile(client, source);
		expect(client.openFiles.get(fileToUri(source))!.version).toBe(version);
	});

	test("祖先会话的写入通知也更新嵌套工作区的导入声明覆盖层", async () => {
		installProtocolPeer();
		const root = path.join(directory.path(), "nested");
		const source = path.join(root, "source.ts");
		const main = path.join(root, "main.ts");
		await Bun.write(source, previousDeclarations);
		await Bun.write(main, consumer);
		const client = await getOrCreateClient(server, root);
		clients.push(client);
		await ensureFileOpen(client, source);
		await ensureFileOpen(client, main);
		await Bun.write(source, currentDeclarations);
		await notifyWorkspaceWatchedFiles(directory.path(), [{ filePath: source, type: FileChangeType.Changed }]);
		const report = await sendRequest(client, "textDocument/diagnostic", { textDocument: { uri: fileToUri(main) } });
		expect(report).toEqual({ kind: "full", items: [] });
	});

	test("花括号批量与单文件目标采用各自正确的嵌套 Rust 工作区", async () => {
		installProtocolPeer({ rootMarker: "Cargo.toml" });
		for (const name of ["first", "second"]) {
			const root = path.join(directory.path(), name);
			await Bun.write(path.join(root, "Cargo.toml"), '[package]\nname = "fixture"\nversion = "0.1.0"\n');
			for (const target of ["patch", "apply_patch"]) {
				await Bun.write(path.join(root, "tests", `${target}.rs`), "#[test]\nfn fixture() {}\n");
			}
			const batch = await tool.execute("batch", {
				action: "diagnostics",
				file: `${name}/tests/{patch,apply_patch}.rs`,
			});
			const client = await getOrCreateClient(server, root);
			clients.push(client);
			expect(batch.details?.success).toBe(true);
			for (const target of ["patch", "apply_patch"]) {
				const individual = await tool.execute("individual", {
					action: "diagnostics",
					file: `${name}/tests/${target}.rs`,
				});
				expect(textOf(individual)).toBe("OK");
			}
		}
	});

	test("批量诊断不会将超过旧 400ms 预算的有效服务器报告误判为失败", async () => {
		const clock = new ProtocolClock();
		clock.install();
		installProtocolPeer({ clock, diagnosticDelayMs: 700 });
		await Bun.write(path.join(directory.path(), "first.rs"), "fn first() {}\n");
		await Bun.write(path.join(directory.path(), "second.rs"), "fn second() {}\n");
		clients.push(await getOrCreateClient(server, directory.path()));
		const batch = await tool.execute("delayed-batch", { action: "diagnostics", file: "{first,second}.rs" });
		expect(batch.details?.success).toBe(true);
		const single = await tool.execute("delayed-single", { action: "diagnostics", file: "first.rs" });
		expect(textOf(single)).toBe("OK");
	});

	test("单文件与批量失败都会提供语言服务器返回的具体原因", async () => {
		const clock = new ProtocolClock();
		clock.install();
		installProtocolPeer({ diagnosticError: "Cargo workspace failed to load: fixture dependency is missing" });
		await Bun.write(path.join(directory.path(), "first.rs"), "fn first() {}\n");
		await Bun.write(path.join(directory.path(), "second.rs"), "fn second() {}\n");
		clients.push(await getOrCreateClient(server, directory.path()));
		for (const file of ["first.rs", "{first,second}.rs"]) {
			const result = await tool.execute("failed", { action: "diagnostics", file });
			expect(result.details?.success).toBe(false);
			expect(textOf(result)).toContain("Cargo workspace failed to load: fixture dependency is missing");
		}
	});
});
