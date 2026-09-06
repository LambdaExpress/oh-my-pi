import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getWorktreeDir, hashPath } from "@oh-my-pi/pi-utils";
import { withRepoLock } from "../utils/repo-lock";
import { copyDirtyStateToWorktree, moveDirtyStateToWorktree } from "./dirty-transfer";
import { isSafeRelativePath } from "./include";
import {
	deleteManagedWorktreeRecord,
	findManagedWorktreeRecord,
	listManagedWorktreeRecords,
	writeManagedWorktreeRecord,
} from "./metadata";
import {
	captureManagedWorktreeChanges,
	type ManagedWorktreeChanges,
	type ManagedWorktreeSubmoduleChanges,
	restoreManagedWorktreeSnapshot,
	saveManagedWorktreeSnapshot,
} from "./snapshot";
import { initializeManagedSubmodules, refreshManagedSubmoduleHeads, submoduleRecordsByPath } from "./submodules";
import type {
	ManagedWorktreeDirtyPolicy,
	ManagedWorktreeListItem,
	ManagedWorktreeRecord,
	ManagedWorktreeSubmoduleRecord,
} from "./types";

export { findManagedWorktreeRecord } from "./metadata";
export type { ManagedWorktreeListItem, ManagedWorktreeRecord } from "./types";

export interface AddManagedWorktreeOptions {
	cwd: string;
	name?: string;
	baseRef?: string;
	dirtyPolicy: ManagedWorktreeDirtyPolicy;
	recurseSubmodules?: boolean;
}

export interface ManagedWorktreeResult {
	record: ManagedWorktreeRecord;
	worktreeRoot: string;
	targetCwd: string;
	warnings: string[];
}

export interface RemoveManagedWorktreeOptions {
	cwd: string;
	idOrName: string;
	forcePermanent?: boolean;
}

export interface MergeManagedWorktreeOptions {
	cwd: string;
	idOrName: string;
}

export interface BranchManagedWorktreeOptions {
	cwd: string;
	idOrName: string;
	branch: string;
}

export interface RestoreManagedWorktreeOptions {
	cwd: string;
	idOrName: string;
}

const SAFE_NAME_FALLBACK = "worktree";
const WORKTREE_SHORT_ID_LENGTH = 8;

function nowIso(): string {
	return new Date().toISOString();
}

function randomId(): string {
	return crypto.randomUUID().replace(/-/g, "");
}

function shortId(id: string): string {
	return (
		id.replace(/[^a-zA-Z0-9]/g, "").slice(0, WORKTREE_SHORT_ID_LENGTH) ||
		randomId().slice(0, WORKTREE_SHORT_ID_LENGTH)
	);
}

export function safeManagedWorktreeName(input: string | undefined): string {
	const normalized = (input ?? SAFE_NAME_FALLBACK)
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[._-]+|[._-]+$/g, "")
		.slice(0, 48);
	if (!normalized || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i.test(normalized)) return SAFE_NAME_FALLBACK;
	return normalized;
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

