import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function textContent(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter(
				(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
			)
			.map(block => block.text)
			.join("\n") ?? ""
	);
}

describe("createAgentSession cwd after /move", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const tempDir of tempDirs.splice(0)) {
			await removeWithRetries(tempDir).catch(() => {});
		}
	});

	it("runs tools from the moved session directory", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-move-cwd-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "cwd-a");
		const cwdB = path.join(tempDir, "cwd-b");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });
		fs.writeFileSync(path.join(cwdA, "marker.txt"), "source\n", "utf8");
		fs.writeFileSync(path.join(cwdB, "marker.txt"), "moved\n", "utf8");

		const sessionManager = SessionManager.create(cwdA, path.join(tempDir, "sessions"));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const { session } = await createAgentSession({
			cwd: cwdA,
			agentDir: tempDir,
			sessionManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read", "bash"],
		});

		try {
			await sessionManager.moveTo(cwdB);

			const readTool = session.getToolByName("read");
			if (!readTool) throw new Error("Expected read tool");
			const result = await readTool.execute("read-after-move", { path: "marker.txt:raw" });

			expect(textContent(result)).toBe("moved\n");

			const bashTool = session.getToolByName("bash");
			if (!bashTool) throw new Error("Expected bash tool");
			const pwdResult = await bashTool.execute("pwd-after-move", { command: "pwd" });

			expect(textContent(pwdResult)).toContain(cwdB);
		} finally {
			try {
				await session.dispose();
			} finally {
				authStorage.close();
			}
		}
	});
});
