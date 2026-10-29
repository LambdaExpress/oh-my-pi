import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { McpProtocolHandler } from "../../src/internal-urls/mcp-protocol";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import * as mcpClient from "../../src/mcp/client";
import { MCPTransportError } from "../../src/mcp/errors";
import { MCPManager } from "../../src/mcp/manager";

const FIXTURE = path.join(import.meta.dir, "fixtures", "silent-resource-server.ts");
const ORIGINAL_TIMEOUT = process.env.OMP_MCP_TIMEOUT_MS;
const ORIGINAL_MANAGER = MCPManager.instance();
let manager: MCPManager | undefined;
let fixturePid: number | undefined;

afterEach(async () => {
	vi.useRealTimers();
	if (ORIGINAL_TIMEOUT === undefined) delete process.env.OMP_MCP_TIMEOUT_MS;
	else process.env.OMP_MCP_TIMEOUT_MS = ORIGINAL_TIMEOUT;
	await manager?.disconnectAll();
	if (fixturePid !== undefined) {
		try {
			process.kill(fixturePid);
		} catch {}
		fixturePid = undefined;
	}
	manager = undefined;
	MCPManager.setInstance(ORIGINAL_MANAGER);
});

async function setup(mode = "read", timeout = 360_000, env: Record<string, string> = {}) {
	delete process.env.OMP_MCP_TIMEOUT_MS;
	manager = new MCPManager(process.cwd());
	MCPManager.setInstance(manager);
	const received = Promise.withResolvers<{ method: string; uri?: string }>();
	manager.addNotificationListener((_server, method, params) => {
		if (method === "notifications/fixture/received") {
			const notification = params as { method: string; uri?: string; pid: number };
			fixturePid = notification.pid;
			received.resolve(
				notification.uri === undefined
					? { method: notification.method }
					: { method: notification.method, uri: notification.uri },
			);
		}
	});
	await manager.connectServers(
		{
			fixture: {
				type: "stdio",
				command: process.execPath,
				args: [FIXTURE],
				env: { SILENT_MCP_MODE: mode, ...env },
				timeout,
			},
		},
		{},
	);
	return { manager, received: received.promise, handler: new McpProtocolHandler() };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => {
			throw new Error("Expected the resource operation to fail");
		},
		error => error,
	);
}

function errorCauses(error: unknown): Error[] {
	if (!(error instanceof Error)) return [];
	return [
		error,
		...errorCauses(error.cause),
		...(error instanceof AggregateError ? error.errors.flatMap(errorCauses) : []),
	];
}

function observeResourceReadiness(manager: MCPManager) {
	const connection = Promise.withResolvers<void>();
	const catalog = Promise.withResolvers<void>();
	const waitForPendingConnections = manager.waitForPendingConnections.bind(manager);
	const ensureServerResources = manager.ensureServerResources.bind(manager);
	const connectionSpy = vi.spyOn(manager, "waitForPendingConnections").mockImplementation((...args) => {
		const pending = waitForPendingConnections(...args);
		connection.resolve();
		return pending;
	});
	const catalogSpy = vi.spyOn(manager, "ensureServerResources").mockImplementation((...args) => {
		const pending = ensureServerResources(...args);
		catalog.resolve();
		return pending;
	});
	return {
		connection: connection.promise,
		catalog: catalog.promise,
		restore() {
			connectionSpy.mockRestore();
			catalogSpy.mockRestore();
		},
	};
}

