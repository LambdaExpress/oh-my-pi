import type { SSHHostConfig } from "../capability/ssh";
import type { SessionEntry } from "./session-entries";

export interface SessionSshConfig {
	config: SSHHostConfig;
	revisionEntryId: string;
}
export type SessionSshConfigMutation =
	| { operation: "upsert"; name: string; config: SSHHostConfig }
	| { operation: "delete"; name: string };

/** Reconstruct session SSH state from one root-to-leaf branch. */
export function reconstructSessionSshConfigs(entries: readonly SessionEntry[]): Map<string, SessionSshConfig> {
	const hosts = new Map<string, SessionSshConfig>();
	for (const entry of entries) {
		if (entry.type !== "ssh_config_change") continue;
		if (entry.operation === "delete") {
			hosts.delete(entry.name);
			continue;
		}
		hosts.set(entry.name, {
			config: structuredClone(entry.config),
			revisionEntryId: entry.id,
		});
	}
	return hosts;
}
