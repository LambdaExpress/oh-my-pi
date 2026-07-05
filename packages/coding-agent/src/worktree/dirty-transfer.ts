import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as git from "../utils/git";
import { copyIncludedIgnoredFiles, copyRelativePath, resolveInside } from "./include";

export interface DirtyTransferResult {
	trackedPaths: string[];
	untrackedPaths: string[];
	includedIgnoredPaths: string[];
	warnings: string[];
}

function uniqueSorted(paths: readonly string[]): string[] {
	return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

async function trackedDirtyPaths(repoRoot: string): Promise<string[]> {
	const [staged, unstaged] = await Promise.all([
		git.diff.changedFiles(repoRoot, { cached: true }),
		git.diff.changedFiles(repoRoot),
	]);
	return uniqueSorted([...staged, ...unstaged]);
}

async function applyTrackedDirtyState(sourceRepoRoot: string, targetRepoRoot: string): Promise<string[]> {
	const [stagedPatch, unstagedPatch, paths] = await Promise.all([
		git.diff(sourceRepoRoot, { binary: true, cached: true }),
		git.diff(sourceRepoRoot, { binary: true }),
		trackedDirtyPaths(sourceRepoRoot),
	]);
	if (stagedPatch.trim()) {
		await git.patch.applyText(targetRepoRoot, stagedPatch);
		await git.patch.applyText(targetRepoRoot, stagedPatch, { cached: true });
	}
	if (unstagedPatch.trim()) await git.patch.applyText(targetRepoRoot, unstagedPatch);
	return paths;
}

async function copyUntrackedFiles(sourceRepoRoot: string, targetRepoRoot: string): Promise<string[]> {
	const untrackedPaths = uniqueSorted(await git.ls.untracked(sourceRepoRoot));
	for (const relativePath of untrackedPaths) {
		await copyRelativePath(sourceRepoRoot, targetRepoRoot, relativePath);
	}
	return untrackedPaths;
}

async function removeRelativePath(root: string, relativePath: string): Promise<void> {
	await fs.rm(resolveInside(root, relativePath), { force: true, recursive: true });
	let parent = path.dirname(resolveInside(root, relativePath));
	const rootPath = path.resolve(root);
	while (parent !== rootPath && parent.startsWith(rootPath)) {
		try {
			await fs.rmdir(parent);
		} catch {
			break;
		}
		parent = path.dirname(parent);
	}
}

export async function copyDirtyStateToWorktree(
	sourceRepoRoot: string,
	targetRepoRoot: string,
	_baseSha: string,
): Promise<DirtyTransferResult> {
	const trackedPaths = await applyTrackedDirtyState(sourceRepoRoot, targetRepoRoot);
	const untrackedPaths = await copyUntrackedFiles(sourceRepoRoot, targetRepoRoot);
	const includeResult = await copyIncludedIgnoredFiles(sourceRepoRoot, targetRepoRoot);
	return {
		trackedPaths,
		untrackedPaths,
		includedIgnoredPaths: includeResult.includedIgnoredPaths,
		warnings: includeResult.warnings,
	};
}

export async function moveDirtyStateToWorktree(
	sourceRepoRoot: string,
	targetRepoRoot: string,
	baseSha: string,
): Promise<DirtyTransferResult> {
	const result = await copyDirtyStateToWorktree(sourceRepoRoot, targetRepoRoot, baseSha);
	const warnings = [...result.warnings];
	if (result.trackedPaths.length > 0) {
		try {
			await git.restore(sourceRepoRoot, {
				files: result.trackedPaths,
				source: baseSha,
				staged: true,
				worktree: true,
			});
		} catch (err) {
			warnings.push(err instanceof Error ? err.message : "Failed to clean local tracked changes");
		}
	}
	for (const relativePath of [...result.untrackedPaths, ...result.includedIgnoredPaths]) {
		try {
			await removeRelativePath(sourceRepoRoot, relativePath);
		} catch (err) {
			warnings.push(err instanceof Error ? err.message : `Failed to clean local path: ${relativePath}`);
		}
	}
	return { ...result, warnings };
}
