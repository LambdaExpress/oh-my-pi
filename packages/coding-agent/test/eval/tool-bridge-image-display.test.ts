import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { JsRuntime, type RuntimeHooks } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
import type { JsDisplayOutput } from "@oh-my-pi/pi-coding-agent/eval/js/shared/types";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import { PythonKernel } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import {
	disposePyToolBridge,
	ensurePyToolBridge,
	registerPyToolBridge,
} from "@oh-my-pi/pi-coding-agent/eval/py/tool-bridge";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { $which, TempDir } from "@oh-my-pi/pi-utils";

const PNG_BASE64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");

function collect(callTool: RuntimeHooks["callTool"]): { hooks: RuntimeHooks; displays: JsDisplayOutput[] } {
	const displays: JsDisplayOutput[] = [];
	const hooks: RuntimeHooks = {
		onText: () => {},
		onDisplay: output => displays.push(output),
		callTool,
	};
	return { hooks, displays };
}

describe("bridged tool image display", () => {
	let runtime: JsRuntime;

	beforeAll(() => {
		runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "tool-bridge-image-test" });
	});

	afterAll(() => {
		runtime.dispose();
	});

	it("surfaces bridged image blocks as display outputs and strips the base64 payload", async () => {
		// Under Code Mode `tool.read()` on an image is the only read path; the
		// image must reach the model as a real image content block, not as a
		// base64 blob inside the returned value.
		const { hooks, displays } = collect(async () => ({
			text: "1024x768 png",
			images: [{ mimeType: "image/png", data: PNG_BASE64 }],
		}));
		const value = await runtime.run("await tool.read({ path: 'img.png' })", undefined, hooks);
		expect(displays).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
		expect(value).toEqual({ text: "1024x768 png", images: "(1 image displayed)" });
	});

	it("returns image-free bridge values untouched", async () => {
		const { hooks, displays } = collect(async () => ({ text: "plain", details: { lines: 3 } }));
		const value = await runtime.run("await tool.read({ path: 'file.txt' })", undefined, hooks);
		expect(displays).toEqual([]);
		expect(value).toEqual({ text: "plain", details: { lines: 3 } });
	});
});

function createPatchSession(cwd: string): {
	owner: AgentSession;
	session: ToolSession;
	setPermission: (permission: "allow_once" | "reject_once") => void;
} {
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"edit.mode": "apply_patch",
		"edit.enforceSeenLines": false,
		"edit.fuzzyMatch": false,
	});
	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		enableLsp: false,
		settings,
		getToolByName: name => owner.getToolByName(name),
		getToolForEvalBridge: name => owner.getToolForEvalBridge(name),
		getEvalBridgeToolNames: () => owner.getEvalBridgeToolNames(),
	};
	const edit = new EditTool(session, "apply_patch") as AgentTool;
	const owner = new AgentSession({
		agent: new Agent({ initialState: { tools: [edit], systemPrompt: [] } }),
		sessionManager: SessionManager.inMemory(cwd),
		settings,
		modelRegistry: {} as never,
		toolRegistry: new Map([[edit.name, edit]]),
		builtInToolNames: [edit.name],
		rebuildSystemPrompt: async () => ({ systemPrompt: [] }),
	});
	let permission: "allow_once" | "reject_once" = "allow_once";
	owner.setClientBridge({
		capabilities: { requestPermission: true },
		async requestPermission() {
			return { outcome: "selected", optionId: permission, kind: permission };
		},
	});
	return {
		owner,
		session,
		setPermission: value => {
			permission = value;
		},
	};
}

type PatchInvocation = { ok: true; value: unknown } | { ok: false; error: string };

interface PatchRuntime {
	invoke(args: Record<string, unknown>): Promise<PatchInvocation>;
	dispose(): Promise<void>;
}

