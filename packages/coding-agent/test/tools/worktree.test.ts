import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type ToolSession, WorktreeTool } from "@oh-my-pi/pi-coding-agent/tools";
import { targetCwdForRecord } from "@oh-my-pi/pi-coding-agent/worktree/manager";
import { readManagedWorktreeRecord } from "@oh-my-pi/pi-coding-agent/worktree/metadata";
import type { WorktreeToolDetails } from "@oh-my-pi/pi-coding-agent/tools/worktree";
import type { ManagedWorktreeRecord } from "@oh-my-pi/pi-coding-agent/worktree/types";
import { removeWithRetries, setWorktreesDir } from "@oh-my-pi/pi-utils";

const ENV_KEYS = [
	"OMP_WORKTREE_DIR",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_TERMINAL_PROMPT",
	"GIT_ASKPASS",
	"XDG_CONFIG_HOME",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];
type WorktreeParams = Parameters<WorktreeTool["execute"]>[1];

let tempRoot: string;
let worktreeBase: string;
let previousEnv: Partial<Record<EnvKey, string | undefined>>;

function restoreEnv(): void {
	for (const key of ENV_KEYS) {
		const value = previousEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function createToolSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		...overrides,
	};
}

function textContent(result: { content?: Array<{ type: string; text?: string }> }): string {
	return result.content?.map(item => (item.type === "text" ? (item.text ?? "") : "")).join("") ?? "";
}

function detailsOf(result: { details?: WorktreeToolDetails }): WorktreeToolDetails {
	expect(result.details).toBeDefined();
	return result.details as WorktreeToolDetails;
}

