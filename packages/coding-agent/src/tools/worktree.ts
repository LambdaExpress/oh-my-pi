import * as fs from "node:fs/promises";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import worktreeDescription from "../prompts/tools/worktree.md" with { type: "text" };
import {
	addManagedWorktree,
	branchManagedWorktree,
	findManagedWorktreeRecord,
	listManagedWorktrees,
	localCwdForRecord,
	type ManagedWorktreeListItem,
	type ManagedWorktreeRecord,
	mergeManagedWorktree,
	removeManagedWorktree,
	restoreManagedWorktree,
	targetCwdForRecord,
} from "../worktree/manager";
import { writeManagedWorktreeSession } from "../worktree/session";
import type { ManagedWorktreeDirtyPolicy } from "../worktree/types";
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const WORKTREE_READONLY_OPS: Record<string, true> = { list: true, path: true };

const worktreeSchema = type({
	op: type("'list' | 'add' | 'path' | 'switch' | 'switch-local' | 'merge' | 'remove' | 'branch' | 'restore'").describe(
		"worktree operation",
	),
	"name?": type("string").describe("new worktree name for add"),
	"base?": type("string").describe("base ref for add; defaults to HEAD"),
	"dirtyPolicy?": type("'ignore' | 'copy' | 'move'").describe("uncommitted-change handling for add"),
	"recurseSubmodules?": type("boolean").describe(
		"initialize and manage submodules recursively for add; defaults false",
	),
	"idOrName?": type("string").describe("managed worktree id or name"),
	"branch?": type("string").describe("branch name for branch"),
	"force?": type("boolean").describe("allow removing permanent managed worktrees"),
});

type WorktreeInput = typeof worktreeSchema.infer;

export interface WorktreeToolDetails {
	meta?: OutputMeta;
	op: WorktreeInput["op"];
	items?: ManagedWorktreeListItem[];
	record?: ManagedWorktreeRecord;
	worktreeRoot?: string;
	targetCwd?: string;
	localCwd?: string;
	warnings?: string[];
	switchedCwd?: string;
	removed?: boolean;
}

