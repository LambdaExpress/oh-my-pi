import type { Component } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { t } from "../../i18n";
import type { AsyncJobSnapshot, AsyncJobSnapshotItem } from "../../session/agent-session";
import { formatStatusIcon, replaceTabs } from "../../tools/render-utils";
import {
	formatSshTransferSummary,
	isSshTransferToolDetails,
	type SshTransferToolDetails,
} from "../../tools/ssh-transfer";
import { Ellipsis, renderStatusLine, truncateToWidth } from "../../tui";
import { theme } from "../theme/theme";

export function isActiveSshTransferJob(job: AsyncJobSnapshotItem): boolean {
	return job.status === "running" || (job.status === "cancelled" && job.settledAt === undefined);
}

export function sshTransferJobDetails(job: AsyncJobSnapshotItem): SshTransferToolDetails | undefined {
	const details = job.progress?.details;
	if (!isSshTransferToolDetails(details)) return undefined;
	if (job.status !== "cancelled" || job.settledAt !== undefined) {
		return job.status === details.status ? details : { ...details, status: job.status };
	}
	return {
		...details,
		status: "cancelled",
		async: {
			state: "running",
			jobId: job.id,
			type: "ssh_transfer",
		},
	};
}

export class SshTransferHud implements Component {
	#jobs = new Map<string, AsyncJobSnapshotItem>();
	#cache: { width: number; lines: readonly string[] } | undefined;

	get size(): number {
		return this.#jobs.size;
	}

	update(job: AsyncJobSnapshotItem): void {
		this.#jobs.set(job.id, job);
		this.invalidate();
	}

	restore(snapshot: AsyncJobSnapshot | null): void {
		this.#jobs.clear();
		if (snapshot) {
			const pendingDeliveryIds = new Set(snapshot.delivery.pendingJobIds);
			for (const job of snapshot.running) {
				if (job.type === "ssh_transfer") this.#jobs.set(job.id, job);
			}
			for (const job of snapshot.recent) {
				if (job.type === "ssh_transfer" && pendingDeliveryIds.has(job.id)) this.#jobs.set(job.id, job);
			}
		}
		this.invalidate();
	}

	markPersisted(jobIds: Iterable<string>): void {
		let changed = false;
		for (const jobId of jobIds) {
			const job = this.#jobs.get(jobId);
			if (!job || isActiveSshTransferJob(job)) continue;
			this.#jobs.delete(jobId);
			changed = true;
		}
		if (changed) this.invalidate();
	}

	clear(): void {
		if (this.#jobs.size === 0) return;
		this.#jobs.clear();
		this.invalidate();
	}

	invalidate(): void {
		this.#cache = undefined;
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) return this.#cache.lines;
		const jobs = [...this.#jobs.values()].sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
		if (jobs.length === 0) return [];

		const activeCount = jobs.filter(isActiveSshTransferJob).length;
		const header = renderStatusLine(
			{
				icon: activeCount > 0 ? "info" : "success",
				title: t("{count} SSH transfer{s}", { count: jobs.length, s: jobs.length === 1 ? "" : "s" }),
				meta: activeCount > 0 ? [t("{count} active", { count: activeCount })] : [t("settled")],
			},
			theme,
		);
		const lines: string[] = [header];
		for (let index = 0; index < jobs.length; index++) {
			const job = jobs[index]!;
			const details = sshTransferJobDetails(job);
			const branch = index === jobs.length - 1 ? theme.tree.last : theme.tree.branch;
			const continuation = index === jobs.length - 1 ? "  " : theme.tree.vertical;
			const status = isActiveSshTransferJob(job)
				? "running"
				: job.status === "completed"
					? "success"
					: job.status === "failed"
						? "error"
						: "aborted";
			const icon = formatStatusIcon(status, theme);
			if (details) {
				const summary = formatSshTransferSummary(details, { width: Math.max(1, width - 5) }).split("\n");
				lines.push(`${branch}${icon} ${summary[0] ?? t("SSH transfer")}`);
				for (const line of summary.slice(1)) lines.push(`${continuation}  ${line}`);
				continue;
			}
			const label = replaceTabs(sanitizeText(job.progress?.text || job.label)).replaceAll("\n", "\\n");
			lines.push(`${branch}${icon} ${truncateToWidth(label, Math.max(1, width - 5), Ellipsis.Unicode)}`);
		}
		const rendered = lines.map(line => truncateToWidth(line, width, Ellipsis.Unicode));
		this.#cache = { width, lines: rendered };
		return rendered;
	}
}