async function createPatchRuntime(language: "js" | "py", session: ToolSession): Promise<PatchRuntime> {
	const sessionId = crypto.randomUUID();
	if (language === "js") {
		const runtime = new JsRuntime({ initialCwd: session.cwd, sessionId });
		const { hooks } = collect((name, args) => callSessionTool(name, args, { session }));
		return {
			invoke: args =>
				runtime.run(
					`await (async () => {
						try {
							return { ok: true, value: await tool.apply_patch(${JSON.stringify(args)}) };
						} catch (error) {
							return { ok: false, error: String(error) };
						}
					})()`,
					undefined,
					hooks,
				) as Promise<PatchInvocation>,
			async dispose() {
				runtime.dispose();
			},
		};
	}
	const bridge = await ensurePyToolBridge();
	const interpreter =
		Bun.env.PYTHON ??
		(process.platform === "win32"
			? ($which("python") ?? $which("python3"))
			: ($which("python3") ?? $which("python"))) ??
		"python";
	const kernel = await PythonKernel.start({
		cwd: session.cwd,
		interpreter,
		env: {
			PI_TOOL_BRIDGE_URL: bridge.url,
			PI_TOOL_BRIDGE_TOKEN: bridge.token,
			PI_TOOL_BRIDGE_SESSION: sessionId,
		},
	});
	return {
		async invoke(args) {
			const runId = crypto.randomUUID();
			const unregister = registerPyToolBridge(sessionId, runId, { toolSession: session });
			let output = "";
			try {
				const result = await kernel.execute(
					[
						"import json",
						"try:",
						`    value = await tool.apply_patch(json.loads(${JSON.stringify(JSON.stringify(args))}))`,
						"except Exception as error:",
						"    result = {'ok': False, 'error': str(error)}",
						"else:",
						"    result = {'ok': True, 'value': value}",
						"print(json.dumps(result))",
					].join("\n"),
					{
						id: runId,
						timeoutMs: 10_000,
						onChunk: chunk => {
							output += chunk;
						},
					},
				);
				if (result.cancelled || result.timedOut || result.kernelKilled) {
					throw new Error("Python 补丁场景被取消或内核终止");
				}
				if (result.status === "error") {
					throw new Error(result.error?.value ?? output);
				}
				return JSON.parse(output) as PatchInvocation;
			} finally {
				unregister();
			}
		},
		async dispose() {
			await kernel.shutdown();
		},
	};
}

describe("Eval apply_patch 真实文件分派", () => {
	afterAll(async () => {
		await disposePyToolBridge();
	});

	// Match the real-kernel integration budget; cell deadlines stay 10s.
	for (const language of ["js", "py"] as const) {
		it(`${language} 按公开名称执行补丁并保留校验、错误和启用状态约束`, async () => {
			using dir = TempDir.createSync("@omp-eval-patch-");
			const target = dir.join("衣服 » 文件.txt");
			await Bun.write(target, "alpha\nbeta\n");
			const fixture = createPatchSession(dir.absolute());
			let runtime: PatchRuntime | undefined;
			try {
				runtime = await createPatchRuntime(language, fixture.session);
				const patch = [
					"*** Begin Patch",
					"*** Update File: 衣服 » 文件.txt",
					"@@",
					"-alpha",
					"+changed",
					" beta",
					"*** End Patch",
					"",
				].join("\n");
				expect(await runtime.invoke({ patch })).toMatchObject({ ok: true });
				expect(await Bun.file(target).text()).toBe("changed\nbeta\n");

				expect(await runtime.invoke({})).toMatchObject({ ok: false });
				const mismatch = patch.replace("-alpha", "-missing-content-that-is-not-in-this-file");
				expect(await runtime.invoke({ input: mismatch })).toMatchObject({ ok: true, value: { hasError: true } });
				expect(await Bun.file(target).text()).toBe("changed\nbeta\n");

				await fixture.owner.setActiveToolsByName([]);
				expect(await runtime.invoke({ patch })).toMatchObject({ ok: false });
				expect(await Bun.file(target).text()).toBe("changed\nbeta\n");
			} finally {
				await runtime?.dispose();
				await fixture.owner.dispose();
			}
		}, 30_000);

		it(`${language} 的补丁删除遵守正常 ACP 拒绝与批准流程`, async () => {
			using dir = TempDir.createSync("@omp-eval-patch-permission-");
			const target = dir.join("protected.txt");
			await Bun.write(target, "protected\n");
			const fixture = createPatchSession(dir.absolute());
			let runtime: PatchRuntime | undefined;
			try {
				runtime = await createPatchRuntime(language, fixture.session);
				const patch = "*** Begin Patch\n*** Delete File: protected.txt\n*** End Patch\n";
				fixture.setPermission("reject_once");
				expect(await runtime.invoke({ patch })).toMatchObject({ ok: false });
				expect(await Bun.file(target).text()).toBe("protected\n");

				fixture.setPermission("allow_once");
				expect(await runtime.invoke({ patch })).toMatchObject({ ok: true });
				expect(await Bun.file(target).exists()).toBe(false);
			} finally {
				await runtime?.dispose();
				await fixture.owner.dispose();
			}
		}, 30_000);
	}
});