function optionalText(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function requireText(value: string | undefined, label: string): string {
	const trimmed = optionalText(value);
	if (!trimmed) throw new ToolError(`${label} is required`);
	return trimmed;
}

async function requireManagedRecord(idOrName: string): Promise<ManagedWorktreeRecord> {
	const record = await findManagedWorktreeRecord(idOrName);
	if (!record) throw new ToolError(`Unknown managed worktree: ${idOrName}`);
	if (record.owner !== "omp") throw new ToolError(`No Oh My Pi managed worktree found for ${idOrName}.`);
	return record;
}

async function requireDirectory(
	dir: string,
	missingMessage = "Managed worktree directory is missing; remove metadata or restore from snapshot.",
): Promise<void> {
	try {
		const stat = await fs.stat(dir);
		if (stat.isDirectory()) return;
	} catch {
		// Fall through to the canonical tool error below.
	}
	throw new ToolError(missingMessage);
}

function statusLabel(item: ManagedWorktreeListItem): string {
	if (item.error) return `error: ${item.error}`;
	if (!item.exists) return item.record.state;
	if (item.current) return "current";
	if (item.unapplied) return "unapplied";
	if (item.dirty) return "dirty";
	return item.record.state;
}

function formatList(items: ManagedWorktreeListItem[]): string {
	if (items.length === 0) return "No managed worktrees for this repository.";
	const lines = [`Managed worktrees (${items.length}):`];
	for (const item of items) {
		lines.push(`- ${item.record.name} (${item.record.id.slice(0, 8)}): ${statusLabel(item)} — ${item.targetCwd}`);
	}
	return lines.join("\n");
}

function withTarget(details: WorktreeToolDetails, record: ManagedWorktreeRecord): WorktreeToolDetails {
	return {
		...details,
		record,
		worktreeRoot: record.worktreeRoot,
		targetCwd: targetCwdForRecord(record),
		localCwd: localCwdForRecord(record),
	};
}

export class WorktreeTool implements AgentTool<typeof worktreeSchema, WorktreeToolDetails> {
	readonly name = "worktree";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const rawOp = (args as Partial<WorktreeInput>).op;
		const op = typeof rawOp === "string" ? rawOp : "";
		return WORKTREE_READONLY_OPS[op] ? "read" : "exec";
	};
	readonly summary = "Manage Oh My Pi managed Git worktrees";
	readonly loadMode = "discoverable";
	readonly label = "Worktree";
	readonly description = prompt.render(worktreeDescription);
	readonly parameters = worktreeSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: WorktreeInput,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<WorktreeToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<WorktreeToolDetails>> {
		return untilAborted(signal, async () => {
			switch (params.op) {
				case "list": {
					const items = await listManagedWorktrees(this.session.cwd);
					return toolResult<WorktreeToolDetails>({ op: params.op, items }).text(formatList(items)).done();
				}
				case "add": {
					const result = await addManagedWorktree({
						cwd: this.session.cwd,
						name: optionalText(params.name),
						baseRef: optionalText(params.base),
						dirtyPolicy: (params.dirtyPolicy ?? "ignore") as ManagedWorktreeDirtyPolicy,
						recurseSubmodules: params.recurseSubmodules ?? false,
					});
					const lines = [`Created managed worktree ${result.record.name}.`, `Target cwd: ${result.targetCwd}`];
					if (result.record.recurseSubmodules) lines.push("Recursive submodules: enabled");
					for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
					return toolResult<WorktreeToolDetails>({
						op: params.op,
						record: result.record,
						worktreeRoot: result.worktreeRoot,
						targetCwd: result.targetCwd,
						warnings: result.warnings,
					})
						.text(lines.join("\n"))
						.done();
				}
				case "path": {
					const record = await requireManagedRecord(requireText(params.idOrName, "idOrName"));
					const targetCwd = targetCwdForRecord(record);
					return toolResult<WorktreeToolDetails>(withTarget({ op: params.op }, record))
						.text(targetCwd)
						.done();
				}
				case "switch": {
					if (!this.session.moveSessionToCwd) {
						throw new ToolError("Current mode does not support moving the session cwd from the worktree tool.");
					}
					const record = await requireManagedRecord(requireText(params.idOrName, "idOrName"));
					if (record.state === "snapshotted") {
						throw new ToolError("Managed worktree directory is missing; run worktree restore first.");
					}
					await requireDirectory(record.worktreeRoot);
					const targetCwd = targetCwdForRecord(record);
					await this.session.moveSessionToCwd(targetCwd);
					const updated = await writeManagedWorktreeSession(record, {
						sessionFile: this.session.getSessionFile() ?? null,
						sessionId: this.session.getSessionId?.() ?? null,
						title: this.session.getSessionName?.() ?? record.title,
					});
					return toolResult<WorktreeToolDetails>({
						op: params.op,
						record: updated,
						worktreeRoot: updated.worktreeRoot,
						targetCwd,
						switchedCwd: targetCwd,
					})
						.text(`Switched current session to managed worktree ${updated.name}: ${targetCwd}`)
						.done();
				}
				case "switch-local": {
					if (!this.session.moveSessionToCwd) {
						throw new ToolError("Current mode does not support moving the session cwd from the worktree tool.");
					}
					const record = await requireManagedRecord(requireText(params.idOrName, "idOrName"));
					const targetCwd = targetCwdForRecord(record);
					const localCwd = localCwdForRecord(record);
					await requireDirectory(localCwd, "Local checkout directory is missing for this managed worktree.");
					await this.session.moveSessionToCwd(localCwd);
					const currentSessionFile = this.session.getSessionFile() ?? null;
					const currentSessionId = this.session.getSessionId?.() ?? null;
					const shouldClearSessionBinding =
						(currentSessionFile !== null && record.sessionFile === currentSessionFile) ||
						(currentSessionId !== null && record.sessionId === currentSessionId);
					const updated = shouldClearSessionBinding
						? await writeManagedWorktreeSession(record, { sessionFile: null, sessionId: null, title: null })
						: record;
					return toolResult<WorktreeToolDetails>({
						op: params.op,
						record: updated,
						worktreeRoot: record.worktreeRoot,
						targetCwd,
						localCwd,
						switchedCwd: localCwd,
					})
						.text(`Switched current session to local checkout for managed worktree ${record.name}: ${localCwd}`)
						.done();
				}
				case "merge": {
					const record = await mergeManagedWorktree({
						cwd: this.session.cwd,
						idOrName: requireText(params.idOrName, "idOrName"),
					});
					return toolResult<WorktreeToolDetails>(withTarget({ op: params.op }, record))
						.text(`Applied managed worktree ${record.name} to the local checkout.`)
						.done();
				}
				case "remove": {
					const idOrName = requireText(params.idOrName, "idOrName");
					const record = await removeManagedWorktree({
						cwd: this.session.cwd,
						idOrName,
						forcePermanent: params.force ?? false,
					});
					if (!record) {
						return toolResult<WorktreeToolDetails>({ op: params.op, removed: true })
							.text(`Removed managed worktree ${idOrName}.`)
							.done();
					}
					const text =
						record.state === "snapshotted" && record.snapshotPath
							? `Removed managed worktree ${record.name}; snapshot saved at ${record.snapshotPath}.`
							: `Marked managed worktree ${record.name} as ${record.state}.`;
					return toolResult<WorktreeToolDetails>(withTarget({ op: params.op, removed: false }, record))
						.text(text)
						.done();
				}
				case "branch": {
					const record = await branchManagedWorktree({
						cwd: this.session.cwd,
						idOrName: requireText(params.idOrName, "idOrName"),
						branch: requireText(params.branch, "branch"),
					});
					return toolResult<WorktreeToolDetails>(withTarget({ op: params.op }, record))
						.text(`Created branch ${record.branch} in managed worktree ${record.name}.`)
						.done();
				}
				case "restore": {
					const result = await restoreManagedWorktree({
						cwd: this.session.cwd,
						idOrName: requireText(params.idOrName, "idOrName"),
					});
					return toolResult<WorktreeToolDetails>({
						op: params.op,
						record: result.record,
						worktreeRoot: result.worktreeRoot,
						targetCwd: result.targetCwd,
						warnings: result.warnings,
					})
						.text(`Restored managed worktree ${result.record.name}: ${result.targetCwd}`)
						.done();
				}
			}
		});
	}
}
