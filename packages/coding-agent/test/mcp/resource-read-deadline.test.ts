import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { McpProtocolHandler } from "../../src/internal-urls/mcp-protocol";
import { parseInternalUrl } from "../../src/internal-urls/parse";
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

	it("bounds readiness waits without stopping the shared pending connection", async () => {
		using temp = TempDir.createSync("@mcp-resource-readiness-");
		const releasePath = path.join(temp.path(), "ready");
		const { manager, received, handler } = await setup("initialize", 360_000, {
			SILENT_MCP_RELEASE_PATH: releasePath,
		});
		expect(await received).toEqual({ method: "initialize" });

		vi.useFakeTimers();
		const result = rejection(handler.resolve(parseInternalUrl("mcp://test://connected")));
		vi.advanceTimersByTime(30_000);
		const error = await result;
		expect((error as Error).cause).toMatchObject({ failure: "timeout", stage: "connect", retryable: false });
		expect((error as Error).message).toContain("fixture");
		expect(manager.getConnectionStatus("fixture")).toBe("connecting");

		vi.useRealTimers();
		await Bun.write(releasePath, "ready");
		await manager.waitForPendingConnections();
		await manager.ensureServerResources("fixture");
		const connected = await handler.resolve(parseInternalUrl("mcp://test://connected"));
		expect(connected.content).toBe("The connected resource is available.");
	});

	it("reports catalog unavailability rather than inventing an empty resource list", async () => {
		const { received, handler } = await setup("catalog");
		expect(await received).toEqual({ method: "resources/list" });
		process.env.OMP_MCP_TIMEOUT_MS = "50";

		const error = await rejection(handler.resolve(parseInternalUrl("mcp://test://connected")));
		expect((error as Error).cause).toBeInstanceOf(AggregateError);
		const failures = ((error as Error).cause as AggregateError).errors;
		expect(failures.some((failure: Error) => (failure.cause as MCPTransportError)?.failure === "timeout")).toBe(true);
		expect((error as Error).message).not.toContain("No MCP server has resource");
		expect((error as Error).message).not.toContain("(none)");
	});

	it("preserves a settled startup failure instead of claiming the server has no resources", async () => {
		const { handler } = await setup("unavailable");
		const error = await rejection(handler.resolve(parseInternalUrl("mcp://test://connected")));
		expect((error as Error).cause).toBeInstanceOf(AggregateError);
		expect((error as Error).message).toContain("-32001");
		expect((error as Error).message).toContain("Back-end application unavailable");
		expect((error as Error).message).not.toContain("No MCP server has resource");
		expect((error as Error).message).not.toContain("(none)");
	});

	it.each(["read", "catalog", "initialize"])("preserves caller cancellation during %s", async mode => {
		const { manager, received, handler } = await setup(mode);
		if (mode === "read") await manager.ensureServerResources("fixture");
		const caller = new AbortController();
		const reason = new Error("The caller cancelled this resource read");
		const result = rejection(
			handler.resolve(parseInternalUrl(mode === "read" ? "mcp://test://silent" : "mcp://test://connected"), {
				signal: caller.signal,
			}),
		);
		await received;
		caller.abort(reason);
		expect(await result).toBe(reason);
	});
});
