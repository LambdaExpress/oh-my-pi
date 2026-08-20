/**
 * First-turn anchor tool catalog: the DeepSeek Minimal two-tool preset clone.
 *
 * Text constants and the `str_replace_editor` semantics are byte-for-byte
 * copies of the DeepSeek Harness Minimal preset (agent.cordis.yml) and
 * `tool-str-replace-editor` — the model-visible surface must match dsh
 * exactly. File operations use `node:fs/promises` directly; they never route
 * through omp's edit tooling.
 */

import type { Stats } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";

/** dsh `maxOutputChars` default for view/list outputs. */
const MAX_OUTPUT_CHARS = 16000;

const TRUNCATED_MESSAGE =
	"<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>";

/** Model-facing description of `bash` in the dsh Minimal preset (7 lines, no surrounding newlines). */
export const ANCHOR_BASH_DESCRIPTION = `Run commands in a bash shell
* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
* You don't have access to the internet via this tool.
* You do have access to a mirror of common linux and python packages via apt and pip.
* State is persistent across command calls and discussions with the user.
* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.
* Please avoid commands that may produce a very large amount of output.
* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.`;

/** Model-facing description of `str_replace_editor` (dsh `DEFAULT_DESCRIPTION`, trimmed). */
export const ANCHOR_STR_REPLACE_DESCRIPTION = `
Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\`
`.trim();

/** `bash` parameter schema for the anchored first turn: dsh shape, single `command` field. */
export const anchorBashSchema = type({
	command: type("string").describe("The bash command to run. Relative path is preferred in the command."),
});

/**
 * `str_replace_editor` parameter schema, mirroring dsh's schemastery
 * declaration field-for-field. The literal-union expression folds into
 * `{ enum: [...], type: "string" }` (order preserved) and `"number.integer"`
 * / `"number.integer[]"` emit `{ type: "integer" }` on the wire, matching
 * dsh's `type: 'integer'` / `items: { type: 'integer' }`.
 */
const anchorStrReplaceEditorSchema = type({
	command: type("'view' | 'create' | 'str_replace' | 'insert'").describe(
		"The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`.",
	),
	path: type("string").describe("Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`."),
	"file_text?": type("string").describe(
		"Required parameter of `create` command, with the content of the file to be created.",
	),
	"insert_line?": type("number.integer").describe(
		"Required parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`.",
	),
	"new_str?": type("string").describe(
		"Optional parameter of `str_replace` command containing the new string (if not given, no string will be added). Required parameter of `insert` command containing the string to insert.",
	),
	"old_str?": type("string").describe(
		"Required parameter of `str_replace` command containing the string in `path` to replace.",
	),
	"view_range?": type("number.integer[]").describe(
		"Optional parameter of `view` command when `path` points to a file. If none is given, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file.",
	),
});

function textResult(text: string): AgentToolResult {
	return { content: [{ type: "text", text }] };
}

function maybeTruncate(content: string, maxOutputChars: number): string {
	return content.length <= maxOutputChars ? content : content.slice(0, maxOutputChars) + TRUNCATED_MESSAGE;
}

function codepointCompare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function matchOffsets(content: string, search: string): number[] {
	const offsets: number[] = [];
	let offset = 0;
	while (true) {
		const match = content.indexOf(search, offset);
		if (match < 0) return offsets;
		offsets.push(match);
		offset = match + search.length;
	}
}

function lineNumbersAt(content: string, offsets: readonly number[]): number[] {
	let line = 1;
	let cursor = 0;
	return offsets.map(offset => {
		while (cursor < offset) {
			if (content[cursor] === "\n") line += 1;
			cursor += 1;
		}
		return line;
	});
}

