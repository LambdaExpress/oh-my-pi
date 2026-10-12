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
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
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
	workspaceSymbols?: (command: string) => boolean | "dynamic";
	workspaceSymbolError?: (command: string) => string | undefined;
	typeScriptProjectRoot?: string;
	languageServiceDisabled?: boolean;
}

interface PeerTrace {
	command: string;
	cwd: string;
	received: RpcMessage[];
	send(message: RpcMessage): void;
}

/** A real framed JSON-RPC peer backed by TypeScript's semantic checker, not canned diagnostics. */
function installProtocolPeer(options: PeerOptions = {}): PeerTrace[] {
	const peers: PeerTrace[] = [];
	vi.spyOn(ptree, "spawn").mockImplementation(((commandLine, spawnOptions) => {
		const command = String(commandLine[0]);
		const cwd = String(spawnOptions?.cwd);
		const workspaceSymbols = options.workspaceSymbols?.(command) ?? false;
		const openDocuments = new Set<string>();
		const received: RpcMessage[] = [];
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
		peers.push({ command, cwd, received, send });
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
			received.push(message);
			const respond = (result: unknown): void => send({ id: message.id, result });
			switch (message.method) {
				case "initialize":
					respond({
						capabilities: {
							diagnosticProvider: {},
							definitionProvider: true,
							workspaceSymbolProvider: workspaceSymbols === true,
							...(options.typeScriptProjectRoot
								? { executeCommandProvider: { commands: ["typescript.tsserverRequest"] } }
								: {}),
						},
					});
					break;
				case "initialized":
					if (workspaceSymbols === "dynamic") {
						send({
							id: "register-workspace-symbol",
							method: "client/registerCapability",
							params: { registrations: [{ id: "symbols", method: "workspace/symbol" }] },
						});
					}
					send({ method: "$/progress", params: { token: "load", value: { kind: "end" } } });
					break;
				case "textDocument/didOpen": {
					const { textDocument } = message.params as {
						textDocument: { uri: string; text: string; version: number };
					};
					openDocuments.add(textDocument.uri);
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
					openDocuments.delete(textDocument.uri);
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
				case "workspace/executeCommand": {
					const params = message.params as {
						command: string;
						arguments: [string, { file: string }, { executionTarget: number }];
					};
					if (
						params.command !== "typescript.tsserverRequest" ||
						params.arguments[0] !== "projectInfo" ||
						params.arguments[2].executionTarget !== 0 ||
						cwd !== options.typeScriptProjectRoot ||
						!openDocuments.has(params.arguments[1].file)
					) {
						send({ id: message.id, error: { code: 1, message: "No Project." } });
					} else {
						respond({
							body: {
								configFileName: path.join(cwd, "tsconfig.json"),
								languageServiceDisabled: options.languageServiceDisabled ?? false,
							},
						});
					}
					break;
				}
				case "workspace/symbol": {
					const error = options.workspaceSymbolError?.(command);
					if (!workspaceSymbols || error) {
						send({
							id: message.id,
							error: { code: -32601, message: error ?? "Unhandled method workspace/symbol" },
						});
						break;
					}
					const { query } = message.params as { query: string };
					const items = project.getLanguageService().compilerObject.getNavigateToItems(query);
					respond(
						items.map(item => {
							const target = project.getSourceFileOrThrow(item.fileName);
							return {
								name: item.name,
								kind: item.kind === "function" ? 12 : 13,
								location: {
									uri: fileToUri(path.join(cwd, item.fileName.slice(1))),
									range: {
										start: target.compilerNode.getLineAndCharacterOfPosition(item.textSpan.start),
										end: target.compilerNode.getLineAndCharacterOfPosition(
											item.textSpan.start + item.textSpan.length,
										),
									},
								},
							};
						}),
					);
					break;
				}
				case "fixture/barrier":
					respond(null);
					break;
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
	return peers;
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

	test("enabled read-only tool plans can navigate imported references through xd://lsp", async () => {
		installProtocolPeer();
		const source = path.join(directory.path(), "source.ts");
		await Bun.write(source, "export function NavigateTarget() {}\n");
		await Bun.write(
			path.join(directory.path(), "main.ts"),
			'import { NavigateTarget } from "./source";\nNavigateTarget();\n',
		);
		clients.push(await getOrCreateClient(server, directory.path()));
		const session: ToolSession = {
			cwd: directory.path(),
			hasUI: false,
			settings: Settings.isolated({ "memory.backend": "off", "autolearn.enabled": false }),
			enableLsp: true,
			lspReadOnly: true,
			taskDepth: 1,
			skipPythonPreflight: true,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
		};
		const tools = await createTools(session, ["read", "grep"]);
		const write = tools.find(entry => entry.name === "write")!;
		const result = await write.execute("readonly-navigate", {
			path: "xd://lsp",
			content: JSON.stringify({ action: "references", file: source, line: 1, symbol: "NavigateTarget" }),
		});
		expect(result.isError).not.toBe(true);
		expect(textOf(result)).toContain("main.ts:2:1");
		expect(textOf(result)).toContain("2: NavigateTarget();");
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

	test("workspace symbols reuse every active project and skip unsupported or unopened scopes", async () => {
		const peers = installProtocolPeer({ workspaceSymbols: command => command === server.command });
		for (const [name, symbol] of [
			["first", "TargetFirst"],
			["second", "TargetSecond"],
		] as const) {
			const root = path.join(directory.path(), name);
			await Bun.write(
				path.join(root, "source.ts"),
				`export function ${symbol}() {}\nexport function Ignored() {}\n`,
			);
			clients.push(await getOrCreateClient(server, root));
		}
		const servers: Record<string, ServerConfig> = { semantic: server };
		for (const extension of ["html", "css", "json", "yaml"]) {
			const unsupported = { command: `unsupported-${extension}-lsp`, fileTypes: [`.${extension}`], rootMarkers: [] };
			servers[extension] = unsupported;
			clients.push(await getOrCreateClient(unsupported, directory.path()));
		}
		servers.typescript = {
			command: "typescript-language-server",
			fileTypes: [".ts"],
			rootMarkers: ["tsconfig.json"],
		};
		configCache.set(directory.path(), { servers });
		const result = await tool.execute("workspace-projects", { action: "symbols", file: "*", query: "Target" });

		expect(result.details?.success).toBe(true);
		expect(textOf(result)).toContain("TargetFirst");
		expect(textOf(result)).toContain("TargetSecond");
		expect(textOf(result)).not.toContain("Ignored");
		expect(textOf(result)).not.toContain("Server failures:");
		expect(peers.map(peer => [peer.command, peer.cwd])).toEqual([
			[server.command, path.join(directory.path(), "first")],
			[server.command, path.join(directory.path(), "second")],
			...["html", "css", "json", "yaml"].map(extension => [`unsupported-${extension}-lsp`, directory.path()]),
		]);
		for (const peer of peers) {
			expect(peer.received.filter(message => message.method === "workspace/symbol")).toHaveLength(
				peer.command === server.command ? 1 : 0,
			);
		}
	});

	test("workspace symbols never start cwd-root clients for unopened projects", async () => {
		const peers = installProtocolPeer({ workspaceSymbols: () => true });
		const result = await tool.execute("workspace-unopened", { action: "symbols", file: "*", query: "Target" });
		expect(result.details?.success).toBe(false);
		expect(textOf(result)).toContain("no active workspace");
		expect(peers).toEqual([]);
	});

	test("workspace symbols exclude unrelated clients and superseded configuration identities", async () => {
		const peers = installProtocolPeer({ workspaceSymbols: () => true });
		await Bun.write(path.join(directory.path(), "source.ts"), "export function TargetCurrent() {}\n");
		clients.push(await getOrCreateClient({ ...server, args: ["old-config"] }, directory.path()));
		const external = TempDir.createSync("@omp-lsp-unrelated-workspace-");
		try {
			await Bun.write(path.join(external.path(), "source.ts"), "export function TargetExternal() {}\n");
			clients.push(await getOrCreateClient(server, external.path()));
			clients.push(await getOrCreateClient(server, directory.path()));
			const result = await tool.execute("workspace-owned", { action: "symbols", file: "*", query: "Target" });
			expect(result.details?.success).toBe(true);
			expect(textOf(result)).toContain("TargetCurrent");
			expect(textOf(result)).not.toContain("TargetExternal");
			expect(
				peers.map(peer => peer.received.filter(message => message.method === "workspace/symbol").length),
			).toEqual([0, 0, 1]);
		} finally {
			await shutdownClientInstance(clients[1]!);
			external.removeSync();
		}
	});

	test("TypeScript workspace symbols use the opened nested semantic project, not the syntax-only cwd client", async () => {
		const root = path.join(directory.path(), "app");
		const source = path.join(root, "source.ts");
		await Bun.write(source, "export function TargetSemantic() {}\n");
		await Bun.write(path.join(root, "tsconfig.json"), "{}\n");
		server = { command: "typescript-language-server", fileTypes: [".ts"], rootMarkers: ["tsconfig.json"] };
		configCache.set(directory.path(), { servers: { typescript: server } });
		const peers = installProtocolPeer({ workspaceSymbols: () => true, typeScriptProjectRoot: root });
		clients.push(await getOrCreateClient(server, directory.path()));
		const semantic = await getOrCreateClient(server, root);
		clients.push(semantic);
		await ensureFileOpen(semantic, source);
		const result = await tool.execute("workspace-typescript", { action: "symbols", file: "*", query: "Target" });

		expect(result.details?.success).toBe(true);
		expect(textOf(result)).toContain("TargetSemantic");
		expect(textOf(result)).not.toContain("No Project.");
		expect(
			peers[0]!.received.filter(message =>
				["workspace/symbol", "workspace/executeCommand"].includes(message.method ?? ""),
			),
		).toEqual([]);
		expect(peers[1]!.received.filter(message => message.method === "workspace/symbol")).toHaveLength(1);
		expect(peers[1]!.received.filter(message => message.method === "workspace/executeCommand")).toHaveLength(1);
	});

	test("disabled TypeScript semantic projects are reported as skipped scopes without a workspace-symbol request", async () => {
		const root = path.join(directory.path(), "app");
		const source = path.join(root, "source.ts");
		await Bun.write(source, "export function TargetDisabled() {}\n");
		await Bun.write(path.join(root, "tsconfig.json"), "{}\n");
		server = { command: "typescript-language-server", fileTypes: [".ts"], rootMarkers: ["tsconfig.json"] };
		configCache.set(directory.path(), { servers: { typescript: server } });
		const peers = installProtocolPeer({
			workspaceSymbols: () => true,
			typeScriptProjectRoot: root,
			languageServiceDisabled: true,
		});
		const client = await getOrCreateClient(server, root);
		clients.push(client);
		await ensureFileOpen(client, source);
		const result = await tool.execute("workspace-disabled", { action: "symbols", file: "*", query: "Target" });

		expect(result.details?.success).toBe(false);
		expect(textOf(result)).toContain("semantic service disabled");
		expect(textOf(result)).not.toContain("Server failures:");
		expect(peers[0]!.received.filter(message => message.method === "workspace/symbol")).toEqual([]);
	});

	test("workspace-symbol dynamic capability registration and removal control actual request dispatch", async () => {
		const peers = installProtocolPeer({ workspaceSymbols: () => "dynamic" });
		await Bun.write(path.join(directory.path(), "source.ts"), "export function TargetDynamic() {}\n");
		const client = await getOrCreateClient(server, directory.path());
		clients.push(client);
		await sendRequest(client, "fixture/barrier", {});
		const first = await tool.execute("workspace-dynamic", { action: "symbols", file: "*", query: "Target" });
		expect(first.details?.success).toBe(true);
		expect(textOf(first)).toContain("TargetDynamic");

		peers[0]!.send({
			id: "unregister-workspace-symbol",
			method: "client/unregisterCapability",
			params: { unregisterations: [{ id: "symbols", method: "workspace/symbol" }] },
		});
		await sendRequest(client, "fixture/barrier", {});
		const removed = await tool.execute("workspace-unregistered", { action: "symbols", file: "*", query: "Target" });
		expect(removed.details?.success).toBe(false);
		expect(peers[0]!.received.filter(message => message.method === "workspace/symbol")).toHaveLength(1);
	});

	test("an empty supported workspace-symbol search succeeds while real server errors remain failures", async () => {
		installProtocolPeer({
			workspaceSymbols: () => true,
			workspaceSymbolError: command =>
				command === "broken-semantic-lsp" ? "semantic index unavailable" : undefined,
		});
		await Bun.write(path.join(directory.path(), "source.ts"), "export function ActualSymbol() {}\n");
		clients.push(await getOrCreateClient(server, directory.path()));
		const missing = await tool.execute("workspace-missing", { action: "symbols", file: "*", query: "Missing" });
		expect(missing.details?.success).toBe(true);
		expect(textOf(missing)).toContain('No symbols matching "Missing"');

		const broken = { ...server, command: "broken-semantic-lsp" };
		clients.push(await getOrCreateClient(broken, directory.path()));
		configCache.set(directory.path(), { servers: { broken } });
		const failed = await tool.execute("workspace-failed", { action: "symbols", file: "*", query: "Actual" });
		expect(failed.details?.success).toBe(false);
		expect(textOf(failed)).toContain("semantic index unavailable");
		expect(textOf(failed)).not.toContain("No symbols matching");

		configCache.set(directory.path(), { servers: { semantic: server, broken } });
		const partial = await tool.execute("workspace-partial", { action: "symbols", file: "*", query: "Actual" });
		expect(partial.details?.success).toBe(true);
		expect(textOf(partial)).toContain("ActualSymbol");
		expect(textOf(partial)).toContain("semantic index unavailable");
	});
});
