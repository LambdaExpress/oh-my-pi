import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getWorktreesDir, hashPath } from "@oh-my-pi/pi-utils";
import type {
	ManagedWorktreeDirtyPolicy,
	ManagedWorktreeMode,
	ManagedWorktreeRecord,
	ManagedWorktreeState,
} from "./types";

const RECORD_VERSION = 1;
const OWNER = "omp";

export function managedMetadataDir(): string {
	return path.join(getWorktreesDir(), "metadata");
}

export function managedSnapshotDir(primaryRoot: string, id: string, timestamp: string): string {
	return path.join(getWorktreesDir(), "snapshots", hashPath(primaryRoot), `${id}-${timestamp}`);
}

function metadataPath(id: string): string {
	return path.join(managedMetadataDir(), `${id}.json`);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isString);
}

function isManagedWorktreeMode(value: unknown): value is ManagedWorktreeMode {
	return value === "managed" || value === "permanent";
}

function isManagedWorktreeState(value: unknown): value is ManagedWorktreeState {
	return (
		value === "creating" ||
		value === "ready" ||
		value === "removing" ||
		value === "orphaned" ||
		value === "snapshotted"
	);
}

function isManagedWorktreeDirtyPolicy(value: unknown): value is ManagedWorktreeDirtyPolicy {
	return value === "ignore" || value === "copy" || value === "move";
}

function parseManagedWorktreeRecord(value: unknown): ManagedWorktreeRecord | null {
	if (value === null || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (record.owner !== OWNER || record.version !== RECORD_VERSION) return null;
	if (
		!isString(record.id) ||
		!isString(record.name) ||
		!isString(record.primaryRoot) ||
		!isString(record.sourceRepoRoot) ||
		!isString(record.worktreeRoot) ||
		!isString(record.relativeCwd) ||
		!isString(record.baseRef) ||
		!isString(record.baseSha) ||
		!isString(record.headSha) ||
		!isManagedWorktreeMode(record.mode) ||
		!isManagedWorktreeState(record.state) ||
		!isNullableString(record.branch) ||
		typeof record.detached !== "boolean" ||
		!isNullableString(record.sessionFile) ||
		!isNullableString(record.sessionId) ||
		!isNullableString(record.title) ||
		!isString(record.createdAt) ||
		!isString(record.updatedAt) ||
		!isString(record.lastUsedAt) ||
		!isManagedWorktreeDirtyPolicy(record.dirtyPolicy) ||
		!isStringArray(record.includeCopied) ||
		!isNullableString(record.snapshotPath) ||
		!isNullableString(record.appliedAt)
	) {
		return null;
	}
	return record as unknown as ManagedWorktreeRecord;
}

async function readRecordFile(filePath: string): Promise<ManagedWorktreeRecord | null> {
	try {
		const text = await Bun.file(filePath).text();
		const parsed: unknown = JSON.parse(text);
		return parseManagedWorktreeRecord(parsed);
	} catch {
		return null;
	}
}

export async function listManagedWorktreeRecords(): Promise<ManagedWorktreeRecord[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(managedMetadataDir());
	} catch (err) {
		if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
		throw err;
	}
	const records = await Promise.all(
		entries
			.filter(entry => entry.endsWith(".json"))
			.map(entry => readRecordFile(path.join(managedMetadataDir(), entry))),
	);
	return records
		.filter((record): record is ManagedWorktreeRecord => record !== null)
		.sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt));
}

export async function readManagedWorktreeRecord(id: string): Promise<ManagedWorktreeRecord | null> {
	return readRecordFile(metadataPath(id));
}

export async function findManagedWorktreeRecord(idOrName: string): Promise<ManagedWorktreeRecord | null> {
	const records = await listManagedWorktreeRecords();
	return records.find(record => record.id === idOrName) ?? records.find(record => record.name === idOrName) ?? null;
}

export async function writeManagedWorktreeRecord(record: ManagedWorktreeRecord): Promise<void> {
	await fs.mkdir(managedMetadataDir(), { recursive: true });
	const filePath = metadataPath(record.id);
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await Bun.write(tempPath, `${JSON.stringify(record, null, "\t")}\n`);
	await fs.rename(tempPath, filePath);
}

export async function deleteManagedWorktreeRecord(id: string): Promise<void> {
	await fs.rm(metadataPath(id), { force: true });
}
