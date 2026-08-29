import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
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

async function trackedDirtyPaths(repoRoot: string, excluded: ReadonlySet<string>): Promise<string[]> {
	const repo = vcs.requireGit(repoRoot);
	const [staged, unstaged] = await Promise.all([repo.changedFiles({ cached: true }), repo.changedFiles({})]);
	return uniqueSorted([...staged, ...unstaged].filter(relativePath => !excluded.has(relativePath)));
}

function childSubmodulePaths(
	parentPath: string | null,
	submodules: readonly ManagedWorktreeSubmoduleRecord[],
): string[] {
	return submodules
		.filter(submodule => submodule.parentPath === parentPath)
		.map(submodule => (parentPath === null ? submodule.path : submodule.path.slice(parentPath.length + 1)));
}

async function applyTrackedDirtyState(
	sourceRepoRoot: string,
	targetRepoRoot: string,
	options: DirtyTransferOptions = {},
	excludedSubmodulePaths?: readonly string[],
): Promise<string[]> {
	const sourceRepo = vcs.requireGit(sourceRepoRoot);
	const targetRepo = vcs.requireGit(targetRepoRoot);
	const submodulePaths = options.ignoreSubmodules
		? (excludedSubmodulePaths ?? (await sourceRepo.submodulePaths()))
		: [];
	const excluded = new Set(submodulePaths);
	const files = options.ignoreSubmodules
		? uniqueSorted([...(await sourceRepo.lsTree("HEAD", [])), ...(await sourceRepo.lsFiles(false, false))]).filter(
				relativePath => !excluded.has(relativePath),
			)
		: undefined;
	const [stagedPatch, unstagedPatch, paths] = await Promise.all([
		files?.length === 0 ? "" : sourceRepo.diffText({ binary: true, cached: true, files }),
		files?.length === 0 ? "" : sourceRepo.diffText({ binary: true, files }),
		trackedDirtyPaths(sourceRepoRoot, excluded),
	]);
	if (stagedPatch.trim()) {
		await targetRepo.applyPatch(stagedPatch, {});
		await targetRepo.applyPatch(stagedPatch, { cached: true });
	}
	if (unstagedPatch.trim()) await targetRepo.applyPatch(unstagedPatch, {});
	return paths;
}

async function copyUntrackedFiles(sourceRepoRoot: string, targetRepoRoot: string): Promise<string[]> {
	const untrackedPaths = uniqueSorted(await vcs.requireGit(sourceRepoRoot).lsFiles(true, true));
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
	excludedSubmodulePaths: readonly string[] = [],
): Promise<DirtyTransferRepoResult> {
	const trackedPaths = await applyTrackedDirtyState(sourceRepoRoot, targetRepoRoot, options, excludedSubmodulePaths);
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
	const sourceRoot = vcs.git(submodule.sourceRepoRoot)?.info().repoRoot ?? null;
	if (sourceRoot === null) return null;
	if (path.resolve(sourceRoot) !== path.resolve(submodule.sourceRepoRoot)) return null;
	return sourceRoot;
}

async function prepareTargetSubmoduleHead(submodule: ManagedWorktreeSubmoduleRecord): Promise<void> {
	const sourceHead = await vcs.requireGit(submodule.sourceRepoRoot).headSha();
	if (!sourceHead || sourceHead === submodule.baseSha) return;
	try {
		await vcs.requireGit(submodule.worktreeRoot).checkout(sourceHead);
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
			await copyRepoDirtyState(
				sourceRoot,
				submodule.worktreeRoot,
				submodule.path,
				{ ignoreSubmodules: true },
				childSubmodulePaths(submodule.path, submodules),
			),
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
			await vcs.requireGit(sourceRepoRoot).restore({
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
	const rootResult = await copyRepoDirtyState(
		sourceRepoRoot,
		targetRepoRoot,
		"",
		{
			ignoreSubmodules: options.ignoreSubmodules,
		},
		childSubmodulePaths(null, options.submodules ?? []),
	);
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
	const rootResult = await copyRepoDirtyState(
		sourceRepoRoot,
		targetRepoRoot,
		"",
		{
			ignoreSubmodules: options.ignoreSubmodules,
		},
		childSubmodulePaths(null, options.submodules ?? []),
	);
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