function pathWithin(root: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function cleanRelativeCwd(relativeCwd: string): string {
	if (relativeCwd === "") return "";
	if (!isSafeRelativePath(relativeCwd))
		throw new Error(`Managed worktree record contains an unsafe relative path: ${relativeCwd}`);
	return relativeCwd;
}

export function targetCwdForRecord(record: ManagedWorktreeRecord): string {
	const relativeCwd = cleanRelativeCwd(record.relativeCwd);
	return relativeCwd === "" ? record.worktreeRoot : path.join(record.worktreeRoot, relativeCwd);
}

export function localCwdForRecord(record: ManagedWorktreeRecord): string {
	const relativeCwd = cleanRelativeCwd(record.relativeCwd);
	return relativeCwd === "" ? record.sourceRepoRoot : path.join(record.sourceRepoRoot, relativeCwd);
}

async function resolveRepositoryRoots(cwd: string): Promise<{ repoRoot: string; primaryRoot: string }> {
	const repo = vcs.git(cwd);
	if (!repo) throw new Error("Current directory is not inside a Git repository; cannot create a managed worktree.");
	return { repoRoot: repo.info().repoRoot, primaryRoot: repo.primaryRoot() };
}

async function resolveOptionalRepositoryRoots(cwd: string): Promise<{ repoRoot: string; primaryRoot: string } | null> {
	const repo = vcs.git(cwd);
	return repo ? { repoRoot: repo.info().repoRoot, primaryRoot: repo.primaryRoot() } : null;
}

async function createPathCandidate(primaryRoot: string, name: string): Promise<{ id: string; worktreeRoot: string }> {
	const projectHash = hashPath(primaryRoot);
	for (let attempt = 0; attempt < 20; attempt++) {
		const id = randomId();
		const worktreeRoot = getWorktreeDir(path.join(projectHash, `${name}-${shortId(id)}`));
		if (!(await pathExists(worktreeRoot))) return { id, worktreeRoot };
	}
	throw new Error("Could not allocate a unique directory for the managed worktree.");
}

async function removeEmptyParents(worktreeRoot: string): Promise<void> {
	await fs.rm(worktreeRoot, { force: true, recursive: true });
	const parent = path.dirname(worktreeRoot);
	try {
		await fs.rmdir(parent);
	} catch {
		/* parent may contain sibling worktrees */
	}
}

async function rollbackCreatedWorktree(primaryRoot: string, worktreeRoot: string, id: string): Promise<void> {
	try {
		await vcs.requireGit(primaryRoot).worktreeRemove(worktreeRoot, true);
	} catch {
		/* best effort rollback */
	}
	await Promise.all([deleteManagedWorktreeRecord(id), removeEmptyParents(worktreeRoot)]);
}

async function localCheckoutIsDirty(
	repoRoot: string,
	options: { ignoreSubmodules?: boolean; submodulePaths?: readonly string[] } = {},
): Promise<boolean> {
	const repo = vcs.requireGit(repoRoot);
	if (options.ignoreSubmodules) {
		const [status, submodulePaths] = await Promise.all([
			repo.statusPorcelain({ untracked: "normal", nulTerminated: true }),
			options.submodulePaths ?? repo.submodulePaths(),
		]);
		const excluded = new Set(submodulePaths);
		const entries = status.split("\0");
		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index];
			if (entry.length < 4) continue;
			const statusCode = entry.slice(0, 2);
			const relativePath = entry.slice(3);
			const renamedOrCopied = statusCode.includes("R") || statusCode.includes("C");
			const sourcePath = renamedOrCopied ? entries[index + 1] : undefined;
			if (!excluded.has(relativePath) || (sourcePath !== undefined && !excluded.has(sourcePath))) return true;
			if (renamedOrCopied) index++;
		}
		return false;
	}
	const summary = await repo.statusSummary();
	return summary.staged > 0 || summary.unstaged > 0 || summary.untracked > 0;
}

function childSubmodulePaths(
	parentPath: string | null,
	submodules: readonly ManagedWorktreeSubmoduleRecord[],
): string[] {
	return submodules
		.filter(submodule => submodule.parentPath === parentPath)
		.map(submodule => (parentPath === null ? submodule.path : submodule.path.slice(parentPath.length + 1)));
}

function submoduleChangesHaveContent(changes: ManagedWorktreeSubmoduleChanges): boolean {
	return (
		changes.rootPatch.trim().length > 0 ||
		changes.untrackedPaths.length > 0 ||
		changes.includedIgnoredPaths.length > 0
	);
}

function hasChanges(changes: ManagedWorktreeChanges): boolean {
	if (
		changes.rootPatch.trim().length > 0 ||
		changes.untrackedPaths.length > 0 ||
		changes.includedIgnoredPaths.length > 0
	) {
		return true;
	}
	return changes.submodules.some(submoduleChangesHaveContent);
}

