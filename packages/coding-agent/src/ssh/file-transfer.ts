/**
 * Byte-preserving remote file I/O over the shared SSH ControlMaster connection.
 *
 * Unlike `executeSSH` (which truncates/sanitizes through an OutputSink) and
 * `runSshCaptureSync` (which `.trim()`s output), these helpers move raw bytes so
 * `ssh://` reads/writes round-trip exactly — leading/trailing whitespace, tabs,
 * and final newlines are preserved.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { commitStagedFileAtomic } from "@oh-my-pi/pi-natives";
import { isEexist, ptree, readLines, sleepLong } from "@oh-my-pi/pi-utils";
import { quotePosixArgument } from "../utils/shell-quote";
import {
	buildPowerShellCommand,
	buildRemoteCommandInvocation,
	ensureConnection,
	ensureHostInfo,
	type SSHConnectionTarget,
	type SSHPowerShellCommand,
} from "./connection-manager";
import { quotePowerShellString, wrapInPosixShell } from "./utils";

/** Per-operation timeout for remote transfers (matches the ssh tool's grep window). */
const DEFAULT_TIMEOUT_MS = 30_000;
const SSH_TRANSFER_PREFLIGHT_MAX_ATTEMPTS = 3;
const SSH_TRANSFER_PREFLIGHT_RETRY_MS = 500;
const SSH_TRANSFER_FINALIZE_MS = 10_000;
const SSH_TRANSFER_COMMIT_POSIX_TIMEOUT_MS = 8_000;
const SSH_TRANSFER_COMMIT_POWERSHELL_TIMEOUT_MS = 20_000;
const SSH_TRANSFER_RECOVERY_MS = 20_000;
const SSH_TRANSFER_STAGE_TERMINATE_MS = 2_000;
const SSH_TRANSFER_PROGRESS_INTERVAL_MS = 250;
const SSH_TRANSFER_COMMIT_MARKER = "OMP_TRANSFER_COMMITTED";
const SSH_TRANSFER_STATE_MARKER = "OMP_TRANSFER_STATE ";
const SSH_TRANSFER_PROGRESS_MARKER = "OMP_TRANSFER_PROGRESS ";

type RemoteTransferMode =
	| { kind: "posix"; shell: "sh" | "bash" | "zsh" }
	| { kind: "powershell"; executable: SSHPowerShellCommand };

type RemotePathEntryKind = "missing" | "file" | "symlink" | "directory" | "other";

export type SshTransferOperation = "upload" | "download";

export type SshTransferCommitStrategy =
	| "no-replace"
	| "local-native"
	| "remote-linux-exchange"
	| "remote-macos-swap"
	| "remote-posix-mv-no-target"
	| "remote-posix-mv"
	| "remote-windows-replace";

export interface SshFileTransferProgress {
	transferredBytes: number;
	totalBytes: number;
	bytesPerSecond: number;
	averageBytesPerSecond: number;
	elapsedMs: number;
}

export interface SshFileTransferPlan {
	operation: SshTransferOperation;
	target: SSHConnectionTarget;
	localPath: string;
	remotePath: string;
	totalBytes: number;
	overwrite: boolean;
	commitStrategy: SshTransferCommitStrategy;
}

export interface SshFileTransferRequest extends Omit<SshFileTransferPlan, "totalBytes" | "commitStrategy"> {
	signal?: AbortSignal;
}

export interface SshFileTransferExecuteOptions {
	signal?: AbortSignal;
	onProgress?: (progress: SshFileTransferProgress) => void;
}

/**
 * Ensure the ControlMaster connection and pick a verified transfer backend.
 * POSIX remotes use the shell whose capability probe round-tripped our
 * transfer snippets. Windows remotes use an explicitly verified PowerShell
 * executable that can run encoded scripts on a Windows platform.
 */
async function resolveRemoteTransferMode(target: SSHConnectionTarget): Promise<RemoteTransferMode> {
	await ensureConnection(target);
	const info = await ensureHostInfo(target);
	if (info.powerShellCommand) {
		return { kind: "powershell", executable: info.powerShellCommand };
	}
	if (info.os === "windows") {
		throw new Error(
			`ssh://: ${target.name} is a Windows host; ssh:// supports POSIX remotes only (head/cat/mv) — use \`bash\` with a remote SSH command for Windows hosts`,
		);
	}
	if (!info.transferShell) {
		throw new Error(
			`ssh://: ${target.name} has no verified POSIX shell for ssh:// read/write — none of sh/bash/zsh round-tripped a capability probe (use \`bash\` with a remote SSH command for this host)`,
		);
	}
	return { kind: "posix", shell: info.transferShell };
}

function normalizePowerShellSshPath(remotePath: string): string {
	if (remotePath === "/") return "/";
	const bareDrive = remotePath.match(/^\/([A-Za-z]):$/);
	if (bareDrive) return `${bareDrive[1]}:/`;
	const drivePath = remotePath.match(/^\/([A-Za-z]:)(\/.*)$/);
	if (drivePath) return `${drivePath[1]}${drivePath[2]}`;
	if (remotePath.startsWith("/\\\\")) return remotePath.slice(1);
	return remotePath;
}

async function runRemotePowerShellBytes(
	target: SSHConnectionTarget,
	executable: SSHPowerShellCommand,
	script: string,
	opts: { signal?: AbortSignal; timeoutMs?: number; stdin?: Uint8Array; allowStdin?: boolean } = {},
): Promise<Uint8Array> {
	const invocation = await buildRemoteCommandInvocation(
		target,
		buildPowerShellCommand(executable, script),
		opts.allowStdin ? { allowStdin: true } : undefined,
	);
	const signal = ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const spawnOptions = opts.stdin
		? { stdin: opts.stdin, signal, env: invocation.env }
		: { signal, env: invocation.env };
	try {
		using child = ptree.spawn([invocation.executable ?? "ssh", ...invocation.args], spawnOptions);
		const raw = await child.bytes();
		await child.exitedCleanly;
		return raw;
	} finally {
		await invocation.cleanup?.();
	}
}

async function runRemotePowerShellText(
	target: SSHConnectionTarget,
	executable: SSHPowerShellCommand,
	script: string,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
	return new TextDecoder().decode(await runRemotePowerShellBytes(target, executable, script, opts));
}

function wrapPowerShellTransferScript(body: string): string {
	return `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
${body}
} catch {
	[Console]::Error.WriteLine($_.Exception.Message)
	exit 1
}
exit 0
`;
}

