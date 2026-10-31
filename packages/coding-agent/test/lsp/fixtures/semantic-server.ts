import * as path from "node:path";
import { Project, ts } from "ts-morph";
import { encodeMessageFrame, MessageFramer } from "../../../src/jsonrpc/message-framing";
import type { Diagnostic, Location, TextEdit, WorkspaceEdit } from "../../../src/lsp/types";
import { fileToUri, uriToFile } from "../../../src/lsp/utils";

// Standalone stdio peer: real TypeScript semantics with controllable protocol
// defects. Run by the consumer tests as a child process, not a mocked module.
const flags = new Map<string, string>();
for (const arg of process.argv.slice(2)) {
	const [name, value = ""] = arg.replace(/^--/, "").split("=", 2);
	flags.set(name, value);
}
const project = new Project({
	compilerOptions: {
		noLib: true,
		strict: true,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
	},
});
for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: process.cwd(), absolute: true, onlyFiles: true })) {
	project.createSourceFile(file, await Bun.file(file).text(), { overwrite: true });
}
const versions = new Map<string, number>();
const service = project.getLanguageService().compilerObject;
const output = Bun.stdout.writer();
function send(message: Record<string, unknown>): void {
	output.write(encodeMessageFrame({ jsonrpc: "2.0", ...message }));
}
function diagnostics(uri: string, semantic: boolean): Diagnostic[] {
	const source = project.getSourceFileOrThrow(uriToFile(uri));
	const items = semantic
		? service.getSemanticDiagnostics(source.getFilePath())
		: service.getSyntacticDiagnostics(source.getFilePath());
	return items.map(item => ({
		range: {
			start: source.compilerNode.getLineAndCharacterOfPosition(item.start ?? 0),
			end: source.compilerNode.getLineAndCharacterOfPosition((item.start ?? 0) + (item.length ?? 0)),
		},
		message: ts.flattenDiagnosticMessageText(item.messageText, "\n"),
		code: item.code,
		severity: item.category === ts.DiagnosticCategory.Warning ? 2 : 1,
		source: "typescript",
	}));
}

