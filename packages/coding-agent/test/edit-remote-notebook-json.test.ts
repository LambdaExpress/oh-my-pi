import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import {
	InternalUrlRouter,
	type InternalResource,
	type InternalUrl,
	type ProtocolHandler,
	type SchemeSpec,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const REMOTE = "ssh://notebook-test/root/启动器.ipynb";
const REMOTE_KEY = encodeURI(REMOTE);
const ORIGINAL_COMMAND = "!bash /root/tzwm-scripts/ComfyUI/autodl/scripts/start.sh";
const NEXT_COMMAND = "!bash /root/autodl-tmp/ComfyUI/start_moss.sh";
const NOTEBOOK = [
	"{",
	' "metadata": {"unchanged": "\\u03bb", "large": 9007199254740993},',
	' "cells": [{"cell_type":"code","metadata":{"trusted":true},"execution_count":7,"outputs":[],',
	'   "source": [',
	'    "# 启动\\n",',
	`    "${ORIGINAL_COMMAND}"`,
	"   ]",
	" }],",
	' "nbformat": 4, "nbformat_minor": 5',
	"}",
	"",
].join("\r\n");

class NotebookRemote implements ProtocolHandler {
	readonly scheme = "ssh";
	readonly spec: SchemeSpec;
	readonly files = new Map([[REMOTE_KEY, NOTEBOOK]]);
	readonly writes: string[] = [];

	constructor(immutable = false, writable = true) {
		this.spec = {
			backing: "remote",
			selectors: "lines",
			portAuthority: true,
			immutable,
			readTier: "exec",
			...(writable
				? { write: { via: "handler", payload: "text", scope: "workspace", tier: () => "exec" } as const }
				: {}),
		};
		if (!writable) this.write = undefined;
	}

	canonicalKey(url: InternalUrl): string {
		return url.href;
	}

	async stat(url: InternalUrl): Promise<"file" | "missing"> {
		return this.files.has(url.href) ? "file" : "missing";
	}

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const content = this.files.get(url.href);
		if (content === undefined) throw new Error(`File not found: ${url.href}`);
		return { url: url.href, content, contentType: "application/json" };
	}

	write: ProtocolHandler["write"] = async (url, content) => {
		this.writes.push(content);
		this.files.set(url.href, content);
	};
}

let cwd: string;
let settingsState: SettingsTestState;

function session(): ToolSession {
	const getArtifactsDir = () => path.join(cwd, "artifacts");
	const getSessionId = () => "notebook-json-regression";
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir,
		getSessionId,
		localProtocolOptions: { getArtifactsDir, getSessionId },
		settings: Settings.isolated({ "edit.enforceSeenLines": false }),
	} as ToolSession;
}

function patch() {
	return {
		input: `*** Begin Patch\n*** Update File: ${REMOTE}\n@@\n    "source": [\n     "# 启动\\n",\n-    "${ORIGINAL_COMMAND}"\n+    "${NEXT_COMMAND}"\n    ]\n*** End Patch`,
	};
}

beforeEach(async () => {
	settingsState = beginSettingsTest();
	InternalUrlRouter.resetForTests();
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-notebook-json-"));
	await Settings.init({ inMemory: true, cwd });
});

afterEach(async () => {
	InternalUrlRouter.resetForTests();
	restoreSettingsTestState(settingsState);
	await removeWithRetries(cwd);
});

describe("remote notebook JSON edits", () => {
	it("patches the reported source-array line without reserializing any other JSON bytes", async () => {
		const remote = new NotebookRemote();
		InternalUrlRouter.instance().register(remote);
		const tool = new EditTool(session(), "apply_patch");
		expect(tool.approval(patch())).toBe("exec");

		const result = await tool.execute("notebook-json", patch());

		expect(result.isError).not.toBe(true);
		const expected = NOTEBOOK.replace(ORIGINAL_COMMAND, NEXT_COMMAND);
		expect(remote.writes).toEqual([expected]);
		expect(Buffer.from(remote.files.get(REMOTE_KEY)!)).toEqual(Buffer.from(expected));
	});

	it("retains the local notebook cell editing representation and metadata", async () => {
		const local = path.join(cwd, "local.ipynb");
		await Bun.write(local, NOTEBOOK);

		const result = await new EditTool(session(), "replace").execute("local-cell", {
			path: local,
			old_string: ORIGINAL_COMMAND,
			new_string: NEXT_COMMAND,
		});

		expect(result.isError).not.toBe(true);
		const updated = JSON.parse(await Bun.file(local).text());
		expect(updated.cells[0].source).toEqual(["# 启动\n", NEXT_COMMAND]);
		expect(updated.cells[0].metadata).toEqual({ trusted: true });
		expect(updated.cells[0].execution_count).toBe(7);
		expect(updated.cells[0].outputs).toEqual([]);
	});

	for (const [name, immutable, writable] of [
		["immutable", true, true],
		["read-only", false, false],
	] as const) {
		it(`refuses ${name} remote notebook resources before writing`, async () => {
			const remote = new NotebookRemote(immutable, writable);
			InternalUrlRouter.instance().register(remote);

			await expect(new EditTool(session(), "apply_patch").execute(`reject-${name}`, patch())).rejects.toThrow(
				/read-only/,
			);

			expect(remote.writes).toEqual([]);
			expect(remote.files.get(REMOTE_KEY)).toBe(NOTEBOOK);
		});
	}
});