export interface RemoteFileReadOptions {
	/** Maximum bytes to materialize; the helper fetches one extra byte to detect truncation. */
	maxBytes: number;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface RemoteFileReadResult {
	/** Raw file bytes, capped at `maxBytes`. */
	bytes: Uint8Array;
	/** True when the remote file was larger than `maxBytes` (`bytes` is the prefix). */
	truncated: boolean;
}

export interface RemoteFileWriteOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface RemoteFileDeleteOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

/**
 * Read a remote file's raw bytes. Fetches `maxBytes + 1` so the caller can
 * distinguish an exactly-`maxBytes` file from a larger (truncated) one.
 *
 * Throws `ptree.NonZeroExitError` (carrying the remote stderr tail) when the
 * file is missing/unreadable or the host is unreachable.
 */
export async function readRemoteFile(
	target: SSHConnectionTarget,
	remotePath: string,
	opts: RemoteFileReadOptions,
): Promise<RemoteFileReadResult> {
	const mode = await resolveRemoteTransferMode(target);
	let raw: Uint8Array;
	if (mode.kind === "posix") {
		const command = `head -c ${opts.maxBytes + 1} ${quotePosixArgument(remotePath)}`;
		const invocation = await buildRemoteCommandInvocation(target, wrapInPosixShell(mode.shell, command));
		try {
			using child = ptree.spawn([invocation.executable ?? "ssh", ...invocation.args], {
				signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
				env: invocation.env,
			});
			// Drain stdout before awaiting exit so a full pipe can't deadlock the child.
			raw = await child.bytes();
			await child.exitedCleanly;
		} finally {
			await invocation.cleanup?.();
		}
	} else {
		const script = wrapPowerShellTransferScript(`
$p = ${quotePowerShellString(normalizePowerShellSshPath(remotePath))}
$fs = [System.IO.File]::Open($p, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
try {
	$buf = [byte[]]::new(${opts.maxBytes + 1})
	$read = $fs.Read($buf, 0, $buf.Length)
	[Console]::OpenStandardOutput().Write($buf, 0, $read)
} finally {
	$fs.Dispose()
}
`);
		raw = await runRemotePowerShellBytes(target, mode.executable, script, {
			signal: opts.signal,
			timeoutMs: opts.timeoutMs,
		});
	}
	const truncated = raw.length > opts.maxBytes;
	return { bytes: truncated ? raw.subarray(0, opts.maxBytes) : raw, truncated };
}

/**
 * Write `content` to a remote file byte-exact. Stdin is always staged first into
 * a uniquely named temp in the destination directory (so the remote never blocks
 * on an unread pipe and a dropped connection lands in the temp, never the
 * destination). The destination then dictates the commit:
 *  - a directory — or a symlink to one, since the `-d` test follows links — is
 *    refused (a plain `mv tmp dir` would move the temp INTO it).
 *  - an existing non-symlink regular file is rewritten IN PLACE from the staged
 *    temp, preserving its inode and therefore its ordinary permission bits (a
 *    `0600` secret stays `0600` on overwrite), ACLs, xattrs, and hardlinks. The
 *    setuid/setgid bits may be cleared by the write (per POSIX). This commit is
 *    not fully atomic — a remote-side failure during the local temp->dest copy
 *    (e.g. the disk filling) can truncate the destination — but the slow network
 *    transfer has already landed in the temp, and the temp is removed on failure.
 *    It also needs write permission on the file itself (a read-only file is
 *    refused, not silently replaced).
 *  - an existing special file (FIFO/socket/device) is refused, not replaced.
 *  - anything else (a new path, a symlink to a non-directory, a dangling symlink)
 *    is committed with an atomic rename, which REPLACES a symlink with a regular
 *    file rather than writing through it (resolving the link target is not
 *    portable across the macOS/Linux hosts this stack supports).
 * Throws `ptree.NonZeroExitError` when the remote path is unwritable or the host
 * is unreachable.
 */
export async function writeRemoteFile(
	target: SSHConnectionTarget,
	remotePath: string,
	content: Uint8Array,
	opts: RemoteFileWriteOptions,
): Promise<void> {
	const mode = await resolveRemoteTransferMode(target);
	if (mode.kind === "posix") {
		if (remotePath.endsWith("/")) {
			throw new Error("ssh://: destination is a directory path (trailing '/'); ssh:// write requires a file path");
		}
		const dest = quotePosixArgument(remotePath);
		const tmp = quotePosixArgument(`${remotePath}.omp-tmp.${crypto.randomUUID()}`);
		// Stage stdin into the temp first (so the remote never blocks on an unread
		// pipe and a dropped connection lands in the temp, never the destination).
		// An EXIT trap removes the staged temp on every exit path (staging failure,
		// in-place success, refuse branches, or a failed rename). Commit by
		// destination kind: a directory (or symlink to one; `-d` follows links) is
		// refused; an existing non-symlink regular file is rewritten IN PLACE
		// (preserving inode, permission bits, ACLs, xattrs, hardlinks; setuid/setgid
		// may clear); an existing special file (FIFO/socket/device) is refused;
		// anything else (a new path or a symlink to a non-directory) uses temp+rename,
		// replacing such a symlink rather than writing through it.
		const command =
			`t=${tmp}; trap 'rm -f -- "$t"' 0; ` +
			`mkdir -p -- "$(dirname "$t")" && ` +
			`cat > "$t" && { ` +
			`if [ -d ${dest} ]; then echo 'ssh://: destination is a directory' >&2; exit 1; ` +
			`elif [ -f ${dest} ] && [ ! -L ${dest} ]; then cat "$t" > ${dest} || exit 1; ` +
			`elif [ -e ${dest} ] && [ ! -L ${dest} ]; then echo 'ssh://: destination is a special file (not a regular file)' >&2; exit 1; ` +
			`else mv "$t" ${dest}; fi; ` +
			`}`;
		const invocation = await buildRemoteCommandInvocation(target, wrapInPosixShell(mode.shell, command), {
			allowStdin: true,
		});
		try {
			using child = ptree.spawn([invocation.executable ?? "ssh", ...invocation.args], {
				stdin: content,
				signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
				env: invocation.env,
			});
			await child.exitedCleanly;
		} finally {
			await invocation.cleanup?.();
		}
		return;
	}

	const destPath = normalizePowerShellSshPath(remotePath);
	if (destPath.endsWith("/") || destPath.endsWith("\\")) {
		throw new Error("ssh://: destination is a directory path (trailing slash); ssh:// write requires a file path");
	}
	const tmpPath = `${destPath}.omp-tmp.${crypto.randomUUID()}`;
	const script = wrapPowerShellTransferScript(`
$p = ${quotePowerShellString(destPath)}
$tmp = ${quotePowerShellString(tmpPath)}
try {
	$parent = [System.IO.Path]::GetDirectoryName($p)
	if (![string]::IsNullOrEmpty($parent)) {
		[System.IO.Directory]::CreateDirectory($parent) | Out-Null
	}
	$stdinStream = [Console]::OpenStandardInput()
	$tmpStream = [System.IO.File]::Open($tmp, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
	try {
		$stdinStream.CopyTo($tmpStream)
	} finally {
		$tmpStream.Dispose()
	}
	$item = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
	$isReparsePoint = $null -ne $item -and (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
	if ($null -ne $item -and $item.PSIsContainer) {
		throw 'ssh://: destination is a directory'
	}
	if ($null -ne $item -and $item -is [System.IO.FileInfo] -and -not $isReparsePoint) {
		$srcStream = [System.IO.File]::Open($tmp, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
		$destStream = [System.IO.File]::Open($p, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
		try {
			$srcStream.CopyTo($destStream)
		} finally {
			$destStream.Dispose()
			$srcStream.Dispose()
		}
	} elseif ($null -ne $item -and -not $isReparsePoint) {
		throw 'ssh://: destination is a special file (not a regular file)'
	} else {
		Move-Item -LiteralPath $tmp -Destination $p -Force -ErrorAction Stop
	}
} finally {
	if ([System.IO.File]::Exists($tmp)) {
		Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
	}
}
`);
	await runRemotePowerShellBytes(target, mode.executable, script, {
		stdin: content,
		allowStdin: true,
		signal: opts.signal,
		timeoutMs: opts.timeoutMs,
	});
}

/**
 * Delete a remote file path. Directories (including symlinks to directories) are
 * refused; regular files, non-directory symlinks, special files, and dangling
 * symlinks are removed. Missing paths fail closed so a stale hashline REM never
 * reports success for a file that was already gone.
 */
export async function deleteRemoteFile(
	target: SSHConnectionTarget,
	remotePath: string,
	opts: RemoteFileDeleteOptions,
): Promise<void> {
	const mode = await resolveRemoteTransferMode(target);
	if (mode.kind === "posix") {
		const p = quotePosixArgument(remotePath);
		const command =
			`if [ -d ${p} ]; then echo 'ssh://: cannot delete directory' >&2; exit 1; ` +
			`elif [ -e ${p} ] || [ -L ${p} ]; then rm -f -- ${p}; ` +
			`else echo 'ssh://: file does not exist' >&2; exit 1; fi`;
		const invocation = await buildRemoteCommandInvocation(target, wrapInPosixShell(mode.shell, command));
		try {
			using child = ptree.spawn([invocation.executable ?? "ssh", ...invocation.args], {
				signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
				env: invocation.env,
			});
			await child.exitedCleanly;
		} finally {
			await invocation.cleanup?.();
		}
		return;
	}
	const script = wrapPowerShellTransferScript(`
$p = ${quotePowerShellString(normalizePowerShellSshPath(remotePath))}
$item = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
if ($null -eq $item) {
	throw 'ssh://: file does not exist'
}
if ($item.PSIsContainer) {
	throw 'ssh://: cannot delete directory'
}
Remove-Item -LiteralPath $p -Force -ErrorAction Stop
`);
	await runRemotePowerShellBytes(target, mode.executable, script, {
		signal: opts.signal,
		timeoutMs: opts.timeoutMs,
	});
}

/**
 * Rename/move a remote file path. Source directories, missing sources, and
 * destination directories are refused; an existing non-directory destination is
 * replaced with POSIX `mv` semantics, matching local `fs.rename` behavior.
 */
export async function moveRemoteFile(
	target: SSHConnectionTarget,
	fromRemotePath: string,
	toRemotePath: string,
	opts: RemoteFileDeleteOptions,
): Promise<void> {
	const mode = await resolveRemoteTransferMode(target);
	if (mode.kind === "posix") {
		const from = quotePosixArgument(fromRemotePath);
		const to = quotePosixArgument(toRemotePath);
		const command =
			`if [ -d ${from} ]; then echo 'ssh://: source is a directory' >&2; exit 1; ` +
			`elif [ -e ${from} ] || [ -L ${from} ]; then ` +
			`if [ -d ${to} ]; then echo 'ssh://: destination is a directory' >&2; exit 1; fi; ` +
			`mv -- ${from} ${to}; ` +
			`else echo 'ssh://: source does not exist' >&2; exit 1; fi`;
		const invocation = await buildRemoteCommandInvocation(target, wrapInPosixShell(mode.shell, command));
		try {
			using child = ptree.spawn([invocation.executable ?? "ssh", ...invocation.args], {
				signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
				env: invocation.env,
			});
			await child.exitedCleanly;
		} finally {
			await invocation.cleanup?.();
		}
		return;
	}
	const script = wrapPowerShellTransferScript(`
$from = ${quotePowerShellString(normalizePowerShellSshPath(fromRemotePath))}
$to = ${quotePowerShellString(normalizePowerShellSshPath(toRemotePath))}
$source = Get-Item -LiteralPath $from -Force -ErrorAction SilentlyContinue
if ($null -eq $source) {
	throw 'ssh://: source does not exist'
}
if ($source.PSIsContainer) {
	throw 'ssh://: source is a directory'
}
$destination = Get-Item -LiteralPath $to -Force -ErrorAction SilentlyContinue
if ($null -ne $destination -and $destination.PSIsContainer) {
	throw 'ssh://: destination is a directory'
}
Move-Item -LiteralPath $from -Destination $to -Force -ErrorAction Stop
`);
	await runRemotePowerShellBytes(target, mode.executable, script, {
		signal: opts.signal,
		timeoutMs: opts.timeoutMs,
	});
}

/** Classification of a remote path, used by the read handler's directory dispatch. */
export type RemotePathKind = "file" | "directory" | "other" | "missing";

/**
 * Classify a remote path with POSIX `test` (portable across Linux/BSD/macOS):
 * `directory`, regular `file`, `other` (special file), or `missing`.
 */
export async function statRemotePath(
	target: SSHConnectionTarget,
	remotePath: string,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RemotePathKind> {
	const mode = await resolveRemoteTransferMode(target);
	if (mode.kind === "posix") {
		const p = quotePosixArgument(remotePath);
		const command = `if [ -d ${p} ]; then echo directory; elif [ -f ${p} ]; then echo file; elif [ -e ${p} ]; then echo other; else echo missing; fi`;
		const invocation = await buildRemoteCommandInvocation(target, wrapInPosixShell(mode.shell, command));
		try {
			using child = ptree.spawn([invocation.executable ?? "ssh", ...invocation.args], {
				signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
				env: invocation.env,
			});
			const out = new TextDecoder().decode(await child.bytes()).trim();
			await child.exitedCleanly;
			return out === "directory" || out === "file" || out === "other" ? out : "missing";
		} finally {
			await invocation.cleanup?.();
		}
	}
	const script = wrapPowerShellTransferScript(`
$p = ${quotePowerShellString(normalizePowerShellSshPath(remotePath))}
$item = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
if ($null -eq $item) {
	[Console]::Out.WriteLine('missing')
} elseif ($item.PSIsContainer) {
	[Console]::Out.WriteLine('directory')
} elseif ($item -is [System.IO.FileInfo]) {
	[Console]::Out.WriteLine('file')
} else {
	[Console]::Out.WriteLine('other')
}
`);
	const out = (await runRemotePowerShellText(target, mode.executable, script, opts)).trim();
	return out === "directory" || out === "file" || out === "other" || out === "missing" ? out : "missing";
}

/** A single entry in a remote directory listing. */
export interface RemoteDirEntry {
	/** Entry name (no path component), trailing `/` stripped. */
	name: string;
	/** True when the entry is a directory. */
	isDirectory: boolean;
}

/**
 * List a remote directory one level deep with `ls -1Ap` (one per line; all
 * entries incl. dotfiles but not `.`/`..`; trailing `/` marks directories).
 * Plain `ls` (no `| head`) so a permission/race failure surfaces as a non-zero
 * exit instead of being masked as an empty listing. Entries are returned in
 * full, sorted directories-first then by name to mirror the local
 * directory-resource contract, so the read tool can paginate the listing.
 */
export async function listRemoteDir(
	target: SSHConnectionTarget,
	remotePath: string,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RemoteDirEntry[]> {
	const mode = await resolveRemoteTransferMode(target);
	let text: string;
	if (mode.kind === "posix") {
		const command = `LC_ALL=C ls -1Ap -- ${quotePosixArgument(remotePath)}`;
		const invocation = await buildRemoteCommandInvocation(target, wrapInPosixShell(mode.shell, command));
		try {
			using child = ptree.spawn([invocation.executable ?? "ssh", ...invocation.args], {
				signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
				env: invocation.env,
			});
			text = new TextDecoder().decode(await child.bytes());
			await child.exitedCleanly;
		} finally {
			await invocation.cleanup?.();
		}
	} else {
		const script = wrapPowerShellTransferScript(`
$p = ${quotePowerShellString(normalizePowerShellSshPath(remotePath))}
Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop |
	Sort-Object @{Expression={$_.PSIsContainer};Descending=$true}, Name |
	ForEach-Object {
		if ($_.PSIsContainer) {
			[Console]::Out.WriteLine("$($_.Name)/")
		} else {
			[Console]::Out.WriteLine($_.Name)
		}
	}
`);
		text = await runRemotePowerShellText(target, mode.executable, script, opts);
	}
	const entries = text
		.split(/\r?\n/)
		.filter(line => line.length > 0)
		.map(line => {
			const isDirectory = line.endsWith("/");
			return { name: isDirectory ? line.slice(0, -1) : line, isDirectory };
		});
	// JS sort is the order contract (mirrors buildDirectoryResource): dirs first, then by name.
	entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
	return entries;
}

async function runRemotePosixText(
	target: SSHConnectionTarget,
	shell: "sh" | "bash" | "zsh",
	command: string,
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
	const invocation = await buildRemoteCommandInvocation(target, wrapInPosixShell(shell, command));
	try {
		using child = ptree.spawn([invocation.executable ?? "ssh", ...invocation.args], {
			signal: ptree.combineSignals(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
			env: invocation.env,
		});
		const bytes = await child.bytes();
		await child.exitedCleanly;
		return new TextDecoder().decode(bytes);
	} finally {
		await invocation.cleanup?.();
	}
}

function parseTransferSize(value: string, sourceDescription: string): number {
	const text = value.trim();
	if (!/^\d+$/.test(text)) {
		throw new Error(`SSH transfer could not determine the size of ${sourceDescription}`);
	}
	const size = BigInt(text);
	if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error(`SSH transfer source exceeds JavaScript's safe file-size limit: ${sourceDescription}`);
	}
	return Number(size);
}

function isMissingFileSystemError(error: unknown): boolean {
	if (!(error instanceof Error) || !("code" in error)) return false;
	return error.code === "ENOENT" || error.code === "ENOTDIR";
}

async function getLocalSourceSize(localPath: string): Promise<number> {
	try {
		const source = await fs.stat(localPath, { bigint: true });
		if (!source.isFile()) {
			throw new Error(`SSH transfer source must resolve to a regular file: ${localPath}`);
		}
		if (source.size > BigInt(Number.MAX_SAFE_INTEGER)) {
			throw new Error(`SSH transfer source exceeds JavaScript's safe file-size limit: ${localPath}`);
		}
		return Number(source.size);
	} catch (error) {
		if (isMissingFileSystemError(error)) {
			throw new Error(`SSH transfer source does not exist: ${localPath}`);
		}
		throw error;
	}
}

async function getLocalDestinationKind(localPath: string): Promise<RemotePathEntryKind> {
	try {
		const destination = await fs.lstat(localPath);
		if (destination.isSymbolicLink()) return "symlink";
		if (destination.isFile()) return "file";
		if (destination.isDirectory()) return "directory";
		return "other";
	} catch (error) {
		if (isMissingFileSystemError(error)) return "missing";
		throw error;
	}
}

async function getRemoteSourceSize(
	target: SSHConnectionTarget,
	mode: RemoteTransferMode,
	remotePath: string,
	signal?: AbortSignal,
): Promise<number> {
	if (mode.kind === "posix") {
		const source = quotePosixArgument(remotePath);
		const text = await runRemotePosixText(
			target,
			mode.shell,
			`if [ ! -e ${source} ] && [ ! -L ${source} ]; then
	printf '%s\\n' 'SSH transfer source does not exist' >&2
	exit 44
fi
if [ ! -f ${source} ]; then
	printf '%s\\n' 'SSH transfer source must resolve to a regular file' >&2
	exit 45
fi
LC_ALL=C wc -c < ${source}`,
			{ signal },
		);
		return parseTransferSize(text, `${target.name}:${remotePath}`);
	}

	const source = quotePowerShellString(normalizePowerShellSshPath(remotePath));
	const text = await runRemotePowerShellText(
		target,
		mode.executable,
		wrapPowerShellTransferScript(`
$p = ${source}
$item = Get-Item -LiteralPath $p -Force -ErrorAction Stop
if ($item.PSIsContainer) {
	throw 'SSH transfer source must resolve to a regular file'
}
$stream = [System.IO.File]::Open(
	$p,
	[System.IO.FileMode]::Open,
	[System.IO.FileAccess]::Read,
	[System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
)
try {
	[Console]::Out.WriteLine($stream.Length)
} finally {
	$stream.Dispose()
}
`),
		{ signal },
	);
	return parseTransferSize(text, `${target.name}:${remotePath}`);
}

async function getRemoteDestinationKind(
	target: SSHConnectionTarget,
	mode: RemoteTransferMode,
	remotePath: string,
	signal?: AbortSignal,
): Promise<RemotePathEntryKind> {
	if (mode.kind === "posix") {
		const destination = quotePosixArgument(remotePath);
		const text = await runRemotePosixText(
			target,
			mode.shell,
			`if [ -L ${destination} ]; then
	printf '%s' symlink
elif [ -f ${destination} ]; then
	printf '%s' file
elif [ -d ${destination} ]; then
	printf '%s' directory
elif [ -e ${destination} ]; then
	printf '%s' other
else
	printf '%s' missing
fi`,
			{ signal },
		);
		const kind = text.trim();
		if (kind === "missing" || kind === "file" || kind === "symlink" || kind === "directory" || kind === "other") {
			return kind;
		}
		throw new Error(`SSH transfer received an invalid destination classification from ${target.name}`);
	}

	const destination = quotePowerShellString(normalizePowerShellSshPath(remotePath));
	const text = await runRemotePowerShellText(
		target,
		mode.executable,
		wrapPowerShellTransferScript(`
$p = ${destination}
$item = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
if ($null -eq $item) {
	[Console]::Out.Write('missing')
} elseif (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
	[Console]::Out.Write('symlink')
} elseif ($item.PSIsContainer) {
	[Console]::Out.Write('directory')
} elseif ($item -is [System.IO.FileInfo]) {
	[Console]::Out.Write('file')
} else {
	[Console]::Out.Write('other')
}
`),
		{ signal },
	);
	const kind = text.trim();
	if (kind === "missing" || kind === "file" || kind === "symlink" || kind === "directory" || kind === "other") {
		return kind;
	}
	throw new Error(`SSH transfer received an invalid destination classification from ${target.name}`);
}

async function probeRemotePosixCommitStrategy(
	target: SSHConnectionTarget,
	mode: Extract<RemoteTransferMode, { kind: "posix" }>,
	signal?: AbortSignal,
): Promise<SshTransferCommitStrategy> {
	const hostInfo = await ensureHostInfo(target);
	const probe =
		hostInfo.os === "linux" || hostInfo.os === "wsl"
			? `python3 -c ${quotePosixArgument(
					"import ctypes, errno; c=ctypes.CDLL(None,use_errno=True); f=getattr(c,'renameat2'); r=f(-100,b'/__omp_transfer_probe_a__',-100,b'/__omp_transfer_probe_b__',2); e=ctypes.get_errno(); raise SystemExit(0 if r == 0 or e not in (errno.ENOSYS, errno.EINVAL) else 1)",
				)} >/dev/null 2>&1`
			: hostInfo.os === "macos"
				? `python3 -c ${quotePosixArgument(
						"import ctypes, errno; c=ctypes.CDLL(None,use_errno=True); f=getattr(c,'renamex_np'); r=f(b'/__omp_transfer_probe_a__',b'/__omp_transfer_probe_b__',2); e=ctypes.get_errno(); raise SystemExit(0 if r == 0 or e not in (errno.ENOSYS, errno.EINVAL) else 1)",
					)} >/dev/null 2>&1`
				: "false";
	const marker = await runRemotePosixText(
		target,
		mode.shell,
		`if ${probe}; then
	printf '%s' exchange
elif command -v mv >/dev/null 2>&1; then
	case "$(mv --help 2>&1)" in
		*--no-target-directory*|*'-T'*) printf '%s' no-target ;;
		*) printf '%s' mv ;;
	esac
else
	printf '%s' unsupported
fi`,
		{ signal },
	);
	switch (marker.trim()) {
		case "exchange":
			return hostInfo.os === "macos" ? "remote-macos-swap" : "remote-linux-exchange";
		case "no-target":
			return "remote-posix-mv-no-target";
		case "mv":
			return "remote-posix-mv";
		default:
			throw new Error(`SSH transfer is unsupported on ${target.name}: no usable atomic exchange or mv command`);
	}
}

function assertDestinationMayBeReplaced(kind: RemotePathEntryKind, destination: string): void {
	if (kind === "directory" || kind === "other") {
		throw new Error(`SSH transfer refuses to replace a directory or special file: ${destination}`);
	}
}

function isTransientSshPreflightError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (error instanceof ptree.NonZeroExitError && error.exitCode !== 255) return false;
	// Authentication and host-key failures can also end with a closed connection.
	if (
		/permission denied|authentication failed|too many authentication failures|host key verification failed|remote host identification has changed|bad permissions|unprotected private key file|no matching (?:host key type|key exchange method|cipher|mac)/i.test(
			error.message,
		)
	) {
		return false;
	}
	// Our read-only probes use other exit codes for remote file errors. SSH
	// transport failures use 255, sometimes with only "Unknown error" on Windows.
	if (error instanceof ptree.NonZeroExitError) return true;
	return /connection (?:closed|reset|refused|timed out)|connection to [^\r\n]+ closed|operation timed out|broken pipe|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT)\b/i.test(
		error.message,
	);
}

export class SshFileTransferPreparationError extends Error {
	constructor(
		operation: SshTransferOperation,
		readonly totalBytes: number | undefined,
		cause: unknown,
		readonly attempts: number,
	) {
		super(
			`SSH ${operation} preflight failed${attempts > 1 ? ` after ${attempts} attempts` : ""} (${describeTransferError(cause)}). ` +
				(totalBytes === undefined ? "Source size was not determined. " : `Source size: ${totalBytes} bytes. `) +
				"No file content was transferred; the destination was not modified.",
			{ cause },
		);
		this.name = "SshFileTransferPreparationError";
	}
}

export async function prepareSshFileTransfer(request: SshFileTransferRequest): Promise<SshFileTransferPlan> {
	let totalBytes: number | undefined;
	let attempts = 0;
	while (true) {
		try {
			if (attempts > 0) {
				await sleepLong(SSH_TRANSFER_PREFLIGHT_RETRY_MS * 2 ** (attempts - 1), request.signal);
			}
			attempts++;
			request.signal?.throwIfAborted();
			// A local source can be measured even when the SSH route cannot connect.
			const localSourceBytes =
				request.operation === "upload" ? await getLocalSourceSize(request.localPath) : undefined;
			if (localSourceBytes !== undefined) totalBytes = localSourceBytes;
			request.signal?.throwIfAborted();
			const mode = await resolveRemoteTransferMode(request.target);
			request.signal?.throwIfAborted();

			if (mode.kind === "powershell") {
				if (
					!/^[A-Za-z]:[\\/]/.test(request.remotePath) &&
					!/^[/\\]{2}[^/\\]+[/\\][^/\\]+/.test(request.remotePath)
				) {
					throw new Error("SSH transfer remote_path must be an absolute drive or UNC path on Windows hosts.");
				}
			} else if (!path.posix.isAbsolute(request.remotePath)) {
				throw new Error("SSH transfer remote_path must be an absolute POSIX path.");
			}

			const sourceBytes =
				localSourceBytes ?? (await getRemoteSourceSize(request.target, mode, request.remotePath, request.signal));
			totalBytes = sourceBytes;
			const destinationKind =
				request.operation === "upload"
					? await getRemoteDestinationKind(request.target, mode, request.remotePath, request.signal)
					: await getLocalDestinationKind(request.localPath);

			if (!request.overwrite && destinationKind !== "missing") {
				const destination =
					request.operation === "upload" ? `${request.target.name}:${request.remotePath}` : request.localPath;
				throw new Error(`SSH transfer destination already exists: ${destination}`);
			}
			if (request.overwrite) {
				const destination =
					request.operation === "upload" ? `${request.target.name}:${request.remotePath}` : request.localPath;
				assertDestinationMayBeReplaced(destinationKind, destination);
			}

			let commitStrategy: SshTransferCommitStrategy;
			if (!request.overwrite) {
				commitStrategy = "no-replace";
			} else if (request.operation === "download") {
				commitStrategy = "local-native";
			} else if (mode.kind === "powershell") {
				commitStrategy = "remote-windows-replace";
			} else {
				commitStrategy = await probeRemotePosixCommitStrategy(request.target, mode, request.signal);
			}
			request.signal?.throwIfAborted();
			return {
				operation: request.operation,
				target: request.target,
				localPath: request.localPath,
				remotePath: request.remotePath,
				totalBytes: sourceBytes,
				overwrite: request.overwrite,
				commitStrategy,
			};
		} catch (error) {
			if (
				request.signal?.aborted ||
				attempts >= SSH_TRANSFER_PREFLIGHT_MAX_ATTEMPTS ||
				!isTransientSshPreflightError(error)
			) {
				throw new SshFileTransferPreparationError(request.operation, totalBytes, error, attempts);
			}
			// Only read-only preflight probes are replayed; staging and commit are not.
		}
	}
}

interface RemoteTransferArtifacts {
	stagePath: string;
	proofPath: string;
	backupPath: string;
}

class SshTransferProgressReporter {
	readonly #totalBytes: number;
	readonly #onProgress: ((progress: SshFileTransferProgress) => void) | undefined;
	readonly #startedAt = Date.now();
	#transferredBytes = 0;
	#lastEmittedAt = this.#startedAt;
	#lastEmittedBytes = 0;
	#lastProgress: SshFileTransferProgress;

