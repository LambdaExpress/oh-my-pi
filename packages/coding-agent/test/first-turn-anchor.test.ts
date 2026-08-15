import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { toolWireSchema } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockCall, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { type SettingPath, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	ANCHOR_BASH_DESCRIPTION,
	ANCHOR_STR_REPLACE_DESCRIPTION,
	anchorStrReplaceEditorTool,
} from "@oh-my-pi/pi-coding-agent/tools/anchor-tools";
import { assistantMsg } from "./utilities";

// The session stream (settingsAwareStreamFn -> streamSimple) and the title
// generation path both dispatch MockModel through the global custom-API
// registry; register it once so every mock call is recorded deterministically.
registerMockApi();

const ANCHOR_SYSTEM_PROMPT = "You are a helpful software engineer assistant.";
const ANCHOR_MAX_TOKENS = 256000;

type AnchorHarness = {
	session: AgentSession;
	mock: MockModel;
	authStorage: AuthStorage;
	tempDir: string;
};

const activeHarnesses: AnchorHarness[] = [];

/**
 * Fresh top-level session factory: DeepSeek-family mock model, in-memory
 * session storage, extension/MCP/LSP disabled, optional resume history and
 * taskDepth (subagent) overrides.
 */
async function createAnchorSession(options: {
	enabled: boolean;
	modelId?: string;
	taskDepth?: number;
	resume?: boolean;
	settingsOverrides?: Partial<Record<SettingPath, unknown>>;
}): Promise<AnchorHarness> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "first-turn-anchor-"));
	await fs.mkdir(path.join(tempDir, "agent"), { recursive: true });
	const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	const mock = createMockModel({
		provider: "deepseek",
		id: options.modelId ?? "deepseek-v4-pro",
		handler: () => ({ content: ["ok"] }),
	});
	authStorage.setRuntimeApiKey("deepseek", "test-key");
	const sessionManager = SessionManager.inMemory(tempDir);
	if (options.resume) {
		// Pre-seed assistant history so the session looks resumed.
		sessionManager.appendMessage(assistantMsg("hi"));
	}
	const settings = Settings.isolated({
		"experimental.firstTurnAnchor": options.enabled,
		"compaction.enabled": false,
		"todo.enabled": false,
		"retry.enabled": false,
		...options.settingsOverrides,
	});
	const { session } = await createAgentSession({
		cwd: tempDir,
		agentDir: path.join(tempDir, "agent"),
		sessionManager,
		authStorage,
		modelRegistry,
		settings,
		model: mock.model,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		workspaceTree: {
			rootPath: tempDir,
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		},
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		...(options.taskDepth !== undefined ? { taskDepth: options.taskDepth, agentId: "SubAgent" } : {}),
	});
	const harness = { session, mock, authStorage, tempDir };
	activeHarnesses.push(harness);
	return harness;
}