async function executeWorktree(session: ToolSession, params: WorktreeParams) {
	return new WorktreeTool(session).execute("call-worktree", params);
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

async function runGit(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stderr: "pipe",
		stdout: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test User",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test User",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
		windowsHide: true,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode ?? 0}`;
		throw new Error(`git ${args.join(" ")} failed: ${detail}`);
	}
	return stdout.trim();
}

async function createGitRepo(name: string): Promise<{ repoRoot: string; initialSha: string }> {
	const repoRoot = path.join(tempRoot, name);
	await fs.mkdir(repoRoot, { recursive: true });
	await runGit(repoRoot, ["init", "-q", "-b", "main"]);
	await runGit(repoRoot, ["config", "user.email", "test@example.com"]);
	await runGit(repoRoot, ["config", "user.name", "Test User"]);
	await fs.mkdir(path.join(repoRoot, "packages", "agent"), { recursive: true });
	await fs.writeFile(path.join(repoRoot, "README.md"), "base\n", "utf8");
	await fs.writeFile(path.join(repoRoot, "packages", "agent", "index.ts"), "export const value = 1;\n", "utf8");
	await runGit(repoRoot, ["add", "."]);
	await runGit(repoRoot, ["commit", "-q", "-m", "initial"]);
	return { repoRoot, initialSha: await runGit(repoRoot, ["rev-parse", "HEAD"]) };
}

async function addWorktree(session: ToolSession, name: string): Promise<ManagedWorktreeRecord> {
	const result = await executeWorktree(session, { op: "add", name, dirtyPolicy: "ignore" });
	const details = detailsOf(result);
	expect(details.record).toBeDefined();
	return details.record as ManagedWorktreeRecord;
}

beforeEach(async () => {
	previousEnv = {};
	for (const key of ENV_KEYS) previousEnv[key] = process.env[key];

	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worktree-tool-"));
	worktreeBase = path.join(tempRoot, "managed-worktrees");
	await fs.mkdir(worktreeBase, { recursive: true });
	await fs.writeFile(path.join(tempRoot, "gitconfig"), "", "utf8");

	process.env.OMP_WORKTREE_DIR = worktreeBase;
	process.env.GIT_CONFIG_GLOBAL = path.join(tempRoot, "gitconfig");
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	process.env.GIT_TERMINAL_PROMPT = "0";
	process.env.GIT_ASKPASS = "true";
	process.env.XDG_CONFIG_HOME = path.join(tempRoot, "xdg");
	delete process.env.GIT_CONFIG_SYSTEM;
	setWorktreesDir(worktreeBase);
});

afterEach(async () => {
	setWorktreesDir(undefined);
	restoreEnv();
	await removeWithRetries(tempRoot).catch(() => {});
});

describe("WorktreeTool", () => {
	it("reports an empty managed worktree list for a repository with no records", async () => {
		const { repoRoot } = await createGitRepo("empty-list");
		const result = await executeWorktree(createToolSession(repoRoot), { op: "list" });
		const details = detailsOf(result);

		expect(details.op).toBe("list");
		expect(details.items).toEqual([]);
		expect(textContent(result)).toBe("No managed worktrees for this repository.");
	});

	it("creates a detached managed worktree, persists metadata, and returns the target cwd", async () => {
		const { repoRoot, initialSha } = await createGitRepo("add-detached");
		const result = await executeWorktree(createToolSession(repoRoot), {
			op: "add",
			name: "Detached Task",
			dirtyPolicy: "ignore",
		});
		const details = detailsOf(result);
		const record = details.record as ManagedWorktreeRecord;

		expect(details).toMatchObject({
			op: "add",
			worktreeRoot: record.worktreeRoot,
			targetCwd: targetCwdForRecord(record),
			warnings: [],
		});
		expect(record).toMatchObject({
			name: "Detached Task",
			primaryRoot: repoRoot,
			sourceRepoRoot: repoRoot,
			relativeCwd: "",
			baseSha: initialSha,
			headSha: initialSha,
			state: "ready",
			detached: true,
			sessionFile: null,
			sessionId: null,
			title: null,
			dirtyPolicy: "ignore",
		});
		expect(await fs.readFile(path.join(details.targetCwd as string, "README.md"), "utf8")).toBe("base\n");
		expect(await runGit(details.targetCwd as string, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
		expect(await readManagedWorktreeRecord(record.id)).toEqual(record);
		expect(textContent(result)).toContain(`Target cwd: ${targetCwdForRecord(record)}`);
	});

	it("creates recursive managed worktrees when requested", async () => {
		const { repoRoot } = await createGitRepo("add-recursive");
		const result = await executeWorktree(createToolSession(repoRoot), {
			op: "add",
			name: "Recursive Task",
			dirtyPolicy: "ignore",
			recurseSubmodules: true,
		});
		const details = detailsOf(result);
		const record = details.record as ManagedWorktreeRecord;

		expect(record.recurseSubmodules).toBe(true);
		expect(record.submodules).toEqual([]);
		expect(details.warnings).toEqual([]);
		expect(textContent(result)).toContain("Recursive submodules: enabled");
	});

	it("resolves a managed worktree target cwd by id or by name", async () => {
		const { repoRoot } = await createGitRepo("path-resolution");
		const session = createToolSession(repoRoot);
		const record = await addWorktree(session, "Path Target");
		const expectedTargetCwd = targetCwdForRecord(record);

		const byId = await executeWorktree(session, { op: "path", idOrName: record.id });
		const byName = await executeWorktree(session, { op: "path", idOrName: record.name });

		expect(detailsOf(byId)).toMatchObject({
			op: "path",
			record,
			worktreeRoot: record.worktreeRoot,
			targetCwd: expectedTargetCwd,
		});
		expect(textContent(byId)).toBe(expectedTargetCwd);
		expect(detailsOf(byName)).toMatchObject({
			op: "path",
			record,
			worktreeRoot: record.worktreeRoot,
			targetCwd: expectedTargetCwd,
		});
		expect(textContent(byName)).toBe(expectedTargetCwd);
	});

	it("switches the current session cwd and writes the current session binding to metadata", async () => {
		const { repoRoot } = await createGitRepo("switch-session");
		const movedCwds: string[] = [];
		const sessionFile = path.join(tempRoot, "sessions", "session.json");
		const session = createToolSession(repoRoot, {
			getSessionFile: () => sessionFile,
			getSessionId: () => "session-123",
			getSessionName: () => "Current Session Title",
			moveSessionToCwd: async cwd => {
				movedCwds.push(cwd);
			},
		});
		const record = await addWorktree(session, "Switch Target");
		const expectedTargetCwd = targetCwdForRecord(record);

		const result = await executeWorktree(session, { op: "switch", idOrName: record.id });
		const details = detailsOf(result);
		const persisted = await readManagedWorktreeRecord(record.id);

		expect(movedCwds).toEqual([expectedTargetCwd]);
		expect(details).toMatchObject({
			op: "switch",
			worktreeRoot: record.worktreeRoot,
			targetCwd: expectedTargetCwd,
			switchedCwd: expectedTargetCwd,
		});
		expect(details.record).toMatchObject({
			id: record.id,
			sessionFile,
			sessionId: "session-123",
			title: "Current Session Title",
		});
		expect(persisted).toMatchObject({
			id: record.id,
			sessionFile,
			sessionId: "session-123",
			title: "Current Session Title",
		});
		expect(textContent(result)).toContain(
			`Switched current session to managed worktree ${record.name}: ${expectedTargetCwd}`,
		);
	});

	it("rejects switch when the session cannot move cwd", async () => {
		const { repoRoot } = await createGitRepo("switch-missing-hook");
		const session = createToolSession(repoRoot);
		const record = await addWorktree(session, "No Hook Target");

		await expect(executeWorktree(session, { op: "switch", idOrName: record.id })).rejects.toThrow(
			"Current mode does not support moving the session cwd from the worktree tool.",
		);
	});

	it("removes a clean managed worktree, deletes metadata, and omits it from later lists", async () => {
		const { repoRoot } = await createGitRepo("remove-clean");
		const session = createToolSession(repoRoot);
		const record = await addWorktree(session, "Remove Target");
		expect(await readManagedWorktreeRecord(record.id)).toEqual(record);
		expect(await pathExists(record.worktreeRoot)).toBe(true);

		const result = await executeWorktree(session, { op: "remove", idOrName: record.id });
		const details = detailsOf(result);
		const listedAfterRemove = await executeWorktree(session, { op: "list" });

		expect(details).toMatchObject({ op: "remove", removed: true });
		expect(textContent(result)).toBe(`Removed managed worktree ${record.id}.`);
		expect(await readManagedWorktreeRecord(record.id)).toBeNull();
		expect(await pathExists(record.worktreeRoot)).toBe(false);
		expect(detailsOf(listedAfterRemove).items).toEqual([]);
	});
});