	constructor(totalBytes: number, onProgress?: (progress: SshFileTransferProgress) => void) {
		this.#totalBytes = totalBytes;
		this.#onProgress = onProgress;
		this.#lastProgress = {
			transferredBytes: 0,
			totalBytes,
			bytesPerSecond: 0,
			averageBytesPerSecond: 0,
			elapsedMs: 0,
		};
	}

	get transferredBytes(): number {
		return this.#transferredBytes;
	}

	get remainingBytes(): number {
		return this.#totalBytes - this.#transferredBytes;
	}

	emitInitial(): void {
		this.#onProgress?.(this.#lastProgress);
	}

	addAcceptedBytes(bytes: number): void {
		if (!Number.isFinite(bytes) || bytes <= 0) {
			throw new Error("SSH transfer write accepted zero bytes");
		}
		this.#transferredBytes += bytes;
		if (this.#transferredBytes > this.#totalBytes) {
			throw new Error("SSH transfer source grew after preflight");
		}
		const now = Date.now();
		if (now - this.#lastEmittedAt >= SSH_TRANSFER_PROGRESS_INTERVAL_MS) {
			this.#emit(now);
		}
	}

	setTransferredBytes(bytes: number): void {
		if (!Number.isSafeInteger(bytes) || bytes <= this.#transferredBytes || bytes > this.#totalBytes) return;
		this.#transferredBytes = bytes;
		const now = Date.now();
		if (now - this.#lastEmittedAt >= SSH_TRANSFER_PROGRESS_INTERVAL_MS) this.#emit(now);
	}

	finish(): SshFileTransferProgress {
		this.#emit(Date.now());
		return this.#lastProgress;
	}

	#emit(now: number): void {
		const elapsedMs = Math.max(0, now - this.#startedAt);
		const sampleMs = Math.max(0, now - this.#lastEmittedAt);
		const sampleBytes = Math.max(0, this.#transferredBytes - this.#lastEmittedBytes);
		const bytesPerSecond = sampleMs === 0 ? 0 : (sampleBytes * 1000) / sampleMs;
		const averageBytesPerSecond = elapsedMs === 0 ? 0 : (this.#transferredBytes * 1000) / elapsedMs;
		this.#lastProgress = {
			transferredBytes: this.#transferredBytes,
			totalBytes: this.#totalBytes,
			bytesPerSecond: Number.isFinite(bytesPerSecond) ? bytesPerSecond : 0,
			averageBytesPerSecond: Number.isFinite(averageBytesPerSecond) ? averageBytesPerSecond : 0,
			elapsedMs,
		};
		this.#lastEmittedAt = now;
		this.#lastEmittedBytes = this.#transferredBytes;
		this.#onProgress?.(this.#lastProgress);
	}
}

function createRemoteTransferArtifacts(remotePath: string, mode: RemoteTransferMode): RemoteTransferArtifacts {
	const id = crypto.randomUUID();
	const parent =
		mode.kind === "posix"
			? path.posix.dirname(remotePath)
			: path.win32.dirname(normalizePowerShellSshPath(remotePath));
	const join = mode.kind === "posix" ? path.posix.join : path.win32.join;
	return {
		stagePath: join(parent, `.omp-transfer-${id}.part`),
		proofPath: join(parent, `.omp-transfer-${id}.proof`),
		backupPath: join(parent, `.omp-transfer-${id}.backup`),
	};
}

function buildPosixUploadStageScript(remotePath: string, artifacts: RemoteTransferArtifacts): string {
	const parent = quotePosixArgument(path.posix.dirname(remotePath));
	const stage = quotePosixArgument(artifacts.stagePath);
	return `set -u
parent=${parent}
stage=${stage}
progress_pid=
stop_transfer_progress() {
	if [ -n "\${progress_pid:-}" ]; then
		kill "$progress_pid" 2>/dev/null || true
		wait "$progress_pid" 2>/dev/null || true
		progress_pid=
	fi
}
trap 'stop_transfer_progress; exit 130' HUP INT TERM
mkdir -p -- "$parent" || exit 1
umask 077
( set -C; : > "$stage" ) || exit 1
(
	trap - HUP INT TERM
	while :; do
		size=$(wc -c < "$stage" 2>/dev/null) || size=0
		printf '${SSH_TRANSFER_PROGRESS_MARKER}%s\\n' "$size"
		sleep 0.25 || exit 0
	done
) &
progress_pid=$!
if ! cat > "$stage"; then
	stop_transfer_progress
	exit 1
fi
stop_transfer_progress
size=$(wc -c < "$stage") || exit 1
printf '${SSH_TRANSFER_PROGRESS_MARKER}%s\\n' "$size"
trap - HUP INT TERM
`;
}

function buildPowerShellUploadStageScript(remotePath: string, artifacts: RemoteTransferArtifacts): string {
	return wrapPowerShellTransferScript(`
$destination = ${quotePowerShellString(normalizePowerShellSshPath(remotePath))}
$stage = ${quotePowerShellString(artifacts.stagePath)}
$parent = [System.IO.Path]::GetDirectoryName($destination)
[System.IO.Directory]::CreateDirectory($parent) | Out-Null
$stream = $null
try {
	$stream = [System.IO.File]::Open(
		$stage,
		[System.IO.FileMode]::CreateNew,
		[System.IO.FileAccess]::Write,
		[System.IO.FileShare]::None
	)
	$inputStream = [Console]::OpenStandardInput()
	$buffer = New-Object byte[] 65536
	$total = [long]0
	$progressClock = [System.Diagnostics.Stopwatch]::StartNew()
	while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
		$stream.Write($buffer, 0, $read)
		$total += $read
		if ($progressClock.ElapsedMilliseconds -ge ${SSH_TRANSFER_PROGRESS_INTERVAL_MS}) {
			[Console]::Out.WriteLine("${SSH_TRANSFER_PROGRESS_MARKER}$total")
			[Console]::Out.Flush()
			$progressClock.Restart()
		}
	}
	$stream.Flush($true)
	[Console]::Out.WriteLine("${SSH_TRANSFER_PROGRESS_MARKER}$total")
	[Console]::Out.Flush()
} finally {
	if ($null -ne $stream) {
		$stream.Dispose()
	}
}
`);
}

function buildRemoteDownloadCommand(mode: RemoteTransferMode, remotePath: string): string {
	if (mode.kind === "posix") {
		return wrapInPosixShell(mode.shell, `cat < ${quotePosixArgument(remotePath)}`);
	}
	return buildPowerShellCommand(
		mode.executable,
		wrapPowerShellTransferScript(`
$source = ${quotePowerShellString(normalizePowerShellSshPath(remotePath))}
$stream = [System.IO.File]::Open(
	$source,
	[System.IO.FileMode]::Open,
	[System.IO.FileAccess]::Read,
	[System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
)
try {
	$stream.CopyTo([Console]::OpenStandardOutput())
} finally {
	$stream.Dispose()
}
`),
	);
}

interface TransferChildHandle {
	exited: Promise<number>;
	kill(): void;
}

async function terminateTransferStageChild(child: TransferChildHandle): Promise<void> {
	child.kill();
	let exited = false;
	await Promise.race([
		child.exited.then(
			() => {
				exited = true;
			},
			() => {
				exited = true;
			},
		),
		Bun.sleep(SSH_TRANSFER_STAGE_TERMINATE_MS),
	]);
	if (!exited) child.kill();
}

async function writeAllToSink(
	sink: Bun.FileSink,
	chunk: Uint8Array,
	onAccepted: (bytes: number) => void,
	signal?: AbortSignal,
): Promise<void> {
	let offset = 0;
	while (offset < chunk.byteLength) {
		signal?.throwIfAborted();
		const accepted = await sink.write(chunk.subarray(offset));
		if (!Number.isFinite(accepted) || accepted <= 0) {
			throw new Error("SSH transfer remote sink accepted zero bytes");
		}
		offset += accepted;
		onAccepted(accepted);
	}
}

async function observeRemoteUploadProgress(
	output: ReadableStream<Uint8Array>,
	reporter: SshTransferProgressReporter,
): Promise<void> {
	const decoder = new TextDecoder();
	for await (const line of readLines(output)) {
		const text = decoder.decode(line).trim();
		if (!text.startsWith(SSH_TRANSFER_PROGRESS_MARKER)) continue;
		const bytes = Number(text.slice(SSH_TRANSFER_PROGRESS_MARKER.length));
		reporter.setTransferredBytes(bytes);
	}
}

async function writeAllToFile(
	file: fs.FileHandle,
	chunk: Uint8Array,
	reporter: SshTransferProgressReporter,
	signal?: AbortSignal,
): Promise<void> {
	let offset = 0;
	while (offset < chunk.byteLength) {
		signal?.throwIfAborted();
		const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
		if (!Number.isFinite(bytesWritten) || bytesWritten <= 0) {
			throw new Error("SSH transfer local file accepted zero bytes");
		}
		offset += bytesWritten;
		reporter.addAcceptedBytes(bytesWritten);
	}
}

async function streamUploadStage(
	plan: SshFileTransferPlan,
	mode: RemoteTransferMode,
	artifacts: RemoteTransferArtifacts,
	reporter: SshTransferProgressReporter,
	signal?: AbortSignal,
): Promise<void> {
	const command =
		mode.kind === "posix"
			? wrapInPosixShell(mode.shell, buildPosixUploadStageScript(plan.remotePath, artifacts))
			: buildPowerShellCommand(mode.executable, buildPowerShellUploadStageScript(plan.remotePath, artifacts));
	const invocation = await buildRemoteCommandInvocation(plan.target, command, { allowStdin: true });
	try {
		using child = ptree.spawn([invocation.executable ?? "ssh", ...invocation.args], {
			stdin: "pipe",
			signal,
			env: invocation.env,
		});
		const cleanExit = child.exitedCleanly;
		const exitFailure = cleanExit.then(
			() => undefined,
			(error: unknown) => error,
		);
		const remoteProgress = observeRemoteUploadProgress(child.stdout, reporter);
		let sourceBytes = 0;
		try {
			const source = Bun.file(plan.localPath).stream();
			for await (const chunk of source) {
				signal?.throwIfAborted();
				if (chunk.byteLength > plan.totalBytes - sourceBytes) {
					throw new Error(`SSH transfer source grew after preflight: ${plan.localPath}`);
				}
				await writeAllToSink(
					child.stdin,
					chunk,
					accepted => {
						sourceBytes += accepted;
					},
					signal,
				);
			}
			await child.stdin.end();
			await Promise.all([remoteProgress, cleanExit]);
		} catch (error) {
			let transportError: unknown = child.exitReason;
			const brokenPipe =
				error instanceof Error &&
				(("code" in error && (error.code === "EPIPE" || error.code === "ECONNRESET")) ||
					/\b(?:broken pipe|EPIPE|ECONNRESET)\b/i.test(error.message));
			if (!signal?.aborted && transportError === undefined && brokenPipe) {
				// A closed stdin can be observed just before SSH reports its exit.
				// Let that diagnostic settle before our own kill could replace it.
				transportError = await Promise.race([exitFailure, Bun.sleep(SSH_TRANSFER_STAGE_TERMINATE_MS)]);
			}
			await terminateTransferStageChild(child);
			await remoteProgress.catch(() => undefined);
			if (!signal?.aborted && transportError instanceof ptree.NonZeroExitError && transportError !== error) {
				throw new Error(
					`${describeTransferError(transportError)}; local upload stream also failed: ${describeTransferError(error)}`,
					{ cause: transportError },
				);
			}
			throw error;
		}
		if (sourceBytes !== plan.totalBytes) {
			throw new Error(
				`SSH transfer source size changed after preflight: expected ${plan.totalBytes} bytes, received ${sourceBytes}`,
			);
		}
		if (reporter.transferredBytes !== plan.totalBytes) reporter.setTransferredBytes(sourceBytes);
	} finally {
		await invocation.cleanup?.();
	}
}

async function streamDownloadStage(
	plan: SshFileTransferPlan,
	mode: RemoteTransferMode,
	stagePath: string,
	reporter: SshTransferProgressReporter,
	signal?: AbortSignal,
): Promise<void> {
	const invocation = await buildRemoteCommandInvocation(
		plan.target,
		buildRemoteDownloadCommand(mode, plan.remotePath),
	);
	try {
		const file = await fs.open(stagePath, "wx", 0o600);
		try {
			using child = ptree.spawn([invocation.executable ?? "ssh", ...invocation.args], {
				signal,
				env: invocation.env,
			});
			try {
				for await (const chunk of child.stdout) {
					signal?.throwIfAborted();
					if (chunk.byteLength > reporter.remainingBytes) {
						throw new Error(`SSH transfer source grew after preflight: ${plan.target.name}:${plan.remotePath}`);
					}
					await writeAllToFile(file, chunk, reporter, signal);
				}
				await child.exitedCleanly;
				await file.sync();
			} catch (error) {
				await terminateTransferStageChild(child);
				throw error;
			}
		} finally {
			await file.close();
		}
	} finally {
		await invocation.cleanup?.();
	}
	if (reporter.transferredBytes !== plan.totalBytes) {
		throw new Error(
			`SSH transfer source size changed after preflight: expected ${plan.totalBytes} bytes, received ${reporter.transferredBytes}`,
		);
	}
}

function buildPosixExchangeCommand(strategy: "remote-linux-exchange" | "remote-macos-swap"): string {
	const code =
		strategy === "remote-linux-exchange"
			? "import ctypes, os, sys; c=ctypes.CDLL(None,use_errno=True); f=getattr(c,'renameat2'); r=f(-100,os.fsencode(sys.argv[1]),-100,os.fsencode(sys.argv[2]),2); e=ctypes.get_errno(); raise SystemExit(0 if r == 0 else e or 1)"
			: "import ctypes, os, sys; c=ctypes.CDLL(None,use_errno=True); f=getattr(c,'renamex_np'); r=f(os.fsencode(sys.argv[1]),os.fsencode(sys.argv[2]),2); e=ctypes.get_errno(); raise SystemExit(0 if r == 0 else e or 1)";
	return `python3 -c ${quotePosixArgument(code)} "$stage" "$destination"`;
}

function buildPosixUploadAcknowledgementScript(): string {
	return `printf '%s\\n' '${SSH_TRANSFER_COMMIT_MARKER}'
if IFS= read -r acknowledgement && [ "$acknowledgement" = ACK ]; then
	if [ -L "$destination" ] || [ ! "$destination" -ef "$proof" ]; then
		printf '%s\\n' 'destination identity changed after commit; transfer proof and displaced entry are preserved' >&2
		exit 1
	fi
	rm -f -- "$stage" "$backup" || exit 1
	rm -f -- "$proof" || exit 1
fi
exit 0`;
}

function buildPosixUploadCommitScript(plan: SshFileTransferPlan, artifacts: RemoteTransferArtifacts): string {
	const stage = quotePosixArgument(artifacts.stagePath);
	const proof = quotePosixArgument(artifacts.proofPath);
	const backup = quotePosixArgument(artifacts.backupPath);
	const destination = quotePosixArgument(plan.remotePath);
	let commit: string;
	switch (plan.commitStrategy) {
		case "no-replace":
			commit = `if ! ln "$stage" "$destination"; then
	printf '%s\\n' 'destination already exists' >&2
	exit 1
fi
rm -f -- "$stage" || exit 1`;
			break;
		case "remote-linux-exchange":
		case "remote-macos-swap": {
			const exchange = buildPosixExchangeCommand(plan.commitStrategy);
			commit = `if [ ! -e "$destination" ] && [ ! -L "$destination" ]; then
	if ! ln "$stage" "$destination"; then
		printf '%s\\n' 'destination appeared before commit' >&2
		exit 1
	fi
	rm -f -- "$stage" || exit 1
else
	if ! ${exchange}; then
		printf '%s\\n' 'exact destination exchange failed' >&2
		exit 1
	fi
	if [ -L "$stage" ] || [ -f "$stage" ]; then
		:
	else
		printf '%s\\n' 'destination became a directory or special file; displaced entry is preserved at stage' >&2
		exit 1
	fi
fi`;
			break;
		}
		case "remote-posix-mv-no-target":
			commit = `if [ -L "$destination" ] || [ -f "$destination" ] || { [ ! -e "$destination" ] && [ ! -L "$destination" ]; }; then
	:
else
	printf '%s\\n' 'destination is a directory or special file' >&2
	exit 1
fi
mv -T -- "$stage" "$destination" || exit 1`;
			break;
		case "remote-posix-mv":
			commit = `if [ -L "$destination" ] || [ -f "$destination" ] || { [ ! -e "$destination" ] && [ ! -L "$destination" ]; }; then
	:
else
	printf '%s\\n' 'destination is a directory or special file' >&2
	exit 1
fi
mv "$stage" "$destination" || exit 1`;
			break;
		default:
			throw new Error(`Invalid POSIX SSH transfer commit strategy: ${plan.commitStrategy}`);
	}

	return `set -u
stage=${stage}
proof=${proof}
backup=${backup}
destination=${destination}
if [ ! -f "$stage" ] || [ -L "$stage" ]; then
	printf '%s\\n' 'staged transfer is missing or is not a regular file' >&2
	exit 1
fi
actual_size=$(LC_ALL=C wc -c < "$stage") || exit 1
actual_size=$(printf '%s' "$actual_size" | tr -d '[:space:]') || exit 1
if [ "$actual_size" != ${plan.totalBytes} ]; then
	printf '%s\\n' 'staged transfer size does not match preflight' >&2
	rm -f -- "$stage"
	exit 1
fi
if ! ln "$stage" "$proof"; then
	if [ -e "$proof" ] && [ "$stage" -ef "$proof" ]; then
		:
	else
		printf '%s\n' 'cannot create transfer proof hardlink' >&2
		rm -f -- "$stage"
		exit 1
	fi
fi
${commit}
if [ -L "$destination" ] || [ ! "$destination" -ef "$proof" ]; then
	printf '%s\\n' 'destination identity does not match transfer proof' >&2
	exit 1
fi
${buildPosixUploadAcknowledgementScript()}
`;
}

const POWERSHELL_TRANSFER_NATIVE = `
if (-not ('OmpSshTransferNative' -as [type])) {
	Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class OmpSshTransferNative {
	[StructLayout(LayoutKind.Sequential)]
	private struct ByHandleFileInformation {
		public uint FileAttributes;
		public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
		public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
		public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
		public uint VolumeSerialNumber;
		public uint FileSizeHigh;
		public uint FileSizeLow;
		public uint NumberOfLinks;
		public uint FileIndexHigh;
		public uint FileIndexLow;
	}

	[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
	private static extern SafeFileHandle CreateFileW(
		string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
	[DllImport("kernel32.dll", SetLastError = true)]
	private static extern bool GetFileInformationByHandle(
		SafeFileHandle handle, out ByHandleFileInformation information);
	[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
	private static extern bool MoveFileExW(string existingPath, string newPath, uint flags);
	[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
	private static extern bool ReplaceFileW(
		string replaced, string replacement, string backup, uint flags, IntPtr exclude, IntPtr reserved);

	private static ByHandleFileInformation Identity(string path) {
		using (SafeFileHandle handle = CreateFileW(
			path, 0x80, 0x7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
			if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
			ByHandleFileInformation information;
			if (!GetFileInformationByHandle(handle, out information)) {
				throw new Win32Exception(Marshal.GetLastWin32Error());
			}
			return information;
		}
	}

	public static bool SameFile(string left, string right) {
		ByHandleFileInformation a = Identity(left);
		ByHandleFileInformation b = Identity(right);
		return a.VolumeSerialNumber == b.VolumeSerialNumber
			&& a.FileIndexHigh == b.FileIndexHigh
			&& a.FileIndexLow == b.FileIndexLow;
	}

	public static void Move(string from, string to, bool replace) {
		uint flags = 0x8 | (replace ? 0x1u : 0u);
		if (!MoveFileExW(from, to, flags)) throw new Win32Exception(Marshal.GetLastWin32Error());
	}

	public static void Replace(string destination, string stage, string backup) {
		if (!ReplaceFileW(destination, stage, backup, 0x2, IntPtr.Zero, IntPtr.Zero)) {
			throw new Win32Exception(Marshal.GetLastWin32Error());
		}
	}
}
'@
}
`;

function buildPowerShellUploadAcknowledgementScript(): string {
	return `
[Console]::Out.WriteLine('${SSH_TRANSFER_COMMIT_MARKER}')
[Console]::Out.Flush()
$acknowledgement = [Console]::In.ReadLine()
if ($acknowledgement -eq 'ACK') {
	if (-not [OmpSshTransferNative]::SameFile($destination, $proof)) {
		throw 'destination identity changed after commit; transfer proof and backup are preserved'
	}
	foreach ($artifact in @($stage, $backup)) {
		if ($null -ne (Get-Item -LiteralPath $artifact -Force -ErrorAction SilentlyContinue)) {
			Remove-Item -LiteralPath $artifact -Force -ErrorAction Stop
		}
	}
	Remove-Item -LiteralPath $proof -Force -ErrorAction Stop
}
`;
}

function buildPowerShellUploadCommitScript(plan: SshFileTransferPlan, artifacts: RemoteTransferArtifacts): string {
	const overwriteCommit =
		plan.commitStrategy === "no-replace"
			? `
New-Item -ItemType HardLink -Path $destination -Target $stage -ErrorAction Stop | Out-Null
Remove-Item -LiteralPath $stage -Force -ErrorAction Stop
`
			: `
$item = Get-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
if ($null -eq $item) {
	[OmpSshTransferNative]::Move($stage, $destination, $false)
} elseif (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
	[OmpSshTransferNative]::Move($stage, $destination, $true)
} elseif ($item.PSIsContainer -or -not ($item -is [System.IO.FileInfo])) {
	throw 'destination is a directory or special file'
} else {
	[OmpSshTransferNative]::Replace($destination, $stage, $backup)
	$old = Get-Item -LiteralPath $backup -Force -ErrorAction Stop
	if ($old.PSIsContainer -and (($old.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0)) {
		throw 'destination became a directory or special file; displaced entry is preserved at backup'
	}
}
`;
	return wrapPowerShellTransferScript(`
${POWERSHELL_TRANSFER_NATIVE}
$stage = ${quotePowerShellString(artifacts.stagePath)}
$proof = ${quotePowerShellString(artifacts.proofPath)}
$backup = ${quotePowerShellString(artifacts.backupPath)}
$destination = ${quotePowerShellString(normalizePowerShellSshPath(plan.remotePath))}
$stageItem = Get-Item -LiteralPath $stage -Force -ErrorAction Stop
if ($stageItem.PSIsContainer -or (($stageItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
	throw 'staged transfer is not a regular file'
}
if ($stageItem.Length -ne ${plan.totalBytes}) {
	Remove-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue
	throw 'staged transfer size does not match preflight'
}
if (-not (Test-Path -LiteralPath $proof)) {
	New-Item -ItemType HardLink -Path $proof -Target $stage -ErrorAction Stop | Out-Null
} elseif (-not [OmpSshTransferNative]::SameFile($stage, $proof)) {
	throw 'transfer proof exists but does not match the stage'
}
${overwriteCommit}
if (-not [OmpSshTransferNative]::SameFile($destination, $proof)) {
	throw 'destination identity does not match transfer proof'
}
${buildPowerShellUploadAcknowledgementScript()}
`);
}

function buildPosixUploadRecoveryScript(plan: SshFileTransferPlan, artifacts: RemoteTransferArtifacts): string {
	return `set -u
stage=${quotePosixArgument(artifacts.stagePath)}
proof=${quotePosixArgument(artifacts.proofPath)}
backup=${quotePosixArgument(artifacts.backupPath)}
destination=${quotePosixArgument(plan.remotePath)}
proof_state=missing
backup_state=missing
stage_state=missing
destination_state=missing
if [ -e "$proof" ] || [ -L "$proof" ]; then proof_state=present; fi
if [ -e "$backup" ] || [ -L "$backup" ]; then backup_state=present; fi
if [ -e "$stage" ] || [ -L "$stage" ]; then stage_state=present; fi
if [ -e "$destination" ] || [ -L "$destination" ]; then destination_state=different; fi
if [ -f "$proof" ] && [ ! -L "$proof" ]; then
	if [ ! -L "$stage" ] && [ "$stage" -ef "$proof" ]; then stage_state=uploaded; fi
	if [ ! -L "$destination" ] && [ "$destination" -ef "$proof" ]; then destination_state=uploaded; fi
fi
printf '${SSH_TRANSFER_STATE_MARKER}%s|%s|%s|%s\\n' "$destination_state" "$stage_state" "$proof_state" "$backup_state"
if [ "$destination_state" = uploaded ]; then
	if [ "$stage_state" = present ] && [ ! -f "$stage" ] && [ ! -L "$stage" ]; then
		printf '%s\\n' 'displaced directory or special file is preserved at stage; recovery left the destination unchanged' >&2
		exit 1
	fi
	${buildPosixUploadAcknowledgementScript()}
fi
exit 0
`;
}

function buildPowerShellUploadRecoveryScript(plan: SshFileTransferPlan, artifacts: RemoteTransferArtifacts): string {
	return wrapPowerShellTransferScript(`
${POWERSHELL_TRANSFER_NATIVE}
$stage = ${quotePowerShellString(artifacts.stagePath)}
$proof = ${quotePowerShellString(artifacts.proofPath)}
$backup = ${quotePowerShellString(artifacts.backupPath)}
$destination = ${quotePowerShellString(normalizePowerShellSshPath(plan.remotePath))}
function Get-TransferEntry([string]$entryPath) {
	try {
		return Get-Item -LiteralPath $entryPath -Force -ErrorAction Stop
	} catch [System.Management.Automation.ItemNotFoundException] {
		return $null
	}
}
$proofItem = Get-TransferEntry $proof
$stageItem = Get-TransferEntry $stage
$backupItem = Get-TransferEntry $backup
$destinationItem = Get-TransferEntry $destination
$proofState = if ($null -eq $proofItem) { 'missing' } else { 'present' }
$backupState = if ($null -eq $backupItem) { 'missing' } else { 'present' }
$stageState = if ($null -eq $stageItem) { 'missing' } else { 'present' }
$destinationState = if ($null -eq $destinationItem) { 'missing' } else { 'different' }
if ($null -ne $proofItem -and -not $proofItem.PSIsContainer -and (($proofItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0)) {
	if ($null -ne $stageItem -and [OmpSshTransferNative]::SameFile($stage, $proof)) {
		$stageState = 'uploaded'
	}
	if ($null -ne $destinationItem -and [OmpSshTransferNative]::SameFile($destination, $proof)) {
		$destinationState = 'uploaded'
	}
}
[Console]::Out.WriteLine("${SSH_TRANSFER_STATE_MARKER}$destinationState|$stageState|$proofState|$backupState")
[Console]::Out.Flush()
if ($destinationState -eq 'uploaded') {
	if ($null -ne $backupItem -and $backupItem.PSIsContainer -and (($backupItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0)) {
		throw 'displaced directory or special file is preserved at backup; recovery left the destination unchanged'
	}
	${buildPowerShellUploadAcknowledgementScript()}
}
`);
}

function buildRemoteArtifactCleanupCommand(mode: RemoteTransferMode, artifacts: RemoteTransferArtifacts): string {
	if (mode.kind === "posix") {
		return wrapInPosixShell(
			mode.shell,
			`rm -f -- ${quotePosixArgument(artifacts.stagePath)} ${quotePosixArgument(artifacts.proofPath)} ${quotePosixArgument(
				artifacts.backupPath,
			)}`,
		);
	}
	return buildPowerShellCommand(
		mode.executable,
		wrapPowerShellTransferScript(`
$artifacts = @(${quotePowerShellString(artifacts.stagePath)}, ${quotePowerShellString(
			artifacts.proofPath,
		)}, ${quotePowerShellString(artifacts.backupPath)})
foreach ($artifact in $artifacts) {
	if (Test-Path -LiteralPath $artifact -ErrorAction Stop) {
		Remove-Item -LiteralPath $artifact -Force -ErrorAction Stop
	}
}
`),
	);
}

interface SshCommitAttemptResult {
	markerSeen: boolean;
	preservation?: SshTransferPreservationState;
	error?: Error;
}

interface SshTransferPreservationState {
	destination: "uploaded" | "different" | "missing";
	stage: "uploaded" | "present" | "missing";
	proof: "present" | "missing";
	backup: "present" | "missing";
}

function parseTransferPreservationState(output: string): SshTransferPreservationState | undefined {
	const match = output.match(
		/(?:^|\n)OMP_TRANSFER_STATE (uploaded|different|missing)\|(uploaded|present|missing)\|(present|missing)\|(present|missing)\r?(?:\n|$)/,
	);
	if (!match) return undefined;
	return {
		destination: match[1] as SshTransferPreservationState["destination"],
		stage: match[2] as SshTransferPreservationState["stage"],
		proof: match[3] as SshTransferPreservationState["proof"],
		backup: match[4] as SshTransferPreservationState["backup"],
	};
}

async function runUploadCommitAttempt(
	plan: SshFileTransferPlan,
	mode: RemoteTransferMode,
	artifacts: RemoteTransferArtifacts,
	timeoutMs?: number,
	recovery = false,
): Promise<SshCommitAttemptResult> {
	const script =
		mode.kind === "posix"
			? wrapInPosixShell(
					mode.shell,
					recovery
						? buildPosixUploadRecoveryScript(plan, artifacts)
						: buildPosixUploadCommitScript(plan, artifacts),
				)
			: buildPowerShellCommand(
					mode.executable,
					recovery
						? buildPowerShellUploadRecoveryScript(plan, artifacts)
						: buildPowerShellUploadCommitScript(plan, artifacts),
				);
	const invocation = await buildRemoteCommandInvocation(plan.target, script, { allowStdin: true });
	const commitTimeoutMs =
		timeoutMs ??
		(mode.kind === "powershell" ? SSH_TRANSFER_COMMIT_POWERSHELL_TIMEOUT_MS : SSH_TRANSFER_COMMIT_POSIX_TIMEOUT_MS);
	let markerSeen = false;
	let preservation: SshTransferPreservationState | undefined;
	try {
		using child = ptree.spawn([invocation.executable ?? "ssh", ...invocation.args], {
			stdin: "pipe",
			signal: ptree.combineSignals(commitTimeoutMs - 1_000),
			env: invocation.env,
		});
		const reader = child.stdout.getReader();
		const decoder = new TextDecoder();
		let output = "";
		let acknowledgementSent = false;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				output = `${output}${decoder.decode(value, { stream: true })}`.slice(-8192);
				preservation = parseTransferPreservationState(output) ?? preservation;
				if (!acknowledgementSent && /(?:^|\n)OMP_TRANSFER_COMMITTED\r?\n/.test(output)) {
					markerSeen = true;
					const acknowledgement = new TextEncoder().encode("ACK\n");
					let offset = 0;
					while (offset < acknowledgement.byteLength) {
						const accepted = await child.stdin.write(acknowledgement.subarray(offset));
						if (!Number.isFinite(accepted) || accepted <= 0) {
							throw new Error("SSH transfer commit acknowledgement accepted zero bytes");
						}
						offset += accepted;
					}
					await child.stdin.end();
					acknowledgementSent = true;
				}
			}
			output = `${output}${decoder.decode()}`.slice(-8192);
			preservation = parseTransferPreservationState(output) ?? preservation;
			if (!acknowledgementSent) await child.stdin.end();
			await child.exitedCleanly;
			if (!markerSeen && /(?:^|\n)OMP_TRANSFER_COMMITTED\r?(?:\n|$)/.test(output)) markerSeen = true;
			return markerSeen
				? { markerSeen: true, preservation }
				: {
						markerSeen: false,
						preservation,
						error: new Error("SSH transfer completion was not confirmed by an identity marker"),
					};
		} catch (error) {
			await terminateTransferStageChild(child);
			let message = error instanceof Error ? error.message : String(error);
			if (!message.includes("stderr")) {
				const tail = typeof child.peekStderr === "function" ? child.peekStderr().slice(0, 512) : "";
				if (tail.length > 0) message = `${message}; remote stderr: ${tail}`;
			}
			const commitError =
				error instanceof Error && message === error.message ? error : new Error(message, { cause: error });
			return {
				markerSeen,
				preservation,
				error: commitError,
			};
		} finally {
			reader.releaseLock();
		}
	} finally {
		await invocation.cleanup?.();
	}
}

async function cleanupRemoteTransferArtifacts(
	target: SSHConnectionTarget,
	mode: RemoteTransferMode,
	artifacts: RemoteTransferArtifacts,
	timeoutMs: number,
): Promise<void> {
	const invocation = await buildRemoteCommandInvocation(target, buildRemoteArtifactCleanupCommand(mode, artifacts));
	try {
		using child = ptree.spawn([invocation.executable ?? "ssh", ...invocation.args], {
			signal: ptree.combineSignals(timeoutMs),
			env: invocation.env,
		});
		await child.bytes();
		await child.exitedCleanly;
	} finally {
		await invocation.cleanup?.();
	}
}

export class SshFileTransferCancelledError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SshFileTransferCancelledError";
	}
}

