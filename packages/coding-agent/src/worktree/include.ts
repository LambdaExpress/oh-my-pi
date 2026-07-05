import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface WorktreeIncludeCopyResult {
	includedIgnoredPaths: string[];
	warnings: string[];
}

interface GitCommandOutput {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

function splitNul(text: string): string[] {
	return text.split("\0").filter(entry => entry.length > 0);
}

function isMissingFileError(err: unknown): boolean {
	return err instanceof Error && "code" in err && err.code === "ENOENT";
}

export function parseWorktreeInclude(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => line.length > 0 && !line.startsWith("#") && !line.startsWith("!"));
}

export function isSafeRelativePath(relativePath: string): boolean {
	if (relativePath.length === 0 || path.isAbsolute(relativePath)) return false;
	const normalized = path.normalize(relativePath);
	return normalized !== ".." && !normalized.startsWith(`..${path.sep}`);
}

export function resolveInside(root: string, relativePath: string): string {
	if (!isSafeRelativePath(relativePath)) throw new Error(`Refusing to handle unsafe path: ${relativePath}`);
	const absolute = path.resolve(root, relativePath);
	const back = path.relative(path.resolve(root), absolute);
	if (back === "" || back === ".." || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
		throw new Error(`Refusing to handle unsafe path: ${relativePath}`);
	}
	return absolute;
}

async function runGit(cwd: string, args: readonly string[]): Promise<GitCommandOutput> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		env: {
			...process.env,
			GIT_TERMINAL_PROMPT: "0",
			GIT_OPTIONAL_LOCKS: "0",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

async function ignoredPathsMatchingInclude(repoRoot: string, patterns: readonly string[]): Promise<string[]> {
	if (patterns.length === 0) return [];
	const result = await runGit(repoRoot, ["ls-files", "-o", "-i", "--exclude-standard", "-z", "--", ...patterns]);
	if (result.exitCode !== 0) {
		throw new Error(
			`Failed to read ignored files matched by .worktreeinclude: ${result.stderr.trim() || "git ls-files failed"}`,
		);
	}
	return splitNul(result.stdout).filter(isSafeRelativePath);
}

export async function readWorktreeInclude(repoRoot: string): Promise<string[]> {
	try {
		return parseWorktreeInclude(await Bun.file(path.join(repoRoot, ".worktreeinclude")).text());
	} catch (err) {
		if (isMissingFileError(err)) return [];
		throw err;
	}
}

async function rejectSymlinkSourceComponent(sourceRoot: string, relativePath: string): Promise<void> {
	const parts = path
		.normalize(relativePath)
		.split(/[\\/]+/)
		.filter(part => part.length > 0);
	let current = path.resolve(sourceRoot);
	for (const part of parts) {
		current = path.join(current, part);
		const stat = await fs.lstat(current);
		if (stat.isSymbolicLink()) throw new Error(`Skipping symlink path: ${relativePath}`);
	}
}

export async function copyRelativePath(
	sourceRoot: string,
	targetRoot: string,
	relativePath: string,
	options: { skipSymlink?: boolean; overwrite?: boolean } = {},
): Promise<void> {
	const source = resolveInside(sourceRoot, relativePath);
	const target = resolveInside(targetRoot, relativePath);
	if (options.skipSymlink) await rejectSymlinkSourceComponent(sourceRoot, relativePath);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.cp(source, target, {
		errorOnExist: !(options.overwrite ?? false),
		force: options.overwrite ?? false,
		preserveTimestamps: true,
		recursive: true,
		verbatimSymlinks: true,
	});
}

export async function copyIncludedIgnoredFiles(
	sourceRepoRoot: string,
	targetRepoRoot: string,
): Promise<WorktreeIncludeCopyResult> {
	const patterns = await readWorktreeInclude(sourceRepoRoot);
	const ignoredPaths = await ignoredPathsMatchingInclude(sourceRepoRoot, patterns);
	const includedIgnoredPaths: string[] = [];
	const warnings: string[] = [];
	for (const relativePath of ignoredPaths) {
		try {
			await copyRelativePath(sourceRepoRoot, targetRepoRoot, relativePath, { skipSymlink: true });
			includedIgnoredPaths.push(relativePath);
		} catch (err) {
			warnings.push(err instanceof Error ? err.message : `Failed to copy ${relativePath}`);
		}
	}
	return { includedIgnoredPaths, warnings };
}
