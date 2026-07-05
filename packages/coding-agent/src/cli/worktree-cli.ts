/**
 * CLI handler for `omp worktree` — list and clean up agent-managed worktrees,
 * and dispatch managed background-worktree operations to the core manager.
 *
 * Layout under `~/.omp/wt/`:
 *
 *   - **Managed background worktrees** (`src/worktree/*`): Git worktrees plus
 *     sidecar metadata under `<base>/metadata/<id>.json`.
 *   - **PR-checkout worktrees** (`tools/gh.ts`): a regular git worktree dir
 *     containing a `.git` *file* that points back at
 *     `<parent-repo>/.git/worktrees/<name>/`.
 *   - **Task-isolation dirs** (`task/worktree.ts`): a wrapper dir with a
 *     compact `m` subdir mounted/cloned by `natives.isoStart`. Legacy `merged`
 *     subdirs are still recognized. These are ephemeral; `ensureIsolation`
 *     removes the base before re-creating it, so leftovers are crashed runs.
 *
 * Legacy entries from before the encoding change keep working because git still
 * tracks them by branch name. This command exists to GC them on demand.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getWorktreesDir, isEnoent } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import * as git from "../utils/git";
import {
	addManagedWorktree,
	branchManagedWorktree,
	mergeManagedWorktree,
	removeManagedWorktree,
	restoreManagedWorktree,
	targetCwdForRecord,
} from "../worktree/manager";
import { findManagedWorktreeRecord, listManagedWorktreeRecords } from "../worktree/metadata";
import type {
	ManagedWorktreeDirtyPolicy,
	ManagedWorktreeRecord,
	ManagedWorktreeSessionStrategy,
} from "../worktree/types";

export type WorktreeKind =
	| "managed"
	| "snapshotted"
	| "pr-checkout"
	| "task-isolation"
	| "raw-git-worktree"
	| "empty"
	| "stray";

type ManagedScannerStatus = "ok" | "missing" | "not-directory" | "unknown" | "snapshotted";

const TASK_ISOLATION_MOUNT_DIRS = ["m", "merged"] as const;
const RESERVED_WORKTREE_DIRS: Record<string, true> = { metadata: true, snapshots: true };

export interface WorktreeScannerState {
	pathExists: boolean;
	gitWorktree: boolean;
	status: ManagedScannerStatus;
	dirty?: boolean;
	error?: string;
}

export interface WorktreeEntry {
	/** Absolute path to the worktree dir (or stray container) under `~/.omp/wt/`. */
	path: string;
	/** Classification of what we found on disk or in sidecar metadata. */
	kind: WorktreeKind;
	/** Parent repo root, when this is a registered git worktree. */
	parentRepo?: string;
	/** Branch name extracted from the parent's tracking file, when available. */
	branch?: string;
	/** OMP sidecar metadata, when this is an Oh My Pi managed worktree. */
	metadata?: ManagedWorktreeRecord;
	/** Scanner/status refresh result. Included in JSON output for diagnostics. */
	scannerState?: WorktreeScannerState;
	/** When set, the entry is unhealthy and `omp worktree clear` will remove it. */
	orphanReason?: string;
}

export interface ListWorktreesOptions {
	json: boolean;
}

export interface ClearWorktreesOptions {
	/** Remove every legacy cleanup candidate, including live PR-checkout worktrees. */
	all: boolean;
	/** Print what would be removed without touching the filesystem. */
	dryRun: boolean;
	json: boolean;
}

export interface AddWorktreeCliOptions {
	cwd: string;
	name?: string;
	baseRef?: string;
	dirtyPolicy: ManagedWorktreeDirtyPolicy;
	recurseSubmodules: boolean;
	sessionStrategy?: ManagedWorktreeSessionStrategy;
	json: boolean;
}

export interface TargetWorktreeCliOptions {
	cwd: string;
	idOrName: string;
	json: boolean;
}

export interface RemoveWorktreeCliOptions extends TargetWorktreeCliOptions {
	force: boolean;
}

