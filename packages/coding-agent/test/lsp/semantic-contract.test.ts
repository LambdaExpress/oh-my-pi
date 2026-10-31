import { beforeAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createLspWritethrough } from "@oh-my-pi/pi-coding-agent/lsp";
import { getActiveClients, shutdownAll } from "@oh-my-pi/pi-coding-agent/lsp/client";
import { configCache, resolveCommand } from "@oh-my-pi/pi-coding-agent/lsp/config";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp/tool";
import type { ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { LspToolDetails } from "@oh-my-pi/pi-tui/tools/lsp";
import { TempDir, WhichCachePolicy } from "@oh-my-pi/pi-utils";

const fixturePath = Bun.fileURLToPath(new URL("./fixtures/semantic-server.ts", import.meta.url));
const declaration = "export function OldName(): number { return 1; }\nexport const sameFile = OldName();\n";
const callerText = 'import { OldName } from "./policy";\nexport const value = OldName();\n';
function text(result: AgentToolResult<LspToolDetails>): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
}
interface Fixture {
	tool: LspTool;
	root: string;
	workspace: string;
	source: string;
	caller: string;
	config: ServerConfig;
}
async function withFixture(
	flags: string[],
	run: (fixture: Fixture) => Promise<void>,
	serverName = "csharp-ls",
): Promise<void> {
	const dir = TempDir.createSync("@omp-lsp-semantic-contract-");
	const root = path.join(dir.path(), "session");
	const workspace = path.join(dir.path(), "sibling-worktree");
	const source = path.join(workspace, "src", "policy.ts");
	const caller = path.join(workspace, "src", "caller.ts");
	try {
		await Bun.write(path.join(root, "package.json"), "{}\n");
		await Bun.write(
			path.join(workspace, "tsconfig.json"),
			'{"compilerOptions":{"strict":true},"include":["src/**/*.ts"]}\n',
		);
		await Bun.write(source, declaration);
		await Bun.write(caller, callerText);
		const config: ServerConfig = {
			command: process.execPath,
			resolvedCommand: process.execPath,
			args: [fixturePath, ...flags],
			fileTypes: [".ts"],
			rootMarkers: ["tsconfig.json"],
		};
		configCache.set(root, { servers: { [serverName]: config } });
		const tool = new LspTool({ cwd: root, settings: Settings.isolated() } as ToolSession);
		await run({ tool, root, workspace, source, caller, config });
	} finally {
		await shutdownAll();
		configCache.delete(root);
		configCache.delete(workspace);
		dir.removeSync();
	}
}

beforeAll(() => initTheme());

describe("semantic rename contract over a real stdio peer", () => {
	for (const representation of ["changes", "documentChanges"]) {
		test(`applies the complete ${representation} across the routed worktree and synchronized callers`, async () => {
			await withFixture([`--workspace-edit=${representation}`], async ({ tool, source, caller, workspace }) => {
				// Open the dependency first, then alter it outside OMP. Rename must
				// reconcile every open document, not just the declaration overlay.
				await tool.execute("open-caller", {
					action: "references",
					file: caller,
					line: 2,
					symbol: "OldName",
					timeout: 30,
				});
				await Bun.write(caller, `${callerText}export const another = OldName();\n`);
				const result = await tool.execute("complete-rename", {
					action: "rename",
					file: source,
					line: 1,
					symbol: "OldName",
					new_name: "NewName",
					timeout: 30,
				});
				expect(result.details?.success).toBe(true);
				expect(await Bun.file(source).text()).toBe(declaration.replaceAll("OldName", "NewName"));
				expect(await Bun.file(caller).text()).toBe(
					`${callerText}export const another = OldName();\n`.replaceAll("OldName", "NewName"),
				);
				expect(getActiveClients().some(client => client.cwd === workspace)).toBe(true);
				// A subsequent semantic consumer must see the committed overlays too.
				const diagnostics = await tool.execute("renamed-caller", {
					action: "diagnostics",
					file: caller,
					timeout: 30,
				});
				expect(diagnostics.details?.success).toBe(true);
				expect(text(diagnostics)).not.toContain("2305");
				expect(text(diagnostics)).not.toContain("2304");
			});
		}, 45_000);

		test(`rejects declaration-only ${representation} without writing either file`, async () => {
			await withFixture(
				["--rename=declaration-only", `--workspace-edit=${representation}`],
				async ({ tool, source, caller }) => {
					const references = await tool.execute("known-callsites", {
						action: "references",
						file: source,
						line: 1,
						symbol: "OldName",
						timeout: 30,
					});
					expect(text(references)).toContain("caller.ts");
					const result = await tool.execute("incomplete-rename", {
						action: "rename",
						file: source,
						line: 1,
						symbol: "OldName",
						new_name: "NewName",
						timeout: 30,
					});
					expect(result.details?.success).toBe(false);
					expect(await Bun.file(source).text()).toBe(declaration);
					expect(await Bun.file(caller).text()).toBe(callerText);
					expect(text(result)).not.toContain("Applied rename:");
				},
			);
		}, 45_000);
	}

	for (const flags of [
		["--rename=declaration-only", "--references=unsupported"],
		["--workspace-edit=shadowed-changes"],
	]) {
		test(`refuses unverifiable or application-shadowed callsites (${flags.join(", ")})`, async () => {
			await withFixture(flags, async ({ tool, source, caller }) => {
				const result = await tool.execute("unsafe-rename", {
					action: "rename",
					file: source,
					line: 1,
					symbol: "OldName",
					new_name: "NewName",
					timeout: 30,
				});
				expect(result.details?.success).toBe(false);
				expect(await Bun.file(source).text()).toBe(declaration);
				expect(await Bun.file(caller).text()).toBe(callerText);
			});
		}, 45_000);
	}
});