function recordWithCapturedHeads(
	record: ManagedWorktreeRecord,
	changes: ManagedWorktreeChanges,
): ManagedWorktreeRecord {
	const changesByPath = new Map(changes.submodules.map(submodule => [submodule.path, submodule.headSha]));
	return {
		...record,
		headSha: changes.headSha,
		submodules: record.submodules.map(submodule => ({
			...submodule,
			headSha: changesByPath.get(submodule.path) ?? submodule.headSha,
		})),
	};
}

function changedFilePaths(changes: {
	untrackedPaths: readonly string[];
	includedIgnoredPaths: readonly string[];
}): string[] {
	return [...changes.untrackedPaths, ...changes.includedIgnoredPaths];
}

async function copyChangedFiles(
	sourceRoot: string,
	targetRoot: string,
	relativePaths: readonly string[],
): Promise<void> {
	for (const relativePath of relativePaths) {
		await fs.mkdir(path.dirname(path.join(targetRoot, relativePath)), { recursive: true });
		await fs.cp(path.join(sourceRoot, relativePath), path.join(targetRoot, relativePath), {
			errorOnExist: true,
			force: false,
			preserveTimestamps: true,
			recursive: true,
			verbatimSymlinks: true,
		});
	}
}

async function requireSubmoduleRepoRoot(repoRoot: string, submodulePath: string): Promise<void> {
	const resolvedRoot = vcs.git(repoRoot)?.info().repoRoot ?? null;
	if (resolvedRoot === null || path.resolve(resolvedRoot) !== path.resolve(repoRoot)) {
		throw new Error(`Managed submodule directory is missing: ${submodulePath}`);
	}
}

async function managedSourceIsDirty(record: ManagedWorktreeRecord): Promise<boolean> {
	if (
		await localCheckoutIsDirty(record.sourceRepoRoot, {
			ignoreSubmodules: record.recurseSubmodules,
			submodulePaths: childSubmodulePaths(null, record.submodules),
		})
	)
		return true;
	if (!record.recurseSubmodules) return false;
	for (const submodule of record.submodules) {
		const sourceRoot = vcs.git(submodule.sourceRepoRoot)?.info().repoRoot ?? null;
		if (sourceRoot === null || path.resolve(sourceRoot) !== path.resolve(submodule.sourceRepoRoot)) continue;
		if (
			await localCheckoutIsDirty(submodule.sourceRepoRoot, {
				ignoreSubmodules: true,
				submodulePaths: childSubmodulePaths(submodule.path, record.submodules),
			})
		)
			return true;
	}
	return false;
}

async function managedWorktreeIsDirty(record: ManagedWorktreeRecord): Promise<boolean> {
	if (
		await localCheckoutIsDirty(record.worktreeRoot, {
			ignoreSubmodules: record.recurseSubmodules,
			submodulePaths: childSubmodulePaths(null, record.submodules),
		})
	)
		return true;
	if (!record.recurseSubmodules) return false;
	for (const submodule of record.submodules) {
		if (
			await localCheckoutIsDirty(submodule.worktreeRoot, {
				ignoreSubmodules: true,
				submodulePaths: childSubmodulePaths(submodule.path, record.submodules),
			})
		)
			return true;
	}
	return false;
}

async function requireManagedRecord(idOrName: string): Promise<ManagedWorktreeRecord> {
	const record = await findManagedWorktreeRecord(idOrName);
	if (record?.owner !== "omp") throw new Error(`No Oh My Pi managed worktree found for ${idOrName}.`);
	return record;
}

async function ensureRecordPrimary(record: ManagedWorktreeRecord, primaryRoot: string): Promise<void> {
	if (path.resolve(record.primaryRoot) !== path.resolve(primaryRoot)) {
		throw new Error("Managed worktree does not belong to the current local checkout; cannot perform this operation.");
	}
}

