import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool, getEditStore, type PatchParams } from "@oh-my-pi/pi-coding-agent/edit";
import { formatHashlineHeader } from "@oh-my-pi/pi-tui/tools/hashline-format";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { EditMode } from "@oh-my-pi/pi-tui/tools/edit";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const MODEL = "openai/gpt-5.6";
const SOURCE = "export function value(): number {\n\treturn 1;\n}\n";
const BROKEN_SOURCE = "export function value(): number {\n\treturn (;\n}\n";

function makeSession(cwd: string, settings: Settings): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => MODEL,
		enableLsp: false,
		settings,
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

let tempDir: string;
let agentDir: string;
let logPath: string;
let settings: Settings;
let session: ToolSession;
let settingsState: SettingsTestState;

beforeEach(async () => {
	settingsState = beginSettingsTest();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-edit-blackbox-"));
	agentDir = path.join(tempDir, "agent");
	logPath = path.join(agentDir, "edit-blackbox.jsonl");
	await fs.mkdir(agentDir, { recursive: true });
	settings = await Settings.loadIsolated({
		cwd: tempDir,
		agentDir,
		inMemory: true,
		overrides: { "edit.enforceSeenLines": false, "edit.blackbox.enabled": true },
	});
	session = makeSession(tempDir, settings);
});

afterEach(async () => {
	restoreSettingsTestState(settingsState);
	await removeWithRetries(tempDir);
});

async function writeFixture(name: string): Promise<string> {
	const absolutePath = path.join(tempDir, name);
	await Bun.write(absolutePath, SOURCE);
	return absolutePath;
}

describe("edit parse-regression blackbox", () => {
	test("does not record parse regressions when disabled", async () => {
		const disabledSettings = await Settings.loadIsolated({
			cwd: tempDir,
			agentDir,
			inMemory: true,
			overrides: { "edit.enforceSeenLines": false, "edit.blackbox.enabled": false },
		});
		const disabledSession = makeSession(tempDir, disabledSettings);
		const filePath = await writeFixture("disabled.ts");

		await new EditTool(disabledSession, "replace").execute("disabled", {
			path: "disabled.ts",
			old_string: "return 1;",
			new_string: "return (;",
		});

		expect(await Bun.file(filePath).text()).toBe(BROKEN_SOURCE);
		expect(await Bun.file(logPath).exists()).toBe(false);
	});

	test("appends valid-to-invalid transitions from every edit variant", async () => {
		await fs.appendFile(logPath, '{"seed":true}\n');
		const expected: Array<{
			prev: string;
			new: string;
			model: string;
			variant: EditMode;
		}> = [];

		const replacePath = await writeFixture("replace.ts");
		const replaceArg = { path: "replace.ts", old_string: "return 1;", new_string: "return (;" };
		await new EditTool(session, "replace").execute("replace", replaceArg);
		expect(await Bun.file(replacePath).text()).toBe(BROKEN_SOURCE);
		expected.push({
			prev: SOURCE,
			new: BROKEN_SOURCE,
			model: MODEL,
			variant: "replace",
		});

		const patchPath = await writeFixture("patch.ts");
		const patchArg = {
			path: "patch.ts",
			edits: [{ op: "update", diff: "@@\n-\treturn 1;\n+\treturn (;" }],
		} satisfies PatchParams;
		await new EditTool(session, "patch").execute("patch", patchArg);
		expect(await Bun.file(patchPath).text()).toBe(BROKEN_SOURCE);
		expected.push({
			prev: SOURCE,
			new: BROKEN_SOURCE,
			model: MODEL,
			variant: "patch",
		});

		const applyPatchPath = await writeFixture("apply-patch.ts");
		const applyPatchArg = {
			input: [
				"*** Begin Patch",
				"*** Update File: apply-patch.ts",
				"@@",
				"-\treturn 1;",
				"+\treturn (;",
				"*** End Patch",
				"",
			].join("\n"),
		};
		await new EditTool(session, "apply_patch").execute("apply-patch", applyPatchArg);
		expect(await Bun.file(applyPatchPath).text()).toBe(BROKEN_SOURCE);
		expected.push({
			prev: SOURCE,
			new: BROKEN_SOURCE,
			model: MODEL,
			variant: "apply_patch",
		});

		const hashlinePath = await writeFixture("hashline.ts");
		const tag = getEditStore(session).recordSnapshot(hashlinePath, SOURCE, undefined);
		const hashlineArg = {
			input: `${formatHashlineHeader("hashline.ts", tag)}\nPUT 2-2:\n+\treturn (;`,
		};
		await new EditTool(session, "hashline").execute("hashline", hashlineArg);
		expect(await Bun.file(hashlinePath).text()).toBe(BROKEN_SOURCE);
		expected.push({
			prev: SOURCE,
			new: BROKEN_SOURCE,
			model: MODEL,
			variant: "hashline",
		});

		const sloppyPath = await writeFixture("sloppy.ts");
		const sloppyArg = {
			input: "*** Edit File: sloppy.ts\n*** Find\n\treturn 1;\n*** Replace\n\treturn (;",
		};
		await new EditTool(session, "sloppy").execute("sloppy", sloppyArg);
		expect(await Bun.file(sloppyPath).text()).toBe(BROKEN_SOURCE);
		expected.push({
			prev: SOURCE,
			new: BROKEN_SOURCE,
			model: MODEL,
			variant: "sloppy",
		});

		const lines = (await Bun.file(logPath).text()).trimEnd().split("\n");
		expect(JSON.parse(lines[0])).toEqual({ seed: true });
		expect(
			lines.slice(1).map(line => {
				const { prev, new: next, model, variant } = JSON.parse(line);
				return { prev, new: next, model, variant };
			}),
		).toEqual(expected);
	});

	test("does not record valid or already-invalid transitions", async () => {
		await writeFixture("valid.ts");
		await new EditTool(session, "replace").execute("valid", {
			path: "valid.ts",
			old_string: "return 1;",
			new_string: "return 2;",
		});

		await Bun.write(path.join(tempDir, "invalid.ts"), "export const value = (;\n");
		await new EditTool(session, "replace").execute("already-invalid", {
			path: "invalid.ts",
			old_string: "value",
			new_string: "next",
		});

		expect(await Bun.file(logPath).exists()).toBe(false);
	});

	test("treats an empty supported source as parseable", async () => {
		await writeFixture("empty.ts");
		await new EditTool(session, "replace").execute("empty", {
			path: "empty.ts",
			old_string: SOURCE,
			new_string: "",
		});

		expect(await Bun.file(path.join(tempDir, "empty.ts")).text()).toBe("");
		expect(await Bun.file(logPath).exists()).toBe(false);
	});
});

