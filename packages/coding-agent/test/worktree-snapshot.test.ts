import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ManagedWorktreeResult } from "@oh-my-pi/pi-coding-agent/worktree/manager";
import {
	addManagedWorktree,
	removeManagedWorktree,
	restoreManagedWorktree,
} from "@oh-my-pi/pi-coding-agent/worktree/manager";
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

interface DirtyManagedWorktreeFixture {
	repoRoot: string;
	worktree: ManagedWorktreeResult;
}

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

async function listFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	async function walk(dir: string): Promise<void> {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const absolute = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(absolute);
			} else if (entry.isFile()) {
				files.push(absolute);
			}
		}
	}
	await walk(root);
	return files.sort();
}

function relativeSnapshotFiles(snapshotPath: string, files: readonly string[]): string[] {
	return files.map(file => path.relative(snapshotPath, file).replaceAll(path.sep, "/")).sort();
}

async function createRepo(name: string): Promise<string> {
	const repoRoot = path.join(tempRoot, `${name}-repo`);
	await fs.mkdir(repoRoot, { recursive: true });
	await runGit(repoRoot, ["init", "-q", "-b", "main"]);
	await runGit(repoRoot, ["config", "user.email", "test@example.com"]);
	await runGit(repoRoot, ["config", "user.name", "Test User"]);
	await Promise.all([
		Bun.write(path.join(repoRoot, "tracked.txt"), "base tracked\n"),
		Bun.write(path.join(repoRoot, ".gitignore"), "secret/\n"),
		Bun.write(path.join(repoRoot, ".worktreeinclude"), "secret/keep.env\n"),
	]);
	await runGit(repoRoot, ["add", "."]);
	await runGit(repoRoot, ["commit", "-q", "-m", "base"]);
	return repoRoot;
}

async function createDirtyManagedWorktree(name: string): Promise<DirtyManagedWorktreeFixture> {
	const repoRoot = await createRepo(name);
	await fs.mkdir(path.join(repoRoot, "secret"), { recursive: true });
	await Bun.write(path.join(repoRoot, "secret", "keep.env"), "source included ignored\n");
	const worktree = await addManagedWorktree({ cwd: repoRoot, dirtyPolicy: "copy", name });
	await fs.mkdir(path.join(worktree.worktreeRoot, "secret"), { recursive: true });
	await Promise.all([
		Bun.write(path.join(worktree.worktreeRoot, "tracked.txt"), "dirty tracked\n"),
		Bun.write(path.join(worktree.worktreeRoot, "created.txt"), "dirty untracked\n"),
		Bun.write(path.join(worktree.worktreeRoot, "secret", "keep.env"), "dirty included ignored\n"),
	]);
	return { repoRoot, worktree };
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
		Bun.write(path.join(worktreeRoot, "root.txt"), "snapshot root\n"),
		Bun.write(path.join(worktreeRoot, "root-created.txt"), "snapshot root untracked\n"),
		Bun.write(path.join(worktreeRoot, "modules", "child", "child.txt"), "snapshot child\n"),
		Bun.write(path.join(worktreeRoot, "modules", "child", "child-created.txt"), "snapshot child untracked\n"),
		Bun.write(path.join(worktreeRoot, "modules", "child", "nested", "leaf", "leaf.txt"), "snapshot leaf\n"),
		Bun.write(
			path.join(worktreeRoot, "modules", "child", "nested", "leaf", "leaf-created.txt"),
			"snapshot leaf untracked\n",
		),
	]);
}

async function removeDirtyRecursiveWorktree(fixtureName: string): Promise<{
	repoRoot: string;
	oldWorktreeRoot: string;
	recordId: string;
	snapshotPath: string;
}> {
	const repoRoot = await createRecursiveRepo(fixtureName);
	const worktree = await addManagedWorktree({
		cwd: repoRoot,
		dirtyPolicy: "ignore",
		name: fixtureName,
		recurseSubmodules: true,
	});
	await makeRecursiveManagedChanges(worktree.worktreeRoot);
	const oldWorktreeRoot = worktree.worktreeRoot;
	const removed = await removeManagedWorktree({ cwd: repoRoot, idOrName: worktree.record.id });
	const metadata = await readManagedWorktreeRecord(worktree.record.id);
	const snapshotPath = removed?.snapshotPath ?? metadata?.snapshotPath;
	if (!snapshotPath) throw new Error("dirty recursive worktree removal did not record a snapshot path");
	return { repoRoot, oldWorktreeRoot, recordId: worktree.record.id, snapshotPath };
}