export interface BranchWorktreeCliOptions extends TargetWorktreeCliOptions {
	branch: string;
}

export async function listWorktrees(options: ListWorktreesOptions): Promise<void> {
	const entries = await scanWorktrees();
	if (options.json) {
		console.log(JSON.stringify(entries, null, 2));
		return;
	}
	if (entries.length === 0) {
		console.log(chalk.dim(`No agent-managed worktrees found under ${getWorktreesDir()}.`));
		return;
	}
	let live = 0;
	let orphaned = 0;
	let snapshotted = 0;
	for (const entry of entries) {
		const tag = entry.orphanReason
			? chalk.yellow("orphaned")
			: entry.kind === "snapshotted"
				? chalk.blue("snapshot")
				: entry.kind === "managed"
					? chalk.green("managed ")
					: entry.kind === "raw-git-worktree"
						? chalk.dim("raw     ")
						: chalk.green("live    ");
		const label = entry.metadata ? `${entry.metadata.name}  ${entry.path}` : entry.path;
		const detail = formatEntryDetail(entry);
		console.log(`${tag}  ${label}`);
		if (detail) console.log(`          ${chalk.dim(detail)}`);
		if (entry.orphanReason) orphaned += 1;
		else if (entry.kind === "snapshotted") snapshotted += 1;
		else live += 1;
	}
	const summary = [`${live} live`, `${orphaned} orphaned`];
	if (snapshotted > 0) summary.push(`${snapshotted} snapshotted`);
	summary.push(`${entries.length} total`);
	console.log(chalk.dim(`\n${summary.join(" · ")}`));
}

export async function clearWorktrees(options: ClearWorktreesOptions): Promise<void> {
	const entries = await scanWorktrees();
	const cleanupCandidates = entries.filter(
		entry =>
			entry.kind === "pr-checkout" ||
			entry.kind === "task-isolation" ||
			entry.kind === "empty" ||
			entry.kind === "stray",
	);
	const targets = options.all
		? cleanupCandidates
		: cleanupCandidates.filter(entry => entry.orphanReason !== undefined);

	if (targets.length === 0) {
		if (options.json) {
			console.log(JSON.stringify({ removed: 0, kept: entries.length }));
		} else {
			console.log(chalk.dim(options.all ? "No worktrees to remove." : "No orphaned worktrees to remove."));
		}
		return;
	}

	if (options.dryRun) {
		if (options.json) {
			console.log(JSON.stringify({ wouldRemove: targets.map(t => t.path) }, null, 2));
		} else {
			for (const target of targets) {
				console.log(`${chalk.yellow("would remove")}  ${target.path}`);
			}
			console.log(chalk.dim(`\n${targets.length} dir${targets.length === 1 ? "" : "s"} would be removed.`));
		}
		return;
	}

	const results: { path: string; ok: boolean; error?: string }[] = [];
	const parentsToPrune = new Set<string>();
	for (const target of targets) {
		try {
			if (target.kind === "pr-checkout" && target.parentRepo && !target.orphanReason) {
				// Live PR-checkout worktree: ask git to remove it cleanly. If git
				// refuses (locked, dirty, etc.), fall back to fs.rm and rely on
				// `worktree prune` to clean the bookkeeping on the parent side.
				const removed = await git.worktree.tryRemove(target.parentRepo, target.path, { force: true });
				if (!removed) {
					await fs.rm(target.path, { recursive: true, force: true });
					parentsToPrune.add(target.parentRepo);
				}
			} else {
				await fs.rm(target.path, { recursive: true, force: true });
				if (target.parentRepo) parentsToPrune.add(target.parentRepo);
			}
			results.push({ path: target.path, ok: true });
		} catch (err) {
			results.push({ path: target.path, ok: false, error: err instanceof Error ? err.message : String(err) });
		}
	}

	// Best-effort: drop stale entries from each affected parent's `.git/worktrees/`.
	for (const parent of parentsToPrune) {
		try {
			await git.worktree.prune(parent);
		} catch {
			/* parent repo may already be gone or pruned — ignore */
		}
	}

	const succeeded = results.filter(r => r.ok).length;
	const failed = results.length - succeeded;

	if (options.json) {
		console.log(JSON.stringify({ removed: succeeded, failed, results }, null, 2));
		if (failed > 0) process.exitCode = 1;
		return;
	}

	for (const result of results) {
		if (result.ok) {
			console.log(`${chalk.green("removed")}  ${result.path}`);
		} else {
			console.log(`${chalk.red("failed ")}  ${result.path}`);
			if (result.error) console.log(`          ${chalk.dim(result.error)}`);
		}
	}
	console.log(chalk.dim(`\n${succeeded} removed${failed > 0 ? ` · ${chalk.red(`${failed} failed`)}` : ""}`));
	if (failed > 0) process.exitCode = 1;
}