function isEnoent(error: unknown): boolean {
	return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** dsh `resolveTarget`: empty/relative paths are rejected before any fs access. */
function assertValidPath(path: string): void {
	if (path.trim().length === 0) throw new Error("path must be a non-empty string");
	if (!isAbsolute(path)) {
		throw new Error(
			`The path ${path} is not an absolute path, it should start with \`/\`. Maybe you meant /${path}?`,
		);
	}
}

/** dsh `statExisting`: missing paths and (for non-view commands) directories are rejected. */
async function statExisting(path: string, command: "view" | "str_replace" | "insert") {
	let info: Stats;
	try {
		info = await stat(path);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		throw new Error(`The path ${path} does not exist. Please provide a valid path.`);
	}
	if (info.isDirectory() && command !== "view") {
		throw new Error(`The path ${path} is a directory and only the \`view\` command can be used on directories`);
	}
	return info;
}

function requiredForCommand(value: string | undefined, parameter: string, command: string, allowEmpty = true): string {
	if (value === undefined) throw new Error(`Parameter \`${parameter}\` is required for command: ${command}`);
	if (!allowEmpty && value.length === 0) {
		throw new Error(`Parameter \`${parameter}\` is empty for command: ${command}`);
	}
	return value;
}

function formatFileView(path: string, content: string, maxOutputChars: number, viewRange?: number[]): string {
	const allLines = content.split("\n");
	let lines = allLines;
	let initialLine = 1;
	let finalLine: number | undefined;
	let prompt = `Here's the content of ${path} with line numbers (which has a total of ${allLines.length} lines)`;
	if (viewRange !== undefined) {
		const [requestedInitialLine, requestedFinalLine] = viewRange;
		if (
			viewRange.length !== 2 ||
			requestedInitialLine === undefined ||
			requestedFinalLine === undefined ||
			!viewRange.every(Number.isInteger)
		) {
			throw new Error("Invalid `view_range`. It should be a list of two integers.");
		}
		initialLine = requestedInitialLine;
		finalLine = requestedFinalLine;
		if (initialLine < 1 || initialLine > allLines.length) {
			throw new Error(
				`Invalid \`view_range\`: [${viewRange.join(", ")}]. Its first element \`${initialLine}\` should be within the range of lines of the file: [1, ${allLines.length}]`,
			);
		}
		if (finalLine > allLines.length) {
			throw new Error(
				`Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${finalLine}\` should be smaller than the number of lines in the file: \`${allLines.length}\``,
			);
		}
		if (finalLine !== -1 && finalLine < initialLine) {
			throw new Error(
				`Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${finalLine}\` should be larger or equal than its first \`${initialLine}\``,
			);
		}
		lines = finalLine === -1 ? allLines.slice(initialLine - 1) : allLines.slice(initialLine - 1, finalLine);
		prompt += ` with view_range=[${initialLine}, ${finalLine}]`;
	}
	const numbered = lines.map((line, index) => `${String(initialLine + index).padStart(6, " ")}  ${line}`).join("\n");
	return maybeTruncate(`${prompt}:\n${numbered}\n`, maxOutputChars);
}

async function listDirectory(path: string, maxOutputChars: number): Promise<string> {
	async function visit(dir: string, depth: number): Promise<string[]> {
		const entries = await readdir(dir, { withFileTypes: true });
		const rows: string[] = [];
		for (const entry of entries.filter(
			candidate =>
				!candidate.name.startsWith(".") && candidate.name !== "node_modules" && candidate.name !== "__pycache__",
		)) {
			const type = entry.isDirectory() ? "d" : entry.isFile() ? "f" : "?";
			const displayPath = join(dir, entry.name);
			rows.push(`${type}\t${displayPath}`);
			if (entry.isDirectory() && depth < 2) {
				rows.push(...(await visit(displayPath, depth + 1)));
			}
		}
		return rows;
	}
	const rows = [`d\t${path}`, ...(await visit(path, 1))];
	rows.sort((left, right) => {
		const leftPath = left.slice(left.indexOf("\t") + 1);
		const rightPath = right.slice(right.indexOf("\t") + 1);
		return codepointCompare(leftPath, rightPath);
	});
	const listing = maybeTruncate(`${rows.join("\n")}\n`, maxOutputChars);
	return `Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items, node_modules, and Python cache directories:\n${listing}\n`;
}

async function viewPath(path: string, viewRange: number[] | undefined, maxOutputChars: number): Promise<string> {
	assertValidPath(path);
	const info = await statExisting(path, "view");
	if (info.isDirectory()) {
		if (viewRange !== undefined) {
			throw new Error("The `view_range` parameter is not allowed when `path` points to a directory.");
		}
		return listDirectory(path, maxOutputChars);
	}
	if (!info.isFile()) {
		throw new Error(`cannot view "${path}": not a regular file or directory`);
	}
	const content = await readFile(path, "utf8");
	return formatFileView(path, content, maxOutputChars, viewRange);
}

async function createFile(path: string, fileText: string | undefined): Promise<string> {
	const content = requiredForCommand(fileText, "file_text", "create");
	assertValidPath(path);
	let info: Stats | undefined;
	try {
		info = await stat(path);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		info = undefined;
	}
	if (info !== undefined) {
		throw new Error(`File already exists at: ${path}. Cannot overwrite files using command \`create\`.`);
	}
	await writeFile(path, content, "utf8");
	return `New file created successfully at: ${path}`;
}

async function replaceInFile(path: string, oldStr: string | undefined, newStr: string | undefined): Promise<string> {
	assertValidPath(path);
	const oldValue = requiredForCommand(oldStr, "old_str", "str_replace", false);
	const newValue = newStr ?? "";
	const info = await statExisting(path, "str_replace");
	if (!info.isFile()) {
		throw new Error(`cannot edit "${path}": not a regular file`);
	}
	const before = await readFile(path, "utf8");
	const offsets = matchOffsets(before, oldValue);
	const offset = offsets[0];
	if (offset === undefined) {
		throw new Error(`No replacement was performed, old_str \`${oldValue}\` did not appear verbatim in ${path}.`);
	}
	if (offsets.length > 1) {
		const lines = lineNumbersAt(before, offsets);
		throw new Error(
			`No replacement was performed. Multiple occurrences of old_str \`${oldValue}\` in lines [${lines.join(", ")}]. Please ensure it is unique`,
		);
	}
	await writeFile(path, before.slice(0, offset) + newValue + before.slice(offset + oldValue.length), "utf8");
	return `The file ${path} has been edited successfully.`;
}

async function insertInFile(path: string, insertLine: number | undefined, newStr: string | undefined): Promise<string> {
	if (insertLine === undefined) throw new Error("Parameter `insert_line` is required for command: insert");
	const value = requiredForCommand(newStr, "new_str", "insert");
	assertValidPath(path);
	const info = await statExisting(path, "insert");
	if (!info.isFile()) {
		throw new Error(`cannot insert into "${path}": not a regular file`);
	}
	const before = await readFile(path, "utf8");
	const lines = before.split("\n");
	if (!Number.isInteger(insertLine) || insertLine < 0 || insertLine > lines.length) {
		throw new Error(
			`Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`,
		);
	}
	const after = [...lines.slice(0, insertLine), ...value.split("\n"), ...lines.slice(insertLine)].join("\n");
	await writeFile(path, after, "utf8");
	return `The file ${path} has been edited successfully.`;
}

function createAnchorStrReplaceEditorTool(
	cwd: () => string = () => process.cwd(),
): AgentTool<typeof anchorStrReplaceEditorSchema> {
	// dsh parity: the fs-local realm resolves `DSH_CWD ?? process.cwd()`. Every
	// operation here is absolute-path, so cwd never participates in resolution,
	// but the hook is retained to satisfy the construction contract.
	const cwdProvider = cwd;
	void cwdProvider;
	return {
		name: "str_replace_editor",
		label: "str_replace_editor",
		description: ANCHOR_STR_REPLACE_DESCRIPTION,
		parameters: anchorStrReplaceEditorSchema,
		intent: "omit",
		loadMode: "essential",
		strict: true,
		async execute(_toolCallId, params) {
			switch (params.command) {
				case "view":
					return textResult(await viewPath(params.path, params.view_range, MAX_OUTPUT_CHARS));
				case "create":
					return textResult(await createFile(params.path, params.file_text));
				case "str_replace":
					return textResult(await replaceInFile(params.path, params.old_str, params.new_str));
				case "insert":
					return textResult(await insertInFile(params.path, params.insert_line, params.new_str));
			}
		},
	};
}

/** Session-scoped `str_replace_editor` clone bound to the process cwd. */
export const anchorStrReplaceEditorTool = createAnchorStrReplaceEditorTool();
