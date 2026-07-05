import * as path from "node:path";
import * as git from "../utils/git";
import { isSafeRelativePath } from "./include";
import type { ManagedWorktreeRecord, ManagedWorktreeSubmoduleRecord } from "./types";

function submodulePathDepth(submodulePath: string): number {
	return submodulePath.split("/").length;
}

export function parentPathForSubmodule(submodulePath: string, allPaths: readonly string[]): string | null {
	let parentPath: string | null = null;
	for (const candidate of allPaths) {
		if (candidate === submodulePath || !submodulePath.startsWith(`${candidate}/`)) continue;
		if (parentPath === null || candidate.length > parentPath.length) parentPath = candidate;
	}
	return parentPath;
}

export async function initializeManagedSubmodules(
	record: ManagedWorktreeRecord,
): Promise<ManagedWorktreeSubmoduleRecord[]> {
	await git.submodule.updateInitRecursive(record.worktreeRoot);
	const entries = await git.submodule.status(record.worktreeRoot, { recursive: true });
	const paths = entries.map(entry => entry.path);
	return entries
		.slice()
		.sort((left, right) => submodulePathDepth(left.path) - submodulePathDepth(right.path) || left.path.localeCompare(right.path))
		.map(entry => {
			if (entry.marker === "-") throw new Error(`Submodule was not initialized: ${entry.path}`);
			if (!isSafeRelativePath(entry.path)) throw new Error(`Refusing to handle unsafe path: ${entry.path}`);
			return {
				path: entry.path,
				parentPath: parentPathForSubmodule(entry.path, paths),
				sourceRepoRoot: path.join(record.sourceRepoRoot, entry.path),
				worktreeRoot: path.join(record.worktreeRoot, entry.path),
				baseSha: entry.sha,
				headSha: entry.sha,
				includeCopied: [],
			};
		});
}

export async function refreshManagedSubmoduleHeads(
	record: ManagedWorktreeRecord,
): Promise<ManagedWorktreeSubmoduleRecord[]> {
	const refreshed: ManagedWorktreeSubmoduleRecord[] = [];
	for (const submodule of record.submodules) {
		const headSha = await git.head.sha(submodule.worktreeRoot);
		refreshed.push({
			...submodule,
			headSha: headSha ?? submodule.headSha,
		});
	}
	return refreshed;
}

export function submoduleRecordsByPath(
	submodules: readonly ManagedWorktreeSubmoduleRecord[],
): Map<string, ManagedWorktreeSubmoduleRecord> {
	const recordsByPath = new Map<string, ManagedWorktreeSubmoduleRecord>();
	for (const submodule of submodules) recordsByPath.set(submodule.path, submodule);
	return recordsByPath;
}