describe("apply_patch 回归", () => {
	test("只移动的补丁通过工具完整保留原始字节", async () => {
		const source = path.join(tempDir, "validation.cs");
		const destination = path.join(tempDir, "staged", "validation.cs.pending");
		const original = new TextEncoder().encode("\ufeffusing System;\r\n// 保留字节 \t\nclass Validation {}");
		await Bun.write(source, original);
		const result = await new EditTool(session, "apply_patch").execute("move-only", {
			input: [
				"*** Begin Patch",
				"*** Update File: validation.cs",
				"*** Move to: staged/validation.cs.pending",
				"*** End Patch",
			].join("\n"),
		});
		expect(result.isError).not.toBe(true);
		expect(await Bun.file(source).exists()).toBe(false);
		expect(await Bun.file(destination).bytes()).toEqual(original);
		expect(await Bun.file(logPath).exists()).toBe(false);
	});

	test("多段补丁用完整两行选中唯一 GoGo 场景", async () => {
		const declaration =
			'                    var gogo = AssetDatabase.LoadAssetAtPath<VRCExpressionsMenu>("Assets/GoGoLocoMenu/Menu.asset");';
		const removed = "                    var goControl = WalkMenus(gogo).SelectMany(m => m.controls)";
		const replacement = "                    var goControl = WalkMenus(mergedGoMenu).SelectMany(m => m.controls)";
		const original = [
			"const int Version = 1;",
			declaration,
			removed,
			"// 保留相似场景 \t",
			declaration,
			"                    var control = WalkMenus(gogo).SelectMany(m => m.controls)",
			"",
		].join("\r\n");
		const source = path.join(tempDir, "scenarios.cs");
		await Bun.write(source, original);
		const result = await new EditTool(session, "apply_patch").execute("unique-hunk", {
			input: [
				"*** Begin Patch",
				"*** Update File: scenarios.cs",
				"@@",
				"-const int Version = 1;",
				"+const int Version = 2;",
				"@@",
				`-${declaration}`,
				`-${removed}`,
				`+${replacement}`,
				"*** End Patch",
			].join("\n"),
		});
		expect(result.isError).not.toBe(true);
		expect(await Bun.file(source).text()).toBe(
			original
				.replace("const int Version = 1;", "const int Version = 2;")
				.replace(`${declaration}\r\n${removed}`, replacement),
		);
	});

	test("真正重复的完整补丁阻止组合补丁的所有文件变更", async () => {
		const source = path.join(tempDir, "source.txt");
		const stable = path.join(tempDir, "stable.txt");
		const ambiguous = path.join(tempDir, "ambiguous.cs");
		const originalSource = "\ufeffkeep\r\nthese bytes\n";
		const duplicate = "var gogo = LoadMenu();\nvar goControl = WalkMenus(gogo);";
		const originalAmbiguous = `version = 1;\n${duplicate}\nseparator();\n${duplicate}\n`;
		await Bun.write(source, originalSource);
		await Bun.write(stable, "old\n");
		await Bun.write(ambiguous, originalAmbiguous);
		const result = await new EditTool(session, "apply_patch").execute("ambiguous-hunk", {
			input: [
				"*** Begin Patch",
				"*** Update File: source.txt",
				"*** Move to: destination.txt",
				"*** Update File: stable.txt",
				"@@",
				"-old",
				"+new",
				"*** Update File: ambiguous.cs",
				"@@",
				"-version = 1;",
				"+version = 2;",
				"@@",
				"-var gogo = LoadMenu();",
				"-var goControl = WalkMenus(gogo);",
				"+var goControl = WalkMenus(mergedGoMenu);",
				"*** End Patch",
			].join("\n"),
		});
		expect(result.isError).toBe(true);
		expect(await Bun.file(path.join(tempDir, "destination.txt")).exists()).toBe(false);
		expect(Buffer.from(await Bun.file(source).arrayBuffer())).toEqual(Buffer.from(originalSource));
		expect(await Bun.file(stable).text()).toBe("old\n");
		expect(await Bun.file(ambiguous).text()).toBe(originalAmbiguous);
		expect(await Bun.file(logPath).exists()).toBe(false);
	});
});
