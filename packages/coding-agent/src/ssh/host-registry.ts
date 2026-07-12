import { type SSHHost, sshCapability } from "../capability/ssh";
import { loadCapability } from "../discovery";
import type { SessionSshConfig } from "../session/session-ssh-config";

export interface SessionSshHosts {
	sessionId: string;
	hosts: ReadonlyMap<string, SessionSshConfig>;
}

function connectionId(sourcePath: string, host: Omit<SSHHost, "_source" | "connectionId">): string {
	const identity = JSON.stringify([
		sourcePath,
		host.name,
		host.host.trim().toLowerCase(),
		host.username ?? "",
		host.port ?? 22,
		host.keyPath ?? "",
		host.compat ?? false,
	]);
	return new Bun.CryptoHasher("sha256").update(identity).digest("hex").slice(0, 24);
}

function withConnectionId(host: Omit<SSHHost, "connectionId">): SSHHost {
	return { ...host, connectionId: connectionId(host._source.path, host) };
}

/** Load session and persistent SSH hosts with whole-entry first-wins precedence. */
export async function loadEffectiveSshHosts(cwd?: string, sessionHosts?: SessionSshHosts): Promise<SSHHost[]> {
	const hosts: SSHHost[] = [];
	const seen = new Set<string>();
	if (sessionHosts) {
		for (const [name, state] of sessionHosts.hosts) {
			const sourcePath = `session://${sessionHosts.sessionId}/${state.revisionEntryId}`;
			const host = withConnectionId({
				name,
				...structuredClone(state.config),
				_source: {
					provider: "ssh-session",
					providerName: "Session SSH",
					level: "session",
					path: sourcePath,
				},
			});
			hosts.push(host);
			seen.add(name);
		}
	}

	const persistent = await loadCapability<SSHHost>(sshCapability.id, cwd ? { cwd } : {});
	for (const rawHost of persistent.items) {
		if (seen.has(rawHost.name)) continue;
		const host = withConnectionId(rawHost);
		hosts.push(host);
		seen.add(host.name);
	}
	return hosts;
}
