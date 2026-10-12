import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { agentLoop, type AgentMessage, type AgentTool, type AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { jsBackend, pythonBackend } from "@oh-my-pi/pi-coding-agent/eval";
import type { ExecutorBackendResult } from "@oh-my-pi/pi-coding-agent/eval/backend";
import {
	cfgEvalAutoBackgroundEnabled,
	cfgEvalAutoBackgroundThresholdMs,
} from "@oh-my-pi/pi-coding-agent/eval/settings";
import { disposeVmContextsByOwner } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import {
	disposePyToolBridge,
	ensurePyToolBridge,
	registerPyToolBridge,
} from "@oh-my-pi/pi-coding-agent/eval/py/tool-bridge";
import * as connectionManager from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import * as sshExecutor from "@oh-my-pi/pi-coding-agent/ssh/ssh-executor";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { SshTool } from "@oh-my-pi/pi-coding-agent/tools/ssh";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { resolveXdevTool, type XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import type { EvalToolDetails } from "@oh-my-pi/pi-tui/tools/eval";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { TempDir } from "@oh-my-pi/pi-utils";

const cellReleases: Array<() => void> = [];
const executions: Promise<unknown>[] = [];
const kernelOwners = new Set<string>();
const jobManagers: AsyncJobManager[] = [];
const controllers: AbortController[] = [];
let usesPythonBridge = false;
let originalPiPy: string | undefined;
let originalPiJs: string | undefined;

beforeEach(() => {
	originalPiPy = Bun.env.PI_PY;
	originalPiJs = Bun.env.PI_JS;
	delete Bun.env.PI_PY;
	delete Bun.env.PI_JS;
});

afterEach(async () => {
	for (const release of cellReleases.splice(0)) release();
	for (const controller of controllers.splice(0)) controller.abort();
	for (const manager of jobManagers) manager.cancelAll();
	await Promise.allSettled(executions.splice(0));
	await Promise.all(jobManagers.splice(0).map(manager => manager.dispose()));
	await Promise.all([...kernelOwners].map(owner => disposeVmContextsByOwner(owner)));
	kernelOwners.clear();
	if (usesPythonBridge) {
		usesPythonBridge = false;
		await disposePyToolBridge();
	}
	vi.restoreAllMocks();
	if (originalPiPy === undefined) delete Bun.env.PI_PY;
	else Bun.env.PI_PY = originalPiPy;
	if (originalPiJs === undefined) delete Bun.env.PI_JS;
	else Bun.env.PI_JS = originalPiJs;
});

function createCellGate(): PromiseWithResolvers<void> {
	const gate = Promise.withResolvers<void>();
	cellReleases.push(gate.resolve);
	return gate;
}

function createController(): AbortController {
	const controller = new AbortController();
	controllers.push(controller);
	return controller;
}

function ownExecution<T>(execution: Promise<T>): Promise<T> {
	executions.push(execution);
	void execution.catch(() => {});
	return execution;
}

async function waitForEntry(entered: Promise<void>, execution: Promise<unknown>): Promise<void> {
	await Promise.race([
		entered,
		execution.then(result => {
			const detail =
				typeof result === "object" && result !== null && "content" in result
					? `: ${text(result as AgentToolResult)}`
					: "";
			throw new Error(`Execution settled before entering the gated cell${detail}`);
		}),
	]);
}

function makeSession(cwd = process.cwd(), identity = crypto.randomUUID()): ToolSession {
	kernelOwners.add(identity);
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getEvalSessionId: () => identity,
		getEvalKernelOwnerId: () => identity,
		settings: Settings.isolated({
			"async.enabled": true,
			"eval.py": true,
			"eval.js": true,
			"eval.autoBackground.enabled": false,
			"tools.speculativeExecution.enabled": false,
			"images.autoResize": false,
		}),
	};
}

function backendResult(output: string): ExecutorBackendResult {
	return {
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		artifactId: undefined,
		totalLines: output ? 1 : 0,
		totalBytes: Buffer.byteLength(output),
		outputLines: output ? 1 : 0,
		outputBytes: Buffer.byteLength(output),
		displayOutputs: [],
	};
}

function text(result: AgentToolResult): string {
	return result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

function nextTurn(): Promise<void> {
	const turn = Promise.withResolvers<void>();
	setImmediate(turn.resolve);
	return turn.promise;
}

function mount(session: ToolSession, tools: Tool[]): void {
	const xdev: XdevState = {
		tools: new Map(tools.map(tool => [tool.name, tool])),
		mountedNames: new Set(tools.map(tool => tool.name)),
		builtInNames: new Set(tools.map(tool => tool.name)),
		isActive: () => false,
		resolve: name => resolveXdevTool(xdev, name),
	};
	session.xdev = xdev;
}

describe("EvalTool concurrency", () => {
	it("runs finite Python Eval alongside read and write xd://ssh without releasing the Eval gate", async () => {
		using directory = TempDir.createSync("eval-concurrency-");
		const session = makeSession(directory.path());
		const entered = Promise.withResolvers<void>();
		const release = createCellGate();
		const cellEnded = Promise.withResolvers<AgentToolResult>();
		const independentFinished = Promise.withResolvers<void>();
		const completed = new Set<string>();
		vi.spyOn(pythonBackend, "isAvailable").mockResolvedValue(true);
		vi.spyOn(pythonBackend, "execute").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return backendResult("Eval finished");
		});
		vi.spyOn(connectionManager, "getCachedHostInfoSync").mockReturnValue(undefined);
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 1,
			os: "windows",
			shell: "powershell",
			compatEnabled: false,
		});
		vi.spyOn(sshExecutor, "executeSSH").mockResolvedValue(backendResult("remote timestamp"));
		const ssh = new SshTool(
			session,
			["probe"],
			new Map([["probe", { name: "probe", host: "192.0.2.1" }]]),
			"SSH timestamp query",
		);
		mount(session, [ssh]);
		const tools: Tool[] = [new EvalTool(session), new ReadTool(session), new WriteTool(session)];
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "cell",
							name: "eval",
							arguments: { language: "py", code: "finite cell", timeout: 20 },
						},
						{ type: "toolCall", id: "docs", name: "read", arguments: { path: "xd://ssh" } },
						{
							type: "toolCall",
							id: "query",
							name: "write",
							arguments: {
								path: "xd://ssh",
								content: JSON.stringify({
									host: "probe",
									command: "(Get-Date).ToUniversalTime().ToString('o')",
									timeout: 20,
								}),
							},
						},
					],
				},
				{ content: ["done"] },
			],
		});
		const loop = agentLoop(
			[{ role: "user", content: "run independent queries", timestamp: 0 }],
			{ systemPrompt: [""], messages: [], tools },
			{ model: mock.model, convertToLlm: identityConverter },
			undefined,
			mock.stream,
		);
		const drain = ownExecution(
			(async () => {
				for await (const event of loop) {
					if (event.type !== "tool_execution_end") continue;
					completed.add(event.toolCallId);
					if (event.toolCallId === "cell") cellEnded.resolve(event.result);
					if (completed.has("docs") && completed.has("query")) independentFinished.resolve();
				}
			})(),
		);
		try {
			await waitForEntry(entered.promise, cellEnded.promise);
			await independentFinished.promise;
			expect(completed.has("cell")).toBe(false);
		} finally {
			release.resolve();
			await drain;
		}
		const results = (await loop.result()).filter(
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		expect(results.map(result => [result.toolCallId, result.isError])).toEqual([
			["cell", false],
			["docs", false],
			["query", false],
		]);
		expect(results[2].details).toMatchObject({ xdev: { tool: "ssh", mode: "execute" } });
	});

	it("preserves file-write and hook-revised device mutation barriers around shared Eval cells", async () => {
		using directory = TempDir.createSync("eval-write-barriers-");
		const session = makeSession(directory.path());
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = createCellGate();
		const firstEnded = Promise.withResolvers<AgentToolResult>();
		const secondStarted = Promise.withResolvers<void>();
		const releaseSecond = createCellGate();
		const secondEnded = Promise.withResolvers<AgentToolResult>();
		const order: string[] = [];
		let retained = 0;
		vi.spyOn(jsBackend, "execute").mockImplementation(async code => {
			order.push(`${code}:start`);
			if (code === "first") {
				firstStarted.resolve();
				await releaseFirst.promise;
				retained = 40;
			} else {
				secondStarted.resolve();
				await releaseSecond.promise;
				retained += 1;
			}
			order.push(`${code}:end`);
			return backendResult(String(retained));
		});
		const schema = type({ operation: "string" });
		const mutate: AgentTool<typeof schema> = {
			name: "conditional",
			label: "Conditional",
			description: "Mutates only when the operation requests it",
			parameters: schema,
			concurrency: args => (args.operation === "mutate" ? "exclusive" : "shared"),
			async execute(_toolCallId, args) {
				order.push("device");
				if (args.operation === "mutate") retained += 1;
				return { content: [{ type: "text", text: String(retained) }] };
			},
		};
		const observe: AgentTool = {
			name: "observe",
			label: "Observe",
			description: "Reads the final retained value",
			parameters: type({}),
			async execute() {
				order.push("observe");
				return { content: [{ type: "text", text: String(retained) }] };
			},
		};
		mount(session, [mutate]);
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "first", name: "eval", arguments: { language: "js", code: "first" } },
						{
							type: "toolCall",
							id: "file",
							name: "write",
							arguments: { path: "note.txt", content: "materialized" },
						},
						{ type: "toolCall", id: "second", name: "eval", arguments: { language: "js", code: "second" } },
						{
							type: "toolCall",
							id: "device",
							name: "write",
							arguments: { path: "xd://conditional", content: JSON.stringify({ operation: "peek" }) },
						},
						{ type: "toolCall", id: "observe", name: "observe", arguments: {} },
					],
				},
				{ content: ["done"] },
			],
		});
		const loop = agentLoop(
			[{ role: "user", content: "run ordered mutations", timestamp: 0 }],
			{
				systemPrompt: [""],
				messages: [],
				tools: [new EvalTool(session), new WriteTool(session), observe],
			},
			{
				model: mock.model,
				convertToLlm: identityConverter,
				beforeToolCall: async ({ toolCall, args }) =>
					toolCall.id === "device"
						? { args: { ...args, content: JSON.stringify({ operation: "mutate" }) } }
						: undefined,
			},
			undefined,
			mock.stream,
		);
		const drain = ownExecution(
			(async () => {
				for await (const event of loop) {
					if (event.type === "tool_execution_start" && event.toolCallId === "file") order.push("file:start");
					if (event.type === "tool_execution_end" && event.toolCallId === "file") order.push("file:end");
					if (event.type === "tool_execution_end" && event.toolCallId === "first")
						firstEnded.resolve(event.result);
					if (event.type === "tool_execution_end" && event.toolCallId === "second")
						secondEnded.resolve(event.result);
				}
			})(),
		);
		try {
			await waitForEntry(firstStarted.promise, firstEnded.promise);
			releaseFirst.resolve();
			await waitForEntry(secondStarted.promise, secondEnded.promise);
		} finally {
			releaseFirst.resolve();
			releaseSecond.resolve();
			await drain;
		}
		expect(order).toEqual([
			"first:start",
			"first:end",
			"file:start",
			"file:end",
			"second:start",
			"second:end",
			"device",
			"observe",
		]);
		const results = (await loop.result()).filter(
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		expect(text(results.find(result => result.toolCallId === "observe")!)).toBe("42");
		expect(await Bun.file(`${directory.path()}/note.txt`).text()).toBe("materialized");
	});

	it.each([
		{ kind: "unknown", path: "xd://missing", content: "{}" },
		{ kind: "malformed", path: "xd://shared", content: "{" },
		{ kind: "recursive", path: "xd://write", content: '{"path":"note.txt","content":"nested write"}' },
		{ kind: "exclusive", path: "xd://exclusive", content: "{}" },
	])("keeps $kind device writes behind the active cell", async target => {
		using directory = TempDir.createSync("eval-device-barrier-");
		const session = makeSession(directory.path());
		const entered = Promise.withResolvers<void>();
		const release = createCellGate();
		let retained = 0;
		let observed = 0;
		vi.spyOn(jsBackend, "execute").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			retained = 42;
			return backendResult(String(retained));
		});
		const device: AgentTool = {
			name: "shared",
			label: "Shared",
			description: "A finite shared device",
			parameters: type({}),
			async execute() {
				return { content: [] };
			},
		};
		const exclusive: AgentTool = { ...device, name: "exclusive", concurrency: "exclusive" };
		const write = new WriteTool(session);
		mount(session, [device, exclusive, write]);
		const observe: AgentTool = {
			name: "observe",
			label: "Observe",
			description: "Reads state at its dispatch boundary",
			parameters: type({}),
			async execute() {
				observed = retained;
				return { content: [{ type: "text", text: String(observed) }] };
			},
		};
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "cell", name: "eval", arguments: { language: "js", code: "hold" } },
						{
							type: "toolCall",
							id: "device",
							name: "write",
							arguments: { path: target.path, content: target.content },
						},
						{ type: "toolCall", id: "observe", name: "observe", arguments: {} },
					],
				},
				{ content: ["done"] },
			],
		});
		const completion = ownExecution(
			agentLoop(
				[{ role: "user", content: "respect device barriers", timestamp: 0 }],
				{ systemPrompt: [""], messages: [], tools: [new EvalTool(session), write, observe] },
				{ model: mock.model, convertToLlm: identityConverter },
				undefined,
				mock.stream,
			).result(),
		);
		try {
			await waitForEntry(entered.promise, completion);
		} finally {
			release.resolve();
			await completion;
		}
		expect(observed).toBe(42);
	});

	it("serializes retained JavaScript state and resets across EvalTool instances sharing one kernel", async () => {
		using directory = TempDir.createSync("eval-state-queue-");
		const session = makeSession(directory.path());
		const entered = Promise.withResolvers<void>();
		const release = createCellGate();
		const gate: AgentTool = {
			name: "hold_cell",
			label: "HoldCell",
			description: "Hold the active cell until its host gate is released",
			parameters: type({}),
			async execute() {
				entered.resolve();
				await release.promise;
				return { content: [] };
			},
		};
		session.getToolForEvalBridge = name => (name === gate.name ? gate : undefined);
		session.getEvalBridgeToolNames = () => [gate.name];
		const firstTool = new EvalTool(session);
		const secondTool = new EvalTool({
			...session,
			getEvalSessionId: () => `js:${session.getEvalSessionId!()}`,
		});
		try {
			await ownExecution(firstTool.execute("seed", { language: "js", code: "var retainedCounter = 0;" }));
			const first = ownExecution(
				firstTool.execute("first", {
					language: "js",
					code: "await tool.hold_cell({}); retainedCounter += 1; print(retainedCounter);",
				}),
			);
			await waitForEntry(entered.promise, first);
			const second = ownExecution(
				secondTool.execute("second", {
					language: "js",
					code: "retainedCounter += 10; print(retainedCounter);",
				}),
			);
			const reset = ownExecution(
				firstTool.execute("reset", {
					language: "js",
					code: "print(typeof retainedCounter);",
					reset: true,
				}),
			);
			const results = Promise.allSettled([first, second, reset]);
			try {
				await nextTurn();
			} finally {
				release.resolve();
			}
			const settled = await results;
			expect(settled.map(result => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
			const fulfilled = settled.flatMap(result => (result.status === "fulfilled" ? [result.value] : []));
			expect(fulfilled.map(result => result.isError === true)).toEqual([false, false, false]);
			expect(fulfilled.map(text)).toEqual(["1", "11", "undefined"]);
		} finally {
			release.resolve();
		}
	}, 30_000);

	it("rejects same-kernel JavaScript bridge cells and resets without corrupting retained state", async () => {
		using directory = TempDir.createSync("eval-reentry-");
		const session = makeSession(directory.path());
		const controller = createController();
		const tool = new EvalTool(session);
		const alias = new EvalTool({
			...session,
			getEvalSessionId: () => `js:${session.getEvalSessionId!()}`,
		});
		const delegate: AgentTool = {
			name: "nested_cell",
			label: "NestedCell",
			description: "Calls Eval indirectly from a host tool",
			parameters: type({}),
			async execute(id, _args, signal) {
				return alias.execute(
					id,
					{ language: "js", code: "retainedCounter = 9001;", timeout: 0, reset: true },
					signal,
				);
			},
		};
		session.getToolForEvalBridge = name =>
			name === "eval" ? (alias as unknown as AgentTool) : name === delegate.name ? delegate : undefined;
		session.getEvalBridgeToolNames = () => ["eval", delegate.name];
		await ownExecution(
			tool.execute(
				"reentry-seed",
				{ language: "js", code: "var retainedCounter = 40;", timeout: 0 },
				controller.signal,
			),
		);
		const result = await ownExecution(
			tool.execute(
				"reentry",
				{
					language: "js",
					timeout: 0,
					code: [
						"var reentryErrors = [];",
						"for (var wipe of [false, true]) {",
						"  try {",
						"    await tool.eval({ language: 'js', code: 'retainedCounter = 9001;', timeout: 0, reset: wipe });",
						"    reentryErrors.push(false);",
						"  } catch (error) { reentryErrors.push(error.name === 'ToolError'); }",
						"}",
						"try { await tool.nested_cell({}); reentryErrors.push(false); }",
						"catch (error) { reentryErrors.push(error.name === 'ToolError'); }",
						"retainedCounter += 1;",
						"display({ reentryErrors, retainedCounter });",
					].join("\n"),
				},
				controller.signal,
			),
		);
		expect(result.isError === true).toBe(false);
		expect(result.details?.jsonOutputs).toEqual([{ reentryErrors: [true, true, true], retainedCounter: 41 }]);
		const next = await ownExecution(
			tool.execute(
				"reentry-next",
				{ language: "js", code: "retainedCounter += 1; print(retainedCounter);", timeout: 0 },
				controller.signal,
			),
		);
		expect(next.isError === true).toBe(false);
		expect(text(next)).toBe("42");
	}, 30_000);

	it("restores Python HTTP callback provenance while allowing an independent JavaScript kernel", async () => {
		const session = makeSession();
		const controller = createController();
		const tool = new EvalTool(session);
		session.getToolForEvalBridge = name => (name === "eval" ? (tool as unknown as AgentTool) : undefined);
		session.getEvalBridgeToolNames = () => ["eval"];
		usesPythonBridge = true;
		// Create the transport outside any Eval lease: the callback must use its
		// registration's context, not the HTTP server's creation context.
		const bridge = await ensurePyToolBridge();
		const pythonCalls: string[] = [];
		const javascriptCalls: string[] = [];
		let retained = 40;
		let independentRetained = 70;
		vi.spyOn(pythonBackend, "isAvailable").mockResolvedValue(true);
		vi.spyOn(jsBackend, "execute").mockImplementation(async code => {
			javascriptCalls.push(code);
			independentRetained += 1;
			return backendResult(String(independentRetained));
		});
		vi.spyOn(pythonBackend, "execute").mockImplementation(async (code, options) => {
			pythonCalls.push(code);
			if (options.reset) retained = 0;
			if (code === "corrupt") retained = 9001;
			else if (code === "outer") {
				const runId = crypto.randomUUID();
				const unregister = registerPyToolBridge(options.sessionId, runId, {
					toolSession: session,
					signal: options.signal,
				});
				const invoke = async (args: Record<string, unknown>) => {
					const response = await fetch(`${bridge.url}/v1/tool`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${bridge.token}`,
						},
						body: JSON.stringify({ session: options.sessionId, run: runId, name: "eval", args }),
						signal: options.signal,
					});
					return (await response.json()) as { ok: boolean; error?: string };
				};
				try {
					for (const reset of [false, true]) {
						const rejected = await invoke({ language: "py", code: "corrupt", timeout: 0, reset });
						expect(rejected).toMatchObject({ ok: false, error: expect.any(String) });
					}
					expect(await invoke({ language: "js", code: "independent", timeout: 0 })).toMatchObject({ ok: true });
				} finally {
					unregister();
				}
				retained += 1;
			} else retained += 1;
			return backendResult(String(retained));
		});
		const result = await ownExecution(
			tool.execute("python-reentry", { language: "py", code: "outer", timeout: 0 }, controller.signal),
		);
		expect(result.isError === true).toBe(false);
		expect(text(result)).toBe("41");
		expect(pythonCalls).toEqual(["outer"]);
		expect(javascriptCalls).toEqual(["independent"]);
		expect(independentRetained).toBe(71);
		const next = await ownExecution(
			tool.execute("python-reentry-next", { language: "py", code: "increment", timeout: 0 }, controller.signal),
		);
		expect(text(next)).toBe("42");
		expect(pythonCalls).toEqual(["outer", "increment"]);
	});

	it.each(["language", "session"] as const)("does not serialize independent %s kernels", async separation => {
		const firstSession = makeSession();
		const secondSession = separation === "session" ? makeSession() : firstSession;
		const entered = Promise.withResolvers<void>();
		const release = createCellGate();
		const completed: string[] = [];
		vi.spyOn(pythonBackend, "isAvailable").mockResolvedValue(true);
		const execute = async (code: string) => {
			if (code === "hold") {
				entered.resolve();
				await release.promise;
			}
			completed.push(code);
			return backendResult(code === "hold" ? "held cell" : "independent cell");
		};
		vi.spyOn(jsBackend, "execute").mockImplementation(execute);
		vi.spyOn(pythonBackend, "execute").mockImplementation(execute);
		const first = ownExecution(new EvalTool(firstSession).execute("held", { language: "js", code: "hold" }));
		await waitForEntry(entered.promise, first);
		const second = ownExecution(
			new EvalTool(secondSession).execute("independent", {
				language: separation === "language" ? "py" : "js",
				code: "independent",
			}),
		);
		try {
			const result = await second;
			expect(result.isError === true).toBe(false);
			expect(result.details?.cells?.[0]?.status).toBe("complete");
			expect(completed).toEqual(["independent"]);
		} finally {
			release.resolve();
			await first;
		}
		expect(completed).toEqual(["independent", "hold"]);
	});

	it("cancels a queued reset without letting later calls overtake the active cell", async () => {
		const session = makeSession();
		const entered = Promise.withResolvers<void>();
		const release = createCellGate();
		const calls: string[] = [];
		let retained = 0;
		vi.spyOn(pythonBackend, "isAvailable").mockResolvedValue(true);
		vi.spyOn(pythonBackend, "execute").mockImplementation(async (code, options) => {
			calls.push(code);
			if (options.reset) retained = 0;
			if (code === "hold") {
				entered.resolve();
				await release.promise;
				retained = 41;
			} else retained += 1;
			return backendResult(String(retained));
		});
		const tool = new EvalTool(session);
		const first = ownExecution(tool.execute("held", { language: "py", code: "hold" }));
		await waitForEntry(entered.promise, first);
		const controller = new AbortController();
		const cancelled = ownExecution(
			tool.execute("cancelled-reset", { language: "py", code: "reset", reset: true }, controller.signal),
		);
		controller.abort();
		await expect(cancelled).rejects.toThrow();
		const later = ownExecution(tool.execute("later", { language: "py", code: "increment" }));
		const results = Promise.all([first, later]);
		try {
			await nextTurn();
			expect(calls).toEqual(["hold"]);
		} finally {
			release.resolve();
		}
		expect((await results).map(text)).toEqual(["41", "42"]);
		expect(calls).toEqual(["hold", "increment"]);
	});

	it("releases the kernel queue after a failed cell", async () => {
		const session = makeSession();
		const entered = Promise.withResolvers<void>();
		const release = createCellGate();
		const calls: string[] = [];
		vi.spyOn(jsBackend, "execute").mockImplementation(async code => {
			calls.push(code);
			if (code === "fail") {
				entered.resolve();
				await release.promise;
				throw new Error("cell failed");
			}
			return backendResult("next cell succeeded");
		});
		const tool = new EvalTool(session);
		const failed = ownExecution(tool.execute("failed", { language: "js", code: "fail" }));
		await waitForEntry(entered.promise, failed);
		const next = ownExecution(tool.execute("next", { language: "js", code: "recover" }));
		try {
			await nextTurn();
			expect(calls).toEqual(["fail"]);
		} finally {
			release.resolve();
		}
		await expect(failed).rejects.toThrow("cell failed");
		const result = await next;
		expect(result.isError === true).toBe(false);
		expect(result.details?.cells?.[0]?.status).toBe("complete");
		expect(calls).toEqual(["fail", "recover"]);
	});

	it("keeps a backgrounded cell's kernel lease until the backend actually settles", async () => {
		const session = makeSession();
		cfgEvalAutoBackgroundEnabled.override(session.settings, true);
		cfgEvalAutoBackgroundThresholdMs.override(session.settings, 0);
		const controller = createController();
		const manager = new AsyncJobManager({});
		jobManagers.push(manager);
		session.asyncJobManager = manager;
		const entered = Promise.withResolvers<void>();
		const release = createCellGate();
		const startCallback = createCellGate();
		const callbackError = Promise.withResolvers<unknown>();
		const calls: string[] = [];
		vi.spyOn(jsBackend, "execute").mockImplementation(async (code, options) => {
			calls.push(code);
			if (code === "hold") {
				entered.resolve();
				await startCallback.promise;
				try {
					await callSessionTool(
						"eval",
						{ language: "js", code: "recursive", timeout: 0 },
						{ session, signal: options.signal },
					);
					callbackError.resolve(undefined);
				} catch (error) {
					callbackError.resolve(error);
				}
				await release.promise;
			}
			return backendResult("completed");
		});
		const tool = new EvalTool(session);
		session.getToolForEvalBridge = name => (name === "eval" ? (tool as unknown as AgentTool) : undefined);
		session.getEvalBridgeToolNames = () => ["eval"];
		let next: Promise<AgentToolResult<EvalToolDetails | undefined>> | undefined;
		try {
			const background = await ownExecution(
				tool.execute("background", { language: "js", code: "hold" }, controller.signal),
			);
			expect(background.isError === true, text(background)).toBe(false);
			expect(background.details?.async?.state, JSON.stringify(background)).toBe("running");
			const jobId = background.details?.async?.jobId;
			if (!jobId) throw new Error("expected a backgrounded cell");
			const job = manager.getJob(jobId);
			if (!job) throw new Error("expected the background cell's managed job");
			await waitForEntry(entered.promise, job.promise);
			startCallback.resolve();
			expect(await Promise.race([callbackError.promise, job.promise])).toBeInstanceOf(ToolError);
			cfgEvalAutoBackgroundEnabled.override(session.settings, false);
			next = ownExecution(tool.execute("next", { language: "js", code: "increment" }, controller.signal));
			await nextTurn();
			expect(calls).toEqual(["hold"]);
			release.resolve();
			const result = await next;
			expect(result.isError === true).toBe(false);
			expect(result.details?.cells?.[0]?.status).toBe("complete");
			expect(calls).toEqual(["hold", "increment"]);
		} finally {
			startCallback.resolve();
			release.resolve();
			controller.abort();
			manager.cancelAll();
			await manager.waitForAll();
			await next?.catch(() => {});
		}
	});
});
