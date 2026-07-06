import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { addManagedWorktree, mergeManagedWorktree } from "@oh-my-pi/pi-coding-agent/worktree/manager";
import { readManagedWorktreeRecord } from "@oh-my-pi/pi-coding-agent/worktree/metadata";
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

let tempRoot = "";
let previousEnv: Partial<Record<GitEnvKey, string | undefined>> = {};

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

async function createRepo(name: string): Promise<string> {
	const repoRoot = path.join(tempRoot, `${name}-repo`);
	await fs.mkdir(repoRoot, { recursive: true });
	await runGit(repoRoot, ["init", "-q", "-b", "main"]);
	await runGit(repoRoot, ["config", "user.email", "test@example.com"]);
	await runGit(repoRoot, ["config", "user.name", "Test User"]);
	await Promise.all([
		Bun.write(path.join(repoRoot, "tracked.txt"), "base tracked\n"),
		Bun.write(path.join(repoRoot, "stable.txt"), "stable\n"),
	]);
	await runGit(repoRoot, ["add", "."]);
	await runGit(repoRoot, ["commit", "-q", "-m", "base"]);
	return repoRoot;
}

async function createRecursiveRepo(name: string): Promise<string> {
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
	return repoRoot;
}

async function makeRecursiveManagedChanges(worktreeRoot: string): Promise<void> {
	await Promise.all([
		Bun.write(path.join(worktreeRoot, "root.txt"), "background root\n"),
		Bun.write(path.join(worktreeRoot, "root-created.txt"), "background root untracked\n"),
		Bun.write(path.join(worktreeRoot, "modules", "child", "child.txt"), "background child\n"),
		Bun.write(path.join(worktreeRoot, "modules", "child", "child-created.txt"), "background child untracked\n"),
		Bun.write(path.join(worktreeRoot, "modules", "child", "nested", "leaf", "leaf.txt"), "background leaf\n"),
		Bun.write(
			path.join(worktreeRoot, "modules", "child", "nested", "leaf", "leaf-created.txt"),
			"background leaf untracked\n",
		),
	]);
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
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worktree-merge-"));
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

describe("managed worktree merge", () => {
	it("applies tracked and untracked background changes to a clean local checkout and records the application", async () => {
		const repoRoot = await createRepo("apply-clean");
		const added = await addManagedWorktree({ cwd: repoRoot, dirtyPolicy: "ignore", name: "mergeable" });
		await Promise.all([
			Bun.write(path.join(added.worktreeRoot, "tracked.txt"), "background tracked\n"),
			Bun.write(path.join(added.worktreeRoot, "created.txt"), "background untracked\n"),
		]);

		const merged = await mergeManagedWorktree({ cwd: repoRoot, idOrName: added.record.id });

		expect(merged.id).toBe(added.record.id);
		await expect(Bun.file(path.join(repoRoot, "tracked.txt")).text()).resolves.toBe("background tracked\n");
		await expect(Bun.file(path.join(repoRoot, "created.txt")).text()).resolves.toBe("background untracked\n");
		expect(await statusLines(repoRoot)).toEqual([" M tracked.txt", "?? created.txt"]);
		const metadata = await readManagedWorktreeRecord(added.record.id);
		expect(metadata?.appliedAt).toEqual(expect.any(String));
		expect(metadata?.state).toBe("ready");
		expect(metadata?.worktreeRoot).toBe(added.worktreeRoot);
		await expect(exists(added.worktreeRoot)).resolves.toBe(true);
		await expect(Bun.file(path.join(added.worktreeRoot, "tracked.txt")).text()).resolves.toBe("background tracked\n");
		await expect(Bun.file(path.join(added.worktreeRoot, "created.txt")).text()).resolves.toBe(
			"background untracked\n",
		);
	});

	it("refuses to apply into a dirty local checkout without changing local files, status, or metadata", async () => {
		const repoRoot = await createRepo("dirty-local");
		const added = await addManagedWorktree({ cwd: repoRoot, dirtyPolicy: "ignore", name: "blocked" });
		await Promise.all([
			Bun.write(path.join(added.worktreeRoot, "tracked.txt"), "background tracked\n"),
			Bun.write(path.join(added.worktreeRoot, "created.txt"), "background untracked\n"),
			Bun.write(path.join(repoRoot, "stable.txt"), "local dirty\n"),
		]);
		const statusBefore = await statusLines(repoRoot);
		const stableBefore = await Bun.file(path.join(repoRoot, "stable.txt")).text();
		const trackedBefore = await Bun.file(path.join(repoRoot, "tracked.txt")).text();
		const metadataBefore = await readManagedWorktreeRecord(added.record.id);

		await expect(mergeManagedWorktree({ cwd: repoRoot, idOrName: added.record.id })).rejects.toThrow(
			/dirty|clean|local|本地|未提交/i,
		);

		expect(await statusLines(repoRoot)).toEqual(statusBefore);
		await expect(Bun.file(path.join(repoRoot, "stable.txt")).text()).resolves.toBe(stableBefore);
		await expect(Bun.file(path.join(repoRoot, "tracked.txt")).text()).resolves.toBe(trackedBefore);
		await expect(exists(path.join(repoRoot, "created.txt"))).resolves.toBe(false);
		const metadataAfter = await readManagedWorktreeRecord(added.record.id);
		expect(metadataAfter?.appliedAt).toBe(metadataBefore?.appliedAt ?? null);
		expect(metadataAfter?.state).toBe("ready");
		await expect(exists(added.worktreeRoot)).resolves.toBe(true);
	});

	it("applies recursive submodule changes to a clean local checkout", async () => {
		const repoRoot = await createRecursiveRepo("recursive-apply-clean");
		const added = await addManagedWorktree({
			cwd: repoRoot,
			dirtyPolicy: "ignore",
			name: "recursive merge",
			recurseSubmodules: true,
		});
		await makeRecursiveManagedChanges(added.worktreeRoot);

		const merged = await mergeManagedWorktree({ cwd: repoRoot, idOrName: added.record.id });

		expect(merged.appliedAt).toEqual(expect.any(String));
		await expect(Bun.file(path.join(repoRoot, "root.txt")).text()).resolves.toBe("background root\n");
		await expect(Bun.file(path.join(repoRoot, "root-created.txt")).text()).resolves.toBe(
			"background root untracked\n",
		);
		await expect(Bun.file(path.join(repoRoot, "modules", "child", "child.txt")).text()).resolves.toBe(
			"background child\n",
		);
		await expect(Bun.file(path.join(repoRoot, "modules", "child", "child-created.txt")).text()).resolves.toBe(
			"background child untracked\n",
		);
		await expect(
			Bun.file(path.join(repoRoot, "modules", "child", "nested", "leaf", "leaf.txt")).text(),
		).resolves.toBe("background leaf\n");
		await expect(
			Bun.file(path.join(repoRoot, "modules", "child", "nested", "leaf", "leaf-created.txt")).text(),
		).resolves.toBe("background leaf untracked\n");
		expect(await statusLines(repoRoot)).toEqual([" M modules/child", " M root.txt", "?? root-created.txt"]);
		expect(await statusLines(path.join(repoRoot, "modules", "child"))).toEqual([
			" M child.txt",
			" M nested/leaf",
			"?? child-created.txt",
		]);
		expect(await statusLines(path.join(repoRoot, "modules", "child", "nested", "leaf"))).toEqual([
			" M leaf.txt",
			"?? leaf-created.txt",
		]);
		const metadata = await readManagedWorktreeRecord(added.record.id);
		expect(metadata?.appliedAt).toEqual(expect.any(String));
	}, 30_000);

	it("refuses recursive merge when a local submodule is dirty", async () => {
		const repoRoot = await createRecursiveRepo("recursive-dirty-local");
		const added = await addManagedWorktree({
			cwd: repoRoot,
			dirtyPolicy: "ignore",
			name: "recursive blocked",
			recurseSubmodules: true,
		});
		await makeRecursiveManagedChanges(added.worktreeRoot);
		await Bun.write(path.join(repoRoot, "modules", "child", "child.txt"), "local child dirty\n");
		const metadataBefore = await readManagedWorktreeRecord(added.record.id);

		await expect(mergeManagedWorktree({ cwd: repoRoot, idOrName: added.record.id })).rejects.toThrow(
			"The local submodule has uncommitted changes. Handle them before applying the managed worktree: modules/child",
		);

		await expect(Bun.file(path.join(repoRoot, "root.txt")).text()).resolves.toBe("root base\n");
		await expect(exists(path.join(repoRoot, "root-created.txt"))).resolves.toBe(false);
		await expect(Bun.file(path.join(repoRoot, "modules", "child", "child.txt")).text()).resolves.toBe(
			"local child dirty\n",
		);
		await expect(exists(path.join(repoRoot, "modules", "child", "child-created.txt"))).resolves.toBe(false);
		const metadataAfter = await readManagedWorktreeRecord(added.record.id);
		expect(metadataAfter?.appliedAt).toBe(metadataBefore?.appliedAt ?? null);
	}, 30_000);

	it("refuses recursive merge when a submodule untracked destination already exists", async () => {
		const repoRoot = await createRecursiveRepo("recursive-untracked-conflict");
		const added = await addManagedWorktree({
			cwd: repoRoot,
			dirtyPolicy: "ignore",
			name: "recursive conflict",
			recurseSubmodules: true,
		});
		await Promise.all([
			Bun.write(path.join(added.worktreeRoot, "root.txt"), "background root\n"),
			Bun.write(path.join(added.worktreeRoot, "modules", "child", "child-created.txt"), "managed child untracked\n"),
		]);
		await runGit(path.join(repoRoot, "modules", "child"), ["config", "status.showUntrackedFiles", "no"]);
		await Bun.write(path.join(repoRoot, "modules", "child", "child-created.txt"), "local existing untracked\n");

		await expect(mergeManagedWorktree({ cwd: repoRoot, idOrName: added.record.id })).rejects.toThrow(
			"Local path already exists; cannot apply untracked file: modules/child/child-created.txt",
		);

		await expect(Bun.file(path.join(repoRoot, "root.txt")).text()).resolves.toBe("root base\n");
		await expect(Bun.file(path.join(repoRoot, "modules", "child", "child-created.txt")).text()).resolves.toBe(
			"local existing untracked\n",
		);
	}, 30_000);
});
