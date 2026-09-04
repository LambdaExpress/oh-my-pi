import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { invalidate as invalidateFs } from "../capability/fs";
import { getCachedHostInfoSync, isLocalWslTarget, type SSHConnectionTarget } from "../ssh/connection-manager";
import { loadEffectiveSshHosts } from "../ssh/host-registry";
import { discoverLocalWslTargets } from "../ssh/wsl";
import type { ToolSession } from ".";

export function formatSshHostEntry(host: SSHConnectionTarget): string {
	if (isLocalWslTarget(host)) {
		const location = host.distribution ? `local ${host.distribution}` : "local default distribution";
		return `- ${host.name} (${location}) | wsl/sh`;
	}
	const info = getCachedHostInfoSync(host);
	let shell: string;
	if (!info) {
		shell = "detecting...";
	} else if (info.os === "windows") {
		if (info.compatEnabled) {
			shell = `windows/${info.compatShell || "bash"}`;
		} else {
			shell = `windows/${info.shell}`;
		}
	} else {
		shell = `${info.os}/${info.shell}`;
	}
	return `- ${host.name} (${host.host}) | ${shell}`;
}

export function formatSshHostsDescription(baseDescription: string, hosts: readonly SSHConnectionTarget[]): string {
	if (hosts.length === 0) return baseDescription;
	return `${baseDescription}\n\nAvailable hosts:\n${hosts.map(formatSshHostEntry).join("\n")}`;
}

export interface LoadSshHostsOptions {
	discoverLocalWslTargets?: () => Promise<readonly SSHConnectionTarget[]>;
}

/**
 * Return a cheap identity for the user's OpenSSH config.
 *
 * This is intentionally separate from capability discovery: SSH tools are
 * long-lived snapshots, while the config is user-editable outside the
 * session. Callers can check this identity before deciding whether to reload
 * the snapshot. Include enough stat data to notice replacements as well as
 * in-place edits without reading the file on every tool call.
 */
export async function getOpenSshConfigFingerprint(home = os.homedir()): Promise<string> {
	const filePath = path.join(home, ".ssh", "config");
	try {
		const stats = await fs.stat(filePath);
		if (!stats.isFile()) return "missing";
		return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
	} catch {
		return "missing";
	}
}

export async function loadSshHosts(
	session: ToolSession,
	options: LoadSshHostsOptions = {},
): Promise<{
	hostNames: string[];
	hostsByName: Map<string, SSHConnectionTarget>;
	openSshConfigFingerprint: string;
}> {
	// The capability filesystem cache is useful for ordinary discovery, but the
	// OpenSSH config is explicitly mutable outside omp. Invalidate only this
	// source at the snapshot refresh boundary; do not reset unrelated
	// capability/file caches.
	const openSshConfigPath = path.join(os.homedir(), ".ssh", "config");
	invalidateFs(openSshConfigPath);
	const hosts = session.getSessionSshHosts
		? await session.getSessionSshHosts()
		: await loadEffectiveSshHosts(session.cwd);
	const hostsByName = new Map<string, SSHConnectionTarget>();
	for (const host of hosts) hostsByName.set(host.name, host);
	const localWslTargets = await (options.discoverLocalWslTargets ?? discoverLocalWslTargets)();
	for (const target of localWslTargets) {
		if (!hostsByName.has(target.name)) hostsByName.set(target.name, target);
	}
	return {
		hostNames: [...hostsByName.keys()].sort(),
		hostsByName,
		openSshConfigFingerprint: await getOpenSshConfigFingerprint(),
	};
}
