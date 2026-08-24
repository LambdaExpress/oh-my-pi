/**
 * Git data model for the `omp git` fullscreen TUI.
 *
 * Owns porcelain status parsing into staged/unstaged file lists, HEAD commit
 * metadata for the clean-tree view, per-file old/new content resolution for
 * the split diff pane, and the staging/commit actions the sidebar triggers.
 */
import * as path from "node:path";
import { parseNumstat } from "../../commit/git/diff";
import * as git from "../../utils/git";

/** SHA of git's canonical empty tree: diff base for a root commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** Files larger than this render as a placeholder instead of a diff. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export type ChangeKind = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
export type ChangeArea = "unstaged" | "staged" | "commit";

/** One changed path shown in the sidebar file lists. */
export interface ChangedFile {
	readonly path: string;
	/** Pre-rename path for renames/copies. */
	readonly origPath?: string;
	readonly kind: ChangeKind;
	readonly area: ChangeArea;
	readonly additions?: number;
	readonly deletions?: number;
}

/** HEAD commit metadata for the clean-tree sidebar view. */
export interface HeadCommit {
	readonly sha: string;
	readonly shortSha: string;
	readonly subject: string;
	readonly body: string;
	readonly authorName: string;
	readonly authorEmail: string;
	readonly authorDate: string;
	readonly parents: readonly string[];
	readonly files: readonly ChangedFile[];
}

/** Old/new sides of a file for the split diff pane. */
export interface FileContents {
	readonly oldText: string;
	readonly newText: string;
	readonly binary: boolean;
	readonly tooLarge: boolean;
}

function kindFromLetter(letter: string): ChangeKind {
	switch (letter) {
		case "A":
			return "added";
		case "D":
			return "deleted";
		case "R":
		case "C":
			return "renamed";
		case "U":
			return "conflicted";
		default:
			return "modified";
	}
}

const CONFLICT_STATES: Record<string, true> = { DD: true, AU: true, UD: true, UA: true, DU: true, AA: true, UU: true };

/**
 * Repository state backing the git TUI. `refresh()` re-reads everything and
 * returns whether the observable state changed since the previous refresh.
 */
export class GitModel {
	readonly cwd: string;
	/** Resolved SHA when the TUI is pinned to one commit (`omp git <rev>`). */
	readonly pinnedSha: string | null;
	branch: string | null = null;
	unstaged: ChangedFile[] = [];
	staged: ChangedFile[] = [];
	headCommit: HeadCommit | null = null;
	#fingerprint = "";

	constructor(cwd: string, options: { pinnedSha?: string } = {}) {
		this.cwd = cwd;
		this.pinnedSha = options.pinnedSha ?? null;
	}

	/** True when the working tree and index carry no changes. */
	get clean(): boolean {
		return this.unstaged.length === 0 && this.staged.length === 0;
	}

