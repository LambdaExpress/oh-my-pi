/**
 * Byte-preserving remote file I/O over the shared SSH ControlMaster connection.
 *
 * Unlike `executeSSH` (which truncates/sanitizes through an OutputSink) and
 * `runSshCaptureSync` (which `.trim()`s output), these helpers move raw bytes so
 * `ssh://` reads/writes round-trip exactly — leading/trailing whitespace, tabs,
 * and final newlines are preserved.
 */
import { ptree } from "@oh-my-pi/pi-utils";
import {
	buildPowerShellCommand,
	buildRemoteCommand,
	ensureConnection,
	ensureHostInfo,
	type SSHConnectionTarget,
	type SSHPowerShellCommand,
} from "./connection-manager";
import { quotePosixPath, quotePowerShellString, wrapInPosixShell } from "./utils";

/** Per-operation timeout for remote transfers (matches the ssh tool's grep window). */
const DEFAULT_TIMEOUT_MS = 30_000;

type RemoteTransferMode =
	| { kind: "posix"; shell: "sh" | "bash" | "zsh" }
	| { kind: "powershell"; executable: SSHPowerShellCommand };

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
			`ssh://: ${target.name} is a Windows host without a verified PowerShell transfer backend — use the ssh tool for cmd-only hosts`,
		);
	}
	if (!info.transferShell) {
		throw new Error(
			`ssh://: ${target.name} has no verified POSIX shell for ssh:// read/write — none of sh/bash/zsh round-tripped a capability probe (use the ssh tool for this host)`,
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
	const args = await buildRemoteCommand(
		target,
		buildPowerShellCommand(executable, script),
		opts.allowStdin ? { allowStdin: true } : undefined,
	);
	const signal = ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const spawnOptions = opts.stdin ? { stdin: opts.stdin, signal } : { signal };
	using child = ptree.spawn(["ssh", ...args], spawnOptions);
	const raw = await child.bytes();
	await child.exitedCleanly;
	return raw;
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
		const command = `head -c ${opts.maxBytes + 1} ${quotePosixPath(remotePath)}`;
		const args = await buildRemoteCommand(target, wrapInPosixShell(mode.shell, command));
		using child = ptree.spawn(["ssh", ...args], {
			signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		});
		// Drain stdout before awaiting exit so a full pipe can't deadlock the child.
		raw = await child.bytes();
		await child.exitedCleanly;
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
		const dest = quotePosixPath(remotePath);
		const tmp = quotePosixPath(`${remotePath}.omp-tmp.${crypto.randomUUID()}`);
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
		const args = await buildRemoteCommand(target, wrapInPosixShell(mode.shell, command), { allowStdin: true });
		using child = ptree.spawn(["ssh", ...args], {
			stdin: content,
			signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		});
		await child.exitedCleanly;
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
		const p = quotePosixPath(remotePath);
		const command =
			`if [ -d ${p} ]; then echo 'ssh://: cannot delete directory' >&2; exit 1; ` +
			`elif [ -e ${p} ] || [ -L ${p} ]; then rm -f -- ${p}; ` +
			`else echo 'ssh://: file does not exist' >&2; exit 1; fi`;
		const args = await buildRemoteCommand(target, wrapInPosixShell(mode.shell, command));
		using child = ptree.spawn(["ssh", ...args], {
			signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		});
		await child.exitedCleanly;
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
		const from = quotePosixPath(fromRemotePath);
		const to = quotePosixPath(toRemotePath);
		const command =
			`if [ -d ${from} ]; then echo 'ssh://: source is a directory' >&2; exit 1; ` +
			`elif [ -e ${from} ] || [ -L ${from} ]; then ` +
			`if [ -d ${to} ]; then echo 'ssh://: destination is a directory' >&2; exit 1; fi; ` +
			`mv -- ${from} ${to}; ` +
			`else echo 'ssh://: source does not exist' >&2; exit 1; fi`;
		const args = await buildRemoteCommand(target, wrapInPosixShell(mode.shell, command));
		using child = ptree.spawn(["ssh", ...args], {
			signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		});
		await child.exitedCleanly;
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
		const p = quotePosixPath(remotePath);
		const command = `if [ -d ${p} ]; then echo directory; elif [ -f ${p} ]; then echo file; elif [ -e ${p} ]; then echo other; else echo missing; fi`;
		const args = await buildRemoteCommand(target, wrapInPosixShell(mode.shell, command));
		using child = ptree.spawn(["ssh", ...args], {
			signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		});
		const out = new TextDecoder().decode(await child.bytes()).trim();
		await child.exitedCleanly;
		return out === "directory" || out === "file" || out === "other" ? out : "missing";
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
		const command = `LC_ALL=C ls -1Ap -- ${quotePosixPath(remotePath)}`;
		const args = await buildRemoteCommand(target, wrapInPosixShell(mode.shell, command));
		using child = ptree.spawn(["ssh", ...args], {
			signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		});
		text = new TextDecoder().decode(await child.bytes());
		await child.exitedCleanly;
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
