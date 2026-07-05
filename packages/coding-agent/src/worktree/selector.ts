import type { ManagedWorktreeListItem, ManagedWorktreeRecord, ManagedWorktreeState } from "./types";

export type ManagedWorktreeAction = "switch" | "merge" | "branch" | "remove" | "restore" | "path";

export interface ManagedWorktreeSelectableAction {
	action: ManagedWorktreeAction;
	label: string;
	enabled: boolean;
	reason: string | null;
}

const STATE_LABELS: Record<ManagedWorktreeState, string> = {
	creating: "Creating",
	ready: "Ready",
	removing: "Removing",
	orphaned: "Directory issue",
	snapshotted: "Snapshotted",
};

export function managedWorktreeStateLabel(state: ManagedWorktreeState): string {
	return STATE_LABELS[state];
}

export function sortManagedWorktreeItems(items: readonly ManagedWorktreeListItem[]): ManagedWorktreeListItem[] {
	return [...items].sort((left, right) => {
		if (left.current !== right.current) return left.current ? -1 : 1;
		return right.record.lastUsedAt.localeCompare(left.record.lastUsedAt);
	});
}

export function actionsForManagedWorktree(
	record: ManagedWorktreeRecord,
	exists: boolean,
): ManagedWorktreeSelectableAction[] {
	const missingReason = exists ? null : "Managed worktree directory is missing";
	const snapshotted = record.state === "snapshotted";
	return [
		{ action: "switch", label: "Switch", enabled: exists && !snapshotted, reason: missingReason },
		{ action: "merge", label: "Apply locally", enabled: exists && !snapshotted, reason: missingReason },
		{
			action: "branch",
			label: "Create branch",
			enabled: exists && record.detached,
			reason: record.detached ? missingReason : "Managed worktree is already on a branch",
		},
		{
			action: "remove",
			label: "Remove",
			enabled: !snapshotted,
			reason: snapshotted ? "Snapshot records must be cleaned with prune" : null,
		},
		{
			action: "restore",
			label: "Restore snapshot",
			enabled: snapshotted && record.snapshotPath !== null,
			reason: snapshotted ? null : "No restorable snapshot",
		},
		{ action: "path", label: "Copy path", enabled: true, reason: null },
	];
}