export async function pruneWorktrees(options: ClearWorktreesOptions): Promise<void> {
	await clearWorktrees(options);
}

export async function addWorktree(options: AddWorktreeCliOptions): Promise<void> {
	const result = await addManagedWorktree({
		cwd: options.cwd,
		name: options.name,
		baseRef: options.baseRef,
		dirtyPolicy: options.dirtyPolicy,
		recurseSubmodules: options.recurseSubmodules,
	});
	if (options.json) {
		console.log(JSON.stringify({ ...result, sessionStrategy: options.sessionStrategy ?? "none" }, null, 2));
		return;
	}
	console.log(`${chalk.green("created")}  managed worktree ${result.record.name}`);
	console.log(`          ${result.targetCwd}`);
	if (result.record.recurseSubmodules) {
		console.log(chalk.dim("          Recursive submodules enabled."));
	}
	if (options.dirtyPolicy === "ignore") {
		console.log(chalk.dim("          Current uncommitted changes were not copied."));
	}
	for (const warning of result.warnings) {
		console.log(`${chalk.yellow("warning")}  ${warning}`);
	}
	if (options.sessionStrategy && options.sessionStrategy !== "none") {
		console.log(
			chalk.dim("          CLI mode only creates the managed worktree; switch sessions from the interactive UI."),
		);
	}
}

export async function switchWorktree(options: TargetWorktreeCliOptions): Promise<void> {
	const record = await requireManagedRecord(options.idOrName);
	if (record.state === "snapshotted")
		throw new Error("Managed worktree directory is missing; run worktree restore first.");
	const targetPath = targetCwdForRecord(record);
	if (options.json) {
		console.log(JSON.stringify({ path: targetPath, id: record.id, name: record.name }, null, 2));
		return;
	}
	console.log(targetPath);
}

export async function pathWorktree(options: TargetWorktreeCliOptions): Promise<void> {
	const record = await requireManagedRecord(options.idOrName);
	if (options.json) {
		console.log(JSON.stringify({ path: record.worktreeRoot, id: record.id, name: record.name }, null, 2));
		return;
	}
	console.log(record.worktreeRoot);
}

export async function mergeWorktree(options: TargetWorktreeCliOptions): Promise<void> {
	const record = await mergeManagedWorktree({
		cwd: options.cwd,
		idOrName: options.idOrName,
	});
	if (options.json) {
		console.log(JSON.stringify(record, null, 2));
		return;
	}
	console.log(`${chalk.green("applied")}  managed worktree ${record.name} to local checkout`);
}

export async function removeWorktree(options: RemoveWorktreeCliOptions): Promise<void> {
	const entries = await scanWorktrees();
	const rawEntry = entries.find(
		entry =>
			entry.kind === "raw-git-worktree" &&
			(entry.path === options.idOrName ||
				path.basename(entry.path) === options.idOrName ||
				entry.branch === options.idOrName ||
				entry.metadata?.id === options.idOrName ||
				entry.metadata?.name === options.idOrName),
	);
	if (rawEntry) {
		throw new Error(
			`Refusing to remove raw Git worktree ${rawEntry.path}; only Oh My Pi managed worktrees can be removed.`,
		);
	}
	const record = await removeManagedWorktree({
		cwd: options.cwd,
		idOrName: options.idOrName,
		forcePermanent: options.force,
	});
	if (options.json) {
		console.log(JSON.stringify(record ?? { removed: true, idOrName: options.idOrName }, null, 2));
		return;
	}
	if (record?.state === "snapshotted" && record.snapshotPath) {
		console.log(
			`${chalk.yellow("snapshotted")}  managed worktree ${record.name} removed; snapshot saved at ${record.snapshotPath}`,
		);
	} else {
		console.log(`${chalk.green("removed")}  managed worktree ${record?.name ?? options.idOrName}`);
	}
}

