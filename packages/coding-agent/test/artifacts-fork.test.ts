import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as vm from "node:vm";
import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { copySessionArtifacts, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createHelpers } from "../src/eval/js/shared/helpers";
import { JAVASCRIPT_PRELUDE_SOURCE } from "../src/eval/js/shared/prelude";
import { callSessionTool } from "../src/eval/js/tool-bridge";

function resultText(result: AgentToolResult): string {
	return result.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

describe("forked session artifact namespace", () => {
	it("round-trips a URL spill after the child allocator initialized before inherited artifacts were copied", async () => {
		using temp = TempDir.createSync("@omp-artifacts-fork-");
		const manager = SessionManager.create(temp.path(), temp.join("sessions"));
		const settings = Settings.isolated({
			"async.enabled": false,
			"marketplace.autoUpdate": "off",
			"eval.py": false,
		});
		const authStorage = await AuthStorage.create(temp.join("auth.db"));
		authStorage.keys.setRuntime("openai", "test-key");
		const coordinates = Array.from({ length: 940 }, (_, index) => [120 + index / 1000, 36 + index / 2000]);
		const route = { code: "Ok", routes: [{ geometry: { type: "LineString", coordinates } }] };
		const routeJson = [
			'{\n  "code": "Ok",\n  "routes": [{\n    "geometry": {\n      "type": "LineString",\n      "coordinates": [',
			coordinates.map(coordinate => `        ${JSON.stringify(coordinate)}`).join(",\n"),
			"      ]\n    }\n  }]\n}",
		].join("\n");
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(routeJson, { headers: { "Content-Type": "application/json" } }),
		});
		try {
			const { session } = await createAgentSession({
				cwd: temp.path(),
				agentDir: temp.path(),
				sessionManager: manager,
				authStorage,
				model: getBundledModel("openai", "gpt-4o-mini"),
				settings,
				restrictToolNames: true,
				toolNames: ["read"],
				disableExtensionDiscovery: true,
				preloadedCustomToolPaths: [],
				skipPythonPreflight: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				workspaceTree: {
					rootPath: temp.path(),
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
				enableMCP: false,
				enableLsp: false,
			});
			try {
				const readTool = session.getToolByName("read");
				if (!readTool) throw new Error("Expected SDK read tool");
				for (let index = 0; index < 5; index++) await manager.saveArtifact(`parent-${index}`, "bash");
				const template = '<!DOCTYPE html>\n<html lang="zh-CN">\n<title>Parent template</title>\n</html>\n';
				expect(await manager.saveArtifact(template, "bash")).toBe("5");
				manager.appendMessage({ role: "user", content: "Inspect artifact://5", timestamp: 1 });
				await manager.ensureOnDisk();
				const parentFile = manager.getSessionFile()!;
				const parentHistory = await Bun.file(parentFile).text();
				const parentArtifacts = manager.getArtifactManager()!;

				const fork = await manager.fork();
				if (!fork) throw new Error("Expected persisted fork");
				// Initialize the active child allocator and consume IDs without writing
				// files, just as streaming tools can do before publishing their output.
				const childArtifacts = manager.getArtifactManager()!;
				for (let index = 0; index < 5; index++) await manager.allocateArtifactPath("eval");
				await copySessionArtifacts(fork.oldSessionFile, fork.newSessionFile);

				// This tool was built before the fork. Its SDK allocation callback must
				// use the active child's namespace, including the newly copied ID 5.
				const initial = await readTool.execute("route-spill", { path: `${server.url.origin}/route:raw` });
				const artifactId = resultText(initial).match(/\bartifact:\/\/(\d+)/u)?.[1];
				if (!artifactId) throw new Error("Expected URL read to spill to an artifact");
				expect(Number(artifactId)).toBeGreaterThan(5);
				const artifactPath = await manager.getArtifactPath(artifactId);
				if (!artifactPath) throw new Error("Expected spilled artifact file");
				expect(path.dirname(artifactPath)).toBe(childArtifacts.dir);
				const selector = `artifact://${artifactId}:raw:1-3000`;
				const direct = resultText(await readTool.execute("recover-route", { path: selector }));
				expect(direct).toContain(routeJson);
				expect(JSON.parse(direct.split("\n---\n\n")[1]!)).toEqual(route);

				const bridgeSession: ToolSession = {
					cwd: temp.path(),
					hasUI: false,
					getSessionFile: () => manager.getSessionFile() ?? null,
					getSessionSpawns: () => "*",
					getArtifactsDir: () => manager.getArtifactsDir(),
					getToolContext: () => ({ sessionManager: manager, settings }) as unknown as AgentToolContext,
					getToolByName: name => session.getToolByName(name),
					sessionManager: manager,
					settings,
				};
				const sandbox = vm.createContext({
					__omp_helpers__: createHelpers({
						cwd: () => temp.path(),
						env: new Map(),
						localRoots: () => ({}),
						emitStatus: () => {},
					}),
					__omp_call_tool__: (name: string, args: unknown) =>
						callSessionTool(name, args, { session: bridgeSession }),
				});
				vm.runInContext(JAVASCRIPT_PRELUDE_SOURCE, sandbox);
				expect(await vm.runInContext(`read(${JSON.stringify(selector)})`, sandbox)).toBe(direct);

				const contents = Array.from({ length: 16 }, (_, index) => `child-output-${index}`);
				const ids = await Promise.all(
					contents.map((content, index) => manager.saveArtifact(content, index % 2 === 0 ? "read" : "bash")),
				);
				expect(new Set(ids).size).toBe(contents.length);
				for (const [index, id] of ids.entries()) {
					expect(Number(id)).toBeGreaterThan(Number(artifactId));
					expect(await Bun.file((await manager.getArtifactPath(id!))!).text()).toBe(contents[index]);
				}

				expect(resultText(await readTool.execute("inherited-template", { path: "artifact://5:raw:1-25" }))).toBe(
					template,
				);
				for (let index = 0; index < 6; index++) {
					const expected = index === 5 ? template : `parent-${index}`;
					expect(await Bun.file((await parentArtifacts.getPath(String(index)))!).text()).toBe(expected);
					expect(await Bun.file((await childArtifacts.getPath(String(index)))!).text()).toBe(expected);
				}
				expect(await Bun.file(parentFile).text()).toBe(parentHistory);
			} finally {
				await session.dispose();
			}
		} finally {
			server.stop(true);
			authStorage.close();
			await manager.close();
		}
	}, 30_000);
});
