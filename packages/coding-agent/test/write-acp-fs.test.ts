import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const FILE_CONTENT = "bridge write content\n";

interface SessionOptions {
	bridge?: ClientBridge;
	planMode?: PlanModeState;
}

function createSession(cwd: string, options: SessionOptions = {}): ToolSession {
	const getArtifactsDir = () => path.join(cwd, "artifacts");
	const getSessionId = () => "session-a";
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir,
		getSessionId,
		localProtocolOptions: { getArtifactsDir, getSessionId },
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		getClientBridge: options.bridge ? () => options.bridge : undefined,
		getPlanModeState: options.planMode ? () => options.planMode : undefined,
	};
}

function resultText(result: AgentToolResult): string {
	const text: string[] = [];
	for (const block of result.content) {
		if (block.type === "text") text.push(block.text);
	}
	return text.join("\n");
}

describe("write tool ACP fs routing", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-acp-fs-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("routes plain text writes through the bridge and does not call Bun.write", async () => {
		const filePath = path.join(tmpDir, "output.txt");

		const bridge: ClientBridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async () => undefined,
		};

		const bridgeSpy = spyOn(bridge, "writeTextFile");
		const bunWriteSpy = spyOn(Bun, "write");

		try {
			const session = createSession(tmpDir, { bridge });
			const tool = new WriteTool(session);

			await tool.execute("call-1", { path: filePath, content: FILE_CONTENT });

			// Bridge was called with the exact path and content
			expect(bridgeSpy).toHaveBeenCalledTimes(1);
			expect(bridgeSpy).toHaveBeenCalledWith({ path: filePath, content: FILE_CONTENT });
			// Disk write must not have been called — bridge is the destination
			expect(bunWriteSpy).not.toHaveBeenCalled();
		} finally {
			bunWriteSpy.mockRestore();
		}
	});

	it("emits a progress snapshot before filesystem writes complete", async () => {
		const filePath = path.join(tmpDir, "progress.txt");
		const session = createSession(tmpDir);
		const tool = new WriteTool(session);
		const updates: AgentToolResult[] = [];

		const result = await tool.execute(
			"call-progress",
			{ path: filePath, content: FILE_CONTENT },
			undefined,
			update => {
				updates.push(update);
			},
		);

		expect(updates).toHaveLength(1);
		expect(updates[0]?.content).toEqual([
			{ type: "text", text: `Writing ${FILE_CONTENT.length} bytes to progress.txt...` },
		]);
		expect(updates[0]?.details).toEqual({ resolvedPath: filePath });
		expect(resultText(result)).toContain(`Successfully wrote ${FILE_CONTENT.length} bytes to progress.txt`);
	});

	it("writes local plan artifacts to disk instead of the ACP bridge", async () => {
		const planPath = "local://PLAN.md";
		const planContent = "# Plan\n\nhello world\n";
		const bridge: ClientBridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async () => {
				throw new Error("Internal error");
			},
		};
		const bridgeSpy = spyOn(bridge, "writeTextFile");
		const session = createSession(tmpDir, {
			bridge,
			planMode: { enabled: true, planFilePath: planPath, workflow: "parallel", reentry: false },
		});

		await new WriteTool(session).execute("call-plan", { path: planPath, content: planContent });

		expect(bridgeSpy).not.toHaveBeenCalled();
		expect(
			await Bun.file(
				resolveLocalUrlToPath(planPath, {
					getArtifactsDir: session.getArtifactsDir,
					getSessionId: session.getSessionId,
				}),
			).text(),
		).toBe(planContent);
	});

	it("writes long Chinese Markdown local plans without truncating content", async () => {
		const planPath = "local://LONG_PLAN.md";
		const sentinel = "结尾哨兵：WRITE_LONG_CHINESE_PLAN_SENTINEL_完";
		const sections = Array.from(
			{ length: 80 },
			(_, i) =>
				`## 阶段 ${i + 1}\n\n- 目标：保持完整的中文 Markdown 内容，不允许预览或桥接逻辑截断。\n- 验收：第 ${i + 1} 段在本地文件中逐字保留。`,
		);
		const planContent = [
			"# 长中文执行计划",
			"",
			"这份计划故意超过预览窗口，验证写入路径保存完整内容。",
			"",
			...sections,
			"## 最终核对",
			"",
			`- ${sentinel}`,
			"",
		].join("\n");
		const bridge: ClientBridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async () => {
				throw new Error("local plans must not use the ACP bridge");
			},
		};
		const bridgeSpy = spyOn(bridge, "writeTextFile");
		const session = createSession(tmpDir, {
			bridge,
			planMode: { enabled: true, planFilePath: planPath, workflow: "parallel", reentry: false },
		});

		await new WriteTool(session).execute("call-long-plan", { path: planPath, content: planContent });

		expect(bridgeSpy).not.toHaveBeenCalled();
		const resolvedPath = resolveLocalUrlToPath(planPath, {
			getArtifactsDir: session.getArtifactsDir,
			getSessionId: session.getSessionId,
		});
		const written = await Bun.file(resolvedPath).text();
		expect(written).toBe(planContent);
		expect(written.endsWith(`- ${sentinel}\n`)).toBe(true);
	});

	it("treats bracketed `[local://...#TAG]` headers as local artifacts, not bridge writes", async () => {
		const planPath = "local://PLAN.md";
		const scratchPath = "local://scratch.md";
		// Active plan file is unrelated to the scratch artifact we are writing.
		const bracketedScratch = `[${scratchPath}#ABCD]`;
		const scratchContent = "scratch notes\n";
		const bridge: ClientBridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async () => undefined,
		};
		const bridgeSpy = spyOn(bridge, "writeTextFile");
		const session = createSession(tmpDir, {
			bridge,
			planMode: { enabled: true, planFilePath: planPath, workflow: "parallel", reentry: false },
		});

		await new WriteTool(session).execute("call-bracketed", { path: bracketedScratch, content: scratchContent });

		// Bracketed local headers must not slip past the bridge router — they are
		// still session-local artifacts and stay on disk under the local sandbox.
		expect(bridgeSpy).not.toHaveBeenCalled();
		expect(
			await Bun.file(
				resolveLocalUrlToPath(scratchPath, {
					getArtifactsDir: session.getArtifactsDir,
					getSessionId: session.getSessionId,
				}),
			).text(),
		).toBe(scratchContent);
	});

	it("appends later local artifact chunks without truncating earlier content", async () => {
		const artifactPath = "local://generated/chunked-output.txt";
		const chunks = ["alpha\n", "beta\n", "gamma\n"];
		const session = createSession(tmpDir);
		const tool = new WriteTool(session);
		const resolvedPath = resolveLocalUrlToPath(artifactPath, {
			getArtifactsDir: session.getArtifactsDir,
			getSessionId: session.getSessionId,
		});

		await tool.execute("call-chunk-1", { path: artifactPath, content: chunks[0]! });
		await tool.execute("call-chunk-2", { path: artifactPath, content: chunks[1]!, mode: "append" });
		await tool.execute("call-chunk-3", { path: artifactPath, content: chunks[2]!, mode: "append" });

		expect(await Bun.file(resolvedPath).text()).toBe(chunks.join(""));
	});

	it("rejects append mode for a missing local artifact", async () => {
		const artifactPath = "local://missing/chunked-output.txt";
		const session = createSession(tmpDir);
		const tool = new WriteTool(session);
		const resolvedPath = resolveLocalUrlToPath(artifactPath, {
			getArtifactsDir: session.getArtifactsDir,
			getSessionId: session.getSessionId,
		});

		await expect(
			tool.execute("call-missing-append", { path: artifactPath, content: "orphan chunk\n", mode: "append" }),
		).rejects.toThrow(/Cannot append to missing file .*local:\/\/missing\/chunked-output\.txt.*write without mode/i);
		await expect(Bun.file(resolvedPath).exists()).resolves.toBe(false);
	});
});