export async function branchWorktree(options: BranchWorktreeCliOptions): Promise<void> {
	const record = await branchManagedWorktree({
		cwd: options.cwd,
		idOrName: options.idOrName,
		branch: options.branch,
	});
	if (options.json) {
		console.log(JSON.stringify(record, null, 2));
		return;
	}
	console.log(`${chalk.green("branched")}  managed worktree ${record.name} -> ${options.branch}`);
}

export async function restoreWorktree(options: TargetWorktreeCliOptions): Promise<void> {
	const result = await restoreManagedWorktree({
		cwd: options.cwd,
		idOrName: options.idOrName,
	});
	if (options.json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}
	console.log(`${chalk.green("restored")}  managed worktree ${result.record.name}`);
	console.log(`          ${result.targetCwd}`);
	for (const warning of result.warnings) {
		console.log(`${chalk.yellow("warning")}  ${warning}`);
	}
}

// ───────────────────────────────────────────────────────────────────────────
// Scanner
// ───────────────────────────────────────────────────────────────────────────

export async function scanWorktrees(): Promise<WorktreeEntry[]> {
	const managed = await scanManagedWorktrees();
	const managedPaths = new Set(managed.map(entry => normalizePathKey(entry.path)));
	const filesystem = await scanFilesystemWorktrees(managedPaths);
	return [...managed, ...filesystem].sort((a, b) => {
		const aManaged = a.metadata ? 0 : 1;
		const bManaged = b.metadata ? 0 : 1;
		if (aManaged !== bManaged) return aManaged - bManaged;
		return a.path.localeCompare(b.path);
	});
}

async function scanManagedWorktrees(): Promise<WorktreeEntry[]> {
	const records = await listManagedWorktreeRecords();
	const entries = await Promise.all(
		records.map(async record => {
			const scannerState = await inspectManagedRecord(record);
			return {
				path: record.worktreeRoot,
				kind: record.state === "snapshotted" ? "snapshotted" : "managed",
				parentRepo: record.primaryRoot,
				branch: record.branch ?? undefined,
				metadata: record,
				scannerState,
			} satisfies WorktreeEntry;
		}),
	);
	return entries;
}

async function scanFilesystemWorktrees(managedPaths: ReadonlySet<string>): Promise<WorktreeEntry[]> {
	const root = getWorktreesDir();
	let topLevel: string[];
	try {
		topLevel = await fs.readdir(root);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}

	const entries: WorktreeEntry[] = [];
	for (const name of topLevel) {
		if (RESERVED_WORKTREE_DIRS[name]) continue;
		const dir = path.join(root, name);
		const stat = await fs.stat(dir).catch(() => null);
		if (!stat?.isDirectory()) continue;
		if (managedPaths.has(normalizePathKey(dir))) continue;

		const direct = await classifyDir(dir);
		if (direct) {
			entries.push(direct);
			continue;
		}

		// Legacy nesting: ~/.omp/wt/<encoded-project>/<branch-or-id>
		let children: string[];
		try {
			children = await fs.readdir(dir);
		} catch {
			continue;
		}
		let nested = 0;
		for (const child of children) {
			const childDir = path.join(dir, child);
			const childStat = await fs.stat(childDir).catch(() => null);
			if (!childStat?.isDirectory()) continue;
			if (managedPaths.has(normalizePathKey(childDir))) {
				nested += 1;
				continue;
			}
			const childClassified = await classifyDir(childDir);
			if (childClassified) {
				entries.push(childClassified);
				nested += 1;
			}
		}
		if (nested === 0) {
			entries.push({
				path: dir,
				kind: children.length === 0 ? "empty" : "stray",
				orphanReason: children.length === 0 ? "empty directory" : "no recognizable worktree contents",
			});
		}
	}
	return entries;
}