	/** Re-read status, branch, numstats, and HEAD metadata. True when anything changed. */
	async refresh(): Promise<boolean> {
		if (this.pinnedSha) {
			if (this.#fingerprint === this.pinnedSha) return false;
			this.#fingerprint = this.pinnedSha;
			this.headCommit = await this.#loadHeadCommit(this.pinnedSha);
			return true;
		}
		const [statusText, branchName, headSha] = await Promise.all([
			git.status(this.cwd, { porcelainV1: true, z: true, untrackedFiles: "all" }).catch(() => null),
			git.branch.current(this.cwd).catch(() => null),
			git.head.sha(this.cwd).catch(() => null),
		]);
		if (statusText === null) throw new Error("Not a git repository");
		const fingerprint = `${headSha ?? ""}\u0000${statusText}`;
		if (fingerprint === this.#fingerprint) {
			this.branch = branchName;
			return false;
		}
		this.#fingerprint = fingerprint;
		this.branch = branchName;

		const [unstagedStat, stagedStat] = await Promise.all([
			git.diff(this.cwd, { numstat: true, allowFailure: true }).then(parseNumstat),
			git.diff(this.cwd, { numstat: true, cached: true, allowFailure: true }).then(parseNumstat),
		]);
		const unstagedCounts = new Map(unstagedStat.map(entry => [entry.path, entry]));
		const stagedCounts = new Map(stagedStat.map(entry => [entry.path, entry]));

		const unstaged: ChangedFile[] = [];
		const staged: ChangedFile[] = [];
		const tokens = statusText.split("\0");
		for (let i = 0; i < tokens.length; i++) {
			const record = tokens[i];
			if (record.length < 4) continue;
			const x = record[0];
			const y = record[1];
			const filePath = record.slice(3);
			// In `-z` output a rename/copy record is followed by the original path
			// as its own NUL-separated token.
			const origPath = x === "R" || x === "C" ? tokens[++i] : undefined;
			if (x === "?" && y === "?") {
				unstaged.push({ path: filePath, kind: "untracked", area: "unstaged" });
				continue;
			}
			if (CONFLICT_STATES[`${x}${y}`]) {
				unstaged.push({ path: filePath, kind: "conflicted", area: "unstaged" });
				continue;
			}
			if (x !== " ") {
				const counts = stagedCounts.get(filePath);
				staged.push({
					path: filePath,
					origPath,
					kind: kindFromLetter(x),
					area: "staged",
					additions: counts?.additions,
					deletions: counts?.deletions,
				});
			}
			if (y !== " ") {
				const counts = unstagedCounts.get(filePath);
				unstaged.push({
					path: filePath,
					kind: kindFromLetter(y),
					area: "unstaged",
					additions: counts?.additions,
					deletions: counts?.deletions,
				});
			}
		}
		this.unstaged = unstaged;
		this.staged = staged;

		this.headCommit = headSha ? await this.#loadHeadCommit(headSha) : null;
		return true;
	}

	async #loadHeadCommit(sha: string): Promise<HeadCommit | null> {
		try {
			const details = await git.commitDetails(this.cwd, sha);
			const base = details.parents[0] ?? EMPTY_TREE;
			const numstat = parseNumstat(await git.diff(this.cwd, { numstat: true, base, head: sha, allowFailure: true }));
			const [subject = "", ...bodyLines] = details.message.split("\n");
			return {
				sha,
				shortSha: sha.slice(0, 8),
				subject,
				body: bodyLines.join("\n").trim(),
				authorName: details.author.name,
				authorEmail: details.author.email,
				authorDate: details.author.date ?? "",
				parents: details.parents,
				files: numstat.map(entry => ({
					path: entry.path,
					kind: entry.additions > 0 && entry.deletions === 0 ? "added" : "modified",
					area: "commit" as const,
					additions: entry.additions,
					deletions: entry.deletions,
				})),
			};
		} catch {
			return null;
		}
	}

	/** Resolve the old/new text of `file` for its area (index vs HEAD vs worktree). */
	async contents(file: ChangedFile): Promise<FileContents> {
		let oldText = "";
		let newText = "";
		let tooLarge = false;
		switch (file.area) {
			case "unstaged": {
				if (file.kind !== "untracked") {
					oldText = await this.#showFile(`:0:${file.path}`);
				}
				({ text: newText, tooLarge } = await this.#readWorktree(file.path));
				break;
			}
			case "staged": {
				oldText = await this.#showFile(`HEAD:${file.origPath ?? file.path}`);
				newText = await this.#showFile(`:0:${file.path}`);
				break;
			}
			case "commit": {
				const head = this.headCommit;
				if (head) {
					const base = head.parents[0];
					if (base) oldText = await this.#showFile(`${base}:${file.origPath ?? file.path}`);
					newText = await this.#showFile(`${head.sha}:${file.path}`);
				}
				break;
			}
		}
		const binary = oldText.includes("\0") || newText.includes("\0");
		return { oldText, newText, binary, tooLarge };
	}

	async #showFile(spec: string): Promise<string> {
		try {
			return await git.show(this.cwd, spec);
		} catch {
			return "";
		}
	}

	async #readWorktree(filePath: string): Promise<{ text: string; tooLarge: boolean }> {
		try {
			const handle = Bun.file(path.join(this.cwd, filePath));
			if (handle.size > MAX_FILE_BYTES) return { text: "", tooLarge: true };
			return { text: await handle.text(), tooLarge: false };
		} catch {
			return { text: "", tooLarge: false };
		}
	}

	/** Stage one file (or everything when `file` is omitted). */
	async stage(file?: ChangedFile): Promise<void> {
		await git.stage.files(this.cwd, file ? [file.path] : []);
	}

	/** Unstage one file (or everything when `file` is omitted). */
	async unstage(file?: ChangedFile): Promise<void> {
		await git.stage.reset(this.cwd, file ? [file.path] : []);
	}

	/** Create (or amend) a commit from the staged changes. */
	async commit(message: string, options: { amend?: boolean } = {}): Promise<void> {
		await git.commit(this.cwd, message, { amend: options.amend });
	}
	/** Apply a patch to the index (`cached`) and/or worktree; `reverse` undoes it. */
	async applyPatch(patchText: string, options: { cached?: boolean; reverse?: boolean } = {}): Promise<void> {
		await git.patch.applyText(this.cwd, patchText, options);
	}
}
