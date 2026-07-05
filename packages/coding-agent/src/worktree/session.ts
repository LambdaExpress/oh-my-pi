import { writeManagedWorktreeRecord } from "./metadata";
import type { ManagedWorktreeRecord, ManagedWorktreeSessionStrategy } from "./types";

export interface ManagedWorktreeSessionBinding {
	sessionFile: string | null;
	sessionId: string | null;
	title: string | null;
}

export interface ManagedWorktreeSessionPlan {
	strategy: ManagedWorktreeSessionStrategy;
	record: ManagedWorktreeRecord;
	targetCwd: string;
}

export function bindManagedWorktreeSession(
	record: ManagedWorktreeRecord,
	binding: ManagedWorktreeSessionBinding,
): ManagedWorktreeRecord {
	const timestamp = new Date().toISOString();
	return {
		...record,
		sessionFile: binding.sessionFile,
		sessionId: binding.sessionId,
		title: binding.title,
		updatedAt: timestamp,
		lastUsedAt: timestamp,
	};
}

export async function writeManagedWorktreeSession(
	record: ManagedWorktreeRecord,
	binding: ManagedWorktreeSessionBinding,
): Promise<ManagedWorktreeRecord> {
	const updated = bindManagedWorktreeSession(record, binding);
	await writeManagedWorktreeRecord(updated);
	return updated;
}

export function createManagedWorktreeSessionPlan(
	strategy: ManagedWorktreeSessionStrategy,
	record: ManagedWorktreeRecord,
	targetCwd: string,
): ManagedWorktreeSessionPlan {
	return { strategy, record, targetCwd };
}
