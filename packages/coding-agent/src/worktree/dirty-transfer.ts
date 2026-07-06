import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as git from "../utils/git";
import { copyIncludedIgnoredFiles, copyRelativePath, resolveInside } from "./include";
import type { ManagedWorktreeSubmoduleRecord } from "./types";

export interface DirtyTransferRepoResult {
	path: string;
	trackedPaths: string[];
	untrackedPaths: string[];
	includedIgnoredPaths: string[];
	warnings: string[];
}

export interface DirtyTransferOptions {
	ignoreSubmodules?: boolean;
	submodules?: readonly ManagedWorktreeSubmoduleRecord[];
}

export interface DirtyTransferResult {
	trackedPaths: string[];
	untrackedPaths: string[];
	includedIgnoredPaths: string[];
	warnings: string[];
	submodules: DirtyTransferRepoResult[];
}

function uniqueSorted(paths: readonly string[]): string[] {
	return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

async function trackedDirtyPaths(repoRoot: string, options: DirtyTransferOptions = {}): Promise<string[]> {
	const ignoreSubmodules = options.ignoreSubmodules ? "all" : undefined;
	const [staged, unstaged] = await Promise.all([
		git.diff.changedFiles(repoRoot, { cached: true, ignoreSubmodules }),
		git.diff.changedFiles(repoRoot, { ignoreSubmodules }),
	]);
	return uniqueSorted([...staged, ...unstaged]);
}

async function applyTrackedDirtyState(
	sourceRepoRoot: string,
	targetRepoRoot: string,
	options: DirtyTransferOptions = {},
): Promise<string[]> {
	const ignoreSubmodules = options.ignoreSubmodules ? "all" : undefined;
	const [stagedPatch, unstagedPatch, paths] = await Promise.all([
		git.diff(sourceRepoRoot, { binary: true, cached: true, ignoreSubmodules }),
		git.diff(sourceRepoRoot, { binary: true, ignoreSubmodules }),
		trackedDirtyPaths(sourceRepoRoot, options),
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

async function copyRepoDirtyState(
	sourceRepoRoot: string,
	targetRepoRoot: string,
	repoPath: string,
	options: DirtyTransferOptions = {},
): Promise<DirtyTransferRepoResult> {
	const trackedPaths = await applyTrackedDirtyState(sourceRepoRoot, targetRepoRoot, options);
	const untrackedPaths = await copyUntrackedFiles(sourceRepoRoot, targetRepoRoot);
	const includeResult = await copyIncludedIgnoredFiles(sourceRepoRoot, targetRepoRoot);
	return {
		path: repoPath,
		trackedPaths,
		untrackedPaths,
		includedIgnoredPaths: includeResult.includedIgnoredPaths,
		warnings: includeResult.warnings,
	};
}

async function initializedSubmoduleSource(submodule: ManagedWorktreeSubmoduleRecord): Promise<string | null> {
	const sourceRoot = await git.repo.root(submodule.sourceRepoRoot);
	if (sourceRoot === null) return null;
	if (path.resolve(sourceRoot) !== path.resolve(submodule.sourceRepoRoot)) return null;
	return sourceRoot;
}

async function prepareTargetSubmoduleHead(submodule: ManagedWorktreeSubmoduleRecord): Promise<void> {
	const sourceHead = await git.head.sha(submodule.sourceRepoRoot);
	if (!sourceHead || sourceHead === submodule.baseSha) return;
	try {
		await git.checkout(submodule.worktreeRoot, sourceHead);
	} catch {
		throw new Error(
			`Could not check out source submodule HEAD ${sourceHead} in managed submodule ${submodule.path}.`,
		);
	}
}

async function copySubmoduleDirtyStates(
	submodules: readonly ManagedWorktreeSubmoduleRecord[],
): Promise<DirtyTransferRepoResult[]> {
	const results: DirtyTransferRepoResult[] = [];
	for (const submodule of submodules) {
		const sourceRoot = await initializedSubmoduleSource(submodule);
		if (sourceRoot === null) {
			results.push({
				path: submodule.path,
				trackedPaths: [],
				untrackedPaths: [],
				includedIgnoredPaths: [],
				warnings: [`Source submodule is not initialized; dirty state was not copied: ${submodule.path}`],
			});
			continue;
		}
		await prepareTargetSubmoduleHead(submodule);
		results.push(
			await copyRepoDirtyState(sourceRoot, submodule.worktreeRoot, submodule.path, { ignoreSubmodules: true }),
		);
	}
	return results;
}

async function cleanRepoDirtyState(
	sourceRepoRoot: string,
	baseSha: string,
	result: DirtyTransferRepoResult,
): Promise<string[]> {
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
	return warnings;
}

export async function copyDirtyStateToWorktree(
	sourceRepoRoot: string,
	targetRepoRoot: string,
	_baseSha: string,
	options: DirtyTransferOptions = {},
): Promise<DirtyTransferResult> {
	const rootResult = await copyRepoDirtyState(sourceRepoRoot, targetRepoRoot, "", {
		ignoreSubmodules: options.ignoreSubmodules,
	});
	const submodules = await copySubmoduleDirtyStates(options.submodules ?? []);
	return {
		trackedPaths: rootResult.trackedPaths,
		untrackedPaths: rootResult.untrackedPaths,
		includedIgnoredPaths: rootResult.includedIgnoredPaths,
		warnings: [...rootResult.warnings, ...submodules.flatMap(result => result.warnings)],
		submodules,
	};
}

export async function moveDirtyStateToWorktree(
	sourceRepoRoot: string,
	targetRepoRoot: string,
	baseSha: string,
	options: DirtyTransferOptions = {},
): Promise<DirtyTransferResult> {
	const rootResult = await copyRepoDirtyState(sourceRepoRoot, targetRepoRoot, "", {
		ignoreSubmodules: options.ignoreSubmodules,
	});
	const submodules = await copySubmoduleDirtyStates(options.submodules ?? []);
	const rootWarnings = await cleanRepoDirtyState(sourceRepoRoot, baseSha, rootResult);
	const submoduleWarnings: string[] = [];
	for (const submoduleResult of submodules) {
		if (
			submoduleResult.trackedPaths.length === 0 &&
			submoduleResult.untrackedPaths.length === 0 &&
			submoduleResult.includedIgnoredPaths.length === 0
		) {
			submoduleWarnings.push(...submoduleResult.warnings);
			continue;
		}
		const submodule = options.submodules?.find(candidate => candidate.path === submoduleResult.path);
		if (!submodule) continue;
		submoduleWarnings.push(
			...(await cleanRepoDirtyState(submodule.sourceRepoRoot, submodule.baseSha, submoduleResult)),
		);
	}
	return {
		trackedPaths: rootResult.trackedPaths,
		untrackedPaths: rootResult.untrackedPaths,
		includedIgnoredPaths: rootResult.includedIgnoredPaths,
		warnings: [...rootWarnings, ...submoduleWarnings],
		submodules,
	};
}
