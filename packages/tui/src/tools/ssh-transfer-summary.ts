/**
 * Formatting for `ssh_transfer` tool details.
 *
 * Shared by the coding agent (tool views, ACP tool-call notifications, background
 * job rows) and the terminal transcript rows, which live in this package.
 */
import { formatBytes, formatDuration, sanitizeText } from "@oh-my-pi/pi-utils";
import { Ellipsis, replaceTabs, shortenPath, truncateToWidth } from "../render/render-utils";

export type SshTransferOperation = "upload" | "download";

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
