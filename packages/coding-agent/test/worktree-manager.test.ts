import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	addManagedWorktree,
	branchManagedWorktree,
	removeManagedWorktree,
	targetCwdForRecord,
} from "@oh-my-pi/pi-coding-agent/worktree/manager";
import {
	listManagedWorktreeRecords,
	managedMetadataDir,
	readManagedWorktreeRecord,
} from "@oh-my-pi/pi-coding-agent/worktree/metadata";
import type { ManagedWorktreeRecord } from "@oh-my-pi/pi-coding-agent/worktree/types";
import { hashPath, removeWithRetries, setWorktreesDir } from "@oh-my-pi/pi-utils";

const ENV_KEYS = [
	"OMP_WORKTREE_DIR",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_TERMINAL_PROMPT",
	"GIT_ASKPASS",
	"XDG_CONFIG_HOME",
	"GIT_ALLOW_PROTOCOL",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

interface GitWorktreeEntry {
	worktree: string;
	head: string | null;
	branch: string | null;
	detached: boolean;
}
interface RecursiveSubmoduleFixture {
	leafRepoRoot: string;
	childRepoRoot: string;
	superRepoRoot: string;
}


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

function normalizePathForCompare(value: string): string {
	const normalized = path.resolve(value).replaceAll("\\", "/");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
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

function parseWorktreeList(output: string): GitWorktreeEntry[] {
	return output
		.split(/\r?\n\r?\n/)
		.map(block => block.trim())
		.filter(Boolean)
		.map(block => {
			const entry: GitWorktreeEntry = { worktree: "", head: null, branch: null, detached: false };
			for (const line of block.split(/\r?\n/)) {
				if (line.startsWith("worktree ")) entry.worktree = line.slice("worktree ".length);
				else if (line.startsWith("HEAD ")) entry.head = line.slice("HEAD ".length);
				else if (line.startsWith("branch ")) entry.branch = line.slice("branch ".length);
				else if (line === "detached") entry.detached = true;
			}
			return entry;
		});
}

async function listGitWorktrees(repoRoot: string): Promise<GitWorktreeEntry[]> {
	return parseWorktreeList(await runGit(repoRoot, ["worktree", "list", "--porcelain"]));
}

function findGitWorktree(entries: GitWorktreeEntry[], worktreeRoot: string): GitWorktreeEntry | undefined {
	const expected = normalizePathForCompare(worktreeRoot);
	return entries.find(entry => normalizePathForCompare(entry.worktree) === expected);
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
async function createRecursiveSubmoduleFixture(name: string): Promise<RecursiveSubmoduleFixture> {
	const leafRepoRoot = path.join(tempRoot, `${name}-leaf-submodule-repo`);
	await fs.mkdir(leafRepoRoot, { recursive: true });
	await runGit(leafRepoRoot, ["init", "-q", "-b", "main"]);
	await runGit(leafRepoRoot, ["config", "user.email", "test@example.com"]);
	await runGit(leafRepoRoot, ["config", "user.name", "Test User"]);
	await fs.writeFile(path.join(leafRepoRoot, "leaf.txt"), "leaf base\n", "utf8");
	await runGit(leafRepoRoot, ["add", "."]);
	await runGit(leafRepoRoot, ["commit", "-q", "-m", "leaf base"]);

	const childRepoRoot = path.join(tempRoot, `${name}-child-submodule-repo`);
	await fs.mkdir(childRepoRoot, { recursive: true });
	await runGit(childRepoRoot, ["init", "-q", "-b", "main"]);
	await runGit(childRepoRoot, ["config", "user.email", "test@example.com"]);
	await runGit(childRepoRoot, ["config", "user.name", "Test User"]);
	await fs.writeFile(path.join(childRepoRoot, "child.txt"), "child base\n", "utf8");
	await runGit(childRepoRoot, ["add", "."]);
	await runGit(childRepoRoot, ["commit", "-q", "-m", "child base"]);
	await runGit(childRepoRoot, ["submodule", "add", leafRepoRoot, "nested/leaf"]);
	await runGit(childRepoRoot, ["commit", "-q", "-m", "add leaf submodule"]);

	const superRepoRoot = path.join(tempRoot, `${name}-super-repo`);
	await fs.mkdir(superRepoRoot, { recursive: true });
	await runGit(superRepoRoot, ["init", "-q", "-b", "main"]);
	await runGit(superRepoRoot, ["config", "user.email", "test@example.com"]);
	await runGit(superRepoRoot, ["config", "user.name", "Test User"]);
	await fs.writeFile(path.join(superRepoRoot, "root.txt"), "root base\n", "utf8");
	await runGit(superRepoRoot, ["add", "."]);
	await runGit(superRepoRoot, ["commit", "-q", "-m", "root base"]);
	await runGit(superRepoRoot, ["submodule", "add", childRepoRoot, "modules/child"]);
	await runGit(superRepoRoot, ["commit", "-q", "-m", "add child submodule"]);
	await runGit(superRepoRoot, ["submodule", "update", "--init", "--recursive"]);

	return { leafRepoRoot, childRepoRoot, superRepoRoot };
}


async function readSidecarRecord(id: string): Promise<ManagedWorktreeRecord> {
	const content = await fs.readFile(path.join(managedMetadataDir(), `${id}.json`), "utf8");
	return JSON.parse(content) as ManagedWorktreeRecord;
}

async function metadataJsonFiles(): Promise<string[]> {
	const dir = managedMetadataDir();
	if (!(await pathExists(dir))) return [];
	return (await fs.readdir(dir)).filter(name => name.endsWith(".json")).sort();
}

beforeEach(async () => {
	previousEnv = {};
	for (const key of ENV_KEYS) previousEnv[key] = process.env[key];

	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worktree-manager-"));
	worktreeBase = path.join(tempRoot, "managed-worktrees");
	await fs.mkdir(worktreeBase, { recursive: true });

	process.env.OMP_WORKTREE_DIR = worktreeBase;
	process.env.GIT_CONFIG_GLOBAL = "/dev/null";
	process.env.GIT_CONFIG_SYSTEM = "/dev/null";
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	process.env.GIT_TERMINAL_PROMPT = "0";
	process.env.GIT_ALLOW_PROTOCOL = "file";
	process.env.GIT_ASKPASS = "true";
	delete process.env.XDG_CONFIG_HOME;
	setWorktreesDir(undefined);
});

afterEach(async () => {
	setWorktreesDir(undefined);
	restoreEnv();
	await removeWithRetries(tempRoot);
});

describe("managed worktree manager", () => {
	it("creates a detached managed worktree from the repository root with sidecar metadata", async () => {
		const { repoRoot, initialSha } = await createGitRepo("repo-root-create");

		const result = await addManagedWorktree({ cwd: repoRoot, name: "root task", dirtyPolicy: "ignore" });

		expect(result.worktreeRoot).toBe(result.record.worktreeRoot);
		expect(result.targetCwd).toBe(result.worktreeRoot);
		expect(targetCwdForRecord(result.record)).toBe(result.targetCwd);
		expect(await fs.readFile(path.join(result.worktreeRoot, "README.md"), "utf8")).toBe("base\n");
		expect(await runGit(result.worktreeRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");

		const gitEntry = findGitWorktree(await listGitWorktrees(repoRoot), result.worktreeRoot);
		expect(gitEntry).toMatchObject({ head: initialSha, branch: null, detached: true });

		const persisted = await readManagedWorktreeRecord(result.record.id);
		expect(persisted).toEqual(result.record);

		const sidecar = await readSidecarRecord(result.record.id);
		expect(sidecar).toMatchObject({
			id: result.record.id,
			name: "root task",
			owner: "omp",
			version: 2,
			primaryRoot: repoRoot,
			sourceRepoRoot: repoRoot,
			worktreeRoot: result.worktreeRoot,
			relativeCwd: "",
			baseSha: initialSha,
			headSha: initialSha,
			mode: "managed",
			state: "ready",
			branch: null,
			detached: true,
			sessionFile: null,
			sessionId: null,
			title: null,
			dirtyPolicy: "ignore",
			includeCopied: [],
			recurseSubmodules: false,
			submodules: [],
			snapshotPath: null,
			appliedAt: null,
		});
	});

	it("creates from a repository subdirectory and targets the matching subdirectory in the worktree", async () => {
		const { repoRoot, initialSha } = await createGitRepo("repo-subdir-create");
		const cwd = path.join(repoRoot, "packages", "agent");

		const result = await addManagedWorktree({ cwd, name: "subdir task", dirtyPolicy: "ignore" });

		expect(result.record.sourceRepoRoot).toBe(repoRoot);
		expect(result.record.primaryRoot).toBe(repoRoot);
		expect(result.record.relativeCwd).toBe(path.join("packages", "agent"));
		expect(result.targetCwd).toBe(path.join(result.worktreeRoot, "packages", "agent"));
		expect(targetCwdForRecord(result.record)).toBe(result.targetCwd);
		expect(await fs.readFile(path.join(result.targetCwd, "index.ts"), "utf8")).toBe("export const value = 1;\n");

		const sidecar = await readSidecarRecord(result.record.id);
		expect(sidecar).toMatchObject({
			id: result.record.id,
			relativeCwd: path.join("packages", "agent"),
			worktreeRoot: result.worktreeRoot,
			baseSha: initialSha,
			headSha: initialSha,
			state: "ready",
			detached: true,
		});
	});

	it("creates two independent detached managed worktrees from the same base commit", async () => {
		const { repoRoot, initialSha } = await createGitRepo("repo-two-detached");

		const first = await addManagedWorktree({ cwd: repoRoot, name: "parallel task", dirtyPolicy: "ignore" });
		const second = await addManagedWorktree({ cwd: repoRoot, name: "parallel task", dirtyPolicy: "ignore" });

		expect(first.record.id).not.toBe(second.record.id);
		expect(first.worktreeRoot).not.toBe(second.worktreeRoot);
		expect(await runGit(first.worktreeRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
		expect(await runGit(second.worktreeRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");

		const entries = await listGitWorktrees(repoRoot);
		expect(findGitWorktree(entries, first.worktreeRoot)).toMatchObject({
			head: initialSha,
			branch: null,
			detached: true,
		});
		expect(findGitWorktree(entries, second.worktreeRoot)).toMatchObject({
			head: initialSha,
			branch: null,
			detached: true,
		});

		expect(await listManagedWorktreeRecords()).toEqual(expect.arrayContaining([first.record, second.record]));
	});

	it("does not leave a Git worktree, project path, or metadata record when creation fails", async () => {
		const { repoRoot } = await createGitRepo("repo-failed-create");
		const beforeWorktrees = await listGitWorktrees(repoRoot);

		await expect(
			addManagedWorktree({
				cwd: repoRoot,
				name: "bad base",
				baseRef: "refs/heads/does-not-exist",
				dirtyPolicy: "ignore",
			}),
		).rejects.toThrow();

		expect((await listGitWorktrees(repoRoot)).map(entry => normalizePathForCompare(entry.worktree))).toEqual(
			beforeWorktrees.map(entry => normalizePathForCompare(entry.worktree)),
		);
		expect(await listManagedWorktreeRecords()).toEqual([]);
		expect(await metadataJsonFiles()).toEqual([]);
		expect(await pathExists(path.join(worktreeBase, hashPath(repoRoot)))).toBe(false);
	});

	it("add leaves submodules uninitialized by default", async () => {
		const { superRepoRoot } = await createRecursiveSubmoduleFixture("plain-recursive");

		const result = await addManagedWorktree({ cwd: superRepoRoot, name: "plain", dirtyPolicy: "ignore" });

		expect(result.record.recurseSubmodules).toBe(false);
		expect(result.record.submodules).toEqual([]);
		await expect(pathExists(path.join(result.worktreeRoot, "modules", "child", "child.txt"))).resolves.toBe(false);
		expect(await runGit(result.worktreeRoot, ["submodule", "status", "--recursive"])).toContain("-");
	}, 30_000);

	it("add initializes recursive submodules when requested", async () => {
		const { superRepoRoot } = await createRecursiveSubmoduleFixture("enabled-recursive");

		const result = await addManagedWorktree({
			cwd: superRepoRoot,
			name: "recursive",
			dirtyPolicy: "ignore",
			recurseSubmodules: true,
		});

		await expect(Bun.file(path.join(result.worktreeRoot, "modules", "child", "child.txt")).text()).resolves.toBe(
			"child base\n",
		);
		await expect(
			Bun.file(path.join(result.worktreeRoot, "modules", "child", "nested", "leaf", "leaf.txt")).text(),
		).resolves.toBe("leaf base\n");
		expect(result.record.recurseSubmodules).toBe(true);
		expect(result.record.submodules.map(submodule => submodule.path).sort()).toEqual([
			"modules/child",
			"modules/child/nested/leaf",
		]);
		expect(result.record.submodules.find(submodule => submodule.path === "modules/child")?.parentPath).toBeNull();
		expect(result.record.submodules.find(submodule => submodule.path === "modules/child/nested/leaf")?.parentPath).toBe(
			"modules/child",
		);
		const status = await runGit(result.worktreeRoot, ["submodule", "status", "--recursive"]);
		expect(status.split(/\r?\n/).filter(Boolean).some(line => line.startsWith("-"))).toBe(false);
	}, 30_000);


	it("removes a clean managed worktree and prunes its empty project directory", async () => {
		const { repoRoot } = await createGitRepo("repo-clean-remove");
		const created = await addManagedWorktree({ cwd: repoRoot, name: "clean removal", dirtyPolicy: "ignore" });
		const projectWorktreeDir = path.join(worktreeBase, hashPath(repoRoot));

		expect(path.dirname(created.worktreeRoot)).toBe(projectWorktreeDir);
		expect(await pathExists(created.worktreeRoot)).toBe(true);
		expect(await pathExists(projectWorktreeDir)).toBe(true);

		await expect(removeManagedWorktree({ cwd: repoRoot, idOrName: created.record.id })).resolves.toBeNull();

		expect(await pathExists(created.worktreeRoot)).toBe(false);
		expect(await pathExists(projectWorktreeDir)).toBe(false);
		expect(findGitWorktree(await listGitWorktrees(repoRoot), created.worktreeRoot)).toBeUndefined();
		expect(await readManagedWorktreeRecord(created.record.id)).toBeNull();
		expect(await listManagedWorktreeRecords()).toEqual([]);
		expect(await metadataJsonFiles()).toEqual([]);
	});

	it("checks out a named branch in the managed worktree and persists non-detached metadata", async () => {
		const { repoRoot, initialSha } = await createGitRepo("repo-branch");
		const created = await addManagedWorktree({ cwd: repoRoot, name: "branch task", dirtyPolicy: "ignore" });

		const updated = await branchManagedWorktree({
			cwd: repoRoot,
			idOrName: created.record.id,
			branch: "feature/managed-worktree",
		});

		expect(updated.id).toBe(created.record.id);
		expect(updated.branch).toBe("feature/managed-worktree");
		expect(updated.detached).toBe(false);
		expect(updated.headSha).toBe(initialSha);
		expect(await runGit(created.worktreeRoot, ["branch", "--show-current"])).toBe("feature/managed-worktree");

		const persisted = await readManagedWorktreeRecord(created.record.id);
		expect(persisted).toEqual(updated);
		expect(await readSidecarRecord(created.record.id)).toMatchObject({
			id: created.record.id,
			branch: "feature/managed-worktree",
			detached: false,
			state: "ready",
		});

		const gitEntry = findGitWorktree(await listGitWorktrees(repoRoot), created.worktreeRoot);
		expect(gitEntry).toMatchObject({
			head: initialSha,
			branch: "refs/heads/feature/managed-worktree",
			detached: false,
		});
	});

	it("branch preserves recursive submodule metadata", async () => {
		const { superRepoRoot } = await createRecursiveSubmoduleFixture("branch-recursive");
		const created = await addManagedWorktree({
			cwd: superRepoRoot,
			name: "recursive branch",
			dirtyPolicy: "ignore",
			recurseSubmodules: true,
		});

		const updated = await branchManagedWorktree({
			cwd: superRepoRoot,
			idOrName: created.record.id,
			branch: "feature/recursive-submodules",
		});

		expect(updated.branch).toBe("feature/recursive-submodules");
		expect(updated.detached).toBe(false);
		expect(updated.recurseSubmodules).toBe(true);
		expect(updated.submodules.map(submodule => submodule.path).sort()).toEqual([
			"modules/child",
			"modules/child/nested/leaf",
		]);
		expect(await readManagedWorktreeRecord(created.record.id)).toEqual(updated);
	}, 30_000);

	it("remove clean recursive worktree deletes only the managed root and metadata", async () => {
		const { superRepoRoot } = await createRecursiveSubmoduleFixture("remove-recursive");
		const created = await addManagedWorktree({
			cwd: superRepoRoot,
			name: "recursive removal",
			dirtyPolicy: "ignore",
			recurseSubmodules: true,
		});

		await expect(pathExists(path.join(superRepoRoot, "modules", "child", "child.txt"))).resolves.toBe(true);
		await expect(pathExists(path.join(superRepoRoot, "modules", "child", "nested", "leaf", "leaf.txt"))).resolves.toBe(
			true,
		);
		await expect(removeManagedWorktree({ cwd: superRepoRoot, idOrName: created.record.id })).resolves.toBeNull();

		await expect(pathExists(created.worktreeRoot)).resolves.toBe(false);
		expect(findGitWorktree(await listGitWorktrees(superRepoRoot), created.worktreeRoot)).toBeUndefined();
		expect(await readManagedWorktreeRecord(created.record.id)).toBeNull();
		await expect(pathExists(path.join(superRepoRoot, "modules", "child", "child.txt"))).resolves.toBe(true);
		await expect(pathExists(path.join(superRepoRoot, "modules", "child", "nested", "leaf", "leaf.txt"))).resolves.toBe(
			true,
		);
	}, 30_000);
});
