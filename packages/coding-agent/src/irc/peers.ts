import * as path from "node:path";

import type { AgentRef } from "../registry/agent-registry";
import type { SessionEntry } from "../session/session-entries";
import type { AgentProgress, SingleResult, TaskToolDetails } from "../task/types";

export interface IrcPeerScope {
	/** Authoritative set of peers visible from the current conversation branch. */
	agentIds?: ReadonlySet<string>;
	/** Compatibility fallback for callers that cannot expose branch ids yet. */
	sessionFile?: string | null;
}

function addId(ids: Set<string>, value: unknown): void {
	if (typeof value === "string" && value.trim().length > 0) ids.add(value);
}

function taskDetailsData(value: AgentProgress | SingleResult): readonly unknown[] {
	const taskData = value.extractedToolData?.task;
	return Array.isArray(taskData) ? taskData : [];
}

function collectFromProgress(progress: AgentProgress, ids: Set<string>, seen: WeakSet<object>): void {
	addId(ids, progress.id);
	collectFromTaskDetails(progress.inflightTaskDetails, ids, seen);
	for (const nested of taskDetailsData(progress)) collectFromTaskDetails(nested, ids, seen);
}

function collectFromResult(result: SingleResult, ids: Set<string>, seen: WeakSet<object>): void {
	addId(ids, result.id);
	for (const nested of taskDetailsData(result)) collectFromTaskDetails(nested, ids, seen);
}

function isTaskDetails(value: unknown): value is TaskToolDetails {
	return Boolean(value) && typeof value === "object" && Array.isArray((value as TaskToolDetails).results);
}

export function collectFromTaskDetails(value: unknown, ids: Set<string>, seen: WeakSet<object> = new WeakSet()): void {
	if (!isTaskDetails(value)) return;
	if (seen.has(value)) return;
	seen.add(value);
	for (const progress of value.progress ?? []) collectFromProgress(progress, ids, seen);
	for (const result of value.results) collectFromResult(result, ids, seen);
}

export function collectIrcPeerIdsFromSessionEntries(entries: readonly SessionEntry[]): Set<string> {
	const ids = new Set<string>();
	const seen = new WeakSet<object>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: unknown; toolName?: unknown; details?: unknown };
		if (message.role !== "toolResult" || message.toolName !== "task") continue;
		collectFromTaskDetails(message.details, ids, seen);
	}
	return ids;
}

function artifactsDirForSessionFile(sessionFile: string | null | undefined): string | null {
	return typeof sessionFile === "string" && sessionFile.endsWith(".jsonl") ? sessionFile.slice(0, -6) : null;
}

function isSameOrInside(child: string, parent: string): boolean {
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isRefInSessionArtifactScope(ref: AgentRef, sessionFile: string | null | undefined): boolean {
	const artifactsDir = artifactsDirForSessionFile(sessionFile);
	if (!artifactsDir || !ref.sessionFile) return true;
	return isSameOrInside(ref.sessionFile, artifactsDir);
}

export function isIrcPeerInScope(ref: AgentRef, scope: IrcPeerScope | undefined): boolean {
	if (scope?.agentIds) return scope.agentIds.has(ref.id);
	return isRefInSessionArtifactScope(ref, scope?.sessionFile);
}
