import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { formatBytes, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import type { SSHHost } from "../capability/ssh";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import sshTransferDescriptionBase from "../prompts/tools/ssh-transfer.md" with { type: "text" };
import { ensureHostInfo } from "../ssh/connection-manager";
import {
	executeSshFileTransfer,
	prepareSshFileTransfer,
	SshFileTransferCancelledError,
	type SshFileTransferPlan,
	type SshFileTransferProgress,
	type SshTransferOperation,
} from "../ssh/file-transfer";
import { Ellipsis, renderStatusLine, truncateToWidth } from "../tui";
import { CachedOutputBlock, markFramedBlockComponent } from "../tui/output-block";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { isInternalUrlPath, resolveToCwd } from "./path-utils";
import { enforcePlanModeWrite } from "./plan-mode-guard";
import { formatDuration, replaceTabs, shortenPath } from "./render-utils";
import { formatSshHostsDescription, loadSshHosts } from "./ssh-hosts";
import { ToolError } from "./tool-errors";

const sshTransferSchema = type({
	op: type("'upload' | 'download'").describe("transfer operation"),
	host: type("string").describe("configured SSH host name"),
	local_path: type("string").describe("local file path"),
	remote_path: type("string").describe("absolute remote file path"),
	"overwrite?": type("boolean").describe("replace an existing file; defaults to false"),
	"async?": type("boolean").describe("run in background; defaults to false"),
});

type SshTransferParams = typeof sshTransferSchema.infer;

export type SshTransferStatus = "running" | "completed" | "failed" | "cancelled";

export interface SshTransferToolDetails {
	operation: SshTransferOperation;
	host: string;
	localPath: string;
	remotePath: string;
	status: SshTransferStatus;
	totalBytes: number;
	transferredBytes: number;
	percent: number;
	bytesPerSecond: number;
	averageBytesPerSecond: number;
	elapsedMs: number;
	error?: string;
	async?: {
		state: "running" | "completed" | "failed";
		jobId: string;
		type: "ssh_transfer";
	};
}

export function isSshTransferToolDetails(value: unknown): value is SshTransferToolDetails {
	if (typeof value !== "object" || value === null) return false;
	if (!("operation" in value) || (value.operation !== "upload" && value.operation !== "download")) return false;
	if (
		!("status" in value) ||
		(value.status !== "running" &&
			value.status !== "completed" &&
			value.status !== "failed" &&
			value.status !== "cancelled")
	) {
		return false;
	}
	if (!("host" in value) || typeof value.host !== "string") return false;
	if (!("localPath" in value) || typeof value.localPath !== "string") return false;
	if (!("remotePath" in value) || typeof value.remotePath !== "string") return false;
	if (!("totalBytes" in value) || typeof value.totalBytes !== "number" || !Number.isFinite(value.totalBytes)) {
		return false;
	}
	if (
		!("transferredBytes" in value) ||
		typeof value.transferredBytes !== "number" ||
		!Number.isFinite(value.transferredBytes)
	) {
		return false;
	}
	if (!("percent" in value) || typeof value.percent !== "number" || !Number.isFinite(value.percent)) return false;
	if (
		!("bytesPerSecond" in value) ||
		typeof value.bytesPerSecond !== "number" ||
		!Number.isFinite(value.bytesPerSecond)
	) {
		return false;
	}
	if (
		!("averageBytesPerSecond" in value) ||
		typeof value.averageBytesPerSecond !== "number" ||
		!Number.isFinite(value.averageBytesPerSecond)
	) {
		return false;
	}
	if (!("elapsedMs" in value) || typeof value.elapsedMs !== "number" || !Number.isFinite(value.elapsedMs)) {
		return false;
	}
	return !("error" in value) || value.error === undefined || typeof value.error === "string";
}

export interface SshTransferSummaryOptions {
	barWidth?: number;
	width?: number;
}

function sanitizeTransferField(value: string): string {
	return replaceTabs(sanitizeText(value)).replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}

function transferPercent(transferredBytes: number, totalBytes: number, status: SshTransferStatus): number {
	if (totalBytes === 0) return status === "completed" ? 100 : 0;
	const raw = (transferredBytes * 100) / totalBytes;
	return Math.min(100, Math.max(0, Math.round(raw * 10) / 10));
}

function detailsFromProgress(
	operation: SshTransferOperation,
	host: string,
	localPath: string,
	remotePath: string,
	status: SshTransferStatus,
	progress: SshFileTransferProgress,
	error?: string,
): SshTransferToolDetails {
	return {
		operation,
		host,
		localPath,
		remotePath,
		status,
		totalBytes: progress.totalBytes,
		transferredBytes: progress.transferredBytes,
		percent: transferPercent(progress.transferredBytes, progress.totalBytes, status),
		bytesPerSecond: progress.bytesPerSecond,
		averageBytesPerSecond: progress.averageBytesPerSecond,
		elapsedMs: progress.elapsedMs,
		...(error === undefined ? {} : { error }),
	};
}

export function formatSshTransferSummary(
	details: SshTransferToolDetails,
	options: SshTransferSummaryOptions = {},
): string {
	const host = sanitizeTransferField(details.host);
	const localPath = sanitizeTransferField(shortenPath(details.localPath));
	const remotePath = sanitizeTransferField(details.remotePath);
	const source = details.operation === "upload" ? localPath : remotePath;
	const destination = details.operation === "upload" ? remotePath : localPath;
	const verb = details.operation === "upload" ? "Upload" : "Download";
	const barWidth = Math.max(1, Math.floor(options.barWidth ?? (options.width && options.width < 60 ? 6 : 10)));
	const filled = details.percent >= 100 ? barWidth : Math.floor((details.percent / 100) * barWidth);
	const bar = `${"█".repeat(filled)}${"░".repeat(barWidth - filled)}`;
	const rate = details.status === "running" ? details.bytesPerSecond : details.averageBytesPerSecond;
	const lines = [
		`${verb} [${host}]  ${source} → ${destination}`,
		`${bar}  ${details.percent.toFixed(1)}% · ${formatBytes(details.transferredBytes)} / ${formatBytes(
			details.totalBytes,
		)} · ${formatBytes(rate)}/s · ${formatDuration(details.elapsedMs)}`,
	];
	if (details.status === "cancelled" && details.async && details.async.state === "running") {
		lines.push("Cancelling · cleanup in progress");
	}
	if (details.async?.state === "running") lines.push(`Job: ${sanitizeTransferField(details.async.jobId)}`);
	if (details.error !== undefined) lines.push(`Error: ${sanitizeTransferField(details.error)}`);
	if (options.width === undefined) return lines.join("\n");
	const width = Math.max(1, Math.floor(options.width));
	return lines.map(line => truncateToWidth(line, width, Ellipsis.Unicode)).join("\n");
}

function toolResultFromDetails(details: SshTransferToolDetails): AgentToolResult<SshTransferToolDetails> {
	return {
		content: [{ type: "text", text: formatSshTransferSummary(details) }],
		details,
		...(details.status === "failed" || details.status === "cancelled" ? { isError: true } : {}),
	};
}

function emptyProgress(totalBytes = 0): SshFileTransferProgress {
	return {
		transferredBytes: 0,
		totalBytes,
		bytesPerSecond: 0,
		averageBytesPerSecond: 0,
		elapsedMs: 0,
	};
}

function isWindowsRemoteAbsolute(remotePath: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(remotePath) || /^[/\\]{2}[^/\\]+[/\\][^/\\]+/.test(remotePath);
}

function approvalDetails(args: unknown): string[] {
	const op = args && typeof args === "object" && "op" in args && typeof args.op === "string" ? args.op : "(missing)";
	const host =
		args && typeof args === "object" && "host" in args && typeof args.host === "string" ? args.host : "(missing)";
	const localPath =
		args && typeof args === "object" && "local_path" in args && typeof args.local_path === "string"
			? args.local_path
			: "(missing)";
	const remotePath =
		args && typeof args === "object" && "remote_path" in args && typeof args.remote_path === "string"
			? args.remote_path
			: "(missing)";
	const overwrite =
		args && typeof args === "object" && "overwrite" in args && args.overwrite === true ? "true" : "false";
	const asyncRequested = args && typeof args === "object" && "async" in args && args.async === true ? "true" : "false";
	return [
		`Direction: ${truncateForPrompt(op)}`,
		`Host: ${truncateForPrompt(host)}`,
		`Local: ${truncateForPrompt(localPath)}`,
		`Remote: ${truncateForPrompt(remotePath)}`,
		`Overwrite: ${overwrite}`,
		`Background: ${asyncRequested}`,
	];
}

export class SshTransferTool implements AgentTool<typeof sshTransferSchema, SshTransferToolDetails> {
	readonly name = "ssh_transfer";
	readonly label = "SSH Transfer";
	readonly summary = "Upload or download one file over SSH";
	readonly approval = "exec" as const;
	readonly loadMode = "discoverable" as const;
	readonly concurrency = "exclusive" as const;
	readonly strict = true;
	readonly interruptible = true;
	readonly abortSettleTimeoutMs = 12_000;
	readonly parameters = sshTransferSchema;
	readonly formatApprovalDetails = approvalDetails;
	readonly #allowedHosts: Set<string>;
	readonly #asyncEnabled: boolean;
	readonly #lastSnapshots = new Map<string, SshTransferToolDetails>();

	constructor(
		private readonly session: ToolSession,
		readonly hostNames: string[],
		readonly hostsByName: Map<string, SSHHost>,
		readonly description: string,
	) {
		this.#allowedHosts = new Set(hostNames);
		this.#asyncEnabled = session.settings.get("async.enabled");
	}

	createAbortedResult(toolCallId: string, params: SshTransferParams): AgentToolResult<SshTransferToolDetails> {
		const previous = this.#lastSnapshots.get(toolCallId);
		const localPath =
			previous?.localPath ?? resolveToCwd(params.local_path.trim() || "(unknown local path)", this.session.cwd);
		const details: SshTransferToolDetails = {
			...(previous ??
				detailsFromProgress(
					params.op,
					params.host,
					localPath,
					params.remote_path.trim() || "(unknown remote path)",
					"cancelled",
					emptyProgress(),
				)),
			status: "cancelled",
			error: "Cleanup deadline exceeded after 12 seconds; transfer cleanup did not settle and a staged file may remain.",
		};
		this.#lastSnapshots.set(toolCallId, details);
		return toolResultFromDetails(details);
	}

	async execute(
		toolCallId: string,
		params: SshTransferParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<SshTransferToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SshTransferToolDetails>> {
		const overwrite = params.overwrite === true;
		const asyncRequested = params.async === true;
		const localInput = params.local_path.trim();
		const remotePath = params.remote_path.trim();
		if (!this.#allowedHosts.has(params.host)) {
			throw new ToolError(`Unknown SSH host: ${params.host}. Available hosts: ${this.hostNames.join(", ")}`);
		}
		const hostConfig = this.hostsByName.get(params.host);
		if (!hostConfig) throw new ToolError(`SSH host not loaded: ${params.host}`);
		if (localInput.length === 0 || remotePath.length === 0) {
			throw new ToolError("SSH transfer paths must not be empty.");
		}
		if (isInternalUrlPath(localInput) || isInternalUrlPath(remotePath)) {
			throw new ToolError("SSH transfer accepts filesystem paths, not internal URLs.");
		}
		const localPath = resolveToCwd(localInput, this.session.cwd);
		enforcePlanModeWrite(this.session, params.op === "upload" ? remotePath : localPath, { op: "create" });

		const hostInfo = await ensureHostInfo(hostConfig);
		if (hostInfo.os === "windows" && hostInfo.powerShellCommand) {
			if (!isWindowsRemoteAbsolute(remotePath)) {
				throw new ToolError("SSH transfer remote_path must be an absolute drive or UNC path on Windows hosts.");
			}
		} else if (!path.posix.isAbsolute(remotePath)) {
			throw new ToolError("SSH transfer remote_path must be an absolute POSIX path.");
		}

		let plan: SshFileTransferPlan;
		try {
			plan = await prepareSshFileTransfer({
				operation: params.op,
				target: hostConfig,
				localPath,
				remotePath,
				overwrite,
				signal,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const status: SshTransferStatus = signal?.aborted ? "cancelled" : "failed";
			const details = detailsFromProgress(
				params.op,
				params.host,
				localPath,
				remotePath,
				status,
				emptyProgress(),
				message,
			);
			this.#lastSnapshots.set(toolCallId, details);
			return toolResultFromDetails(details);
		}

		if (asyncRequested) {
			if (!this.#asyncEnabled) {
				throw new ToolError("Async SSH transfer is disabled. Enable async.enabled to use async mode.");
			}
			const manager = this.session.asyncJobManager;
			if (!manager) throw new ToolError("Async job manager unavailable for this session.");
			const jobId = manager.register(
				"ssh_transfer",
				`${params.op} ${localPath} ${remotePath}`,
				async ({ jobId: runningJobId, signal: jobSignal, reportProgress }) => {
					const asyncState = { state: "running" as const, jobId: runningJobId, type: "ssh_transfer" as const };
					try {
						const progress = await executeSshFileTransfer(plan, {
							signal: jobSignal,
							onProgress: update => {
								const details = {
									...detailsFromProgress(params.op, params.host, localPath, remotePath, "running", update),
									async: asyncState,
								};
								void reportProgress(formatSshTransferSummary(details), { ...details });
							},
						});
						const details: SshTransferToolDetails = {
							...detailsFromProgress(params.op, params.host, localPath, remotePath, "completed", progress),
							async: { state: "completed", jobId: runningJobId, type: "ssh_transfer" },
						};
						const text = formatSshTransferSummary(details);
						await reportProgress(text, { ...details });
						return text;
					} catch (error) {
						const cancelled = jobSignal.aborted || error instanceof SshFileTransferCancelledError;
						const message = error instanceof Error ? error.message : String(error);
						const current = manager.getJob(runningJobId)?.progress?.details;
						const transferredBytes =
							current && typeof current.transferredBytes === "number" ? current.transferredBytes : 0;
						const elapsedMs = current && typeof current.elapsedMs === "number" ? current.elapsedMs : 0;
						const details: SshTransferToolDetails = {
							...detailsFromProgress(
								params.op,
								params.host,
								localPath,
								remotePath,
								cancelled ? "cancelled" : "failed",
								{
									transferredBytes,
									totalBytes: plan.totalBytes,
									bytesPerSecond: 0,
									averageBytesPerSecond: elapsedMs === 0 ? 0 : (transferredBytes * 1000) / elapsedMs,
									elapsedMs,
								},
								message,
							),
							async: { state: "failed", jobId: runningJobId, type: "ssh_transfer" },
						};
						const text = formatSshTransferSummary(details);
						await reportProgress(text, { ...details });
						throw new Error(text, { cause: error });
					}
				},
				{
					input: `${params.op} ${localPath} ${remotePath}`,
					toolCallId,
					ownerId: this.session.getAgentId?.() ?? undefined,
					scopeId: this.session.getAgentScopeId?.() ?? undefined,
				},
			);
			const details: SshTransferToolDetails = {
				...detailsFromProgress(
					params.op,
					params.host,
					localPath,
					remotePath,
					"running",
					emptyProgress(plan.totalBytes),
				),
				async: { state: "running", jobId, type: "ssh_transfer" },
			};
			this.#lastSnapshots.set(toolCallId, details);
			return {
				content: [
					{
						type: "text",
						text: `${formatSshTransferSummary(details)}\nResult will be delivered automatically. Use job to inspect or cancel it.`,
					},
				],
				details,
			};
		}

		let lastProgress = emptyProgress(plan.totalBytes);
		try {
			const progress = await executeSshFileTransfer(plan, {
				signal,
				onProgress: update => {
					lastProgress = update;
					const details = detailsFromProgress(params.op, params.host, localPath, remotePath, "running", update);
					this.#lastSnapshots.set(toolCallId, details);
					onUpdate?.(toolResultFromDetails(details));
				},
			});
			const details = detailsFromProgress(params.op, params.host, localPath, remotePath, "completed", progress);
			this.#lastSnapshots.set(toolCallId, details);
			return toolResultFromDetails(details);
		} catch (error) {
			const cancelled = signal?.aborted || error instanceof SshFileTransferCancelledError;
			const message = error instanceof Error ? error.message : String(error);
			const details = detailsFromProgress(
				params.op,
				params.host,
				localPath,
				remotePath,
				cancelled ? "cancelled" : "failed",
				lastProgress,
				message,
			);
			this.#lastSnapshots.set(toolCallId, details);
			return toolResultFromDetails(details);
		}
	}
}

interface SshTransferRenderArgs {
	op?: SshTransferOperation;
	host?: string;
	local_path?: string;
	remote_path?: string;
}

export const sshTransferToolRenderer = {
	inline: false,

	renderCall(args: SshTransferRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const operation = args.op === "download" ? "Download" : args.op === "upload" ? "Upload" : "Transfer";
		const host = sanitizeTransferField(args.host ?? "…");
		const text = renderStatusLine(
			{ icon: "pending", title: "SSH Transfer", description: `${operation} [${host}]` },
			uiTheme,
		);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: {
			content: Array<{ type: string; text?: string }>;
			details?: SshTransferToolDetails;
			isError?: boolean;
		},
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: SshTransferRenderArgs,
	): Component {
		const outputBlock = new CachedOutputBlock();
		return markFramedBlockComponent({
			render(width: number): readonly string[] {
				const details = result.details;
				const partial = options.isPartial === true || details?.status === "running";
				const failed = result.isError === true || details?.status === "failed" || details?.status === "cancelled";
				const operation =
					details?.operation === "download" || args?.op === "download"
						? "Download"
						: details?.operation === "upload" || args?.op === "upload"
							? "Upload"
							: "Transfer";
				const host = sanitizeTransferField(details?.host ?? args?.host ?? "…");
				const header = renderStatusLine(
					partial
						? { icon: "pending", title: "SSH Transfer", description: `${operation} [${host}]` }
						: failed
							? { icon: "error", title: "SSH Transfer", description: `${operation} [${host}]` }
							: {
									iconOverride: uiTheme.styledSymbol("tool.ssh", "accent"),
									title: "SSH Transfer",
									description: `${operation} [${host}]`,
								},
					uiTheme,
				);
				const plainText = details
					? formatSshTransferSummary(details, { width: Math.max(1, width - 4) })
					: sanitizeText(result.content.find(item => item.type === "text")?.text ?? "");
				const lines = plainText
					.split("\n")
					.map(line =>
						uiTheme.fg(failed ? "error" : "toolOutput", truncateToWidth(line, width, Ellipsis.Unicode)),
					);
				return outputBlock.render(
					{
						header,
						state: partial ? "pending" : failed ? "error" : "success",
						sections: [{ lines }],
						width,
					},
					uiTheme,
				);
			},
			invalidate(): void {
				outputBlock.invalidate();
			},
		});
	},

	mergeCallAndResult: true,
	forceFirstResultViewportRepaint: true,
	forceResultViewportRepaintOnSettle: true,
};

export async function loadSshTransferTool(session: ToolSession): Promise<SshTransferTool | null> {
	const { hostNames, hostsByName } = await loadSshHosts(session);
	if (hostNames.length === 0) return null;
	const descriptionHosts = hostNames.flatMap(name => {
		const host = hostsByName.get(name);
		return host ? [host] : [];
	});
	const description = formatSshHostsDescription(prompt.render(sshTransferDescriptionBase), descriptionHosts);
	return new SshTransferTool(session, hostNames, hostsByName, description);
}
