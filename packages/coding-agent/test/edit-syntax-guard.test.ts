import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import {
	computeRepairRegion,
	hasParseRegression,
	repairParseRegression,
	sourceParseStatus,
} from "@oh-my-pi/pi-coding-agent/edit/auto-repair";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const powershellBefore = await fs.readFile(
	new URL("../../../crates/pi-edit/tests/fixtures/syntax/powershell-before.ps1", import.meta.url),
	"utf8",
);
const powershellAfter = await fs.readFile(
	new URL("../../../crates/pi-edit/tests/fixtures/syntax/powershell-after.ps1", import.meta.url),
	"utf8",
);

describe("edit syntax confidence", () => {
	test("PowerShell grammar results remain uncertain for valid and invalid source", () => {
		for (const filename of ["script.ps1", "module.psm1", "manifest.psd1", "script.PS1"]) {
			for (const code of [powershellBefore, powershellAfter, "$value = (\n", ""]) {
				expect(sourceParseStatus(code, filename)).toBe("unknown");
			}
			expect(hasParseRegression({ path: filename, prev: powershellBefore, next: powershellAfter })).toBe(false);
			expect(hasParseRegression({ path: filename, prev: "$value = 1\n", next: "$value = (\n" })).toBe(false);
		}
	});

	test("only known valid-to-invalid transitions are repairable", () => {
		for (const [filename, prev, next, regressed] of [
			["broken.ts", "const value = 1;\n", "const value = (;\n", true],
			["valid.ts", "const value = 1;\n", "const value = 2;\n", false],
			["already-invalid.ts", "const value = (;\n", "const next = (;\n", false],
			["empty.ts", "", "const value = (;\n", true],
			["broken.json", '{"value":1}\n', '{"value":}\n', true],
			["broken.rs", "fn main() {}\n", "fn main( {}\n", true],
			["unknown.txt", "const value = 1;\n", "const value = (;\n", false],
		] as const) {
			const snapshot = { path: filename, prev, next };
			expect(hasParseRegression(snapshot)).toBe(regressed);
			if (!regressed) expect(computeRepairRegion(snapshot)).toBeUndefined();
		}
	});

	test("uncertain PowerShell syntax never requests an AI repair", async () => {
		const snapshot = { path: "script.ps1", prev: powershellBefore, next: powershellAfter };
		expect(computeRepairRegion(snapshot)).toBeUndefined();
		let completions = 0;
		const repair = await repairParseRegression(snapshot, async () => {
			completions++;
			throw new Error("Uncertain grammar must not request an AI repair");
		});
		expect(repair).toBeUndefined();
		expect(completions).toBe(0);
	});
});

describe("PowerShell apply_patch", () => {
	let tempDir: string;
	let settingsState: SettingsTestState;

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-edit-syntax-"));
	});

	afterEach(async () => {
		restoreSettingsTestState(settingsState);
		await removeWithRetries(tempDir);
	});

	test("keeps the valid BOM script without recording a syntax regression", async () => {
		const agentDir = path.join(tempDir, "agent");
		await fs.mkdir(agentDir, { recursive: true });
		const settings = await Settings.loadIsolated({
			cwd: tempDir,
			agentDir,
			inMemory: true,
			overrides: {
				"edit.enforceSeenLines": false,
				"edit.blackbox.enabled": true,
				"edit.autoRepair.enabled": true,
			},
		});
		const session = {
			cwd: tempDir,
			hasUI: false,
			enableLsp: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => null,
			getSessionId: () => null,
			getPlanModeState: () => undefined,
		} as unknown as ToolSession;
		const scriptPath = path.join(tempDir, "probe.ps1");
		await Bun.write(scriptPath, powershellBefore);
		const input = [
			"*** Begin Patch",
			"*** Update File: probe.ps1",
			"@@",
			...powershellBefore
				.replace(/^\ufeff/u, "")
				.trimEnd()
				.split("\n")
				.map(line => `-${line}`),
			...powershellAfter
				.replace(/^\ufeff/u, "")
				.trimEnd()
				.split("\n")
				.map(line => `+${line}`),
			"*** End Patch",
		].join("\n");
		await new EditTool(session, "apply_patch").execute("powershell-confidence", { input });
		expect(await fs.readFile(scriptPath)).toEqual(Buffer.from(powershellAfter, "utf8"));
		expect(await Bun.file(path.join(agentDir, "edit-blackbox.jsonl")).exists()).toBe(false);
	});
});
