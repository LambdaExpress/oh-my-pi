import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as git from "../utils/git";
import { copyRelativePath, resolveInside } from "./include";
import { managedSnapshotDir } from "./metadata";
import { submoduleRecordsByPath } from "./submodules";
import type { ManagedWorktreeRecord } from "./types";

export interface WorktreeSnapshotResult {
	snapshotPath: string;
	rootPatchPath: string;
	untrackedManifestPath: string;
	metadataPath: string;
}

export interface ManagedWorktreeSubmoduleChanges {
	path: string;
	headSha: string;
	rootPatch: string;
	untrackedPaths: string[];
	includedIgnoredPaths: string[];
}

export interface ManagedWorktreeChanges {
	rootPatch: string;
	untrackedPaths: string[];
	includedIgnoredPaths: string[];
	headSha: string;
	submodules: ManagedWorktreeSubmoduleChanges[];
}

interface SnapshotRestoreSubmoduleManifest {
	path: string;
	rootPatch: string;
	untrackedManifest: string;
	includedManifest: string;
}

interface SnapshotRestoreManifest {
	version: 2;
	id: string;
	baseSha: string;
	rootPatch: string;
	untrackedManifest: string;
	includedManifest: string;
	metadata: string;
	submodules: SnapshotRestoreSubmoduleManifest[];
}

function snapshotTimestamp(date = new Date()): string {
	return date.toISOString().replace(/[:.]/g, "-");
}