async function removeDirtyWorktree(fixtureName: string): Promise<{
	repoRoot: string;
	oldWorktreeRoot: string;
	recordId: string;
	snapshotPath: string;
}> {
	const { repoRoot, worktree } = await createDirtyManagedWorktree(fixtureName);
	const oldWorktreeRoot = worktree.worktreeRoot;
	const removed = await removeManagedWorktree({ cwd: repoRoot, idOrName: worktree.record.id });
	const metadata = await readManagedWorktreeRecord(worktree.record.id);
	const snapshotPath = removed?.snapshotPath ?? metadata?.snapshotPath;
	if (!snapshotPath) throw new Error("dirty worktree removal did not record a snapshot path");
	return { repoRoot, oldWorktreeRoot, recordId: worktree.record.id, snapshotPath };
}

async function findSnapshotPatch(snapshotPath: string): Promise<string> {
	const patchPath = (await listFiles(snapshotPath)).find(file => file.endsWith(".patch"));
	if (!patchPath) throw new Error(`snapshot under ${snapshotPath} did not contain a patch file`);
	return patchPath;
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
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worktree-snapshot-"));
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

describe("managed worktree snapshots", () => {
	it("saves patch, manifests, and metadata when removing a dirty managed worktree", async () => {
		const { repoRoot, oldWorktreeRoot, recordId, snapshotPath } = await removeDirtyWorktree("remove-dirty");
		const metadata = await readManagedWorktreeRecord(recordId);
		const snapshotFiles = await listFiles(snapshotPath);
		const relativeFiles = relativeSnapshotFiles(snapshotPath, snapshotFiles);
		const patchPath = await findSnapshotPatch(snapshotPath);
		const patchText = await Bun.file(patchPath).text();
		const jsonTexts = await Promise.all(
			snapshotFiles.filter(file => file.endsWith(".json")).map(file => Bun.file(file).text()),
		);

		expect(metadata?.owner).toBe("omp");
		expect(metadata?.state).toBe("snapshotted");
		expect(metadata?.snapshotPath).toBe(snapshotPath);
		expect(metadata?.worktreeRoot).toBe(oldWorktreeRoot);
		await expect(exists(oldWorktreeRoot)).resolves.toBe(false);
		await expect(exists(snapshotPath)).resolves.toBe(true);
		expect(relativeFiles).toContain("restore.json");
		expect(relativeFiles.some(file => file.endsWith(".patch"))).toBe(true);
		expect(
			jsonTexts.some(text => text.includes(recordId) && text.includes('"owner"') && text.includes('"omp"')),
		).toBe(true);
		expect(jsonTexts.some(text => text.includes("created.txt"))).toBe(true);
		expect(jsonTexts.some(text => text.includes("secret/keep.env") || text.includes("secret\\\\keep.env"))).toBe(
			true,
		);
		expect(patchText).toContain("+dirty tracked");
		expect(await statusLines(repoRoot)).toEqual([]);
	});

	it("restores a snapshotted worktree into a new detached checkout with tracked, untracked, and included ignored files", async () => {
		const { repoRoot, oldWorktreeRoot, recordId, snapshotPath } = await removeDirtyWorktree("restore-success");

		const restored = await restoreManagedWorktree({ cwd: repoRoot, idOrName: recordId });

		expect(restored.record.id).toBe(recordId);
		expect(restored.record.state).toBe("ready");
		expect(restored.worktreeRoot).not.toBe(oldWorktreeRoot);
		await expect(exists(oldWorktreeRoot)).resolves.toBe(false);
		await expect(exists(restored.worktreeRoot)).resolves.toBe(true);
		await expect(Bun.file(path.join(restored.worktreeRoot, "tracked.txt")).text()).resolves.toBe("dirty tracked\n");
		await expect(Bun.file(path.join(restored.worktreeRoot, "created.txt")).text()).resolves.toBe("dirty untracked\n");
		await expect(Bun.file(path.join(restored.worktreeRoot, "secret", "keep.env")).text()).resolves.toBe(
			"dirty included ignored\n",
		);
		expect(await statusLines(restored.worktreeRoot)).toEqual([" M tracked.txt", "?? created.txt"]);
		expect(await runGit(restored.worktreeRoot, ["branch", "--show-current"])).toBe("");
		const metadata = await readManagedWorktreeRecord(recordId);
		expect(metadata?.state).toBe("ready");
		expect(metadata?.worktreeRoot).toBe(restored.worktreeRoot);
		expect(metadata?.snapshotPath).toBe(snapshotPath);
	});

	it("marks metadata orphaned and keeps the new worktree when snapshot restore fails", async () => {
		const { repoRoot, oldWorktreeRoot, recordId, snapshotPath } = await removeDirtyWorktree("restore-failure");
		await Bun.write(await findSnapshotPatch(snapshotPath), "this is not a git patch\n");

		await expect(restoreManagedWorktree({ cwd: repoRoot, idOrName: recordId })).rejects.toThrow();

		const metadata = await readManagedWorktreeRecord(recordId);
		expect(metadata?.state).toBe("orphaned");
		expect(metadata?.worktreeRoot).not.toBe(oldWorktreeRoot);
		if (!metadata?.worktreeRoot)
			throw new Error("failed restore did not leave an orphaned worktree path in metadata");
		await expect(exists(metadata.worktreeRoot)).resolves.toBe(true);
		await expect(exists(path.join(metadata.worktreeRoot, ".git"))).resolves.toBe(true);
	});

	it("snapshots dirty recursive submodule changes on remove", async () => {
		const { oldWorktreeRoot, recordId, snapshotPath } = await removeDirtyRecursiveWorktree("recursive-remove-dirty");
		const metadata = await readManagedWorktreeRecord(recordId);
		const restoreManifest = JSON.parse(await Bun.file(path.join(snapshotPath, "restore.json")).text()) as {
			version?: number;
			submodules?: Array<{ path?: string }>;
		};

		expect(metadata?.state).toBe("snapshotted");
		expect(metadata?.snapshotPath).toBe(snapshotPath);
		await expect(exists(oldWorktreeRoot)).resolves.toBe(false);
		expect(restoreManifest.version).toBe(2);
		expect(restoreManifest.submodules?.map(submodule => submodule.path).sort()).toEqual([
			"modules/child",
			"modules/child/nested/leaf",
		]);
		await expect(exists(path.join(snapshotPath, "submodules", "modules", "child", "root.patch"))).resolves.toBe(true);
		await expect(
			exists(path.join(snapshotPath, "submodules", "modules", "child", "nested", "leaf", "root.patch")),
		).resolves.toBe(true);
	}, 30_000);

	it("restores dirty recursive submodule snapshot", async () => {
		const { repoRoot, oldWorktreeRoot, recordId, snapshotPath } =
			await removeDirtyRecursiveWorktree("recursive-restore-success");

		const restored = await restoreManagedWorktree({ cwd: repoRoot, idOrName: recordId });

		expect(restored.record.id).toBe(recordId);
		expect(restored.record.state).toBe("ready");
		expect(restored.record.recurseSubmodules).toBe(true);
		expect(restored.worktreeRoot).not.toBe(oldWorktreeRoot);
		await expect(exists(oldWorktreeRoot)).resolves.toBe(false);
		await expect(exists(restored.worktreeRoot)).resolves.toBe(true);
		await expect(Bun.file(path.join(restored.worktreeRoot, "root.txt")).text()).resolves.toBe("snapshot root\n");
		await expect(Bun.file(path.join(restored.worktreeRoot, "root-created.txt")).text()).resolves.toBe(
			"snapshot root untracked\n",
		);
		await expect(Bun.file(path.join(restored.worktreeRoot, "modules", "child", "child.txt")).text()).resolves.toBe(
			"snapshot child\n",
		);
		await expect(
			Bun.file(path.join(restored.worktreeRoot, "modules", "child", "child-created.txt")).text(),
		).resolves.toBe("snapshot child untracked\n");
		await expect(
			Bun.file(path.join(restored.worktreeRoot, "modules", "child", "nested", "leaf", "leaf.txt")).text(),
		).resolves.toBe("snapshot leaf\n");
		await expect(
			Bun.file(path.join(restored.worktreeRoot, "modules", "child", "nested", "leaf", "leaf-created.txt")).text(),
		).resolves.toBe("snapshot leaf untracked\n");
		expect(await statusLines(restored.worktreeRoot)).toContain(" M root.txt");
		expect(await statusLines(path.join(restored.worktreeRoot, "modules", "child"))).toContain(" M child.txt");
		expect(await statusLines(path.join(restored.worktreeRoot, "modules", "child", "nested", "leaf"))).toEqual([
			" M leaf.txt",
			"?? leaf-created.txt",
		]);
		const metadata = await readManagedWorktreeRecord(recordId);
		expect(metadata?.worktreeRoot).toBe(restored.worktreeRoot);
		expect(metadata?.snapshotPath).toBe(snapshotPath);
	}, 30_000);
});