async function transferDirtyState(
	record: ManagedWorktreeRecord,
	policy: ManagedWorktreeDirtyPolicy,
): Promise<{ includeCopied: string[]; submodules: ManagedWorktreeSubmoduleRecord[]; warnings: string[] }> {
	if (policy === "ignore") {
		const warnings = (await managedSourceIsDirty(record))
			? ["Current uncommitted changes were not copied into the managed worktree."]
			: [];
		return { includeCopied: [], submodules: record.submodules, warnings };
	}
	const dirtyTransferOptions = {
		ignoreSubmodules: record.recurseSubmodules,
		submodules: record.recurseSubmodules ? record.submodules : [],
	};
	const result =
		policy === "copy"
			? await copyDirtyStateToWorktree(
					record.sourceRepoRoot,
					record.worktreeRoot,
					record.baseSha,
					dirtyTransferOptions,
				)
			: await moveDirtyStateToWorktree(
					record.sourceRepoRoot,
					record.worktreeRoot,
					record.baseSha,
					dirtyTransferOptions,
				);
	const includedByPath = new Map(result.submodules.map(submodule => [submodule.path, submodule.includedIgnoredPaths]));
	const submodules = await refreshManagedSubmoduleHeads({
		...record,
		submodules: record.submodules.map(submodule => ({
			...submodule,
			includeCopied: includedByPath.get(submodule.path) ?? submodule.includeCopied,
		})),
	});
	return { includeCopied: result.includedIgnoredPaths, submodules, warnings: result.warnings };
}

export async function addManagedWorktree(options: AddManagedWorktreeOptions): Promise<ManagedWorktreeResult> {
	const cwd = path.resolve(options.cwd);
	const { repoRoot, primaryRoot } = await resolveRepositoryRoots(cwd);
	const baseRef = options.baseRef ?? "HEAD";
	const baseSha = await vcs.requireGit(repoRoot).resolveRef(baseRef);
	if (!baseSha) throw new Error(`Could not resolve managed worktree base: ${baseRef}`);
	const displayName =
		(options.name ?? path.basename(repoRoot)).trim() || path.basename(repoRoot) || SAFE_NAME_FALLBACK;
	const safeName = safeManagedWorktreeName(displayName);
	const { id, worktreeRoot } = await createPathCandidate(primaryRoot, safeName);
	const relativeCwd = path.relative(repoRoot, cwd);
	if (relativeCwd && !isSafeRelativePath(relativeCwd))
		throw new Error("Current directory is outside the Git repository; cannot create a managed worktree.");
	const timestamp = nowIso();
	let record: ManagedWorktreeRecord = {
		id,
		name: displayName,
		owner: "omp",
		version: 2,
		primaryRoot,
		sourceRepoRoot: repoRoot,
		worktreeRoot,
		relativeCwd,
		baseRef,
		baseSha,
		headSha: baseSha,
		mode: "managed",
		state: "creating",
		branch: null,
		detached: true,
		sessionFile: null,
		sessionId: null,
		title: null,
		createdAt: timestamp,
		updatedAt: timestamp,
		lastUsedAt: timestamp,
		dirtyPolicy: options.dirtyPolicy,
		includeCopied: [],
		recurseSubmodules: options.recurseSubmodules ?? false,
		submodules: [],
		snapshotPath: null,
		appliedAt: null,
	};
	await writeManagedWorktreeRecord(record);
	try {
		await withRepoLock(primaryRoot, () =>
			vcs.requireGit(primaryRoot).worktreeAdd(worktreeRoot, baseSha, { detach: true, clone: false }),
		);
	} catch (err) {
		await rollbackCreatedWorktree(primaryRoot, worktreeRoot, id);
		throw err;
	}
	try {
		if (record.recurseSubmodules) {
			record = { ...record, submodules: await initializeManagedSubmodules(record), updatedAt: nowIso() };
			await writeManagedWorktreeRecord(record);
		}
		const transfer = await transferDirtyState(record, options.dirtyPolicy);
		record = {
			...record,
			headSha: (await vcs.requireGit(worktreeRoot).headSha()) ?? baseSha,
			state: "ready",
			includeCopied: transfer.includeCopied,
			submodules: transfer.submodules,
			updatedAt: nowIso(),
			lastUsedAt: nowIso(),
		};
		await writeManagedWorktreeRecord(record);
		return { record, worktreeRoot, targetCwd: targetCwdForRecord(record), warnings: transfer.warnings };
	} catch (err) {
		await rollbackCreatedWorktree(primaryRoot, worktreeRoot, id);
		throw err;
	}
}

