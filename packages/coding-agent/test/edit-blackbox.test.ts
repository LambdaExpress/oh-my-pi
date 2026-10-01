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
