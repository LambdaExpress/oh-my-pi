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

	test("falls back from hashline to sloppy for Kimi models", () => {
		delete Bun.env.PI_EDIT_VARIANT;

		expect(resolveEditMode(createSession({ activeModel: "openrouter/moonshotai/Kimi-K2-Instruct" }))).toBe("sloppy");
	});

	test("falls back from hashline to sloppy for MiMo models", () => {
		delete Bun.env.PI_EDIT_VARIANT;

		expect(resolveEditMode(createSession({ activeModel: "xiaomi/MiMo-V2.5-Pro" }))).toBe("sloppy");
	});

	test("falls back from hashline to sloppy for DeepSeek V4 Flash models", () => {
		delete Bun.env.PI_EDIT_VARIANT;

		expect(resolveEditMode(createSession({ activeModel: "tensormesh/deepseek-ai/DeepSeek-V4-Flash" }))).toBe(
			"sloppy",
		);
	});

	test("falls back from hashline to sloppy for Step 3.7 Flash models", () => {
		delete Bun.env.PI_EDIT_VARIANT;

		expect(resolveEditMode(createSession({ activeModel: "kilo/stepfun/step-3.7-flash:free" }))).toBe("sloppy");
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

	test("applies absolute update paths both inside and outside the workspace", async () => {
		const insidePath = path.join(workspace, "inside.txt");
		const outsidePath = path.join(tempRoot, "outside.txt");
		await Bun.write(insidePath, "original\n");
		await Bun.write(outsidePath, "original\n");
		const tool = new EditTool(createApplyPatchSession(workspace), "apply_patch");

		for (const absolutePath of [insidePath, outsidePath]) {
			const input = applyPatchEnvelope([`*** Update File: ${absolutePath}`, "@@", "-original", "+modified"]);
			const result = await tool.execute(`absolute-${absolutePath}`, { input });
			expect(result.isError).toBeUndefined();
		}

		expect(await Bun.file(insidePath).text()).toBe("modified\n");
		expect(await Bun.file(outsidePath).text()).toBe("modified\n");
	});

	test("applies absolute sibling-worktree updates outside the workspace", async () => {
		// User-reported flow: apply_patch editing sibling-worktree paths while
		// the session cwd is a different project root (D:/project/21cp-worktrees/…).
		const outsideRoot = path.join(tempRoot, "sibling-worktree");
		const targetPath = path.join(outsideRoot, "src", "File.cs");
		await fs.mkdir(path.dirname(targetPath), { recursive: true });
		await Bun.write(targetPath, "old\n");
		const tool = new EditTool(createApplyPatchSession(workspace), "apply_patch");
		const input = applyPatchEnvelope([`*** Update File: ${targetPath}`, "@@", "-old", "+new"]);

		const result = await tool.execute("absolute-sibling-update", { input });

		expect(result.isError).toBeUndefined();
		expect(await Bun.file(targetPath).text()).toBe("new\n");
	});

	test("applies absolute paths to create, update, and delete operations", async () => {
		const createdPath = path.join(tempRoot, "created.txt");
		const updatedPath = path.join(tempRoot, "updated.txt");
		const deletedPath = path.join(tempRoot, "deleted.txt");
		await Bun.write(updatedPath, "old\n");
		await Bun.write(deletedPath, "delete-me\n");
		const tool = new EditTool(createApplyPatchSession(workspace), "apply_patch");

		const createResult = await tool.execute("absolute-create", {
			input: applyPatchEnvelope([`*** Add File: ${createdPath}`, "+created"]),
		});
		expect(createResult.isError).toBeUndefined();
		expect(await Bun.file(createdPath).text()).toBe("created\n");

		const updateResult = await tool.execute("absolute-update", {
			input: applyPatchEnvelope([`*** Update File: ${updatedPath}`, "@@", "-old", "+new"]),
		});
		expect(updateResult.isError).toBeUndefined();
		expect(await Bun.file(updatedPath).text()).toBe("new\n");

		const deleteResult = await tool.execute("absolute-delete", {
			input: applyPatchEnvelope([`*** Delete File: ${deletedPath}`]),
		});
		expect(deleteResult.isError).toBeUndefined();
		expect(await Bun.file(deletedPath).exists()).toBe(false);
	});

	test("moves a relative source to an absolute destination", async () => {
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

			const result = await tool.execute(`absolute-move-${index}`, { input });
			expect(result.isError).toBeUndefined();
			expect(await Bun.file(sourcePath).exists()).toBe(false);
			expect(await Bun.file(destinationPath).text()).toBe("modified\n");
		}
	});

	test("applies a mixed relative-and-absolute patch in one call", async () => {
		const relativePath = path.join(workspace, "relative-first.txt");
		const absoluteCreatedPath = path.join(tempRoot, "created-after.txt");
		await Bun.write(relativePath, "original\n");
		const tool = new EditTool(createApplyPatchSession(workspace), "apply_patch");
		const input = applyPatchEnvelope([
			"*** Update File: relative-first.txt",
			"@@",
			"-original",
			"+modified",
			`*** Add File: ${absoluteCreatedPath}`,
			"+created",
		]);

		const result = await tool.execute("absolute-preflight", { input });
		expect(result.isError).toBeUndefined();
		expect(await Bun.file(relativePath).text()).toBe("modified\n");
		expect(await Bun.file(absoluteCreatedPath).text()).toBe("created\n");
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