export async function listManagedWorktrees(cwd: string): Promise<ManagedWorktreeListItem[]> {
	const roots = await resolveOptionalRepositoryRoots(path.resolve(cwd));
	const records = await listManagedWorktreeRecords();
	const filtered = roots
		? records.filter(record => path.resolve(record.primaryRoot) === path.resolve(roots.primaryRoot))
		: records;
	return Promise.all(
		filtered.map(async record => {
			try {
				const exists = await pathExists(record.worktreeRoot);
				const targetCwd = targetCwdForRecord(record);
				const current = roots
					? pathWithin(record.worktreeRoot, roots.repoRoot) || pathWithin(record.worktreeRoot, cwd)
					: false;
				if (!exists || record.state === "snapshotted") {
					return {
						record,
						worktreeRoot: record.worktreeRoot,
						targetCwd,
						exists,
						current,
						dirty: null,
						unapplied: null,
						error: null,
					};
				}
				const changes = await captureManagedWorktreeChanges(record);
				return {
					record: recordWithCapturedHeads(record, changes),
					worktreeRoot: record.worktreeRoot,
					targetCwd,
					exists,
					current,
					dirty: await managedWorktreeIsDirty(record),
					unapplied: record.appliedAt === null && hasChanges(changes),
					error: null,
				};
			} catch (err) {
				return {
					record,
					worktreeRoot: record.worktreeRoot,
					targetCwd: record.worktreeRoot,
					exists: false,
					current: false,
					dirty: null,
					unapplied: null,
					error: err instanceof Error ? err.message : "Could not read managed worktree status",
				};
			}
		}),
	);
}

export async function removeManagedWorktree(
	options: RemoveManagedWorktreeOptions,
): Promise<ManagedWorktreeRecord | null> {
	const record = await requireManagedRecord(options.idOrName);
	const roots = await resolveOptionalRepositoryRoots(path.resolve(options.cwd));
	if (roots) {
		await ensureRecordPrimary(record, roots.primaryRoot);
		if (pathWithin(record.worktreeRoot, roots.repoRoot))
			throw new Error("Cannot remove the current managed worktree.");
	}
	if (record.mode === "permanent" && !options.forcePermanent)
		throw new Error("This managed worktree is marked as permanent and cannot be removed without --force.");
	if (record.state === "snapshotted") return record;
	if (!(await pathExists(record.worktreeRoot))) {
		const orphaned: ManagedWorktreeRecord = { ...record, state: "orphaned", updatedAt: nowIso() };
		await writeManagedWorktreeRecord(orphaned);
		return orphaned;
	}
	return withRepoLock(record.primaryRoot, async () => {
		const changes = await captureManagedWorktreeChanges(record);
		if (record.appliedAt === null && hasChanges(changes)) {
			const captured = recordWithCapturedHeads(record, changes);
			const snapshot = await saveManagedWorktreeSnapshot(captured);
			const snapshotted: ManagedWorktreeRecord = {
				...captured,
				state: "snapshotted",
				snapshotPath: snapshot.snapshotPath,
				updatedAt: nowIso(),
				lastUsedAt: nowIso(),
			};
			await writeManagedWorktreeRecord(snapshotted);
			await vcs.requireGit(record.primaryRoot).worktreeRemove(record.worktreeRoot, true);
			await removeEmptyParents(record.worktreeRoot);
			return snapshotted;
		}
		await vcs.requireGit(record.primaryRoot).worktreeRemove(record.worktreeRoot, true);
		await Promise.all([deleteManagedWorktreeRecord(record.id), removeEmptyParents(record.worktreeRoot)]);
		return null;
	});
}