describe("MCP resource deadlines", () => {
	it("bounds an advertised silent resource independently of a six-minute tool timeout", async () => {
		const { manager, received, handler } = await setup();
		await manager.ensureServerResources("fixture");
		const connected = await handler.resolve(parseInternalUrl("mcp://test://connected"));
		expect(connected.content).toBe("The connected resource is available.");

		vi.useFakeTimers();
		const result = rejection(handler.resolve(parseInternalUrl("mcp://test://silent")));
		expect(await received).toEqual({ method: "resources/read", uri: "test://silent" });
		vi.advanceTimersByTime(30_000);
		const error = await result;
		expect(error).toBeInstanceOf(Error);
		const cause = (error as Error).cause;
		expect(cause).toBeInstanceOf(MCPTransportError);
		expect(cause).toMatchObject({ transport: "stdio", failure: "timeout", retryable: false });
		expect((error as Error).message).toContain("fixture");
		expect((error as Error).message).toContain("test://silent");
		expect((error as Error).message).toMatch(/server.*application.*logs/i);
	});

	it("waits beyond the resource deadline for a five-minute server startup", async () => {
		using temp = TempDir.createSync("@mcp-resource-cold-start-");
		const releasePath = path.join(temp.path(), "ready");
		const { manager, received, handler } = await setup("initialize", 300_000, {
			SILENT_MCP_RELEASE_PATH: releasePath,
		});
		expect(await received).toEqual({ method: "initialize" });

		const readiness = observeResourceReadiness(manager);
		try {
			vi.useFakeTimers();
			let settled = false;
			const result = handler.resolve(parseInternalUrl("mcp://test://connected")).then(
				resource => {
					settled = true;
					return { resource };
				},
				error => {
					settled = true;
					return { error };
				},
			);
			await readiness.connection;
			vi.advanceTimersByTime(30_000);
			const nextTurn = Promise.withResolvers<void>();
			setImmediate(nextTurn.resolve);
			await nextTurn.promise;
			expect(settled).toBe(false);
			expect(manager.getConnectionStatus("fixture")).toBe("connecting");

			vi.useRealTimers();
			await Bun.write(releasePath, "ready");
			expect(await result).toMatchObject({ resource: { content: "The connected resource is available." } });
		} finally {
			readiness.restore();
		}
	});

	it("bounds readiness by the configured startup budget without stopping shared startup", async () => {
		using temp = TempDir.createSync("@mcp-resource-readiness-");
		const releasePath = path.join(temp.path(), "ready");
		const { manager, received, handler } = await setup("initialize", 300_000, {
			SILENT_MCP_RELEASE_PATH: releasePath,
		});
		expect(await received).toEqual({ method: "initialize" });

		const readiness = observeResourceReadiness(manager);
		try {
			vi.useFakeTimers();
			const result = rejection(handler.resolve(parseInternalUrl("mcp://test://connected")));
			await readiness.connection;
			vi.advanceTimersByTime(300_000);
			const error = await result;
			expect((error as Error).cause).toMatchObject({ failure: "timeout", stage: "connect", retryable: false });
			expect((error as Error).message).toContain("fixture");
			expect((error as Error).message).toContain("300000ms");
			expect(manager.getConnectionStatus("fixture")).toBe("connecting");

			vi.useRealTimers();
			await Bun.write(releasePath, "ready");
			await manager.waitForPendingConnections();
			await manager.ensureServerResources("fixture");
			const connected = await handler.resolve(parseInternalUrl("mcp://test://connected"));
			expect(connected.content).toBe("The connected resource is available.");
		} finally {
			readiness.restore();
		}
	});

	it("bounds catalog readiness independently of the five-minute startup budget", async () => {
		const { manager, received } = await setup("catalog", 300_000);
		expect(await received).toEqual({ method: "resources/list" });

		vi.useFakeTimers();
		const result = rejection(manager.ensureServerResources("fixture"));
		vi.advanceTimersByTime(30_000);
		const error = await result;
		expect(error).toBeInstanceOf(MCPTransportError);
		expect(error).toMatchObject({ failure: "timeout", stage: "receive", retryable: false });
		expect((error as Error).message).toContain("30000ms");
		expect(manager.getConnectionStatus("fixture")).toBe("connected");
	});

	it("reports catalog unavailability rather than inventing an empty resource list", async () => {
		const { received, handler } = await setup("catalog");
		expect(await received).toEqual({ method: "resources/list" });
		process.env.OMP_MCP_TIMEOUT_MS = "50";

		const error = await rejection(handler.resolve(parseInternalUrl("mcp://test://connected")));
		const failures = errorCauses(error);
		expect(failures.some(failure => failure instanceof MCPTransportError && failure.failure === "timeout")).toBe(
			true,
		);
		expect((error as Error).message).not.toContain("No MCP server has resource");
		expect((error as Error).message).not.toContain("(none)");
	});

	it("preserves a settled startup failure instead of claiming the server has no resources", async () => {
		const connect = mcpClient.connectToServer;
		let startupFailure: unknown;
		const connectSpy = vi.spyOn(mcpClient, "connectToServer").mockImplementation(async (...args) => {
			try {
				return await connect(...args);
			} catch (error) {
				startupFailure = error;
				throw error;
			}
		});
		try {
			const { manager, handler } = await setup("unavailable");
			await manager.waitForStartup(0);
			if (!(startupFailure instanceof Error)) throw new Error("Expected the original startup error");
			expect(startupFailure).toMatchObject({ code: -32001, failure: "json_rpc" });

			const error = await rejection(handler.resolve(parseInternalUrl("mcp://test://connected")));
			if (!(error instanceof Error)) throw new Error("Expected the resource-read failure");
			expect(errorCauses(error)).toContain(startupFailure);
			expect(error.message).toContain("-32001");
			expect(error.message).toContain("Back-end application unavailable");
			expect(error.message).not.toContain("No MCP server has resource");
			expect(error.message).not.toContain("(none)");
		} finally {
			connectSpy.mockRestore();
		}
	});

	it.each(["read", "catalog", "initialize"])("preserves caller cancellation during %s", async mode => {
		using temp = TempDir.createSync("@mcp-resource-cancellation-");
		const releasePath = path.join(temp.path(), "ready");
		const { manager, received, handler } = await setup(mode, 360_000, {
			SILENT_MCP_RELEASE_PATH: releasePath,
		});
		if (mode === "read") await manager.ensureServerResources("fixture");
		const readiness = observeResourceReadiness(manager);
		try {
			const caller = new AbortController();
			const reason = new Error("The caller cancelled this resource read");
			const result = rejection(
				handler.resolve(parseInternalUrl(mode === "read" ? "mcp://test://silent" : "mcp://test://connected"), {
					signal: caller.signal,
				}),
			);
			await received;
			if (mode === "catalog") await readiness.catalog;
			if (mode === "initialize") await readiness.connection;
			caller.abort(reason);
			expect(await result).toBe(reason);
			expect(manager.getConnectionStatus("fixture")).toBe(mode === "initialize" ? "connecting" : "connected");

			if (mode === "initialize") {
				await Bun.write(releasePath, "ready");
				await manager.waitForPendingConnections();
				await manager.ensureServerResources("fixture");
				const connected = await handler.resolve(parseInternalUrl("mcp://test://connected"));
				expect(connected.content).toBe("The connected resource is available.");
			}
		} finally {
			readiness.restore();
		}
	});
});
