import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getWorktreeDir, hashPath } from "@oh-my-pi/pi-utils";
import * as git from "../utils/git";
import { copyDirtyStateToWorktree, moveDirtyStateToWorktree } from "./dirty-transfer";
import { isSafeRelativePath } from "./include";
import {
	deleteManagedWorktreeRecord,
	findManagedWorktreeRecord,
	listManagedWorktreeRecords,
	writeManagedWorktreeRecord,
} from "./metadata";
import { captureManagedWorktreeChanges, restoreManagedWorktreeSnapshot, saveManagedWorktreeSnapshot } from "./snapshot";
import type { ManagedWorktreeDirtyPolicy, ManagedWorktreeListItem, ManagedWorktreeRecord } from "./types";

export type { ManagedWorktreeListItem, ManagedWorktreeRecord } from "./types";
export { findManagedWorktreeRecord } from "./metadata";

export interface AddManagedWorktreeOptions {
	cwd: string;
	name?: string;
	baseRef?: string;
	dirtyPolicy: ManagedWorktreeDirtyPolicy;
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

async function resolveRepositoryRoots(cwd: string): Promise<{ repoRoot: string; primaryRoot: string }> {
	const repoRoot = await git.repo.root(cwd);
	if (!repoRoot)
		throw new Error("Current directory is not inside a Git repository; cannot create a managed worktree.");
	const primaryRoot = (await git.repo.primaryRoot(cwd)) ?? repoRoot;
	return { repoRoot, primaryRoot };
}

async function resolveOptionalRepositoryRoots(cwd: string): Promise<{ repoRoot: string; primaryRoot: string } | null> {
	const repoRoot = await git.repo.root(cwd);
	if (!repoRoot) return null;
	return { repoRoot, primaryRoot: (await git.repo.primaryRoot(cwd)) ?? repoRoot };
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
		await git.worktree.tryRemove(primaryRoot, worktreeRoot, { force: true });
	} catch {
		/* best effort rollback */
	}
	await Promise.all([deleteManagedWorktreeRecord(id), removeEmptyParents(worktreeRoot)]);
}

async function localCheckoutIsDirty(repoRoot: string): Promise<boolean> {
	const summary = await git.status.summary(repoRoot);
	if (!summary) throw new Error("Could not read the local checkout status.");
	return summary.staged > 0 || summary.unstaged > 0 || summary.untracked > 0;
}

function hasChanges(changes: {
	rootPatch: string;
	untrackedPaths: readonly string[];
	includedIgnoredPaths: readonly string[];
}): boolean {
	return (
		changes.rootPatch.trim().length > 0 ||
		changes.untrackedPaths.length > 0 ||
		changes.includedIgnoredPaths.length > 0
	);
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
): Promise<{ includeCopied: string[]; warnings: string[] }> {
	if (policy === "ignore") {
		const warnings = (await localCheckoutIsDirty(record.sourceRepoRoot))
			? ["Current uncommitted changes were not copied into the managed worktree."]
			: [];
		return { includeCopied: [], warnings };
	}
	const result =
		policy === "copy"
			? await copyDirtyStateToWorktree(record.sourceRepoRoot, record.worktreeRoot, record.baseSha)
			: await moveDirtyStateToWorktree(record.sourceRepoRoot, record.worktreeRoot, record.baseSha);
	return { includeCopied: result.includedIgnoredPaths, warnings: result.warnings };
}

