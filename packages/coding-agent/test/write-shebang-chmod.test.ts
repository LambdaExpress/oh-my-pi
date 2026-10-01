import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		enableLsp: false,
	};
}

function details(result: { details?: { madeExecutable?: boolean } }): { madeExecutable?: boolean } {
	return result.details ?? {};
}

describe("write tool shebang chmod", () => {
	let tmpDir: string;
	let settingsState: SettingsTestState | undefined;

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-shebang-test-"));
	});

	afterEach(async () => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await removeWithRetries(tmpDir);
	});

	it.skipIf(process.platform === "win32")(
		"marks files starting with #! as executable and flags the result",
		async () => {
			const filePath = path.join(tmpDir, "run.sh");
			const tool = new WriteTool(createSession(tmpDir));

			const result = await tool.execute("call-1", {
				path: filePath,
				content: "#!/bin/sh\necho hi\n",
			});

			const stat = await fs.stat(filePath);
			// All three execute bits flipped on (chmod a+x semantics).
			expect(stat.mode & 0o111).toBe(0o111);
			expect(details(result).madeExecutable).toBe(true);
		},
	);

	it("does not chmod files without a shebang", async () => {
		const filePath = path.join(tmpDir, "data.txt");
		const tool = new WriteTool(createSession(tmpDir));

		const result = await tool.execute("call-2", {
			path: filePath,
			content: "no shebang here\n",
		});

		const stat = await fs.stat(filePath);
		expect(stat.mode & 0o111).toBe(0);
		expect(details(result).madeExecutable).toBeUndefined();
	});

	it.skipIf(process.platform === "win32")("does not re-flag when file is already executable", async () => {
		const filePath = path.join(tmpDir, "preexec.sh");
		await fs.writeFile(filePath, "#!/bin/sh\nold\n");
		await fs.chmod(filePath, 0o755);

		const tool = new WriteTool(createSession(tmpDir));
		const result = await tool.execute("call-3", {
			path: filePath,
			content: "#!/usr/bin/env python3\nprint('hi')\n",
		});

		const stat = await fs.stat(filePath);
		expect(stat.mode & 0o111).toBe(0o111);
		// Mode didn't change, so no flag.
		expect(details(result).madeExecutable).toBeUndefined();
	});

	it.skipIf(process.platform !== "win32")(
		"writes shebang content when the filesystem has no POSIX execute bits",
		async () => {
			const filePath = path.join(tmpDir, "run.sh");
			const content = "#!/bin/sh\necho hi\n";
			const result = await new WriteTool(createSession(tmpDir)).execute("call-windows", {
				path: filePath,
				content,
			});

			expect(result.isError).toBeUndefined();
			expect(await fs.readFile(filePath, "utf8")).toBe(content);
		},
	);
});
