import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type RpcAgentProcess, RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcCommand, RpcReadyFrame, RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { TempDir } from "@oh-my-pi/pi-utils";

const MOCK_AGENT = path.join(import.meta.dir, "fixtures", "mock-rpc-agent.ts");

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function createPagingProcess(mode: "busy" | "stale"): RpcAgentProcess {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const exit = Promise.withResolvers<number>();
	let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
	let closed = false;
	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			stdoutController = controller;
		},
	});
	const output = (frame: RpcReadyFrame | RpcResponse): void => {
		if (!closed) stdoutController.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
	};
	const snapshotMessage: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: "streaming snapshot" }],
		timestamp: 3,
	};
	const firstPageMessage: AgentMessage = { role: "user", content: "first", timestamp: 1 };

	queueMicrotask(() => {
		output({
			type: "ready",
			protocolVersion: 1,
			supportedProtocolVersions: [1, 2],
			maxFrameBytes: 1024 * 1024,
			maxReassembledFrameBytes: 64 * 1024 * 1024,
		});
	});

	return {
		stdin: {
			write(data) {
				const command = JSON.parse(typeof data === "string" ? data : decoder.decode(data)) as RpcCommand;
				if (command.type === "negotiate_protocol") {
					output({
						id: command.id,
						type: "response",
						command: "negotiate_protocol",
						success: true,
						data: { protocolVersion: 2 },
					});
				} else if (command.type === "get_messages_page") {
					if (mode === "busy" || command.cursor !== undefined) {
						output({
							id: command.id,
							type: "response",
							command: "get_messages_page",
							success: false,
							error:
								mode === "busy"
									? "Cannot page messages while the session is changing"
									: "RPC message cursor is stale",
							code: mode === "busy" ? "session_busy" : "stale_cursor",
						});
					} else {
						output({
							id: command.id,
							type: "response",
							command: "get_messages_page",
							success: true,
							data: {
								messages: [firstPageMessage],
								nextCursor: "second-page",
								totalMessages: 2,
							},
						});
					}
				} else if (command.type === "get_messages") {
					output({
						id: command.id,
						type: "response",
						command: "get_messages",
						success: true,
						data: {
							messages: [snapshotMessage],
						},
					});
				} else {
					output({
						id: command.id,
						type: "response",
						command: command.type,
						success: false,
						error: `Unexpected command: ${command.type}`,
					});
				}
			},
		},
		stdout,
		peekStderr: () => "",
		kill() {
			if (closed) return;
			closed = true;
			stdoutController.close();
			exit.resolve(0);
		},
		exited: exit.promise,
	};
}

function createExitOnCommandProcess(): RpcAgentProcess {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const exit = Promise.withResolvers<number>();
	let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
	let closed = false;
	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			stdoutController = controller;
		},
	});
	const output = (frame: RpcReadyFrame | RpcResponse): void => {
		if (!closed) stdoutController.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
	};
	queueMicrotask(() => {
		output({
			type: "ready",
			protocolVersion: 1,
			supportedProtocolVersions: [1, 2],
			maxFrameBytes: 1024 * 1024,
			maxReassembledFrameBytes: 64 * 1024 * 1024,
		});
	});

	return {
		stdin: {
			write(data) {
				const command = JSON.parse(typeof data === "string" ? data : decoder.decode(data)) as RpcCommand;
				if (command.type === "negotiate_protocol") {
					output({
						id: command.id,
						type: "response",
						command: "negotiate_protocol",
						success: true,
						data: { protocolVersion: 2 },
					});
					return;
				}
				queueMicrotask(() => {
					if (closed) return;
					closed = true;
					stdoutController.close();
					exit.resolve(23);
				});
			},
		},
		stdout,
		peekStderr: () => "fixture worker failed",
		kill() {
			if (closed) return;
			closed = true;
			stdoutController.close();
			exit.resolve(0);
		},
		exited: exit.promise,
	};
}