export async function addManagedWorktree(options: AddManagedWorktreeOptions): Promise<ManagedWorktreeResult> {
	const cwd = path.resolve(options.cwd);
	const { repoRoot, primaryRoot } = await resolveRepositoryRoots(cwd);
	const baseRef = options.baseRef ?? "HEAD";
	const baseSha = await git.ref.resolve(repoRoot, baseRef);
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
		version: 1,
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
		snapshotPath: null,
		appliedAt: null,
	};
	await writeManagedWorktreeRecord(record);
	try {
		await git.withRepoLock(primaryRoot, () => git.worktree.add(primaryRoot, worktreeRoot, baseSha, { detach: true }));
	} catch (err) {
		await rollbackCreatedWorktree(primaryRoot, worktreeRoot, id);
		throw err;
	}
	try {
		const transfer = await transferDirtyState(record, options.dirtyPolicy);
		record = {
			...record,
			headSha: (await git.head.sha(worktreeRoot)) ?? baseSha,
			state: "ready",
			includeCopied: transfer.includeCopied,
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
					record: { ...record, headSha: changes.headSha },
					worktreeRoot: record.worktreeRoot,
					targetCwd,
					exists,
					current,
					dirty: await localCheckoutIsDirty(record.worktreeRoot),
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
	return git.withRepoLock(record.primaryRoot, async () => {
		const changes = await captureManagedWorktreeChanges(record);
		if (record.appliedAt === null && hasChanges(changes)) {
			const snapshot = await saveManagedWorktreeSnapshot({ ...record, headSha: changes.headSha });
			const snapshotted: ManagedWorktreeRecord = {
				...record,
				headSha: changes.headSha,
				state: "snapshotted",
				snapshotPath: snapshot.snapshotPath,
				updatedAt: nowIso(),
				lastUsedAt: nowIso(),
			};
			await writeManagedWorktreeRecord(snapshotted);
			await git.worktree.remove(record.primaryRoot, record.worktreeRoot, { force: true });
			await removeEmptyParents(record.worktreeRoot);
			return snapshotted;
		}
		await git.worktree.remove(record.primaryRoot, record.worktreeRoot, { force: true });
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
	if (await localCheckoutIsDirty(repoRoot)) {
		throw new Error("The local checkout has uncommitted changes. Handle them before applying the managed worktree.");
	}
	if (!(await pathExists(record.worktreeRoot)))
		throw new Error("Managed worktree directory is missing; cannot apply it to the local checkout.");
	const changes = await captureManagedWorktreeChanges(record);
	if (!hasChanges(changes)) throw new Error("No changes to apply.");
	if (changes.rootPatch.trim() && !(await git.patch.canApplyText(repoRoot, changes.rootPatch))) {
		throw new Error(
			"Managed worktree changes cannot be applied cleanly. Keep the managed worktree and resolve the conflict manually.",
		);
	}
	for (const relativePath of changes.untrackedPaths) {
		if (await pathExists(path.join(repoRoot, relativePath)))
			throw new Error(`Local path already exists; cannot apply untracked file: ${relativePath}`);
	}
	if (changes.rootPatch.trim()) await git.patch.applyText(repoRoot, changes.rootPatch);
	for (const relativePath of changes.untrackedPaths) {
		await fs.mkdir(path.dirname(path.join(repoRoot, relativePath)), { recursive: true });
		await fs.cp(path.join(record.worktreeRoot, relativePath), path.join(repoRoot, relativePath), {
			errorOnExist: true,
			force: false,
			preserveTimestamps: true,
			recursive: true,
			verbatimSymlinks: true,
		});
	}
	const updated: ManagedWorktreeRecord = {
		...record,
		headSha: changes.headSha,
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
	return git.withRepoLock(record.primaryRoot, async () => {
		await git.branch.checkoutNew(record.worktreeRoot, options.branch);
		const updated: ManagedWorktreeRecord = {
			...record,
			branch: options.branch,
			detached: false,
			headSha: (await git.head.sha(record.worktreeRoot)) ?? record.headSha,
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
	await git.withRepoLock(record.primaryRoot, () =>
		git.worktree.add(record.primaryRoot, worktreeRoot, record.baseSha, { detach: true }),
	);
	try {
		await restoreManagedWorktreeSnapshot(record, worktreeRoot);
	} catch (err) {
		const orphaned: ManagedWorktreeRecord = {
			...record,
			worktreeRoot,
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
		headSha: (await git.head.sha(worktreeRoot)) ?? record.baseSha,
		updatedAt: nowIso(),
		lastUsedAt: nowIso(),
	};
	await writeManagedWorktreeRecord(restored);
	return { record: restored, worktreeRoot, targetCwd: targetCwdForRecord(restored), warnings: [] };
}
