import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { readMcpResource } from "../../src/internal-urls/mcp-protocol";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import { MCPTransportError } from "../../src/mcp/errors";
import { MCPManager } from "../../src/mcp/manager";

const FIXTURE = path.join(import.meta.dir, "fixtures", "failed-startup-server.ts");
const ORIGINAL_TIMEOUT = process.env.OMP_MCP_TIMEOUT_MS;
const managers: MCPManager[] = [];

afterEach(async () => {
	await Promise.all(managers.splice(0).map(manager => manager.disconnectAll()));
	if (ORIGINAL_TIMEOUT === undefined) delete process.env.OMP_MCP_TIMEOUT_MS;
	else process.env.OMP_MCP_TIMEOUT_MS = ORIGINAL_TIMEOUT;
});

function errorCauses(error: unknown): Error[] {
	if (!(error instanceof Error)) return [];
	return [
		error,
		...errorCauses(error.cause),
		...(error instanceof AggregateError ? error.errors.flatMap(errorCauses) : []),
	];
}

async function failStartup(mode: string) {
	delete process.env.OMP_MCP_TIMEOUT_MS;
	const manager = new MCPManager(process.cwd());
	managers.push(manager);
	const startup = await manager.connectServers(
		{
			fixture: {
				type: "stdio",
				command: process.execPath,
				args: [FIXTURE, mode],
				timeout: 5_000,
			},
		},
		{},
		undefined,
		0,
	);
	const error = await readMcpResource(manager, parseInternalUrl("mcp://test://unavailable")).then(
		() => undefined,
		reason => reason,
	);
	if (!(error instanceof Error)) throw new Error("Expected the failed MCP startup to reject the resource read");
	const diagnostic = errorCauses(error).find(cause => cause instanceof MCPTransportError);
	if (!(diagnostic instanceof MCPTransportError)) throw error;
	return { startup, error, diagnostic };
}

describe("MCP stdio startup diagnostics", () => {
	it.each(["short", "long"])("preserves the exit code and redacted stderr tail after %s output", async mode => {
		const { startup, error, diagnostic } = await failStartup(mode);
		expect(diagnostic).toMatchObject({ transport: "stdio", stage: "receive", failure: "eof", code: 23 });
		expect(diagnostic.message).toContain("MCP subprocess exited with code 23 before responding");
		expect(diagnostic.message).toContain("Traceback (most recent call last):");
		expect(diagnostic.message).toContain("RuntimeError: Unity editor 启动失败: backend refused connection");
		expect(diagnostic.message).toContain("Stderr tail");
		expect(diagnostic.message).toContain("[redacted]");
		expect(diagnostic.message).not.toContain("fixture-bearer-secret");
		expect(diagnostic.message).not.toContain("fixture-url-secret");
		expect(diagnostic.message).not.toContain("fixture-password-secret");
		expect(diagnostic.message).not.toContain("fixture-truncated-secret-");
		expect(diagnostic.message).not.toContain("\uFFFD");
		expect(diagnostic.message.length).toBeLessThanOrEqual(1_000);
		expect(startup.errors.get("fixture")).toBe(diagnostic.message);
		expect(error.message).toContain("RuntimeError: Unity editor 启动失败: backend refused connection");
		expect(error.message).not.toContain("No MCP server has resource");
	});
});
