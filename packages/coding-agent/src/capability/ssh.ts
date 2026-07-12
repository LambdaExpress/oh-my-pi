/**
 * SSH Hosts Capability
 *
 * Canonical shape for SSH host entries, regardless of source format.
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * Canonical SSH host configuration, regardless of source format.
 */
export interface SSHHostConfig {
	host: string;
	username?: string;
	port?: number;
	keyPath?: string;
	password?: string;
	description?: string;
	compat?: boolean;
}

/**
 * Resolved SSH host entry.
 */
export interface SSHHost extends SSHHostConfig {
	/** Host name (config key) */
	name: string;
	/** Non-secret identity for connection reuse and invalidation. */
	connectionId?: string;
	/** Source metadata (added by loader) */
	_source: SourceMeta;
}

export const sshCapability = defineCapability<SSHHost>({
	id: "ssh",
	displayName: "SSH Hosts",
	description: "SSH host entries for remote command execution",
	key: host => host.name,
	validate: host => {
		if (!host.name) return "Missing name";
		if (!host.host) return "Missing host";
		return undefined;
	},
});