function describeTransferError(error: unknown): string {
	if (error instanceof Error) {
		if (error instanceof ptree.NonZeroExitError && error.exitCode === 255) {
			return (
				`${error.message} SSH transport exited with status 255; its stderr may identify an intermediate ` +
				"jump/proxy host and does not by itself establish that the destination host is unavailable."
			);
		}
		return error.message;
	}
	return String(error);
}

async function executeUploadTransfer(
	plan: SshFileTransferPlan,
	mode: RemoteTransferMode,
	reporter: SshTransferProgressReporter,
	signal?: AbortSignal,
): Promise<void> {
	const artifacts = createRemoteTransferArtifacts(plan.remotePath, mode);
	try {
		await streamUploadStage(plan, mode, artifacts, reporter, signal);
	} catch (error) {
		if (!signal?.aborted) {
			throw new Error(
				`SSH upload staging failed (${describeTransferError(error)}); commit was not attempted and this transfer did not modify the destination. ` +
					`Local source was not modified: ${plan.localPath}. ` +
					`Remote stage was not deleted: ${plan.target.name}:${artifacts.stagePath} ` +
					`(${reporter.transferredBytes} of ${plan.totalBytes} bytes acknowledged). ` +
					"The stage may be partial or absent if the transport failed before creation; its remote presence could not be confirmed. " +
					"Inspect it against the source before manual recovery, or remove it when no longer needed.",
				{ cause: error },
			);
		}
		let cleanupError: unknown;
		try {
			await cleanupRemoteTransferArtifacts(
				plan.target,
				mode,
				artifacts,
				Math.max(1, SSH_TRANSFER_FINALIZE_MS - SSH_TRANSFER_STAGE_TERMINATE_MS),
			);
		} catch (caughtCleanupError) {
			cleanupError = caughtCleanupError;
		}
		const residual =
			cleanupError === undefined
				? " Partial upload artifacts were removed."
				: ` Cleanup failed; possible residual paths: ${artifacts.stagePath}, ${artifacts.proofPath}, ${
						artifacts.backupPath
					}. ${describeTransferError(cleanupError)}`;
		throw new SshFileTransferCancelledError(
			`SSH upload cancelled before commit; this transfer did not modify the destination.${residual}`,
			{ cause: error },
		);
	}

	if (signal?.aborted) {
		const cleanupStartedAt = Date.now();
		let cleanupError: unknown;
		try {
			await cleanupRemoteTransferArtifacts(
				plan.target,
				mode,
				artifacts,
				Math.max(1, SSH_TRANSFER_FINALIZE_MS - (Date.now() - cleanupStartedAt)),
			);
		} catch (error) {
			cleanupError = error;
		}
		const suffix =
			cleanupError === undefined
				? " Partial upload artifacts were removed."
				: ` Cleanup failed; possible residual paths: ${artifacts.stagePath}, ${artifacts.proofPath}, ${
						artifacts.backupPath
					}. ${describeTransferError(cleanupError)}`;
		throw new SshFileTransferCancelledError(
			`SSH upload cancelled before commit; this transfer did not modify the destination.${suffix}`,
		);
	}

	const attempt = await runUploadCommitAttempt(plan, mode, artifacts);
	if (attempt.error === undefined && attempt.markerSeen) return;
	// A commit may already have exchanged the stage with the old destination.
	// Replaying it could install that old file over an unrelated destination;
	// recovery inspects identity and never retries a replacement or rollback.
	let recovery: SshCommitAttemptResult;
	try {
		recovery = await runUploadCommitAttempt(plan, mode, artifacts, SSH_TRANSFER_RECOVERY_MS, true);
	} catch (recoveryError) {
		recovery = {
			markerSeen: false,
			error:
				recoveryError instanceof Error
					? recoveryError
					: new Error(describeTransferError(recoveryError), { cause: recoveryError }),
		};
	}
	if (recovery.error === undefined && recovery.markerSeen) return;
	const state = recovery.preservation;
	let preservation =
		"The current destination version and previous-destination preservation are unknown because recovery could not inspect them.";
	if (state) {
		let previous = "previous-destination preservation could not be established.";
		if (state.backup === "present") {
			previous = recovery.markerSeen
				? `a displaced destination backup was observed at ${artifacts.backupPath}; its preservation after acknowledgement is unknown.`
				: `recovery left the displaced destination backup untouched at ${artifacts.backupPath}.`;
		} else if (state.stage === "present") {
			previous = recovery.markerSeen
				? `a displaced or unrecognized stage was observed at ${artifacts.stagePath}; its preservation after acknowledgement is unknown.`
				: `recovery left a displaced or unrecognized stage untouched at ${artifacts.stagePath}; previous-destination identity is unknown.`;
		}
		preservation =
			`Recovery observed destination=${state.destination}, stage=${state.stage}, proof=${state.proof}, backup=${state.backup}; ` +
			previous;
	}
	const acknowledged = attempt.markerSeen || recovery.markerSeen;
	throw new Error(
		`SSH upload completion is uncertain (${attempt.error ? describeTransferError(attempt.error) : "final acknowledgement was lost"}); ` +
			`recovery did not settle (${recovery.error ? describeTransferError(recovery.error) : "identity was not confirmed"}). ` +
			(acknowledged
				? "The destination matched the uploaded file when the commit marker was emitted; final cleanup is unconfirmed. "
				: "") +
			`${preservation} Recovery never overwrites the destination. Local source is unchanged: ${plan.localPath}. ` +
			`Transfer artifact paths: ${artifacts.stagePath}, ${artifacts.proofPath}, ${artifacts.backupPath}`,
		{ cause: recovery.error ?? attempt.error },
	);
}