function uniqueSorted(paths: readonly string[]): string[] {
	return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

async function existingPaths(root: string, relativePaths: readonly string[]): Promise<string[]> {
	const found: string[] = [];
	for (const relativePath of relativePaths) {
		try {
			await fs.access(resolveInside(root, relativePath));
			found.push(relativePath);
		} catch {
			/* absent copied include files are not restorable */
		}
	}
	return found;
}

function joinPatchParts(parts: readonly string[]): string {
	const patchParts = parts.filter(part => part.trim().length > 0);
	return patchParts.length === 0 ? "" : git.patch.join(patchParts);
}

async function captureRepoChanges(
	repoRoot: string,
	baseSha: string,
	fallbackHeadSha: string,
	includeCopied: readonly string[],
	ignoreSubmodules: boolean,
): Promise<Omit<ManagedWorktreeSubmoduleChanges, "path">> {
	const headSha = (await git.head.sha(repoRoot)) ?? fallbackHeadSha;
	const ignoreSubmodulesOption = ignoreSubmodules ? "all" : undefined;
	const [committedPatch, stagedPatch, unstagedPatch, untrackedPaths, includedIgnoredPaths] = await Promise.all([
		git.diff.tree(repoRoot, baseSha, headSha, {
			allowFailure: true,
			binary: true,
			ignoreSubmodules: ignoreSubmodulesOption,
		}),
		git.diff(repoRoot, { binary: true, cached: true, ignoreSubmodules: ignoreSubmodulesOption }),
		git.diff(repoRoot, { binary: true, ignoreSubmodules: ignoreSubmodulesOption }),
		git.ls.untracked(repoRoot),
		existingPaths(repoRoot, includeCopied),
	]);
	return {
		headSha,
		rootPatch: joinPatchParts([committedPatch, stagedPatch, unstagedPatch]),
		untrackedPaths: uniqueSorted(untrackedPaths),
		includedIgnoredPaths: uniqueSorted(includedIgnoredPaths),
	};
}

export async function captureManagedWorktreeChanges(record: ManagedWorktreeRecord): Promise<ManagedWorktreeChanges> {
	const rootChanges = await captureRepoChanges(
		record.worktreeRoot,
		record.baseSha,
		record.headSha,
		record.includeCopied,
		record.recurseSubmodules,
	);
	const submodules: ManagedWorktreeSubmoduleChanges[] = [];
	if (record.recurseSubmodules) {
		for (const submodule of record.submodules) {
			try {
				await fs.access(submodule.worktreeRoot);
			} catch {
				throw new Error(`Managed submodule directory is missing: ${submodule.path}`);
			}
			const changes = await captureRepoChanges(
				submodule.worktreeRoot,
				submodule.baseSha,
				submodule.headSha,
				submodule.includeCopied,
				true,
			);
			submodules.push({ path: submodule.path, ...changes });
		}
	}
	return {
		...rootChanges,
		submodules,
	};
}

async function copySnapshotFiles(
	worktreeRoot: string,
	snapshotPath: string,
	paths: readonly string[],
	subdir: "untracked" | "included",
): Promise<void> {
	for (const relativePath of paths) {
		await copyRelativePath(worktreeRoot, path.join(snapshotPath, subdir), relativePath);
	}
}

async function writeRepoSnapshot(
	snapshotPath: string,
	worktreeRoot: string,
	changes: Pick<ManagedWorktreeSubmoduleChanges, "rootPatch" | "untrackedPaths" | "includedIgnoredPaths">,
): Promise<void> {
	await fs.mkdir(snapshotPath, { recursive: true });
	await Promise.all([
		Bun.write(path.join(snapshotPath, "root.patch"), changes.rootPatch),
		Bun.write(path.join(snapshotPath, "untracked-manifest.json"), `${JSON.stringify(changes.untrackedPaths, null, "\t")}\n`),
		Bun.write(path.join(snapshotPath, "included-manifest.json"), `${JSON.stringify(changes.includedIgnoredPaths, null, "\t")}\n`),
	]);
	await copySnapshotFiles(worktreeRoot, snapshotPath, changes.untrackedPaths, "untracked");
	await copySnapshotFiles(worktreeRoot, snapshotPath, changes.includedIgnoredPaths, "included");
}

export async function saveManagedWorktreeSnapshot(record: ManagedWorktreeRecord): Promise<WorktreeSnapshotResult> {
	const snapshotPath = managedSnapshotDir(record.primaryRoot, record.id, snapshotTimestamp());
	await fs.mkdir(snapshotPath, { recursive: true });
	const changes = await captureManagedWorktreeChanges(record);
	const rootPatchPath = path.join(snapshotPath, "root.patch");
	const untrackedManifestPath = path.join(snapshotPath, "untracked-manifest.json");
	const metadataPath = path.join(snapshotPath, "metadata.json");
	await writeRepoSnapshot(snapshotPath, record.worktreeRoot, changes);
	await Bun.write(metadataPath, `${JSON.stringify(record, null, "\t")}\n`);
	const submodulesByPath = submoduleRecordsByPath(record.submodules);
	const submodules: SnapshotRestoreSubmoduleManifest[] = [];
	for (const submoduleChanges of changes.submodules) {
		const submodule = submodulesByPath.get(submoduleChanges.path);
		if (!submodule) continue;
		const submoduleSnapshotPath = resolveInside(snapshotPath, path.join("submodules", submoduleChanges.path));
		await writeRepoSnapshot(submoduleSnapshotPath, submodule.worktreeRoot, submoduleChanges);
		submodules.push({
			path: submoduleChanges.path,
			rootPatch: "root.patch",
			untrackedManifest: "untracked-manifest.json",
			includedManifest: "included-manifest.json",
		});
	}
	const restoreManifest: SnapshotRestoreManifest = {
		version: 2,
		id: record.id,
		baseSha: record.baseSha,
		rootPatch: "root.patch",
		untrackedManifest: "untracked-manifest.json",
		includedManifest: "included-manifest.json",
		metadata: "metadata.json",
		submodules,
	};
	await Bun.write(path.join(snapshotPath, "restore.json"), `${JSON.stringify(restoreManifest, null, "\t")}\n`);
	return { snapshotPath, rootPatchPath, untrackedManifestPath, metadataPath };
}

async function readManifest(filePath: string): Promise<string[]> {
	const parsed: unknown = JSON.parse(await Bun.file(filePath).text());
	if (!Array.isArray(parsed) || !parsed.every(entry => typeof entry === "string")) {
		throw new Error(`Invalid snapshot manifest format: ${filePath}`);
	}
	return parsed;
}

async function restoreSnapshotFiles(
	snapshotPath: string,
	targetRoot: string,
	paths: readonly string[],
	subdir: "untracked" | "included",
): Promise<void> {
	for (const relativePath of paths) {
		await copyRelativePath(path.join(snapshotPath, subdir), targetRoot, relativePath);
	}
}

async function restoreRepoSnapshot(
	snapshotPath: string,
	targetRoot: string,
	files: { rootPatch: string; untrackedManifest: string; includedManifest: string } = {
		rootPatch: "root.patch",
		untrackedManifest: "untracked-manifest.json",
		includedManifest: "included-manifest.json",
	},
): Promise<void> {
	const rootPatch = await Bun.file(resolveInside(snapshotPath, files.rootPatch)).text();
	if (rootPatch.trim()) await git.patch.applyText(targetRoot, rootPatch);
	const untrackedPaths = await readManifest(resolveInside(snapshotPath, files.untrackedManifest));
	const includedIgnoredPaths = await readManifest(resolveInside(snapshotPath, files.includedManifest));
	await restoreSnapshotFiles(snapshotPath, targetRoot, untrackedPaths, "untracked");
	await restoreSnapshotFiles(snapshotPath, targetRoot, includedIgnoredPaths, "included");
}

function isSnapshotRestoreManifest(value: unknown): value is SnapshotRestoreManifest {
	if (value === null || typeof value !== "object") return false;
	const manifest = value as Record<string, unknown>;
	return (
		manifest.version === 2 &&
		typeof manifest.id === "string" &&
		typeof manifest.baseSha === "string" &&
		typeof manifest.rootPatch === "string" &&
		typeof manifest.untrackedManifest === "string" &&
		typeof manifest.includedManifest === "string" &&
		typeof manifest.metadata === "string" &&
		Array.isArray(manifest.submodules) &&
		manifest.submodules.every(entry => {
			if (entry === null || typeof entry !== "object") return false;
			const submodule = entry as Record<string, unknown>;
			return (
				typeof submodule.path === "string" &&
				typeof submodule.rootPatch === "string" &&
				typeof submodule.untrackedManifest === "string" &&
				typeof submodule.includedManifest === "string"
			);
		})
	);
}

async function readRestoreManifest(snapshotPath: string): Promise<SnapshotRestoreManifest | null> {
	try {
		const parsed: unknown = JSON.parse(await Bun.file(path.join(snapshotPath, "restore.json")).text());
		if (!isSnapshotRestoreManifest(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}

export async function restoreManagedWorktreeSnapshot(record: ManagedWorktreeRecord, targetRoot: string): Promise<void> {
	if (!record.snapshotPath) throw new Error("Managed worktree has no restorable snapshot.");
	const restoreManifest = await readRestoreManifest(record.snapshotPath);
	if (!restoreManifest) {
		await restoreRepoSnapshot(record.snapshotPath, targetRoot);
		return;
	}
	await restoreRepoSnapshot(record.snapshotPath, targetRoot, restoreManifest);
	for (const submodule of restoreManifest.submodules) {
		const submoduleSnapshotPath = resolveInside(record.snapshotPath, path.join("submodules", submodule.path));
		const targetSubmoduleRoot = resolveInside(targetRoot, submodule.path);
		try {
			await fs.access(targetSubmoduleRoot);
		} catch {
			throw new Error(`Managed submodule directory is missing: ${submodule.path}`);
		}
		await restoreRepoSnapshot(submoduleSnapshotPath, targetSubmoduleRoot, submodule);
	}
}