interface Message {
	id?: number | string;
	method?: string;
	params?: unknown;
}
function handle(message: Message): void {
	const respond = (result: unknown): void => send({ id: message.id, result });
	const fail = (text: string): void => send({ id: message.id, error: { code: -32_001, message: text } });
	switch (message.method) {
		case "initialize":
			respond({
				capabilities: {
					textDocumentSync: { openClose: true, change: 1, save: true },
					referencesProvider: true,
					renameProvider: true,
					diagnosticProvider: {},
					executeCommandProvider: { commands: ["typescript.tsserverRequest"] },
				},
			});
			break;
		case "initialized":
			send({ method: "$/progress", params: { token: "load", value: { kind: "end" } } });
			break;
		case "textDocument/didOpen": {
			const { textDocument } = message.params as { textDocument: { uri: string; text: string; version: number } };
			project.createSourceFile(uriToFile(textDocument.uri), textDocument.text, { overwrite: true });
			versions.set(textDocument.uri, textDocument.version);
			// Deliberately reproduce a fresh, version-matched syntax/placeholder
			// publish that must not stand in for semantic completion.
			send({
				method: "textDocument/publishDiagnostics",
				params: { uri: textDocument.uri, version: textDocument.version, diagnostics: [] },
			});
			break;
		}
		case "textDocument/didChange": {
			const { textDocument, contentChanges } = message.params as {
				textDocument: { uri: string; version: number };
				contentChanges: Array<{ text: string }>;
			};
			project.createSourceFile(uriToFile(textDocument.uri), contentChanges[0]!.text, { overwrite: true });
			versions.set(textDocument.uri, textDocument.version);
			break;
		}
		case "textDocument/diagnostic": {
			const { textDocument } = message.params as { textDocument: { uri: string } };
			respond({ kind: "full", items: flags.get("pull") === "semantic" ? diagnostics(textDocument.uri, true) : [] });
			break;
		}
		case "workspace/executeCommand": {
			const { arguments: args } = message.params as {
				arguments: [string, { file: string }, { executionTarget: number }];
			};
			if (args[2].executionTarget !== 0 || !versions.has(args[1].file)) {
				fail("No Project.");
			} else if (args[0] === "projectInfo") {
				if (flags.get("project") === "no-project") fail("<semantic> No Project.");
				else
					respond({
						body: {
							configFileName: path.join(process.cwd(), "tsconfig.json"),
							languageServiceDisabled: flags.get("project") === "disabled",
						},
					});
			} else if (args[0] === "semanticDiagnosticsSync" || args[0] === "syntacticDiagnosticsSync") {
				if (flags.get("project") === "malformed-diagnostics") {
					respond({ success: true });
				} else if (flags.get("project") === "semantic-no-project" && args[0] === "semanticDiagnosticsSync") {
					fail("<semantic> No Project.");
				} else {
					respond({
						body: diagnostics(args[1].file, args[0] === "semanticDiagnosticsSync").map(item => ({
							start: { line: item.range.start.line + 1, offset: item.range.start.character + 1 },
							end: { line: item.range.end.line + 1, offset: item.range.end.character + 1 },
							text: item.message,
							code: item.code,
							category: "error",
						})),
					});
				}
			} else {
				fail(`Unsupported tsserver command: ${args[0]}`);
			}
			break;
		}
		case "textDocument/references":
		case "textDocument/rename": {
			const { textDocument, position, newName } = message.params as {
				textDocument: { uri: string };
				position: { line: number; character: number };
				newName?: string;
			};
			const source = project.getSourceFileOrThrow(uriToFile(textDocument.uri));
			const offset = source.compilerNode.getPositionOfLineAndCharacter(position.line, position.character);
			if (message.method === "textDocument/references") {
				if (flags.get("references") === "unsupported") {
					send({ id: message.id, error: { code: -32_601, message: "Method not found" } });
					break;
				}
				const groups = service.findReferences(source.getFilePath(), offset) ?? [];
				const locations: Location[] = groups.flatMap(group =>
					group.references.map(reference => {
						const target = project.getSourceFileOrThrow(reference.fileName);
						return {
							uri: fileToUri(reference.fileName),
							range: {
								start: target.compilerNode.getLineAndCharacterOfPosition(reference.textSpan.start),
								end: target.compilerNode.getLineAndCharacterOfPosition(
									reference.textSpan.start + reference.textSpan.length,
								),
							},
						};
					}),
				);
				respond(locations);
			} else {
				const locations = service.findRenameLocations(source.getFilePath(), offset, false, false, true) ?? [];
				const changes: Record<string, TextEdit[]> = {};
				for (const location of locations) {
					if (
						flags.get("rename") === "declaration-only" &&
						(location.fileName !== source.getFilePath() ||
							location.textSpan.start > offset ||
							location.textSpan.start + location.textSpan.length <= offset)
					)
						continue;
					const target = project.getSourceFileOrThrow(location.fileName);
					(changes[fileToUri(location.fileName)] ??= []).push({
						range: {
							start: target.compilerNode.getLineAndCharacterOfPosition(location.textSpan.start),
							end: target.compilerNode.getLineAndCharacterOfPosition(
								location.textSpan.start + location.textSpan.length,
							),
						},
						newText: `${location.prefixText ?? ""}${newName}${location.suffixText ?? ""}`,
					});
				}
				const edit: WorkspaceEdit =
					flags.get("workspace-edit") === "shadowed-changes"
						? {
								changes,
								documentChanges: [
									{
										textDocument: { uri: textDocument.uri, version: versions.get(textDocument.uri) ?? null },
										edits: changes[textDocument.uri]!.filter(
											edit =>
												edit.range.start.line === position.line &&
												edit.range.start.character <= position.character &&
												edit.range.end.character > position.character,
										),
									},
								],
							}
						: flags.get("workspace-edit") === "documentChanges"
							? {
									documentChanges: Object.entries(changes).map(([uri, edits]) => ({
										textDocument: { uri, version: versions.get(uri) ?? null },
										edits,
									})),
								}
							: { changes };
				respond(edit);
			}
			break;
		}
		case "shutdown":
			respond(null);
			break;
		case "exit":
			process.exit(0);
	}
}

const framer = new MessageFramer(Buffer.alloc(0));
for await (const chunk of Bun.stdin.stream()) {
	framer.push(chunk);
	for (const frame of framer.drain(header => {
		throw new Error(`Invalid fixture framing: ${header}`);
	})) {
		handle(JSON.parse(frame) as Message);
	}
	await output.flush();
}
