import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { addManagedWorktree, targetCwdForRecord } from "@oh-my-pi/pi-coding-agent/worktree/manager";
import { getProjectDir, removeWithRetries, Snowflake, setProjectDir, setWorktreesDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

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

async function seedGitRepo(repoRoot: string): Promise<void> {
	await $`git init`.cwd(repoRoot).quiet();
	await $`git config user.email omp-test@example.com`.cwd(repoRoot).quiet();
	await $`git config user.name "OMP Test"`.cwd(repoRoot).quiet();
	await fs.promises.writeFile(path.join(repoRoot, "README.md"), "root\n", "utf8");
	await $`git add README.md`.cwd(repoRoot).quiet();
	await $`git commit -m init`.cwd(repoRoot).quiet();
}

const originalProjectDir = getProjectDir();

describe("createAgentSession cwd after /move", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		setWorktreesDir(undefined);
		setProjectDir(originalProjectDir);
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
		const { session } = await createAgentSession({
			cwd: cwdA,
			agentDir: tempDir,
			sessionManager,
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
			toolNames: ["read"],
		});

		try {
			await sessionManager.moveTo(cwdB);

			const readTool = session.getToolByName("read");
			if (!readTool) throw new Error("Expected read tool");
			const result = await readTool.execute("read-after-move", { path: "marker.txt:raw" });

			expect(textContent(result)).toBe("moved\n");
		} finally {
			await session.dispose();
		}
	});

	it("runs tools in a managed worktree after /worktree switch and back in the local repo after /move", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-worktree-cwd-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const repoRoot = path.join(tempDir, "repo");
		const worktreeBase = path.join(tempDir, "worktree-base");
		fs.mkdirSync(repoRoot, { recursive: true });
		fs.mkdirSync(worktreeBase, { recursive: true });
		await seedGitRepo(repoRoot);
		setWorktreesDir(worktreeBase);
		setProjectDir(repoRoot);

		const sessionManager = SessionManager.create(repoRoot, path.join(tempDir, "sessions"));
		const settings = Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
		});
		const { session } = await createAgentSession({
			cwd: repoRoot,
			agentDir: tempDir,
			sessionManager,
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read"],
		});

		try {
			const added = await addManagedWorktree({ cwd: repoRoot, name: "sdk-bg", dirtyPolicy: "ignore" });
			const expectedWorktreeCwd = targetCwdForRecord(added.record);
			await fs.promises.writeFile(path.join(repoRoot, "marker.txt"), "local\n", "utf8");
			await fs.promises.writeFile(path.join(expectedWorktreeCwd, "marker.txt"), "background\n", "utf8");
			const output: string[] = [];
			const runtime = {
				session,
				sessionManager,
				settings,
				cwd: repoRoot,
				output: (text: string) => {
					output.push(text);
				},
				refreshCommands: () => {},
				reloadPlugins: async () => {},
				notifyConfigChanged: () => {},
				notifyTitleChanged: () => {},
			};

			const switchResult = await executeAcpBuiltinSlashCommand("/worktree switch sdk-bg", runtime);
			expect(switchResult).toEqual({ consumed: true });
			const readTool = session.getToolByName("read");
			if (!readTool) throw new Error("Expected read tool");
			const worktreeRead = await readTool.execute("read-after-worktree-switch", { path: "marker.txt:raw" });
			expect(textContent(worktreeRead)).toBe("background\n");

			const moveResult = await executeAcpBuiltinSlashCommand(`/move ${repoRoot}`, {
				...runtime,
				cwd: expectedWorktreeCwd,
			});
			expect(moveResult).toEqual({ consumed: true });
			const localRead = await readTool.execute("read-after-moving-back", { path: "marker.txt:raw" });
			expect(textContent(localRead)).toBe("local\n");
		} finally {
			await session.dispose();
		}
	});
});