export async function mergeManagedWorktree(options: MergeManagedWorktreeOptions): Promise<ManagedWorktreeRecord> {
	const cwd = path.resolve(options.cwd);
	const { repoRoot, primaryRoot } = await resolveRepositoryRoots(cwd);
	const record = await requireManagedRecord(options.idOrName);
	await ensureRecordPrimary(record, primaryRoot);
	if (pathWithin(record.worktreeRoot, repoRoot)) {
		throw new Error("Switch back to the local checkout before applying a managed worktree.");
	}
	if (
		await localCheckoutIsDirty(repoRoot, {
			ignoreSubmodules: record.recurseSubmodules,
			submodulePaths: childSubmodulePaths(null, record.submodules),
		})
	) {
		throw new Error("The local checkout has uncommitted changes. Handle them before applying the managed worktree.");
	}
	if (!(await pathExists(record.worktreeRoot)))
		throw new Error("Managed worktree directory is missing; cannot apply it to the local checkout.");
	const changes = await captureManagedWorktreeChanges(record);
	if (!hasChanges(changes)) throw new Error("No changes to apply.");
	const changedSubmodules = changes.submodules.filter(submoduleChangesHaveContent);
	const submodulesByPath = submoduleRecordsByPath(record.submodules);
	for (const submoduleChanges of changedSubmodules) {
		const localSubmoduleRoot = path.join(repoRoot, submoduleChanges.path);
		await requireSubmoduleRepoRoot(localSubmoduleRoot, submoduleChanges.path);
		if (
			await localCheckoutIsDirty(localSubmoduleRoot, {
				ignoreSubmodules: true,
				submodulePaths: childSubmodulePaths(submoduleChanges.path, record.submodules),
			})
		) {
			throw new Error(
				`The local submodule has uncommitted changes. Handle them before applying the managed worktree: ${submoduleChanges.path}`,
			);
		}
	}
	if (changes.rootPatch.trim() && !(await vcs.requireGit(repoRoot).canApplyPatch(changes.rootPatch, {}))) {
		throw new Error(
			"Managed worktree changes cannot be applied cleanly. Keep the managed worktree and resolve the conflict manually.",
		);
	}
	for (const submoduleChanges of changedSubmodules) {
		if (
			submoduleChanges.rootPatch.trim() &&
			!(await vcs
				.requireGit(path.join(repoRoot, submoduleChanges.path))
				.canApplyPatch(submoduleChanges.rootPatch, {}))
		) {
			throw new Error(
				"Managed worktree changes cannot be applied cleanly. Keep the managed worktree and resolve the conflict manually.",
			);
		}
	}
	for (const relativePath of changedFilePaths(changes)) {
		if (await pathExists(path.join(repoRoot, relativePath)))
			throw new Error(`Local path already exists; cannot apply untracked file: ${relativePath}`);
	}
	for (const submoduleChanges of changedSubmodules) {
		for (const relativePath of changedFilePaths(submoduleChanges)) {
			const displayPath = path.posix.join(submoduleChanges.path, relativePath.replace(/\\/g, "/"));
			if (await pathExists(path.join(repoRoot, submoduleChanges.path, relativePath)))
				throw new Error(`Local path already exists; cannot apply untracked file: ${displayPath}`);
		}
	}
	if (changes.rootPatch.trim()) await vcs.requireGit(repoRoot).applyPatch(changes.rootPatch, {});
	await copyChangedFiles(record.worktreeRoot, repoRoot, changedFilePaths(changes));
	for (const submoduleChanges of changedSubmodules) {
		const localSubmoduleRoot = path.join(repoRoot, submoduleChanges.path);
		if (submoduleChanges.rootPatch.trim())
			await vcs.requireGit(localSubmoduleRoot).applyPatch(submoduleChanges.rootPatch, {});
		const managedSubmodule = submodulesByPath.get(submoduleChanges.path);
		if (!managedSubmodule) throw new Error(`Managed submodule directory is missing: ${submoduleChanges.path}`);
		await copyChangedFiles(managedSubmodule.worktreeRoot, localSubmoduleRoot, changedFilePaths(submoduleChanges));
	}
	const captured = recordWithCapturedHeads(record, changes);
	const updated: ManagedWorktreeRecord = {
		...captured,
		submodules: record.recurseSubmodules ? await refreshManagedSubmoduleHeads(captured) : captured.submodules,
		appliedAt: nowIso(),
		updatedAt: nowIso(),
		lastUsedAt: nowIso(),
	};
	await writeManagedWorktreeRecord(updated);
	return updated;
}

