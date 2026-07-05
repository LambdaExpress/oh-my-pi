import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as git from "../utils/git";
import { copyRelativePath } from "./include";
import { managedSnapshotDir } from "./metadata";
import type { ManagedWorktreeRecord } from "./types";

export interface WorktreeSnapshotResult {
	snapshotPath: string;
	rootPatchPath: string;
	untrackedManifestPath: string;
	metadataPath: string;
}

export interface ManagedWorktreeChanges {
	rootPatch: string;
	untrackedPaths: string[];
	includedIgnoredPaths: string[];
	headSha: string;
}

interface SnapshotRestoreManifest {
	version: 1;
	id: string;
	baseSha: string;
	rootPatch: string;
	untrackedManifest: string;
	includedManifest: string;
	metadata: string;
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
			await fs.access(path.join(root, relativePath));
			found.push(relativePath);
		} catch {
			/* absent copied include files are not restorable */
		}
	}
	return found;
}

export async function captureManagedWorktreeChanges(record: ManagedWorktreeRecord): Promise<ManagedWorktreeChanges> {
	const headSha = (await git.head.sha(record.worktreeRoot)) ?? record.headSha;
	const [committedPatch, stagedPatch, unstagedPatch, untrackedPaths, includedIgnoredPaths] = await Promise.all([
		git.diff.tree(record.worktreeRoot, record.baseSha, headSha, { allowFailure: true, binary: true }),
		git.diff(record.worktreeRoot, { binary: true, cached: true }),
		git.diff(record.worktreeRoot, { binary: true }),
		git.ls.untracked(record.worktreeRoot),
		existingPaths(record.worktreeRoot, record.includeCopied),
	]);
	const patchParts = [committedPatch, stagedPatch, unstagedPatch].filter(part => part.trim().length > 0);
	return {
		headSha,
		rootPatch: patchParts.length === 0 ? "" : git.patch.join(patchParts),
		untrackedPaths: uniqueSorted(untrackedPaths),
		includedIgnoredPaths: uniqueSorted(includedIgnoredPaths),
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

export async function saveManagedWorktreeSnapshot(record: ManagedWorktreeRecord): Promise<WorktreeSnapshotResult> {
	const snapshotPath = managedSnapshotDir(record.primaryRoot, record.id, snapshotTimestamp());
	await fs.mkdir(snapshotPath, { recursive: true });
	const changes = await captureManagedWorktreeChanges(record);
	const rootPatchPath = path.join(snapshotPath, "root.patch");
	const untrackedManifestPath = path.join(snapshotPath, "untracked-manifest.json");
	const includedManifestPath = path.join(snapshotPath, "included-manifest.json");
	const metadataPath = path.join(snapshotPath, "metadata.json");
	await Promise.all([
		Bun.write(rootPatchPath, changes.rootPatch),
		Bun.write(untrackedManifestPath, `${JSON.stringify(changes.untrackedPaths, null, "\t")}\n`),
		Bun.write(includedManifestPath, `${JSON.stringify(changes.includedIgnoredPaths, null, "\t")}\n`),
		Bun.write(metadataPath, `${JSON.stringify(record, null, "\t")}\n`),
	]);
	await copySnapshotFiles(record.worktreeRoot, snapshotPath, changes.untrackedPaths, "untracked");
	await copySnapshotFiles(record.worktreeRoot, snapshotPath, changes.includedIgnoredPaths, "included");
	const restoreManifest: SnapshotRestoreManifest = {
		version: 1,
		id: record.id,
		baseSha: record.baseSha,
		rootPatch: "root.patch",
		untrackedManifest: "untracked-manifest.json",
		includedManifest: "included-manifest.json",
		metadata: "metadata.json",
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

export async function restoreManagedWorktreeSnapshot(record: ManagedWorktreeRecord, targetRoot: string): Promise<void> {
	if (!record.snapshotPath) throw new Error("Managed worktree has no restorable snapshot.");
	const rootPatchPath = path.join(record.snapshotPath, "root.patch");
	const rootPatch = await Bun.file(rootPatchPath).text();
	if (rootPatch.trim()) await git.patch.applyText(targetRoot, rootPatch);
	const untrackedPaths = await readManifest(path.join(record.snapshotPath, "untracked-manifest.json"));
	const includedIgnoredPaths = await readManifest(path.join(record.snapshotPath, "included-manifest.json"));
	await restoreSnapshotFiles(record.snapshotPath, targetRoot, untrackedPaths, "untracked");
	await restoreSnapshotFiles(record.snapshotPath, targetRoot, includedIgnoredPaths, "included");
}