async function classifyDir(dir: string): Promise<WorktreeEntry | null> {
	const gitEntry = path.join(dir, ".git");
	const gitStat = await fs.stat(gitEntry).catch(() => null);
	if (gitStat?.isFile()) {
		return classifyGitWorktree(dir, gitEntry);
	}
	for (const mountDir of TASK_ISOLATION_MOUNT_DIRS) {
		const mountStat = await fs.stat(path.join(dir, mountDir)).catch(() => null);
		if (!mountStat?.isDirectory()) continue;
		return {
			path: dir,
			kind: "task-isolation",
			orphanReason: "task-isolation leftover (no live task owns it)",
		};
	}
	return null;
}

async function classifyGitWorktree(dir: string, gitEntry: string): Promise<WorktreeEntry> {
	let contents: string;
	try {
		contents = await fs.readFile(gitEntry, "utf8");
	} catch (err) {
		const kind = inferGitWorktreeKind(dir);
		if (kind === "pr-checkout") {
			return { path: dir, kind, orphanReason: `cannot read .git file: ${formatError(err)}` };
		}
		return {
			path: dir,
			kind,
			scannerState: {
				pathExists: true,
				gitWorktree: true,
				status: "unknown",
				error: `cannot read .git file: ${formatError(err)}`,
			},
		};
	}
	const match = /^gitdir:\s*(.+?)\s*$/m.exec(contents);
	const parentGitDir = match?.[1];
	if (!parentGitDir) {
		const kind = inferGitWorktreeKind(dir);
		if (kind === "pr-checkout") return { path: dir, kind, orphanReason: "malformed .git file (no gitdir line)" };
		return {
			path: dir,
			kind,
			scannerState: {
				pathExists: true,
				gitWorktree: true,
				status: "unknown",
				error: "malformed .git file (no gitdir line)",
			},
		};
	}
	// parentGitDir is `<parent-repo>/.git/worktrees/<name>`; back out the repo root.
	const parentRepo = path.dirname(path.dirname(path.dirname(parentGitDir)));
	const branch = await readWorktreeBranch(path.join(parentGitDir, "HEAD"));
	const kind = inferGitWorktreeKind(dir, branch);

	const parentDirStat = await fs.stat(parentGitDir).catch(() => null);
	if (!parentDirStat?.isDirectory()) {
		if (kind === "pr-checkout") {
			return {
				path: dir,
				kind,
				parentRepo,
				branch,
				orphanReason: "parent repo no longer tracks this worktree",
			};
		}
		return {
			path: dir,
			kind,
			parentRepo,
			branch,
			scannerState: {
				pathExists: true,
				gitWorktree: true,
				status: "unknown",
				error: "parent repo no longer tracks this worktree",
			},
		};
	}
	const parentRepoStat = await fs.stat(parentRepo).catch(() => null);
	if (!parentRepoStat?.isDirectory()) {
		if (kind === "pr-checkout") {
			return {
				path: dir,
				kind,
				parentRepo,
				branch,
				orphanReason: "parent repo missing",
			};
		}
		return {
			path: dir,
			kind,
			parentRepo,
			branch,
			scannerState: {
				pathExists: true,
				gitWorktree: true,
				status: "unknown",
				error: "parent repo missing",
			},
		};
	}
	return { path: dir, kind, parentRepo, branch };
}

async function readWorktreeBranch(headFile: string): Promise<string | undefined> {
	try {
		const head = (await fs.readFile(headFile, "utf8")).trim();
		const refMatch = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
		return refMatch?.[1];
	} catch {
		return undefined;
	}
}

