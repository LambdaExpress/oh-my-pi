import { createInterface } from "node:readline";

const mode = process.env.SILENT_MCP_MODE ?? "read";
const input = createInterface({ input: process.stdin });

for await (const line of input) {
	const request = JSON.parse(line);
	if (request.id === undefined) continue;
	const received = () =>
		process.stdout.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				method: "notifications/fixture/received",
				params: { method: request.method, uri: request.params?.uri, pid: process.pid },
			})}\n`,
		);
	let result: unknown;
	switch (request.method) {
		case "initialize":
			if (mode === "unavailable") {
				received();
				process.stdout.write(
					`${JSON.stringify({
						jsonrpc: "2.0",
						id: request.id,
						error: { code: -32001, message: "Back-end application unavailable" },
					})}\n`,
				);
				continue;
			}
			if (mode === "initialize") {
				received();
				const releasePath = process.env.SILENT_MCP_RELEASE_PATH;
				if (!releasePath) continue;
				while (!(await Bun.file(releasePath).exists())) await Bun.sleep(10);
			}
			result = {
				protocolVersion: request.params.protocolVersion,
				capabilities: { resources: {} },
				serverInfo: { name: "silent-resource-fixture", version: "1" },
			};
			break;
		case "resources/list":
			if (mode === "catalog") {
				received();
				continue;
			}
			result = {
				resources: [
					{ uri: "test://connected", name: "Connected resource" },
					{ uri: "test://silent", name: "Silent resource" },
				],
			};
			break;
		case "resources/templates/list":
			result = { resourceTemplates: [] };
			break;
		case "resources/read":
			if (request.params.uri === "test://silent") {
				received();
				continue;
			}
			result = { contents: [{ uri: request.params.uri, text: "The connected resource is available." }] };
			break;
		default:
			process.stdout.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } })}\n`,
			);
			continue;
	}
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}
