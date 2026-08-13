import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type EditMode, type EditModeSessionLike, resolveEditMode } from "@oh-my-pi/pi-coding-agent/utils/edit-mode";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const originalEditVariant = Bun.env.PI_EDIT_VARIANT;
const originalStrictEditMode = Bun.env.PI_STRICT_EDIT_MODE;

function restoreEnv(): void {
	if (originalEditVariant === undefined) {
		delete Bun.env.PI_EDIT_VARIANT;
	} else {
		Bun.env.PI_EDIT_VARIANT = originalEditVariant;
	}
	if (originalStrictEditMode === undefined) {
		delete Bun.env.PI_STRICT_EDIT_MODE;
	} else {
		Bun.env.PI_STRICT_EDIT_MODE = originalStrictEditMode;
	}
}

function createSession(args: {
	activeModel?: string;
	modelVariant?: EditMode | null;
	settingsMode?: EditMode;
}): EditModeSessionLike {
	return {
		getActiveModelString: () => args.activeModel,
		settings: {
			get: () => args.settingsMode ?? "hashline",
			getEditVariantForModel: () => args.modelVariant ?? null,
		},
	};
}

describe("resolveEditMode", () => {
	beforeEach(() => {
		delete Bun.env.PI_EDIT_VARIANT;
		delete Bun.env.PI_STRICT_EDIT_MODE;
	});

	afterEach(() => {
		restoreEnv();
	});

	test("falls back from hashline to replace for Kimi models", () => {
		delete Bun.env.PI_EDIT_VARIANT;

		expect(resolveEditMode(createSession({ activeModel: "openrouter/moonshotai/Kimi-K2-Instruct" }))).toBe("replace");
	});

	test("falls back from hashline to replace for MiMo models", () => {
		delete Bun.env.PI_EDIT_VARIANT;

		expect(resolveEditMode(createSession({ activeModel: "xiaomi/MiMo-V2.5-Pro" }))).toBe("replace");
	});

	test("falls back from hashline to replace for DeepSeek V4 Flash models", () => {
		delete Bun.env.PI_EDIT_VARIANT;

		expect(resolveEditMode(createSession({ activeModel: "tensormesh/deepseek-ai/DeepSeek-V4-Flash" }))).toBe(
			"replace",
		);
	});

	test("falls back from hashline to replace for Step 3.7 Flash models", () => {
		delete Bun.env.PI_EDIT_VARIANT;

		expect(resolveEditMode(createSession({ activeModel: "kilo/stepfun/step-3.7-flash:free" }))).toBe("replace");
	});

	test("does not exclude non-Kimi Moonshot models", () => {
		delete Bun.env.PI_EDIT_VARIANT;

		expect(resolveEditMode(createSession({ activeModel: "moonshot/moonshot-v1-128k" }))).toBe("hashline");
	});

	test("keeps explicit model variants ahead of the Kimi fallback", () => {
		delete Bun.env.PI_EDIT_VARIANT;

		expect(
			resolveEditMode(
				createSession({ activeModel: "openrouter/moonshotai/Kimi-K2-Instruct", modelVariant: "hashline" }),
			),
		).toBe("hashline");
	});

	test("keeps PI_EDIT_VARIANT ahead of the Kimi fallback", () => {
		Bun.env.PI_EDIT_VARIANT = "hashline";

		expect(resolveEditMode(createSession({ activeModel: "openrouter/moonshotai/Kimi-K2-Instruct" }))).toBe(
			"hashline",
		);
	});

	test("only falls back when the resolved mode is hashline", () => {
		delete Bun.env.PI_EDIT_VARIANT;

		expect(
			resolveEditMode(
				createSession({ activeModel: "openrouter/moonshotai/Kimi-K2-Instruct", settingsMode: "apply_patch" }),
			),
		).toBe("apply_patch");
	});

	test("keeps strict edit mode ahead of the Kimi fallback", () => {
		delete Bun.env.PI_EDIT_VARIANT;
		Bun.env.PI_STRICT_EDIT_MODE = "1";

		expect(resolveEditMode(createSession({ activeModel: "openrouter/moonshotai/Kimi-K2-Instruct" }))).toBe(
			"hashline",
		);
	});
});

function createApplyPatchSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		enableLsp: false,
		settings: Settings.isolated({ "edit.mode": "apply_patch" }),
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

function applyPatchEnvelope(lines: readonly string[]): string {
	return ["*** Begin Patch", ...lines, "*** End Patch", ""].join("\n");
}

const ABSOLUTE_PATH_ERROR = /Local apply_patch paths must be workspace-relative/;

