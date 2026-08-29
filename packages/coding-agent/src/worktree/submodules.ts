import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { ptree } from "@oh-my-pi/pi-utils";
import { REJECT_PROMPT_COMMAND } from "../exec/non-interactive-env";
import { isSafeRelativePath } from "./include";
import type { ManagedWorktreeRecord, ManagedWorktreeSubmoduleRecord } from "./types";

const SUBMODULE_UPDATE_TIMEOUT_MS = 5 * 60 * 1000;

async function updateSubmodules(record: ManagedWorktreeRecord): Promise<void> {
	await ptree.exec(["git", "submodule", "update", "--init", "--recursive"], {
		cwd: record.worktreeRoot,
		env: {
			...process.env,
			GIT_ASKPASS: "true",
			GIT_COMMON_DIR: undefined,
			GIT_DIR: undefined,
			GIT_EDITOR: "true",
			GIT_INDEX_FILE: undefined,
			GIT_OBJECT_DIRECTORY: undefined,
			GIT_OPTIONAL_LOCKS: "0",
			GIT_TERMINAL_PROMPT: "0",
			GIT_WORK_TREE: undefined,
			GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
			SSH_ASKPASS: REJECT_PROMPT_COMMAND,
		},
		stderr: "full",
		timeout: SUBMODULE_UPDATE_TIMEOUT_MS,
	});
}

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
	await updateSubmodules(record);
	const paths = await vcs.requireGit(record.worktreeRoot).submodulePaths();
	return paths
		.slice()
		.sort((left, right) => submodulePathDepth(left) - submodulePathDepth(right) || left.localeCompare(right))
		.map(submodulePath => {
			if (!isSafeRelativePath(submodulePath)) throw new Error(`Refusing to handle unsafe path: ${submodulePath}`);
			const worktreeRoot = path.join(record.worktreeRoot, submodulePath);
			const headSha = vcs.requireGit(worktreeRoot).headSync().commit;
			if (!headSha) throw new Error(`Could not resolve initialized submodule HEAD: ${submodulePath}`);
			return {
				path: submodulePath,
				parentPath: parentPathForSubmodule(submodulePath, paths),
				sourceRepoRoot: path.join(record.sourceRepoRoot, submodulePath),
				worktreeRoot,
				baseSha: headSha,
				headSha,
				includeCopied: [],
			};
		});
}

export async function refreshManagedSubmoduleHeads(
	record: ManagedWorktreeRecord,
): Promise<ManagedWorktreeSubmoduleRecord[]> {
	const refreshed: ManagedWorktreeSubmoduleRecord[] = [];
	for (const submodule of record.submodules) {
		const headSha = await vcs.requireGit(submodule.worktreeRoot).headSha();
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