describe("TypeScript diagnostics require a semantic result", () => {
	test("reports a real TS2322 despite a fresh version-matched empty publish and empty pull", async () => {
		await withFixture(
			[],
			async ({ tool, source }) => {
				await Bun.write(source, 'export const wrong: number = "text";\n');
				const result = await tool.execute("semantic-error", { action: "diagnostics", file: source, timeout: 30 });
				expect(result.details?.success).toBe(true);
				expect(text(result)).toContain("2322");
				expect(text(result)).toContain("not assignable");
			},
			"typescript-language-server",
		);
	}, 45_000);

	test("reports a genuinely clean file only after semantic analysis", async () => {
		await withFixture(
			[],
			async ({ tool, source }) => {
				await Bun.write(source, "export const right: number = 1;\n");
				const result = await tool.execute("semantic-clean", { action: "diagnostics", file: source, timeout: 30 });
				expect(result.details?.success).toBe(true);
				expect(text(result)).toBe("OK");
			},
			"typescript-language-server",
		);
	}, 45_000);

	for (const state of ["disabled", "no-project", "semantic-no-project", "malformed-diagnostics"]) {
		test(`does not turn ${state} into a clean result`, async () => {
			await withFixture(
				[`--project=${state}`],
				async ({ tool, source }) => {
					await Bun.write(source, 'export const wrong: number = "text";\n');
					const result = await tool.execute("semantic-unavailable", {
						action: "diagnostics",
						file: source,
						timeout: 30,
					});
					expect(result.details?.success).toBe(false);
					expect(text(result)).not.toBe("OK");
					expect(
						getActiveClients()
							.flatMap(client => client.semanticProjects ?? [])
							.some(project => project.status === "unavailable"),
					).toBe(true);
				},
				"typescript-language-server",
			);
		}, 45_000);
	}

	test("does not let a clean syntax linter hide unavailable TypeScript semantics", async () => {
		await withFixture(
			["--project=disabled"],
			async ({ tool, source, root }) => {
				configCache.get(root)!.servers["syntax-linter"] = {
					command: "fixture-syntax-linter",
					fileTypes: [".ts"],
					rootMarkers: [],
					isLinter: true,
					createClient: () => ({
						lint: async () => [],
						format: async (_filePath, content) => content,
					}),
				};
				const result = await tool.execute("linter-is-not-semantics", {
					action: "diagnostics",
					file: source,
					timeout: 30,
				});
				expect(result.details?.success).toBe(false);
				expect(text(result)).not.toMatch(/^OK\b/);
				expect(text(result)).toContain("languageServiceDisabled=true");
			},
			"typescript-language-server",
		);
	}, 45_000);

	for (const project of ["available", "disabled"]) {
		test(`surfaces ${project} semantics to the write consumer instead of a placeholder clean result`, async () => {
			await withFixture(
				[`--project=${project}`],
				async ({ root, workspace, source }) => {
					const config = configCache.get(root)!;
					config.servers["syntax-linter"] = {
						command: "fixture-syntax-linter",
						fileTypes: [".ts"],
						rootMarkers: [],
						isLinter: true,
						createClient: () => ({
							lint: async () => [],
							format: async (_filePath, content) => content,
						}),
					};
					configCache.set(workspace, config);
					const writethrough = createLspWritethrough(workspace, {
						enableFormat: false,
						enableDiagnostics: true,
					});
					const content = 'export const wrong: number = "text";\n';
					const result = await writethrough(source, content);
					expect(await Bun.file(source).text()).toBe(content);
					expect(result?.diagnostics?.messages.join("\n")).toContain(
						project === "available" ? "2322" : "languageServiceDisabled=true",
					);
					expect(result?.diagnostics?.summary).not.toMatch(/^(OK|no issues)$/);
				},
				"typescript-language-server",
			);
		}, 45_000);
	}
});

test.skipIf(process.platform !== "win32")(
	"launches a PATH-resolved npx.cmd without requiring another global server",
	async () => {
		await withFixture(
			[],
			async ({ tool, source, root, config }) => {
				const shimDir = path.join(root, "launcher with spaces");
				const shim = path.join(shimDir, "npx.cmd");
				await Bun.write(shim, `@echo off\r\n"${process.execPath}" "${fixturePath}" %*\r\n`);
				const resolved = resolveCommand("npx.cmd", root, { PATH: shimDir, cache: WhichCachePolicy.Bypass });
				expect(resolved).toBe(shim);
				config.command = "npx.cmd";
				config.resolvedCommand = resolved!;
				config.args = [];
				const result = await tool.execute("cmd-launcher", {
					action: "references",
					file: source,
					line: 1,
					symbol: "OldName",
					timeout: 30,
				});
				expect(result.details?.success).toBe(true);
				expect(text(result)).toContain("caller.ts");
			},
			"typescript-language-server",
		);
	},
	45_000,
);
