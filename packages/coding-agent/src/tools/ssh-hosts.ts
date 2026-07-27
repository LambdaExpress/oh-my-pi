import type { SSHHost } from "../capability/ssh";
import { getCachedHostInfoSync } from "../ssh/connection-manager";
import { loadEffectiveSshHosts } from "../ssh/host-registry";
import type { ToolSession } from ".";

export function formatSshHostEntry(host: SSHHost): string {
	const info = getCachedHostInfoSync(host);
	let shell: string;
	if (!info) {
		shell = "detecting...";
	} else if (info.os === "windows") {
		if (info.compatEnabled) {
			shell = `windows/${info.compatShell || "bash"}`;
		} else {
			shell = info.shell === "powershell" ? "windows/powershell" : "windows/cmd";
		}
	} else {
		shell = `${info.os}/${info.shell}`;
	}
	return `- ${host.name} (${host.host}) | ${shell}`;
}

export function formatSshHostsDescription(baseDescription: string, hosts: readonly SSHHost[]): string {
	if (hosts.length === 0) return baseDescription;
	return `${baseDescription}\n\nAvailable hosts:\n${hosts.map(formatSshHostEntry).join("\n")}`;
}

export async function loadSshHosts(session: ToolSession): Promise<{
	hostNames: string[];
	hostsByName: Map<string, SSHHost>;
}> {
	const hosts = session.getSessionSshHosts
		? await session.getSessionSshHosts()
		: await loadEffectiveSshHosts(session.cwd);
	const hostsByName = new Map<string, SSHHost>();
	for (const host of hosts) hostsByName.set(host.name, host);
	return { hostNames: [...hostsByName.keys()].sort(), hostsByName };
}