afterEach(async () => {
	while (activeHarnesses.length > 0) {
		const { session, authStorage, tempDir } = activeHarnesses.pop()!;
		await session.dispose();
		authStorage.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

/** Tool names declared in a recorded provider context. */
function toolNames(context: MockCall["context"]): string[] {
	return (context.tools ?? []).map(tool => tool.name);
}

/** Assert a provider call used the regular full configuration (not anchored). */
function expectNotAnchored(call: MockCall): void {
	const names = toolNames(call.context);
	expect(names).toContain("read");
	expect(names).toContain("bash");
	expect(names.length).toBeGreaterThan(2);
	expect(call.context.systemPrompt).not.toEqual([ANCHOR_SYSTEM_PROMPT]);
}

/** Extract the text of a tool result's first content block. */
function textOf(result: AgentToolResult): string {
	const block = result.content[0];
	if (block?.type !== "text") throw new Error("expected a text content block");
	return block.text;
}

describe("first-turn anchor (experimental.firstTurnAnchor)", () => {
	it("anchors the first DeepSeek request with the two-tool minimal catalog", async () => {
		const { session, mock } = await createAnchorSession({ enabled: true });
		await session.prompt("hello");

		expect(mock.calls.length).toBeGreaterThanOrEqual(1);
		const call = mock.calls[0]!;

		// Tool catalog is exactly bash + str_replace_editor.
		expect(toolNames(call.context)).toEqual(["bash", "str_replace_editor"]);

		// bash: dsh Minimal description + single-`command` wire schema.
		const bash = call.context.tools?.find(tool => tool.name === "bash");
		expect(bash).toBeDefined();
		expect(bash?.description).toBe(ANCHOR_BASH_DESCRIPTION);
		const bashWire = toolWireSchema(bash!);
		expect(Object.keys((bashWire.properties ?? {}) as Record<string, unknown>)).toEqual(["command"]);
		expect(bashWire.required).toEqual(["command"]);

		// str_replace_editor: dsh DEFAULT_DESCRIPTION text.
		const editor = call.context.tools?.find(tool => tool.name === "str_replace_editor");
		expect(editor).toBeDefined();
		expect(editor?.description).toBe(ANCHOR_STR_REPLACE_DESCRIPTION);
		// str_replace_editor wire schema mirrors dsh's schemastery declaration:
		// field order, enum values, integer/array types, and required set.
		const editorWire = toolWireSchema(editor!);
		const editorProps = (editorWire.properties ?? {}) as Record<string, unknown>;
		expect(Object.keys(editorProps)).toEqual([
			"command",
			"path",
			"file_text",
			"insert_line",
			"new_str",
			"old_str",
			"view_range",
		]);
		expect(editorWire.required).toEqual(["command", "path"]);
		expect((editorProps.command as Record<string, unknown>).enum).toEqual([
			"view",
			"create",
			"str_replace",
			"insert",
		]);
		expect((editorProps.insert_line as Record<string, unknown>).type).toBe("integer");
		expect((editorProps.view_range as Record<string, unknown>).type).toBe("array");
		expect(((editorProps.view_range as Record<string, unknown>).items as Record<string, unknown>).type).toBe(
			"integer",
		);

		// One-line system prompt, 256000 output budget, no injected messages.
		expect(call.context.systemPrompt).toEqual([ANCHOR_SYSTEM_PROMPT]);
		expect(call.options?.maxTokens).toBe(ANCHOR_MAX_TOKENS);
		expect(call.context.messages.length).toBeGreaterThanOrEqual(1);
		for (const message of call.context.messages) {
			expect(message.role).toBe("user");
		}
	});

	it("restores the full configuration from the second request on", async () => {
		const { session, mock } = await createAnchorSession({ enabled: true });
		await session.prompt("hello");
		await session.prompt("hello again");

		expect(mock.calls.length).toBeGreaterThanOrEqual(2);
		// The first request is anchored...
		expect(toolNames(mock.calls[0]!.context)).toEqual(["bash", "str_replace_editor"]);
		// ...and the second request runs with the full catalog again.
		const second = mock.calls[1]!;
		expectNotAnchored(second);
		expect(second.options?.maxTokens).not.toBe(ANCHOR_MAX_TOKENS);
	});

	it("does not anchor when the setting is off", async () => {
		const { session, mock } = await createAnchorSession({ enabled: false });
		await session.prompt("hello");

		expect(mock.calls.length).toBeGreaterThanOrEqual(1);
		expectNotAnchored(mock.calls[0]!);
	});

	it("does not anchor non-deepseek models even when the setting is on", async () => {
		const { session, mock } = await createAnchorSession({ enabled: true, modelId: "mock-model" });
		await session.prompt("hello");

		expect(mock.calls.length).toBeGreaterThanOrEqual(1);
		expectNotAnchored(mock.calls[0]!);
	});

	it("does not anchor resumed sessions with assistant history", async () => {
		const { session, mock } = await createAnchorSession({ enabled: true, resume: true });
		await session.prompt("hello");

		expect(mock.calls.length).toBeGreaterThanOrEqual(1);
		const call = mock.calls[0]!;
		expectNotAnchored(call);
		// The seeded assistant history participates in the request.
		expect(call.context.messages.some(message => message.role === "assistant")).toBe(true);
	});

	it("does not anchor subagent sessions (taskDepth > 0)", async () => {
		const { session, mock } = await createAnchorSession({ enabled: true, taskDepth: 1 });
		await session.prompt("hello");

		expect(mock.calls.length).toBeGreaterThanOrEqual(1);
		expectNotAnchored(mock.calls[0]!);
	});

	it("implements str_replace_editor with dsh semantics", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "first-turn-anchor-tool-"));
		try {
			const filePath = path.join(tempDir, "notes.txt");
			await fs.writeFile(filePath, "line one\nline two\nline three");
			const tool = anchorStrReplaceEditorTool;

			// view: cat -n line-number format.
			const view = textOf(await tool.execute("view-1", { command: "view", path: filePath }));
			expect(view).toContain(`Here's the content of ${filePath} with line numbers (which has a total of 3 lines)`);
			expect(view).toContain("     1  line one\n     2  line two\n     3  line three");

			// view with view_range [2, -1] shows from line 2 to the end.
			const ranged = textOf(await tool.execute("view-2", { command: "view", path: filePath, view_range: [2, -1] }));
			expect(ranged).toContain("with view_range=[2, -1]");
			expect(ranged).toContain("     2  line two\n     3  line three");

			// view of a directory lists non-hidden entries with type prefixes.
			const listing = textOf(await tool.execute("view-3", { command: "view", path: tempDir }));
			expect(listing).toContain(
				`Here're the files and directories up to 2 levels deep in ${tempDir}, excluding hidden items, node_modules, and Python cache directories:`,
			);
			expect(listing).toContain(`d\t${tempDir}`);
			expect(listing).toContain(`f\t${filePath}`);

			// str_replace with a unique match edits the file.
			const replaced = textOf(
				await tool.execute("replace-1", {
					command: "str_replace",
					path: filePath,
					old_str: "line two",
					new_str: "line TWO",
				}),
			);
			expect(replaced).toBe(`The file ${filePath} has been edited successfully.`);
			expect(await fs.readFile(filePath, "utf8")).toBe("line one\nline TWO\nline three");

			// str_replace with multiple occurrences is rejected with dsh's message.
			await fs.writeFile(filePath, "dup\ndup\n");
			await expect(
				tool.execute("replace-2", { command: "str_replace", path: filePath, old_str: "dup", new_str: "x" }),
			).rejects.toThrow(
				"No replacement was performed. Multiple occurrences of old_str `dup` in lines [1, 2]. Please ensure it is unique",
			);

			// Non-absolute paths are rejected before any fs access.
			const relativePathError =
				"The path notes.txt is not an absolute path, it should start with `/`. Maybe you meant /notes.txt?";
			await expect(tool.execute("view-4", { command: "view", path: "notes.txt" })).rejects.toThrow(
				relativePathError,
			);
			await expect(
				tool.execute("replace-3", { command: "str_replace", path: "notes.txt", old_str: "dup", new_str: "x" }),
			).rejects.toThrow(relativePathError);

			// create refuses to overwrite an existing file.
			await expect(
				tool.execute("create-1", { command: "create", path: filePath, file_text: "overwrite" }),
			).rejects.toThrow(`File already exists at: ${filePath}. Cannot overwrite files using command \`create\`.`);

			// create writes a new file.
			const newFilePath = path.join(tempDir, "new.txt");
			const created = textOf(
				await tool.execute("create-2", { command: "create", path: newFilePath, file_text: "fresh" }),
			);
			expect(created).toBe(`New file created successfully at: ${newFilePath}`);
			expect(await fs.readFile(newFilePath, "utf8")).toBe("fresh");

			// insert adds new_str AFTER the given line.
			const inserted = textOf(
				await tool.execute("insert-1", { command: "insert", path: filePath, insert_line: 1, new_str: "between" }),
			);
			expect(inserted).toBe(`The file ${filePath} has been edited successfully.`);
			expect(await fs.readFile(filePath, "utf8")).toBe("dup\nbetween\ndup\n");

			// insert out of range is rejected with dsh's message.
			await expect(
				tool.execute("insert-2", { command: "insert", path: filePath, insert_line: 99, new_str: "x" }),
			).rejects.toThrow(
				"Invalid `insert_line` parameter: 99. It should be within the range of lines of the file: [0, 4]",
			);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("does not consume the anchor with title generation", async () => {
		const { session, mock } = await createAnchorSession({ enabled: true });
		await session.generateTitle("Implement the login flow");
		await session.prompt("hello");

		expect(mock.calls.length).toBeGreaterThanOrEqual(1);
		// The prompt's request (the last recorded call) is still anchored even
		// though title generation ran a model request first.
		const last = mock.calls[mock.calls.length - 1]!;
		expect(toolNames(last.context)).toEqual(["bash", "str_replace_editor"]);
		expect(last.context.systemPrompt).toEqual([ANCHOR_SYSTEM_PROMPT]);
		expect(last.options?.maxTokens).toBe(ANCHOR_MAX_TOKENS);
	});
});