async function inspectManagedRecord(record: ManagedWorktreeRecord): Promise<WorktreeScannerState> {
	if (record.state === "snapshotted") {
		return { pathExists: false, gitWorktree: false, status: "snapshotted" };
	}
	const stat = await fs.stat(record.worktreeRoot).catch((err: unknown) => {
		if (isEnoent(err)) return null;
		throw err;
	});
	if (!stat) {
		return {
			pathExists: false,
			gitWorktree: false,
			status: "missing",
			error: "Managed worktree directory is missing",
		};
	}
	if (!stat.isDirectory()) {
		return {
			pathExists: true,
			gitWorktree: false,
			status: "not-directory",
			error: "metadata path is not a directory",
		};
	}
	try {
		const status = await git.status(record.worktreeRoot);
		return { pathExists: true, gitWorktree: true, status: "ok", dirty: status.trim().length > 0 };
	} catch (err) {
		return { pathExists: true, gitWorktree: true, status: "unknown", error: formatError(err) };
	}
}

function formatEntryDetail(entry: WorktreeEntry): string {
	const parts: string[] = [];
	if (entry.metadata) {
		const record = entry.metadata;
		parts.push("Oh My Pi managed worktree");
		parts.push(`state=${record.state}`);
		parts.push(record.branch ? `branch=${record.branch}` : `base=${record.baseRef}`);
		parts.push(record.detached ? "detached" : "attached");
		if (entry.scannerState?.status === "ok") {
			parts.push(entry.scannerState.dirty ? "has unapplied changes" : "no unapplied changes");
		} else if (entry.scannerState?.status === "unknown") {
			parts.push(`status unknown${entry.scannerState.error ? `: ${entry.scannerState.error}` : ""}`);
		} else if (entry.scannerState?.status === "missing") {
			parts.push("managed worktree directory is missing");
		}
		if (record.title) parts.push(`session=${record.title}`);
		const date = new Date(record.lastUsedAt);
		parts.push(`last used=${Number.isNaN(date.getTime()) ? record.lastUsedAt : date.toLocaleString()}`);
		if (record.snapshotPath) parts.push(`snapshot=${record.snapshotPath}`);
	} else if (entry.kind === "pr-checkout") {
		const repo = entry.parentRepo ? path.basename(entry.parentRepo) : "unknown repo";
		const branch = entry.branch ?? "unknown branch";
		parts.push(`GitHub PR checkout · ${repo} · ${branch}`);
	} else if (entry.kind === "raw-git-worktree") {
		const repo = entry.parentRepo ? path.basename(entry.parentRepo) : "unknown repo";
		const branch = entry.branch ?? "detached or unknown branch";
		parts.push(`raw Git worktree · ${repo} · ${branch}`);
	} else if (entry.kind === "task-isolation") {
		parts.push("task-isolation sandbox");
	} else if (entry.kind === "empty") {
		parts.push("legacy project shell");
	} else {
		parts.push("unrecognized contents");
	}
	if (entry.orphanReason) parts.push(entry.orphanReason);
	return parts.join(" — ");
}

function inferGitWorktreeKind(dir: string, branch?: string): "pr-checkout" | "raw-git-worktree" {
	if (branch && /^pr-\d+$/.test(branch)) return "pr-checkout";
	if (/^\d+-[0-9a-f]{7}(?:-\d+)?$/i.test(path.basename(dir))) return "pr-checkout";
	return "raw-git-worktree";
}

async function requireManagedRecord(idOrName: string): Promise<ManagedWorktreeRecord> {
	const record = await findManagedWorktreeRecord(idOrName);
	if (!record) throw new Error(`No Oh My Pi managed worktree found for ${idOrName}.`);
	if (record.state !== "snapshotted") {
		const stat = await fs.stat(record.worktreeRoot).catch((err: unknown) => {
			if (isEnoent(err)) return null;
			throw err;
		});
		if (!stat?.isDirectory()) throw new Error(`Managed worktree directory is missing: ${record.worktreeRoot}`);
	}
	return record;
}

function normalizePathKey(value: string): string {
	const resolved = path.resolve(value);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function formatError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
