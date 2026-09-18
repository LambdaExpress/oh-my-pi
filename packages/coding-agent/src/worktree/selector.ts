import { t } from "../i18n";
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
	return t(STATE_LABELS[state]);
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
	const missingReason = exists ? null : t("Managed worktree directory is missing");
	const snapshotted = record.state === "snapshotted";
	return [
		{ action: "switch", label: t("Switch"), enabled: exists && !snapshotted, reason: missingReason },
		{ action: "merge", label: t("Apply locally"), enabled: exists && !snapshotted, reason: missingReason },
		{
			action: "branch",
			label: t("Create branch"),
			enabled: exists && record.detached,
			reason: record.detached ? missingReason : t("Managed worktree is already on a branch"),
		},
		{
			action: "remove",
			label: t("Remove"),
			enabled: !snapshotted,
			reason: snapshotted ? t("Snapshot records must be cleaned with prune") : null,
		},
		{
			action: "restore",
			label: t("Restore snapshot"),
			enabled: snapshotted && record.snapshotPath !== null,
			reason: snapshotted ? null : t("No restorable snapshot"),
		},
		{ action: "path", label: t("Copy path"), enabled: true, reason: null },
	];
}