describe("RpcClient lifecycle (issue #4079 B)", () => {
	test("auto-negotiates protocol v2 and reassembles an oversized response", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_V2: "1" },
		});

		await client.start();
		const state = (await client.getState()) as unknown as { payload: string };
		expect(state.payload).toBe("😀".repeat(270_000));
		expect((await client.getMessages()) as unknown).toEqual([
			{ role: "user", content: "first", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "second" }], timestamp: 2 },
		]);
	}, 20_000);

	test("normalizes omitted state fields and a runtime-invalid tokensPerSecond", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_LEGACY_STATE: "1", MOCK_RPC_INVALID_TPS: "1" },
		});

		await client.start();
		const state = await client.getState();
		expect(state.fastModeEnabled).toBe(false);
		expect(state.fastModeActive).toBe(false);
		expect(state.tokensPerSecond).toBeNull();
	}, 20_000);

	test("preserves getMessages snapshot behavior while a v2 page walk is unavailable", async () => {
		using client = new RpcClient({
			spawn: () => createPagingProcess("busy"),
		});

		await client.start();
		await expect(client.getMessagesPage()).rejects.toMatchObject({
			command: "get_messages_page",
			code: "session_busy",
			message: "Cannot page messages while the session is changing",
		});
		expect((await client.getMessages()) as unknown).toEqual([
			{ role: "user", content: [{ type: "text", text: "streaming snapshot" }], timestamp: 3 },
		]);
	}, 20_000);

	test("discards partial pages and falls back to get_messages when a cursor goes stale mid-walk", async () => {
		using client = new RpcClient({
			spawn: () => createPagingProcess("stale"),
		});

		await client.start();
		// Direct page walks stay strict: the stale cursor is surfaced to the caller.
		const firstPage = await client.getMessagesPage();
		expect(firstPage.nextCursor).toBe("second-page");
		await expect(client.getMessagesPage({ cursor: firstPage.nextCursor })).rejects.toMatchObject({
			command: "get_messages_page",
			code: "stale_cursor",
			message: "RPC message cursor is stale",
		});
		// The high-level drain discards the partial first page and takes the legacy snapshot.
		expect((await client.getMessages()) as unknown).toEqual([
			{ role: "user", content: [{ type: "text", text: "streaming snapshot" }], timestamp: 3 },
		]);
	}, 20_000);

	test("start() succeeds a second time after stop() on the same instance", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
		});

		// First lifecycle: start + stop.
		await client.start();
		await client.stop();

		// Second start on the same instance must NOT reuse the aborted
		// controller from the previous stop(). Before the fix, this rejected
		// with "Agent process exited before ready" because the JSONL reader
		// short-circuited on the pre-aborted signal.
		await client.start();
		await client.stop();
	}, 20000);

	test("start() waits for a signal-ignoring worker to be reaped after stop()", async () => {
		using tempDir = TempDir.createSync("@omp-rpc-stop-restart-");
		const pidFile = tempDir.join("pid");
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: {
				MOCK_RPC_PID_FILE: pidFile,
				MOCK_RPC_IGNORE_SIGTERM: process.platform === "win32" ? "0" : "1",
			},
			terminationGraceMs: 10,
		});

		await client.start();
		const firstPid = Number(await Bun.file(pidFile).text());

		const stopped = client.stop();
		const restarted = client.start();
		await Promise.all([stopped, restarted]);

		const secondPid = Number(await Bun.file(pidFile).text());
		expect(secondPid).not.toBe(firstPid);
		expect(isProcessAlive(firstPid)).toBe(false);
		await client.stop();
	}, 20_000);

	test("start() may be retried after a failed start (child is cleaned up on failure)", async () => {
		const env: Record<string, string> = {
			MOCK_RPC_EXIT_BEFORE_READY: "17",
			MOCK_RPC_EXIT_STDERR: "fixture startup failed",
		};
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env,
			terminationGraceMs: 10,
		});

		await expect(client.start()).rejects.toThrow("fixture startup failed");

		// Before the fix, #process stayed set after the failed spawn so the
		// second start() rejected with "Client already started". A successful
		// retry proves both the child and the client lifecycle state were reset.
		delete env.MOCK_RPC_EXIT_BEFORE_READY;
		await client.start();
		await client.stop();
	}, 10_000);

	test("stop() rejects active requests instead of leaving them to time out", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_IGNORE_COMMANDS: "1" },
		});
		await client.start();

		const pending = client.getState();
		client.stop();

		await expect(pending).rejects.toThrow("Client stopped");
	});

	test("rejects pending requests and reaps the worker when stdout parsing fails", async () => {
		// This awaits the real child-process grace-to-hard-kill path; fake timers
		// cannot drive OS signal delivery or process reaping.
		using tempDir = TempDir.createSync("@omp-rpc-reader-failure-");
		const pidFile = tempDir.join("pid");
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: {
				MOCK_RPC_PID_FILE: pidFile,
				MOCK_RPC_INVALID_OUTPUT: "1",
				MOCK_RPC_IGNORE_SIGTERM: process.platform === "win32" ? "0" : "1",
			},
			terminationGraceMs: 10,
		});

		let pid = 0;
		try {
			await client.start();
			pid = Number(await Bun.file(pidFile).text());

			await expect(client.getState()).rejects.toThrow(/Agent output reader failed/);
			await expect(client.getState()).rejects.toThrow("Client not started");
			expect(isProcessAlive(pid)).toBe(false);
		} finally {
			if (pid > 0 && isProcessAlive(pid)) process.kill(pid, "SIGKILL");
		}
	}, 10_000);

	test("reports exit code and stderr when a ready worker exits", async () => {
		using client = new RpcClient({
			spawn: () => createExitOnCommandProcess(),
		});
		await client.start();

		await expect(client.getState()).rejects.toThrow(
			"Agent process exited with code 23. Stderr: fixture worker failed",
		);
	});
});