async function ensureDownloadParentDirectory(parent: string): Promise<void> {
	try {
		await fs.mkdir(parent, { recursive: true });
		return;
	} catch (error) {
		if (!isEexist(error)) throw error;
		try {
			if ((await fs.stat(parent)).isDirectory()) return;
		} catch {
			// Preserve mkdir's original EEXIST when the parent cannot be verified.
		}
		throw error;
	}
}

async function executeDownloadTransfer(
	plan: SshFileTransferPlan,
	mode: RemoteTransferMode,
	reporter: SshTransferProgressReporter,
	signal?: AbortSignal,
): Promise<void> {
	const parent = path.dirname(plan.localPath);
	await ensureDownloadParentDirectory(parent);
	const stagePath = path.join(parent, `.omp-transfer-${crypto.randomUUID()}.part`);
	let commitStarted = false;
	try {
		await streamDownloadStage(plan, mode, stagePath, reporter, signal);
		if (signal?.aborted) {
			throw new SshFileTransferCancelledError("SSH download cancelled before commit");
		}
		commitStarted = true;
		commitStagedFileAtomic(stagePath, plan.localPath, plan.overwrite);
	} catch (error) {
		const destinationState = commitStarted
			? "The atomic local commit failed; inspect its diagnostic for destination state."
			: "Commit was not attempted; this transfer did not modify the local destination.";
		const sourceState = `This transfer did not modify the remote source: ${plan.target.name}:${plan.remotePath}.`;
		if (signal?.aborted || error instanceof SshFileTransferCancelledError) {
			let cleanupError: unknown;
			try {
				await fs.rm(stagePath, { force: true });
			} catch (caughtCleanupError) {
				cleanupError = caughtCleanupError;
			}
			const cleanup =
				cleanupError === undefined
					? "Partial download was removed."
					: `Cleanup failed; possible residual path: ${stagePath}. ${describeTransferError(cleanupError)}`;
			throw new SshFileTransferCancelledError(
				`SSH download cancelled. ${destinationState} ${sourceState} ${cleanup}`,
				{
					cause: error,
				},
			);
		}
		let partialState: string;
		try {
			const stage = await fs.lstat(stagePath);
			if (stage.isFile() && stage.size === 0) {
				await fs.rm(stagePath);
				partialState = `Empty local stage was removed: ${stagePath}; no recoverable bytes remain.`;
			} else {
				partialState =
					`${commitStarted ? "Local staged file" : "Partial download"} retained at ${stagePath} ` +
					`(${stage.size} of ${plan.totalBytes} expected bytes). ` +
					"Inspect it against the source before manual recovery, or remove it when no longer needed.";
			}
		} catch (inspectionError) {
			partialState = isMissingFileSystemError(inspectionError)
				? `No local stage was found at ${stagePath}.`
				: `Local stage was not deleted; inspect ${stagePath}. Its state could not be determined: ${describeTransferError(inspectionError)}`;
		}
		throw new Error(
			`SSH download ${commitStarted ? "atomic commit failed" : "failed before commit"} (${describeTransferError(error)}). ` +
				`${destinationState} ${sourceState} ${partialState}`,
			{ cause: error },
		);
	}
}

export async function executeSshFileTransfer(
	plan: SshFileTransferPlan,
	options: SshFileTransferExecuteOptions = {},
): Promise<SshFileTransferProgress> {
	options.signal?.throwIfAborted();
	let mode: RemoteTransferMode;
	try {
		mode = await resolveRemoteTransferMode(plan.target);
	} catch (error) {
		const message =
			`SSH ${plan.operation} transport setup failed (${describeTransferError(error)}); staging was not started. ` +
			"This transfer did not modify the source or destination, and no partial file was created.";
		if (options.signal?.aborted) throw new SshFileTransferCancelledError(message, { cause: error });
		throw new Error(message, { cause: error });
	}
	options.signal?.throwIfAborted();
	const reporter = new SshTransferProgressReporter(plan.totalBytes, options.onProgress);
	reporter.emitInitial();
	try {
		if (plan.operation === "upload") {
			await executeUploadTransfer(plan, mode, reporter, options.signal);
		} else {
			await executeDownloadTransfer(plan, mode, reporter, options.signal);
		}
		return reporter.finish();
	} catch (error) {
		reporter.finish();
		throw error;
	}
}
