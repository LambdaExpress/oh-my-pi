import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { copyDirtyStateToWorktree, moveDirtyStateToWorktree } from "@oh-my-pi/pi-coding-agent/worktree/dirty-transfer";
import type { ManagedWorktreeSubmoduleRecord } from "@oh-my-pi/pi-coding-agent/worktree/types";
import { removeWithRetries, setWorktreesDir } from "@oh-my-pi/pi-utils";

const GIT_ENV_KEYS = [
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_TERMINAL_PROMPT",
	"GIT_ASKPASS",
	"XDG_CONFIG_HOME",
	"OMP_WORKTREE_DIR",
	"GIT_ALLOW_PROTOCOL",
] as const;

type GitEnvKey = (typeof GIT_ENV_KEYS)[number];

interface DirtyFixture {
	repoRoot: string;
	baseSha: string;
	targetRoot: string;
	symlinkCreated: boolean;
}

interface RecursiveDirtyFixture {
	repoRoot: string;
	baseSha: string;
	targetRoot: string;
	submodules: ManagedWorktreeSubmoduleRecord[];
}

let tempRoot = "";
let previousEnv: Partial<Record<GitEnvKey, string | undefined>> = {};

function toRepoPath(filePath: string): string {
	return filePath.replaceAll(path.sep, "/");
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.lstat(filePath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test User",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test User",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
		stderr: "pipe",
		stdout: "pipe",
		windowsHide: true,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed with exit code ${exitCode}`);
	}
	return stdout.trimEnd();
}

async function statusLines(repoRoot: string): Promise<string[]> {
	const status = await runGit(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
	return status.split(/\r?\n/).filter(Boolean).sort();
}

async function createIgnoredSymlink(repoRoot: string): Promise<boolean> {
	const target = path.join(repoRoot, "ignored-real");
	await fs.mkdir(target, { recursive: true });
	await Bun.write(path.join(target, "payload.txt"), "symlink target\n");
	try {
		await fs.symlink(target, path.join(repoRoot, "ignored-link"), process.platform === "win32" ? "junction" : "dir");
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EPERM" || code === "EACCES" || code === "EINVAL") return false;
		throw error;
	}
}

async function createDirtyFixture(name: string): Promise<DirtyFixture> {
	const repoRoot = path.join(tempRoot, `${name}-repo`);
	const targetRoot = path.join(tempRoot, `${name}-target`);
	await fs.mkdir(repoRoot, { recursive: true });
	await runGit(repoRoot, ["init", "-q", "-b", "main"]);
	await runGit(repoRoot, ["config", "user.email", "test@example.com"]);
	await runGit(repoRoot, ["config", "user.name", "Test User"]);
	await Promise.all([
		Bun.write(path.join(repoRoot, "staged.txt"), "base staged\n"),
		Bun.write(path.join(repoRoot, "unstaged.txt"), "base unstaged\n"),
		Bun.write(path.join(repoRoot, ".gitignore"), "ignored-local/\nignored-link\nignored-real/\n"),
		Bun.write(path.join(repoRoot, ".worktreeinclude"), "ignored-local/keep.env\nignored-link\n"),
	]);
	await runGit(repoRoot, ["add", "."]);
	await runGit(repoRoot, ["commit", "-q", "-m", "base"]);
	const baseSha = await runGit(repoRoot, ["rev-parse", "HEAD"]);
	await runGit(repoRoot, ["worktree", "add", "--detach", targetRoot, baseSha]);

	await Promise.all([
		Bun.write(path.join(repoRoot, "staged.txt"), "source staged\n"),
		Bun.write(path.join(repoRoot, "unstaged.txt"), "source unstaged\n"),
		Bun.write(path.join(repoRoot, "untracked.txt"), "source untracked\n"),
		fs.mkdir(path.join(repoRoot, "ignored-local"), { recursive: true }),
	]);
	await runGit(repoRoot, ["add", "staged.txt"]);
	await Promise.all([
		Bun.write(path.join(repoRoot, "ignored-local", "keep.env"), "copied secret\n"),
		Bun.write(path.join(repoRoot, "ignored-local", "skip.env"), "local only secret\n"),
	]);
	const symlinkCreated = await createIgnoredSymlink(repoRoot);

	return { repoRoot, baseSha, targetRoot, symlinkCreated };
}

async function createRecursiveSubmoduleFixture(name: string): Promise<RecursiveDirtyFixture> {
	const leafRepoRoot = path.join(tempRoot, `${name}-leaf-submodule-repo`);
	await fs.mkdir(leafRepoRoot, { recursive: true });
	await runGit(leafRepoRoot, ["init", "-q", "-b", "main"]);
	await runGit(leafRepoRoot, ["config", "user.email", "test@example.com"]);
	await runGit(leafRepoRoot, ["config", "user.name", "Test User"]);
	await Bun.write(path.join(leafRepoRoot, "leaf.txt"), "leaf base\n");
	await runGit(leafRepoRoot, ["add", "."]);
	await runGit(leafRepoRoot, ["commit", "-q", "-m", "leaf base"]);

	const childRepoRoot = path.join(tempRoot, `${name}-child-submodule-repo`);
	await fs.mkdir(childRepoRoot, { recursive: true });
	await runGit(childRepoRoot, ["init", "-q", "-b", "main"]);
	await runGit(childRepoRoot, ["config", "user.email", "test@example.com"]);
	await runGit(childRepoRoot, ["config", "user.name", "Test User"]);
	await Bun.write(path.join(childRepoRoot, "child.txt"), "child base\n");
	await runGit(childRepoRoot, ["add", "."]);
	await runGit(childRepoRoot, ["commit", "-q", "-m", "child base"]);
	await runGit(childRepoRoot, ["submodule", "add", leafRepoRoot, "nested/leaf"]);
	await runGit(childRepoRoot, ["commit", "-q", "-m", "add leaf submodule"]);

	const repoRoot = path.join(tempRoot, `${name}-super-repo`);
	const targetRoot = path.join(tempRoot, `${name}-target`);
	await fs.mkdir(repoRoot, { recursive: true });
	await runGit(repoRoot, ["init", "-q", "-b", "main"]);
	await runGit(repoRoot, ["config", "user.email", "test@example.com"]);
	await runGit(repoRoot, ["config", "user.name", "Test User"]);
	await Bun.write(path.join(repoRoot, "root.txt"), "root base\n");
	await runGit(repoRoot, ["add", "."]);
	await runGit(repoRoot, ["commit", "-q", "-m", "root base"]);
	await runGit(repoRoot, ["submodule", "add", childRepoRoot, "modules/child"]);
	await runGit(repoRoot, ["commit", "-q", "-m", "add child submodule"]);
	await runGit(repoRoot, ["submodule", "update", "--init", "--recursive"]);
	const baseSha = await runGit(repoRoot, ["rev-parse", "HEAD"]);
	await runGit(repoRoot, ["worktree", "add", "--detach", targetRoot, baseSha]);
	await runGit(targetRoot, ["submodule", "update", "--init", "--recursive"]);
	const childPath = "modules/child";
	const leafPath = "modules/child/nested/leaf";
	const childSha = await runGit(path.join(targetRoot, "modules", "child"), ["rev-parse", "HEAD"]);
	const leafSha = await runGit(path.join(targetRoot, "modules", "child", "nested", "leaf"), ["rev-parse", "HEAD"]);
	const submodules: ManagedWorktreeSubmoduleRecord[] = [
		{
			path: childPath,
			parentPath: null,
			sourceRepoRoot: path.join(repoRoot, "modules", "child"),
			worktreeRoot: path.join(targetRoot, "modules", "child"),
			baseSha: childSha,
			headSha: childSha,
			includeCopied: [],
		},
		{
			path: leafPath,
			parentPath: childPath,
			sourceRepoRoot: path.join(repoRoot, "modules", "child", "nested", "leaf"),
			worktreeRoot: path.join(targetRoot, "modules", "child", "nested", "leaf"),
			baseSha: leafSha,
			headSha: leafSha,
			includeCopied: [],
		},
	];
	await Promise.all([
		Bun.write(path.join(repoRoot, "root.txt"), "root dirty\n"),
		Bun.write(path.join(repoRoot, "root-untracked.txt"), "root untracked\n"),
		Bun.write(path.join(repoRoot, "modules", "child", "child.txt"), "child dirty\n"),
		Bun.write(path.join(repoRoot, "modules", "child", "child-untracked.txt"), "child untracked\n"),
		Bun.write(path.join(repoRoot, "modules", "child", "nested", "leaf", "leaf.txt"), "leaf dirty\n"),
		Bun.write(path.join(repoRoot, "modules", "child", "nested", "leaf", "leaf-untracked.txt"), "leaf untracked\n"),
	]);
	return { repoRoot, baseSha, targetRoot, submodules };
}

async function expectRecursiveDirtyFiles(root: string): Promise<void> {
	await expect(Bun.file(path.join(root, "root.txt")).text()).resolves.toBe("root dirty\n");
	await expect(Bun.file(path.join(root, "root-untracked.txt")).text()).resolves.toBe("root untracked\n");
	await expect(Bun.file(path.join(root, "modules", "child", "child.txt")).text()).resolves.toBe("child dirty\n");
	await expect(Bun.file(path.join(root, "modules", "child", "child-untracked.txt")).text()).resolves.toBe(
		"child untracked\n",
	);
	await expect(Bun.file(path.join(root, "modules", "child", "nested", "leaf", "leaf.txt")).text()).resolves.toBe(
		"leaf dirty\n",
	);
	await expect(
		Bun.file(path.join(root, "modules", "child", "nested", "leaf", "leaf-untracked.txt")).text(),
	).resolves.toBe("leaf untracked\n");
}

async function expectRecursiveSourceClean(root: string): Promise<void> {
	await expect(Bun.file(path.join(root, "root.txt")).text()).resolves.toBe("root base\n");
	await expect(exists(path.join(root, "root-untracked.txt"))).resolves.toBe(false);
	await expect(Bun.file(path.join(root, "modules", "child", "child.txt")).text()).resolves.toBe("child base\n");
	await expect(exists(path.join(root, "modules", "child", "child-untracked.txt"))).resolves.toBe(false);
	await expect(Bun.file(path.join(root, "modules", "child", "nested", "leaf", "leaf.txt")).text()).resolves.toBe(
		"leaf base\n",
	);
	await expect(exists(path.join(root, "modules", "child", "nested", "leaf", "leaf-untracked.txt"))).resolves.toBe(
		false,
	);
	await expect(exists(path.join(root, "modules", "child", ".git"))).resolves.toBe(true);
	await expect(exists(path.join(root, "modules", "child", "nested", "leaf", ".git"))).resolves.toBe(true);
}

async function expectTransferredFiles(targetRoot: string, symlinkCreated: boolean): Promise<void> {
	await expect(Bun.file(path.join(targetRoot, "staged.txt")).text()).resolves.toBe("source staged\n");
	await expect(Bun.file(path.join(targetRoot, "unstaged.txt")).text()).resolves.toBe("source unstaged\n");
	await expect(Bun.file(path.join(targetRoot, "untracked.txt")).text()).resolves.toBe("source untracked\n");
	await expect(Bun.file(path.join(targetRoot, "ignored-local", "keep.env")).text()).resolves.toBe("copied secret\n");
	await expect(exists(path.join(targetRoot, "ignored-local", "skip.env"))).resolves.toBe(false);
	if (symlinkCreated) {
		await expect(exists(path.join(targetRoot, "ignored-link"))).resolves.toBe(false);
	}
}

beforeEach(async () => {
	previousEnv = {};
	for (const key of GIT_ENV_KEYS) previousEnv[key] = process.env[key];
	process.env.GIT_CONFIG_GLOBAL = "/dev/null";
	process.env.GIT_CONFIG_SYSTEM = "/dev/null";
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	process.env.GIT_TERMINAL_PROMPT = "0";
	process.env.GIT_ASKPASS = "true";
	process.env.GIT_ALLOW_PROTOCOL = "file";
	delete process.env.XDG_CONFIG_HOME;
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worktree-dirty-transfer-"));
	const worktreeBase = path.join(tempRoot, "managed-worktrees");
	await fs.mkdir(worktreeBase, { recursive: true });
	process.env.OMP_WORKTREE_DIR = worktreeBase;
	setWorktreesDir(worktreeBase);
});

afterEach(async () => {
	setWorktreesDir(undefined);
	for (const key of GIT_ENV_KEYS) {
		const previous = previousEnv[key];
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	}
	previousEnv = {};
	if (tempRoot) await removeWithRetries(tempRoot);
	tempRoot = "";
});

describe("managed worktree dirty transfer", () => {
	it("copies staged, unstaged, untracked, and included ignored files without changing the source checkout", async () => {
		const fixture = await createDirtyFixture("copy");
		const sourceStatusBefore = await statusLines(fixture.repoRoot);

		const result = await copyDirtyStateToWorktree(fixture.repoRoot, fixture.targetRoot, fixture.baseSha);

		expect(result.trackedPaths.map(toRepoPath).sort()).toEqual(["staged.txt", "unstaged.txt"]);
		expect(result.untrackedPaths.map(toRepoPath).sort()).toEqual(["untracked.txt"]);
		expect(result.includedIgnoredPaths.map(toRepoPath).sort()).toEqual(["ignored-local/keep.env"]);
		expect(result.warnings.some(warning => warning.includes("ignored-link"))).toBe(fixture.symlinkCreated);
		await expectTransferredFiles(fixture.targetRoot, fixture.symlinkCreated);
		expect(await statusLines(fixture.targetRoot)).toEqual([" M unstaged.txt", "?? untracked.txt", "M  staged.txt"]);
		expect(await statusLines(fixture.repoRoot)).toEqual(sourceStatusBefore);
		await expect(Bun.file(path.join(fixture.repoRoot, "ignored-local", "skip.env")).text()).resolves.toBe(
			"local only secret\n",
		);
		if (fixture.symlinkCreated) {
			await expect(exists(path.join(fixture.repoRoot, "ignored-link"))).resolves.toBe(true);
		}
	});

	it("moves transferred dirty state and cleans only the paths that were copied", async () => {
		const fixture = await createDirtyFixture("move");

		const result = await moveDirtyStateToWorktree(fixture.repoRoot, fixture.targetRoot, fixture.baseSha);

		expect(result.trackedPaths.map(toRepoPath).sort()).toEqual(["staged.txt", "unstaged.txt"]);
		expect(result.untrackedPaths.map(toRepoPath).sort()).toEqual(["untracked.txt"]);
		expect(result.includedIgnoredPaths.map(toRepoPath).sort()).toEqual(["ignored-local/keep.env"]);
		expect(result.warnings.some(warning => warning.includes("ignored-link"))).toBe(fixture.symlinkCreated);
		await expectTransferredFiles(fixture.targetRoot, fixture.symlinkCreated);
		expect(await statusLines(fixture.targetRoot)).toEqual([" M unstaged.txt", "?? untracked.txt", "M  staged.txt"]);
		expect(await statusLines(fixture.repoRoot)).toEqual([]);
		await expect(Bun.file(path.join(fixture.repoRoot, "staged.txt")).text()).resolves.toBe("base staged\n");
		await expect(Bun.file(path.join(fixture.repoRoot, "unstaged.txt")).text()).resolves.toBe("base unstaged\n");
		await expect(exists(path.join(fixture.repoRoot, "untracked.txt"))).resolves.toBe(false);
		await expect(exists(path.join(fixture.repoRoot, "ignored-local", "keep.env"))).resolves.toBe(false);
		await expect(Bun.file(path.join(fixture.repoRoot, "ignored-local", "skip.env")).text()).resolves.toBe(
			"local only secret\n",
		);
		if (fixture.symlinkCreated) {
			await expect(exists(path.join(fixture.repoRoot, "ignored-link"))).resolves.toBe(true);
		}
	});

	it("copies recursive submodule dirty tracked and untracked state without changing the source checkout", async () => {
		const fixture = await createRecursiveSubmoduleFixture("recursive-copy");

		const result = await copyDirtyStateToWorktree(fixture.repoRoot, fixture.targetRoot, fixture.baseSha, {
			ignoreSubmodules: true,
			submodules: fixture.submodules,
		});

		expect(result.trackedPaths).toEqual(["root.txt"]);
		expect(result.untrackedPaths).toEqual(["root-untracked.txt"]);
		expect(result.submodules.map(submodule => submodule.path)).toEqual([
			"modules/child",
			"modules/child/nested/leaf",
		]);
		expect(result.submodules[0]?.trackedPaths).toEqual(["child.txt"]);
		expect(result.submodules[0]?.untrackedPaths).toEqual(["child-untracked.txt"]);
		expect(result.submodules[1]?.trackedPaths).toEqual(["leaf.txt"]);
		expect(result.submodules[1]?.untrackedPaths).toEqual(["leaf-untracked.txt"]);
		await expectRecursiveDirtyFiles(fixture.repoRoot);
		await expectRecursiveDirtyFiles(fixture.targetRoot);
	}, 30_000);

	it("moves recursive submodule dirty state and cleans source submodules without deleting them", async () => {
		const fixture = await createRecursiveSubmoduleFixture("recursive-move");

		const result = await moveDirtyStateToWorktree(fixture.repoRoot, fixture.targetRoot, fixture.baseSha, {
			ignoreSubmodules: true,
			submodules: fixture.submodules,
		});

		expect(result.trackedPaths).toEqual(["root.txt"]);
		expect(result.untrackedPaths).toEqual(["root-untracked.txt"]);
		expect(result.submodules[0]?.trackedPaths).toEqual(["child.txt"]);
		expect(result.submodules[0]?.untrackedPaths).toEqual(["child-untracked.txt"]);
		expect(result.submodules[1]?.trackedPaths).toEqual(["leaf.txt"]);
		expect(result.submodules[1]?.untrackedPaths).toEqual(["leaf-untracked.txt"]);
		await expectRecursiveDirtyFiles(fixture.targetRoot);
		await expectRecursiveSourceClean(fixture.repoRoot);
		expect(await statusLines(fixture.repoRoot)).toEqual([]);
		expect(await statusLines(path.join(fixture.repoRoot, "modules", "child"))).toEqual([]);
		expect(await statusLines(path.join(fixture.repoRoot, "modules", "child", "nested", "leaf"))).toEqual([]);
	}, 30_000);
});
