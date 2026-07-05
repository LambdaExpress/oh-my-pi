export type ManagedWorktreeMode = "managed" | "permanent";
export type ManagedWorktreeState = "creating" | "ready" | "removing" | "orphaned" | "snapshotted";
export type ManagedWorktreeDirtyPolicy = "ignore" | "copy" | "move";
export type ManagedWorktreeSessionStrategy = "none" | "new" | "fork";

export interface ManagedWorktreeRecord {
	id: string;
	name: string;
	owner: "omp";
	version: 1;
	primaryRoot: string;
	sourceRepoRoot: string;
	worktreeRoot: string;
	relativeCwd: string;
	baseRef: string;
	baseSha: string;
	headSha: string;
	mode: ManagedWorktreeMode;
	state: ManagedWorktreeState;
	branch: string | null;
	detached: boolean;
	sessionFile: string | null;
	sessionId: string | null;
	title: string | null;
	createdAt: string;
	updatedAt: string;
	lastUsedAt: string;
	dirtyPolicy: ManagedWorktreeDirtyPolicy;
	includeCopied: string[];
	snapshotPath: string | null;
	appliedAt: string | null;
}

export interface ManagedWorktreeListItem {
	record: ManagedWorktreeRecord;
	worktreeRoot: string;
	targetCwd: string;
	exists: boolean;
	current: boolean;
	dirty: boolean | null;
	unapplied: boolean | null;
	error: string | null;
}
