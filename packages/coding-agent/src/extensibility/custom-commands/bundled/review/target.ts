import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { t } from "../../../../i18n";
import { parseReviewDiffSnapshot, type ReviewDiffSnapshot } from "./diff";

export type LocalReviewKind = "base-branch" | "uncommitted" | "commit";

/** One frozen diff: the annotation view and the reviewer prompt both read this snapshot. */
export interface ResolvedReviewTarget {
	kind: LocalReviewKind | "pr";
	mode: string;
	rawDiff: string;
	snapshot: ReviewDiffSnapshot;
	emptyMessage: string;
	filteredMessage?: string;
	diffInstruction?: string;
	contextInstruction?: string;
}

export interface ReviewTargetUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** Labels are accessors so a language change is picked up without reloading this module. */
export const LOCAL_REVIEW_CHOICES: ReadonlyArray<{ label: string; kind: LocalReviewKind }> = [
	{
		get label() {
			return t("1. Review against a base branch (PR Style)");
		},
		kind: "base-branch",
	},
	{
		get label() {
			return t("2. Review uncommitted changes");
		},
		kind: "uncommitted",
	},
	{
		get label() {
			return t("3. Review a specific commit");
		},
		kind: "commit",
	},
];

const GIT_UNCOMMITTED_DIFF_INSTRUCTION =
	"MUST run both `git diff -- <path>` and `git diff --cached -- <path>` for assigned files";
const JJ_UNCOMMITTED_DIFF_INSTRUCTION = "MUST run `jj --ignore-working-copy diff --git -- <path>` for assigned files";

export function createResolvedReviewTarget(
	kind: ResolvedReviewTarget["kind"],
	mode: string,
	rawDiff: string,
	emptyMessage: string,
	options: Pick<ResolvedReviewTarget, "filteredMessage" | "diffInstruction" | "contextInstruction"> = {},
): ResolvedReviewTarget {
	return {
		kind,
		mode,
		rawDiff,
		snapshot: parseReviewDiffSnapshot(rawDiff),
		emptyMessage,
		...options,
	};
}

export function getReviewTargetIssue(target: ResolvedReviewTarget): string | undefined {
	if (!target.rawDiff.trim()) return target.emptyMessage;
	if (target.snapshot.files.length === 0) {
		return target.filteredMessage ?? t("No reviewable files (all changes filtered out)");
	}
	return undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Read staged + unstaged (or jj working-copy) changes; throws when no repository is available. */
export async function readUncommittedReviewTarget(cwd: string): Promise<ResolvedReviewTarget> {
	const repository = vcs.require(cwd);
	const diffText = await repository.uncommittedDiff([]);
	const isJj = repository.kind() === "jj";
	return createResolvedReviewTarget(
		"uncommitted",
		isJj ? "Reviewing JJ working-copy changes" : "Reviewing uncommitted changes (staged + unstaged)",
		diffText,
		isJj || !diffText.trim() ? t("No uncommitted changes found") : t("No diff content found"),
		{ diffInstruction: isJj ? JJ_UNCOMMITTED_DIFF_INSTRUCTION : GIT_UNCOMMITTED_DIFF_INSTRUCTION },
	);
}

async function listGitBranches(cwd: string): Promise<string[]> {
	try {
		return await vcs.requireGit(cwd).listBranches(true);
	} catch {
		return [];
	}
}

async function currentGitBranch(cwd: string): Promise<string> {
	try {
		return (await vcs.git(cwd)?.currentBranch()) ?? "HEAD";
	} catch {
		return "HEAD";
	}
}

async function recentCommits(cwd: string, count: number): Promise<string[]> {
	try {
		return await vcs.require(cwd).logOnelines(count);
	} catch {
		return [];
	}
}

export async function resolveLocalReviewTarget(
	kind: LocalReviewKind,
	cwd: string,
	ui: ReviewTargetUI,
): Promise<ResolvedReviewTarget | undefined> {
	switch (kind) {
		case "base-branch": {
			const branches = await listGitBranches(cwd);
			if (branches.length === 0) {
				ui.notify(t("No git branches found"), "error");
				return undefined;
			}
			const baseBranch = await ui.select(t("Select base branch to compare against"), branches);
			if (!baseBranch) return undefined;
			const currentBranch = await currentGitBranch(cwd);
			let diffText: string;
			try {
				const repository = vcs.requireGit(cwd);
				// PR-style review compares the merge base against the current
				// branch (`base...head`), so base-only commits are excluded.
				const mergeBase = await repository.mergeBase(baseBranch, currentBranch);
				if (!mergeBase) {
					// No common ancestor: `git diff base...head` aborts here
					// rather than comparing unrelated trees tip-to-tip.
					ui.notify(
						t("No common history between {baseBranch} and {currentBranch}", {
							baseBranch,
							currentBranch,
						}),
						"error",
					);
					return undefined;
				}
				diffText = await repository.diffText({ base: mergeBase, head: currentBranch });
			} catch (error) {
				ui.notify(
					t("Failed to get diff: {error}", {
						error: errorMessage(error),
					}),
					"error",
				);
				return undefined;
			}
			return createResolvedReviewTarget(
				"base-branch",
				`Reviewing changes between \`${baseBranch}\` and \`${currentBranch}\` (PR-style)`,
				diffText,
				`No changes between ${baseBranch} and ${currentBranch}`,
			);
		}
		case "uncommitted":
			try {
				return await readUncommittedReviewTarget(cwd);
			} catch (error) {
				ui.notify(
					t("Failed to get diff: {error}", {
						error: errorMessage(error),
					}),
					"error",
				);
				return undefined;
			}
		case "commit": {
			const commits = await recentCommits(cwd, 20);
			if (commits.length === 0) {
				ui.notify(t("No commits found"), "error");
				return undefined;
			}
			const selectedCommit = await ui.select(t("Select commit to review"), commits);
			if (!selectedCommit) return undefined;
			const hash = selectedCommit.split(" ")[0];
			let diffText: string;
			try {
				diffText = (await vcs.requireGit(cwd).showCommit(hash)).data.toString("utf8");
			} catch (error) {
				ui.notify(
					t("Failed to get commit: {error}", {
						error: errorMessage(error),
					}),
					"error",
				);
				return undefined;
			}
			return createResolvedReviewTarget(
				"commit",
				`Reviewing commit \`${hash}\``,
				diffText,
				t("Commit has no diff content"),
				{
					filteredMessage: t("No reviewable files in commit (all changes filtered out)"),
				},
			);
		}
	}
}