export async function branchManagedWorktree(options: BranchManagedWorktreeOptions): Promise<ManagedWorktreeRecord> {
	const record = await requireManagedRecord(options.idOrName);
	if (record.branch || !record.detached)
		throw new Error(`Managed worktree is already on branch ${record.branch ?? "HEAD"}.`);
	if (!(await pathExists(record.worktreeRoot)))
		throw new Error("Managed worktree directory is missing; cannot create a branch.");
	return withRepoLock(record.primaryRoot, async () => {
		await vcs.requireGit(record.worktreeRoot).checkoutNewBranch(options.branch);
		const submodules = record.recurseSubmodules ? await refreshManagedSubmoduleHeads(record) : record.submodules;
		const updated: ManagedWorktreeRecord = {
			...record,
			branch: options.branch,
			detached: false,
			headSha: (await vcs.requireGit(record.worktreeRoot).headSha()) ?? record.headSha,
			submodules,
			updatedAt: nowIso(),
			lastUsedAt: nowIso(),
		};
		await writeManagedWorktreeRecord(updated);
		return updated;
	});
}

export async function restoreManagedWorktree(options: RestoreManagedWorktreeOptions): Promise<ManagedWorktreeResult> {
	const record = await requireManagedRecord(options.idOrName);
	if (record.state !== "snapshotted" || !record.snapshotPath)
		throw new Error("This managed worktree has no restorable snapshot.");
	if (!(await pathExists(record.snapshotPath)))
		throw new Error("Managed worktree snapshot is missing; cannot restore it.");
	const restoredName = safeManagedWorktreeName(record.name);
	const { worktreeRoot } = await createPathCandidate(record.primaryRoot, restoredName);
	await withRepoLock(record.primaryRoot, () =>
		vcs.requireGit(record.primaryRoot).worktreeAdd(worktreeRoot, record.baseSha, { detach: true, clone: false }),
	);
	let submodules = record.submodules;
	try {
		if (record.recurseSubmodules) {
			const initialized = await initializeManagedSubmodules({ ...record, worktreeRoot });
			const previousByPath = submoduleRecordsByPath(record.submodules);
			submodules = initialized.map(submodule => {
				const previous = previousByPath.get(submodule.path);
				return previous
					? { ...submodule, baseSha: previous.baseSha, includeCopied: previous.includeCopied }
					: submodule;
			});
		}
		await restoreManagedWorktreeSnapshot(record, worktreeRoot);
	} catch (err) {
		const orphaned: ManagedWorktreeRecord = {
			...record,
			worktreeRoot,
			submodules,
			state: "orphaned",
			updatedAt: nowIso(),
			lastUsedAt: nowIso(),
		};
		await writeManagedWorktreeRecord(orphaned);
		throw err;
	}
	const restored: ManagedWorktreeRecord = {
		...record,
		worktreeRoot,
		state: "ready",
		detached: true,
		branch: null,
		headSha: (await vcs.requireGit(worktreeRoot).headSha()) ?? record.baseSha,
		submodules: record.recurseSubmodules
			? await refreshManagedSubmoduleHeads({ ...record, worktreeRoot, submodules })
			: submodules,
		updatedAt: nowIso(),
		lastUsedAt: nowIso(),
	};
	await writeManagedWorktreeRecord(restored);
	return { record: restored, worktreeRoot, targetCwd: targetCwdForRecord(restored), warnings: [] };
}
