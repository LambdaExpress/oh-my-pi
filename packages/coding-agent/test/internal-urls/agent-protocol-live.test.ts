/**
 * `read agent://<id>` for agents that have not published `<id>.md` yet. The
 * id resolves through the same registry `write agent://<id>` messages, so a
 * running agent answers with its status and progress instead of `Not found`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { resetRegisteredArtifactDirsForTests } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { TempDir } from "@oh-my-pi/pi-utils";

let tempDir: TempDir;
let rootSessionFile: string;
let artifactsDir: string;

function liveSession(messages: unknown[]): AgentSession {
	return { messages, sessionManager: { getArtifactsDir: () => artifactsDir } } as unknown as AgentSession;
}

function assistantText(text: string): unknown {
	return { role: "assistant", content: [{ type: "text", text }], timestamp: 1 };
}

function yieldResult(type: string | string[] | undefined, data: unknown): unknown {
	return {
		role: "toolResult",
		toolCallId: `yield-${JSON.stringify(type)}`,
		toolName: "yield",
		content: [{ type: "text", text: "Result submitted." }],
		details: { data, status: "success", type },
		isError: false,
		timestamp: 2,
	};
}

function registerSub(id: string, parentId: string, session: AgentSession, status: "running" | "idle" = "running") {
	AgentRegistry.global().register({
		id,
		displayName: id,
		kind: "sub",
		parentId,
		session,
		sessionFile: path.join(artifactsDir, `${id}.jsonl`),
		status,
	});
}

async function readText(url: string): Promise<string> {
	const session: ToolSession = {
		cwd: tempDir.path(),
		hasUI: false,
		getSessionFile: () => rootSessionFile,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => artifactsDir,
		allocateOutputArtifact: async toolType => ({
			id: "agent-read",
			path: path.join(artifactsDir, `agent-read.${toolType}.log`),
		}),
		settings: Settings.isolated(),
	};
	const result = await new ReadTool(session).execute("agent-read", { path: url });
	const output = result.content.find(part => part.type === "text");
	if (output?.type !== "text") throw new Error("Expected text output");
	return output.text;
}

describe("agent:// for agents without a published output", () => {
	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
		resetRegisteredArtifactDirsForTests();
		tempDir = TempDir.createSync("@omp-agent-live-");
		rootSessionFile = path.join(tempDir.path(), "session.jsonl");
		artifactsDir = rootSessionFile.slice(0, -6);
		await fs.mkdir(artifactsDir, { recursive: true });
		AgentRegistry.global().register({
			id: "Main",
			displayName: "main",
			kind: "main",
			session: liveSession([]),
			sessionFile: rootSessionFile,
		});
	});

	afterEach(() => {
		InternalUrlRouter.resetForTests();
		AgentRegistry.resetGlobalForTests();
		resetRegisteredArtifactDirsForTests();
		tempDir.removeSync();
	});

	it("reads a running agent with no output artifact as its status and latest text", async () => {
		registerSub("Builder", "Main", liveSession([assistantText("compiling the folder sources")]));

		const text = await readText("agent://Builder");

		expect(text).toContain("Builder (running)");
		expect(text).toContain("compiling the folder sources");
	});

	it("reads a live dotted child id with no output artifact", async () => {
		registerSub("Builder", "Main", liveSession([]));
		registerSub("Builder.Child", "Builder", liveSession([assistantText("child is scanning")]));

		const resource = await InternalUrlRouter.instance().resolve("agent://Builder.Child", {
			sessionFile: rootSessionFile,
		});

		expect(resource.content).toContain("Builder.Child (running)");
		expect(resource.content).toContain("child is scanning");
	});

	it("shows every accepted non-terminal yield section of a running agent", async () => {
		registerSub(
			"CodeBuildFolderSources",
			"Main",
			liveSession([
				yieldResult(["code-ready"], { files: ["src/a.ts", "src/b.ts"] }),
				yieldResult(["findings"], { title: "missing export" }),
			]),
		);

		const text = await readText("agent://CodeBuildFolderSources");

		expect(text).toContain("code-ready");
		expect(text).toContain('"src/b.ts"');
		expect(text).toContain("findings");
		expect(text).toContain('"missing export"');
	});

	it("reads a parked agent's progress from its retained session file", async () => {
		const timestamp = new Date().toISOString();
		const entry = (id: string, parentId: string | null, message: unknown) =>
			JSON.stringify({ type: "message", id, parentId, timestamp, message });
		const transcript = path.join(artifactsDir, "Parked.jsonl");
		await Bun.write(
			transcript,
			[
				JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "parked", timestamp, cwd: "/tmp" }),
				entry("m1", null, { role: "user", content: "go", timestamp: 1 }),
				entry("m2", "m1", yieldResult(["code-ready"], { files: ["src/parked.ts"] })),
				entry("m3", "m2", { ...(assistantText("parked mid-run") as object), stopReason: "stop" }),
			].join("\n"),
		);
		AgentRegistry.global().register({
			id: "Parked",
			displayName: "Parked",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: transcript,
			status: "parked",
		});

		const text = await readText("agent://Parked");

		expect(text).toContain("Parked (parked)");
		expect(text).toContain('"src/parked.ts"');
		expect(text).toContain("parked mid-run");
	});

	it("serves the published output over progress once <id>.md exists", async () => {
		registerSub("Builder", "Main", liveSession([assistantText("still talking")]), "idle");
		await Bun.write(path.join(artifactsDir, "Builder.md"), "final report");

		const resource = await InternalUrlRouter.instance().resolve("agent://Builder", { sessionFile: rootSessionFile });

		expect(resource.content).toBe("final report");
	});

	it("reads a plain Markdown report field with the same line coordinates as the bare output", async () => {
		const lines = Array.from({ length: 220 }, (_, index) =>
			index === 0 ? "## Summary" : `Finding ${index + 1}: inspect source-${index + 1}.ts`,
		);
		await Bun.write(path.join(artifactsDir, "EquipmentQueryTrace.md"), lines.join("\n"));

		const report = await readText("agent://EquipmentQueryTrace/report:raw:190-196");
		const bare = await readText("agent://EquipmentQueryTrace:raw:190-196");

		expect(report).toBe(lines.slice(189, 196).join("\n"));
		expect(bare).toBe(report);
		await expect(readText("agent://EquipmentQueryTrace/report/missing")).rejects.toThrow(/not valid JSON/);
		await expect(readText("agent://EquipmentQueryTrace/summary")).rejects.toThrow(/not valid JSON/);
	});

	it("keeps structured report fields and nested array selectors separate from the Markdown alias", async () => {
		await Bun.write(
			path.join(artifactsDir, "Structured.md"),
			JSON.stringify({
				report: "first line\nsecond line\nthird line",
				sections: [{ report: "nested first\nnested second\nnested third" }],
				metadata: { count: 3 },
			}),
		);

		expect(await readText("agent://Structured/report:raw:2-3")).toBe("second line\nthird line");
		expect(await readText("agent://Structured/sections/0/report:raw:2-3")).toBe("nested second\nnested third");
		expect(JSON.parse(await readText("agent://Structured/metadata"))).toEqual({ count: 3 });
		expect(await readText("agent://Structured/sections/2/report")).toBe("null");
	});

	it("prefers a structured sidecar report and only falls back after a missing or invalid sidecar", async () => {
		const markdown = "## Report\nMarkdown body";
		const sidecar = path.join(artifactsDir, "Sidecar.json");
		await Bun.write(path.join(artifactsDir, "Sidecar.md"), markdown);
		await Bun.write(sidecar, JSON.stringify({ report: "sidecar report", results: [{ count: 4 }] }));

		expect(await readText("agent://Sidecar/report")).toBe("sidecar report");
		expect(await readText("agent://Sidecar/results/0/count")).toBe("4");

		await Bun.write(sidecar, "{unfinished");
		expect(await readText("agent://Sidecar/report")).toBe(markdown);
		await fs.rm(sidecar);
		expect(await readText("agent://Sidecar/report")).toBe(markdown);

		await fs.mkdir(sidecar);
		await expect(readText("agent://Sidecar/report")).rejects.toMatchObject({ code: "EISDIR" });
	});

	it("routes an empty orphaned output to an explicit unavailable error instead of an empty file read", async () => {
		await Bun.write(path.join(artifactsDir, "BatchScheduling.md"), "");
		const target = await InternalUrlRouter.instance().target("agent://BatchScheduling", {
			sessionFile: rootSessionFile,
		});

		expect(target?.kind).toBe("resource");
		await expect(readText("agent://BatchScheduling")).rejects.toThrow(/BatchScheduling.*unavailable.*empty/i);
		await expect(readText("agent://BatchScheduling/report")).rejects.toThrow(/BatchScheduling.*unavailable.*empty/i);
	});

	it("shows current progress rather than an empty artifact for a live running agent", async () => {
		const session = liveSession([assistantText("continuing the local analysis")]);
		Object.defineProperty(session, "isStreaming", { value: true });
		registerSub("BatchScheduling", "Main", session);
		await Bun.write(path.join(artifactsDir, "BatchScheduling.md"), "");

		const text = await readText("agent://BatchScheduling");

		expect(text).toContain("BatchScheduling (running)");
		expect(text).toContain("continuing the local analysis");
		expect(text).not.toContain("PREVIOUS run");
	});

	it("reports an unavailable stale registration without claiming its recorded running state is live", async () => {
		AgentRegistry.global().register({
			id: "BatchScheduling",
			displayName: "BatchScheduling",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: path.join(artifactsDir, "missing-session.jsonl"),
			status: "running",
		});

		await expect(readText("agent://BatchScheduling")).rejects.toThrow(
			/BatchScheduling.*unavailable.*last recorded status: running/i,
		);
	});

	it("rejects a missing agent through the read consumer instead of returning an empty success", async () => {
		await expect(readText("agent://MissingAgent")).rejects.toThrow(/Not found: MissingAgent/);
		AgentRegistry.resetGlobalForTests();
		await expect(InternalUrlRouter.instance().resolve("agent://MissingAgent")).rejects.toThrow(/unavailable/i);
	});

	it("rejects JSON-path extraction until the agent publishes its output", async () => {
		registerSub("Builder", "Main", liveSession([yieldResult(["code-ready"], { files: [] })]));

		await expect(
			InternalUrlRouter.instance().resolve("agent://Builder/files", { sessionFile: rootSessionFile }),
		).rejects.toThrow(/not published yet/);
	});

	it("suggests only near ids for an unknown id instead of every output", async () => {
		for (let i = 0; i < 200; i++) await Bun.write(path.join(artifactsDir, `Unrelated${i}.md`), "x");
		registerSub("CodeBuildFolderSources", "Main", liveSession([]));

		const error = await InternalUrlRouter.instance()
			.resolve("agent://CodeBuildFolderSrcs", { sessionFile: rootSessionFile })
			.then(
				() => undefined,
				(err: unknown) => err as Error,
			);

		expect(error?.message.split("\n")[0]).toBe("Not found: CodeBuildFolderSrcs");
		expect(error?.message).toContain("CodeBuildFolderSources");
		expect(error?.message).not.toContain("Unrelated");
	});
});
