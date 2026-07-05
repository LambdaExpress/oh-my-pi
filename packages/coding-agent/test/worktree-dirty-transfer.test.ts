import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { copyDirtyStateToWorktree, moveDirtyStateToWorktree } from "@oh-my-pi/pi-coding-agent/worktree/dirty-transfer";
import { removeWithRetries, setWorktreesDir } from "@oh-my-pi/pi-utils";

const GIT_ENV_KEYS = [
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_TERMINAL_PROMPT",
	"GIT_ASKPASS",
	"XDG_CONFIG_HOME",
	"OMP_WORKTREE_DIR",
] as const;

type GitEnvKey = (typeof GIT_ENV_KEYS)[number];

interface DirtyFixture {
	repoRoot: string;
	baseSha: string;
	targetRoot: string;
	symlinkCreated: boolean;
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
});
