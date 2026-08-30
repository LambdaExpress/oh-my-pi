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

export async function loadSshHosts(
	session: ToolSession,
	options: LoadSshHostsOptions = {},
): Promise<{
	hostNames: string[];
	hostsByName: Map<string, SSHConnectionTarget>;
}> {
	const hosts = session.getSessionSshHosts
		? await session.getSessionSshHosts()
		: await loadEffectiveSshHosts(session.cwd);
	const hostsByName = new Map<string, SSHConnectionTarget>();
	for (const host of hosts) hostsByName.set(host.name, host);
	const localWslTargets = await (options.discoverLocalWslTargets ?? discoverLocalWslTargets)();
	for (const target of localWslTargets) {
		if (!hostsByName.has(target.name)) hostsByName.set(target.name, target);
	}
	return { hostNames: [...hostsByName.keys()].sort(), hostsByName };
}
