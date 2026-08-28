export function sanitizeHostName(name: string): string {
	const sanitized = name.replace(/[^a-zA-Z0-9._-]+/g, "_");
	return sanitized.length > 0 ? sanitized : "remote";
}

const PROXY_JUMP_ERROR = "Invalid SSH ProxyJump specification";
const PROXY_JUMP_COMPONENT = /^[A-Za-z0-9._-]+$/;
const PROXY_JUMP_IPV6 = /^[A-Fa-f0-9:.]+$/;
const PROXY_JUMP_PORT = /^[0-9]+$/;

function invalidProxyJump(): never {
	throw new Error(PROXY_JUMP_ERROR);
}

function validateProxyJumpComponent(value: string): void {
	if (!value || value.startsWith("-") || !PROXY_JUMP_COMPONENT.test(value)) invalidProxyJump();
}

function validateProxyJumpPort(value: string): void {
	if (!PROXY_JUMP_PORT.test(value)) invalidProxyJump();
	const port = Number(value);
	if (port < 1 || port > 65535) invalidProxyJump();
}

function validateProxyJumpHop(hop: string): void {
	if (!hop) invalidProxyJump();

	const at = hop.indexOf("@");
	if (at !== hop.lastIndexOf("@")) invalidProxyJump();

	let destination = hop;
	if (at !== -1) {
		validateProxyJumpComponent(hop.slice(0, at));
		destination = hop.slice(at + 1);
	}

	if (destination.startsWith("[")) {
		const closeBracket = destination.indexOf("]");
		if (closeBracket === -1) invalidProxyJump();

		const address = destination.slice(1, closeBracket);
		if (!address.includes(":") || !PROXY_JUMP_IPV6.test(address)) invalidProxyJump();

		const suffix = destination.slice(closeBracket + 1);
		if (suffix) {
			if (!suffix.startsWith(":")) invalidProxyJump();
			validateProxyJumpPort(suffix.slice(1));
		}
		return;
	}

	const colon = destination.indexOf(":");
	let host = destination;
	if (colon !== -1) {
		if (colon !== destination.lastIndexOf(":")) invalidProxyJump();
		host = destination.slice(0, colon);
		validateProxyJumpPort(destination.slice(colon + 1));
	}
	validateProxyJumpComponent(host);
}

/**
 * Validate and outer-trim an OpenSSH ProxyJump specification without
 * interpreting aliases or splitting its comma-separated chain into argv.
 */
export function normalizeProxyJump(value: string): string {
	const normalized = value.trim();
	if (!normalized) invalidProxyJump();
	for (const hop of normalized.split(",")) validateProxyJumpHop(hop);
	return normalized;
}

/**
 * ProxyJump may rely on OpenSSH config, an agent, or keys. OMP's target
 * password askpass environment cannot safely distinguish target and jump
 * authentication prompts, so refuse that combination.
 */
export function assertProxyJumpPasswordCompatible(proxyJump: string | undefined, password: string | undefined): void {
	if (proxyJump !== undefined && password !== undefined) {
		throw new Error(
			"SSH ProxyJump cannot be used with password authentication; configure target authentication with a key or SSH agent instead",
		);
	}
}

export function buildSshTarget(username: string | undefined, host: string): string {
	// SSH treats a destination starting with "-" as an option, so a host/user of
	// `-oProxyCommand=...` becomes local command execution. Reject before this
	// string reaches any `ssh` argv (this is the single render chokepoint for
	// every connection, transfer, and sshfs mount).
	if (host.startsWith("-")) {
		throw new Error(
			`Invalid SSH host "${host}": an SSH destination must not begin with "-" (argument-injection guard)`,
		);
	}
	if (username?.startsWith("-")) {
		throw new Error(
			`Invalid SSH username "${username}": an SSH username must not begin with "-" (argument-injection guard)`,
		);
	}
	return username ? `${username}@${host}` : host;
}

/**
 * Single-quote a path for the POSIX remote shell used by `ssh://`
 * file-transfer helpers, escaping embedded single quotes.
 */
export function quotePosixPath(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Single-quote a string for PowerShell, escaping embedded single quotes.
 */
export function quotePowerShellString(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Wrap a POSIX command in `<shell> -c '<command>'` so it runs under the
 * named shell rather than whatever `$SHELL` happens to be on the remote.
 *
 * Used by the `ssh://` transfer helpers and the Windows compat dispatch:
 * OpenSSH passes our snippets to `<login-shell> -c`, so a remote whose
 * login shell is fish/csh/tcsh (or cmd/powershell on Windows compat)
 * can't parse `if [ … ]; then …`. Wrapping forces parsing under the
 * shell OMP actually verified can run the snippet.
 *
 * `-c` (not `-lc`): the transfer snippets only call absolute POSIX
 * builtins (`head`/`cat`/`mv`/`test`/`ls`/`mkdir`/`rm`/`dirname`) and
 * don't need login-profile setup. Capability *probing* still uses
 * `-lc` to mirror the user's real environment.
 */
export function wrapInPosixShell(shell: "sh" | "bash" | "zsh", command: string): string {
	return `${shell} -c ${quotePosixPath(command)}`;
}
