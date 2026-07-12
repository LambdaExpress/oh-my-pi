import { SecretObfuscator } from "../secrets/obfuscator";
import type { SessionEntry } from "./session-entries";
import { SSH_SESSION_REDACTED } from "./session-ssh-redaction";

export class SessionSshExternalRedactor {
	readonly #obfuscator: SecretObfuscator;

	constructor(passwords: readonly string[]) {
		this.#obfuscator = new SecretObfuscator(
			[...new Set(passwords)]
				.filter(password => password.length > 0)
				.map(password => ({
					type: "plain" as const,
					content: password,
					mode: "replace" as const,
					replacement: SSH_SESSION_REDACTED,
				})),
		);
	}

	hasSecrets(): boolean {
		return this.#obfuscator.hasSecrets();
	}

	redact(text: string): string {
		return this.#obfuscator.obfuscate(text);
	}

	redactJson<T>(value: T): T {
		if (!this.hasSecrets()) return value;
		return JSON.parse(this.redact(JSON.stringify(value))) as T;
	}
}

export function collectSessionSshPasswords(entries: readonly SessionEntry[]): string[] {
	const passwords: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "ssh_config_change" || entry.operation !== "upsert") continue;
		if (entry.config.password !== undefined) passwords.push(entry.config.password);
	}
	return passwords;
}

export function createSessionSshExternalRedactor(
	entryGroups: Iterable<readonly SessionEntry[]>,
): SessionSshExternalRedactor {
	const passwords: string[] = [];
	for (const entries of entryGroups) passwords.push(...collectSessionSshPasswords(entries));
	return new SessionSshExternalRedactor(passwords);
}

export function omitSessionSshConfigEntries(entries: readonly SessionEntry[]): SessionEntry[] {
	return entries.filter(entry => entry.type !== "ssh_config_change");
}
