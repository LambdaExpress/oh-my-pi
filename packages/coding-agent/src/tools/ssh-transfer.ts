import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Ellipsis, Text, truncateToWidth } from "@oh-my-pi/pi-tui";
import { prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { t } from "../i18n";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import sshTransferDescriptionBase from "../prompts/tools/ssh-transfer.md" with { type: "text" };
import { ensureHostInfo, type SSHConnectionTarget } from "../ssh/connection-manager";
import {
	executeSshFileTransfer,
	prepareSshFileTransfer,
	SshFileTransferCancelledError,
	type SshFileTransferPlan,
	type SshFileTransferProgress,
} from "../ssh/file-transfer";
import { CachedOutputBlock, markFramedBlockComponent } from "@oh-my-pi/pi-tui/render/output-block";
import { renderStatusLine } from "@oh-my-pi/pi-tui/render/status-line";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { isInternalUrlPath, resolveToCwd } from "./path-utils";
import { enforcePlanModeWrite } from "./plan-mode-guard";
import { replaceTabs } from "@oh-my-pi/pi-tui/render/render-utils";
import {
	formatSshTransferSummary,
	type SshTransferOperation,
	type SshTransferStatus,
	type SshTransferToolDetails,
} from "@oh-my-pi/pi-tui/tools/ssh-transfer-summary";
import { formatSshHostsDescription, getOpenSshConfigFingerprint, loadSshHosts } from "./ssh-hosts";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

const sshTransferSchema = type({
	op: type("'upload' | 'download'").describe("transfer operation"),
	host: type("string").describe("available SSH or local WSL target name"),
	local_path: type("string").describe("local file path"),
	remote_path: type("string").describe("absolute remote file path"),
	"overwrite?": type("boolean").describe("replace an existing file; defaults to false"),
	"async?": type("boolean").describe("run in background; defaults to false"),
});

type SshTransferParams = typeof sshTransferSchema.infer;

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
	readonly #baseDescription: string;
	#openSshConfigFingerprint: string | undefined;
	#refreshPromise: Promise<void> | undefined;
	readonly hostNames: string[];
	readonly hostsByName: Map<string, SSHConnectionTarget>;
	description: string;

	constructor(
		private readonly session: ToolSession,
		hostNames: string[],
		hostsByName: Map<string, SSHConnectionTarget>,
		description: string,
		openSshConfigFingerprint?: string,
	) {
		this.hostNames = hostNames;
		this.hostsByName = hostsByName;
		this.description = description;
		this.#baseDescription = prompt.render(sshTransferDescriptionBase);
		this.#openSshConfigFingerprint = openSshConfigFingerprint;
		this.#allowedHosts = new Set(hostNames);
		this.#asyncEnabled = session.settings.get("async.enabled");
	}

	async #refreshHostsIfChanged(): Promise<void> {
		// Directly constructed tools (for example SDK embedders/tests) do not
		// carry discovery state and intentionally retain their supplied snapshot.
		if (this.#openSshConfigFingerprint === undefined) return;
		if (this.#refreshPromise) return this.#refreshPromise;

		const refresh = (async () => {
			const currentFingerprint = await getOpenSshConfigFingerprint();
			if (currentFingerprint === this.#openSshConfigFingerprint) return;

			const loaded = await loadSshHosts(this.session);
			this.hostNames.splice(0, this.hostNames.length, ...loaded.hostNames);
			this.hostsByName.clear();
			for (const [name, host] of loaded.hostsByName) this.hostsByName.set(name, host);
			this.#allowedHosts.clear();
			for (const name of loaded.hostNames) this.#allowedHosts.add(name);
			this.#openSshConfigFingerprint = loaded.openSshConfigFingerprint;
			const hosts = loaded.hostNames.flatMap(name => {
				const host = loaded.hostsByName.get(name);
				return host ? [host] : [];
			});
			this.description = formatSshHostsDescription(this.#baseDescription, hosts);
		})();
		this.#refreshPromise = refresh;
		try {
			await refresh;
		} finally {
			if (this.#refreshPromise === refresh) this.#refreshPromise = undefined;
		}
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
		await this.#refreshHostsIfChanged();
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
			{ icon: "pending", title: t("SSH Transfer"), description: `${t(operation)} [${host}]` },
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
						? { icon: "pending", title: t("SSH Transfer"), description: `${t(operation)} [${host}]` }
						: failed
							? { icon: "error", title: t("SSH Transfer"), description: `${t(operation)} [${host}]` }
							: {
									iconOverride: uiTheme.styledSymbol("tool.ssh", "accent"),
									title: t("SSH Transfer"),
									description: `${t(operation)} [${host}]`,
								},
					uiTheme,
				);
				let plainText: string;
				if (details) {
					plainText = formatSshTransferSummary(details, { width: Math.max(1, width - 4) });
				} else {
					const localPath = sanitizeTransferField(args?.local_path ?? "");
					const remotePath = sanitizeTransferField(args?.remote_path ?? "");
					const pathSummary =
						localPath || remotePath
							? operation === "Download"
								? `[${host}]:${remotePath || "…"} → ${localPath || "…"}`
								: `${localPath || "…"} → [${host}]:${remotePath || "…"}`
							: "";
					const output = sanitizeText(result.content.find(item => item.type === "text")?.text ?? "");
					plainText = [pathSummary, output].filter(Boolean).join("\n");
				}
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
	const { hostNames, hostsByName, openSshConfigFingerprint } = await loadSshHosts(session);
	if (hostNames.length === 0) return null;
	const descriptionHosts = hostNames.flatMap(name => {
		const host = hostsByName.get(name);
		return host ? [host] : [];
	});
	const description = formatSshHostsDescription(prompt.render(sshTransferDescriptionBase), descriptionHosts);
	return new SshTransferTool(session, hostNames, hostsByName, description, openSshConfigFingerprint);
}