describe("EditTool apply_patch local path contract", () => {
	let tempRoot: string;
	let workspace: string;

	beforeEach(async () => {
		resetSettingsForTest();
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-apply-patch-paths-"));
		workspace = path.join(tempRoot, "21cp");
		await fs.mkdir(workspace);
		await Settings.init({ inMemory: true, cwd: workspace });
	});

	afterEach(async () => {
		resetSettingsForTest();
		await removeWithRetries(tempRoot);
	});

	test("treats both reported D:/project sibling-worktree updates as the same rejected contract", async () => {
		const tool = new EditTool(createApplyPatchSession("D:/project/21cp"), "apply_patch");
		const reportedPaths = [
			"D:/project/21cp-worktrees/cen21-6771-services/21stCenturyServices/ROM.WindowsAgent.Client/WindowsAgentClient.cs",
			"D:/project/21cp-worktrees/cen21-6771-services/21stCenturyServices/IdentityService/Properties/launchSettings.json",
		];

		for (const reportedPath of reportedPaths) {
			const input = applyPatchEnvelope([`*** Update File: ${reportedPath}`, "@@", "-old", "+new"]);
			await expect(tool.execute(`reported-${reportedPath}`, { input })).rejects.toThrow(ABSOLUTE_PATH_ERROR);
		}
	});

	test("rejects absolute update paths both inside and outside the workspace without modifying either file", async () => {
		const insidePath = path.join(workspace, "inside.txt");
		const outsidePath = path.join(tempRoot, "outside.txt");
		await Bun.write(insidePath, "original\n");
		await Bun.write(outsidePath, "original\n");
		const tool = new EditTool(createApplyPatchSession(workspace), "apply_patch");

		for (const absolutePath of [insidePath, outsidePath]) {
			const input = applyPatchEnvelope([`*** Update File: ${absolutePath}`, "@@", "-original", "+modified"]);
			await expect(tool.execute(`absolute-${absolutePath}`, { input })).rejects.toThrow(ABSOLUTE_PATH_ERROR);
		}

		expect(await Bun.file(insidePath).text()).toBe("original\n");
		expect(await Bun.file(outsidePath).text()).toBe("original\n");
	});

	test("rejects Windows drive, UNC, and POSIX absolute path syntax on every file operation", async () => {
		const absolutePaths = [
			"D:/project/21cp-worktrees/repo/file.txt",
			String.raw`\\server\share\repo\file.txt`,
			"/var/tmp/repo/file.txt",
		];
		const tool = new EditTool(createApplyPatchSession(workspace), "apply_patch");

		for (const absolutePath of absolutePaths) {
			const operations = [
				[`*** Add File: ${absolutePath}`, "+created"],
				[`*** Delete File: ${absolutePath}`],
				[`*** Update File: ${absolutePath}`, "@@", "-old", "+new"],
			];
			for (const lines of operations) {
				await expect(
					tool.execute(`absolute-operation-${absolutePath}`, { input: applyPatchEnvelope(lines) }),
				).rejects.toThrow(ABSOLUTE_PATH_ERROR);
			}
		}
	});

	test("preflights an absolute move destination before changing its relative source", async () => {
		const tool = new EditTool(createApplyPatchSession(workspace), "apply_patch");
		const destinations = [path.join(workspace, "inside-moved.txt"), path.join(tempRoot, "outside-moved.txt")];

		for (let index = 0; index < destinations.length; index++) {
			const sourceName = `source-${index}.txt`;
			const sourcePath = path.join(workspace, sourceName);
			const destinationPath = destinations[index];
			await Bun.write(sourcePath, "original\n");
			const input = applyPatchEnvelope([
				`*** Update File: ${sourceName}`,
				`*** Move to: ${destinationPath}`,
				"@@",
				"-original",
				"+modified",
			]);

			await expect(tool.execute(`absolute-move-${index}`, { input })).rejects.toThrow(ABSOLUTE_PATH_ERROR);
			expect(await Bun.file(sourcePath).text()).toBe("original\n");
			expect(await Bun.file(destinationPath).exists()).toBe(false);
		}
	});

	test("rejects the whole patch before a preceding relative entry can write", async () => {
		const relativePath = path.join(workspace, "relative-first.txt");
		await Bun.write(relativePath, "original\n");
		const tool = new EditTool(createApplyPatchSession(workspace), "apply_patch");
		const input = applyPatchEnvelope([
			"*** Update File: relative-first.txt",
			"@@",
			"-original",
			"+modified",
			"*** Add File: D:/project/21cp-worktrees/repo/created.txt",
			"+created",
		]);

		await expect(tool.execute("absolute-preflight", { input })).rejects.toThrow(ABSOLUTE_PATH_ERROR);
		expect(await Bun.file(relativePath).text()).toBe("original\n");
	});

	test("continues to apply workspace-relative paths", async () => {
		const targetPath = path.join(workspace, "relative.txt");
		await Bun.write(targetPath, "original\n");
		const tool = new EditTool(createApplyPatchSession(workspace), "apply_patch");
		const input = applyPatchEnvelope(["*** Update File: relative.txt", "@@", "-original", "+modified"]);

		const result = await tool.execute("relative-success", { input });

		expect(result.isError).toBeUndefined();
		expect(await Bun.file(targetPath).text()).toBe("modified\n");
	});
});
