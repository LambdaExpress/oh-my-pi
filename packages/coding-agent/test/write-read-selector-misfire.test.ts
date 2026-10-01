import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { readArchiveEntries, writeArchive } from "@oh-my-pi/pi-utils/ar";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

// A read-only step that mis-dispatches `read` as `write` passes the full read
// expression (`src/foo.tsx:1-260:raw`) as the target. Because a literal colon
// filename is legal on POSIX (issue #4618), that used to resolve to filesystem
// creation and report success, leaving a stray zero-byte file the model could
// not recover from (issue #6387 — local analogue of the #6123 xd:// guard).

function session(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated({}),
	};
}

const workspaces: string[] = [];
let settingsState: SettingsTestState | undefined;

beforeEach(() => {
	settingsState = beginSettingsTest();
});

afterEach(async () => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	await Promise.all(workspaces.splice(0).map(dir => removeWithRetries(dir)));
});

async function makeWorkspace(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "write-selector-misfire-"));
	workspaces.push(dir);
	await fs.mkdir(path.join(dir, "src/components"), { recursive: true });
	await Bun.write(path.join(dir, "src/components/LoraSelector.tsx"), "export const x = 1;\n");
	return dir;
}

describe("write refuses read-selector misfires", () => {
	it("fails closed on a missing selector-suffixed target with empty content", async () => {
		const dir = await makeWorkspace();
		const write = new WriteTool(session(dir));
		const literal = "src/components/LoraSelector.tsx:1-260:raw";
		await expect(write.execute("c", { path: literal, content: "" })).rejects.toThrow();
		expect(await fs.readdir(path.join(dir, "src/components"))).toEqual(["LoraSelector.tsx"]);
		expect(await Bun.file(path.join(dir, "src/components/LoraSelector.tsx")).text()).toBe("export const x = 1;\n");
	});

	it.skipIf(process.platform === "win32")(
		"lets non-empty content deliberately create a selector-shaped filename",
		async () => {
			const dir = await makeWorkspace();
			const write = new WriteTool(session(dir));
			const literal = "src/components/LoraSelector.tsx:1-260:raw";
			const res = await write.execute("c", { path: literal, content: "hi" });
			expect(res.isError).toBeUndefined();
			expect(await Bun.file(path.join(dir, literal)).text()).toBe("hi");
		},
	);

	it.skipIf(process.platform === "win32")(
		"keeps an existing literal colon filename writable with empty content",
		async () => {
			const dir = await makeWorkspace();
			await Bun.write(path.join(dir, "log:1-5"), "old");
			const write = new WriteTool(session(dir));
			const res = await write.execute("c", { path: "log:1-5", content: "" });
			expect(res.isError).toBeUndefined();
			expect(await Bun.file(path.join(dir, "log:1-5")).text()).toBe("");
		},
	);

	it("still allows ordinary empty-file creation without a read-shaped suffix", async () => {
		const dir = await makeWorkspace();
		const write = new WriteTool(session(dir));
		const res = await write.execute("c", { path: "src/empty.txt", content: "" });
		expect(res.isError).toBeUndefined();
		expect(await Bun.file(path.join(dir, "src/empty.txt")).exists()).toBe(true);
	});

	it("rejects a missing selector-suffixed archive member without mutating the archive", async () => {
		const dir = await makeWorkspace();
		const archivePath = path.join(dir, "bundle.zip");
		const archiveEntries: Array<readonly [string, string]> = [["src/foo.ts", "export const x = 1;\n"]];
		await writeArchive(archivePath, "zip", archiveEntries);
		const before = await Bun.file(archivePath).bytes();
		const write = new WriteTool(session(dir));
		const target = "bundle.zip:src/foo.ts:1-20:raw";
		await expect(write.execute("c", { path: target, content: "" })).rejects.toThrow();
		expect(await Bun.file(archivePath).bytes()).toEqual(before);
		const entries = await readArchiveEntries({ bytes: before, format: "zip" });
		expect(entries.has("src/foo.ts")).toBe(true);
		expect(entries.has("src/foo.ts:1-20:raw")).toBe(false);
	});

	it("keeps an existing literal selector-shaped archive member writable", async () => {
		const dir = await makeWorkspace();
		const archivePath = path.join(dir, "bundle.zip");
		const member = "src/foo.ts:1-20:raw";
		const archiveEntries: Array<readonly [string, string]> = [[member, "old"]];
		await writeArchive(archivePath, "zip", archiveEntries);
		const write = new WriteTool(session(dir));
		const result = await write.execute("c", { path: `bundle.zip:${member}`, content: "" });
		expect(result.isError).toBeUndefined();
		const entries = await readArchiveEntries({ bytes: await Bun.file(archivePath).bytes(), format: "zip" });
		expect(entries.get(member)).toEqual(new Uint8Array());
	});

	it("rejects a semicolon-joined selector list with non-empty content and creates nothing", async () => {
		const dir = await makeWorkspace();
		const write = new WriteTool(session(dir));
		const target = "a.txt:1-2;b/c.txt:3-4";
		await expect(write.execute("c", { path: target, content: "{}" })).rejects.toThrow();
		expect(await fs.readdir(dir)).toEqual(["src"]);
	});

	it("still writes a real path that merely contains a semicolon (no per-segment selectors)", async () => {
		const dir = await makeWorkspace();
		const write = new WriteTool(session(dir));
		const target = "notes;draft.txt";
		const res = await write.execute("c", { path: target, content: "hi" });
		expect(res.isError).toBeUndefined();
		expect(await Bun.file(path.join(dir, target)).text()).toBe("hi");
	});

	it.skipIf(process.platform === "win32")(
		"keeps an existing literal file whose name looks like a selector list writable",
		async () => {
			const dir = await makeWorkspace();
			const write = new WriteTool(session(dir));
			const target = "report:1-2;archive:3-4";
			await Bun.write(path.join(dir, target), "old");
			const res = await write.execute("c", { path: target, content: "new" });
			expect(res.isError).toBeUndefined();
			expect(await Bun.file(path.join(dir, target)).text()).toBe("new");
		},
	);
});
