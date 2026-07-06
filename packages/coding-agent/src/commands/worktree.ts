/**
 * Manage Oh My Pi background worktrees under the configured worktree base.
 */
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import {
	addWorktree,
	branchWorktree,
	clearWorktrees,
	listWorktrees,
	mergeWorktree,
	pathWorktree,
	pruneWorktrees,
	removeWorktree,
	restoreWorktree,
	switchLocalWorktree,
	switchWorktree,
} from "../cli/worktree-cli";
import { Settings } from "../config/settings";
import type { ManagedWorktreeDirtyPolicy, ManagedWorktreeSessionStrategy } from "../worktree/types";

type WorktreeAction =
	| "list"
	| "add"
	| "switch"
	| "switch-local"
	| "merge"
	| "remove"
	| "prune"
	| "branch"
	| "path"
	| "restore"
	| "clear";

const WORKTREE_ACTIONS: WorktreeAction[] = [
	"list",
	"add",
	"switch",
	"switch-local",
	"merge",
	"remove",
	"prune",
	"branch",
	"path",
	"restore",
	"clear",
];
const DIRTY_POLICIES: ManagedWorktreeDirtyPolicy[] = ["ignore", "copy", "move"];
const SESSION_STRATEGIES: ManagedWorktreeSessionStrategy[] = ["none", "new", "fork"];

export default class Worktree extends Command {
	static description = "Manage Oh My Pi background worktrees (~/.omp/wt)";

	static aliases = ["wt"];

	static args = {
		// `list` (default) inspects the worktree dir; `clear` remains a
		// compatibility alias for orphan pruning.
		action: Args.string({
			description: "Worktree action",
			required: false,
			options: WORKTREE_ACTIONS,
			default: "list",
		}),
		targets: Args.string({
			description: "Action arguments: name, id/name, or branch name",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		all: Flags.boolean({
			description: "Prune every legacy cleanup candidate, including live PR-checkout worktrees (clear/prune)",
			default: false,
		}),
		base: Flags.string({
			description: "Base ref/branch-ish for creating a background worktree (add)",
		}),
		branch: Flags.string({
			description: "Branch name for `branch`, or base branch-ish for `add`",
		}),
		"branch-ish": Flags.string({
			description: "Alias for --base on add and --branch on branch",
		}),
		"dirty-policy": Flags.string({
			description: "How to handle current uncommitted changes when adding a background worktree",
			options: DIRTY_POLICIES,
			default: "ignore",
		}),
		"dry-run": Flags.boolean({
			char: "n",
			description: "Print what would be removed without touching the filesystem (clear/prune)",
			default: false,
		}),
		force: Flags.boolean({
			description: "Allow removing a permanent background worktree (remove)",
			default: false,
		}),
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON", default: false }),
		name: Flags.string({
			description: "Name for a new background worktree (add)",
		}),
		"recurse-submodules": Flags.boolean({
			description: "Initialize and manage submodules recursively when adding a background worktree",
			default: false,
		}),
		session: Flags.string({
			description: "Session strategy accepted for parity with interactive worktree actions",
			options: SESSION_STRATEGIES,
			default: "none",
		}),
	};

	static examples = [
		"omp worktree",
		"omp worktree list --json",
		"omp worktree add fix-auth --base main --dirty-policy copy",
		"omp worktree add fix-auth --recurse-submodules",
		"omp worktree switch fix-auth",
		"omp worktree switch-local fix-auth",
		"omp worktree path fix-auth --json",
		"omp worktree merge fix-auth",
		"omp worktree branch fix-auth feature/fix-auth",
		"omp worktree remove fix-auth --force",
		"omp worktree restore fix-auth",
		"omp worktree prune --dry-run",
		"omp worktree clear",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Worktree);
		const cwd = getProjectDir();
		// Load settings so the `worktree.base` override is applied before we scan
		// — otherwise this command would inspect ~/.omp/wt while the agent created
		// its worktrees under the configured base.
		await Settings.init({ cwd });

		const action = (args.action ?? "list") as WorktreeAction;
		const targets = Array.isArray(args.targets) ? args.targets : args.targets ? [args.targets] : [];
		const json = flags.json ?? false;

		switch (action) {
			case "list":
				await listWorktrees({ json });
				return;
			case "clear":
				await clearWorktrees({
					all: flags.all ?? false,
					dryRun: flags["dry-run"] ?? false,
					json,
				});
				return;
			case "prune":
				await pruneWorktrees({
					all: flags.all ?? false,
					dryRun: flags["dry-run"] ?? false,
					json,
				});
				return;
			case "add":
				await addWorktree({
					cwd,
					name: flags.name ?? (targets.length > 0 ? targets.join(" ") : undefined),
					baseRef: flags.base ?? flags["branch-ish"] ?? flags.branch,
					dirtyPolicy: parseDirtyPolicy(flags["dirty-policy"]),
					sessionStrategy: parseSessionStrategy(flags.session),
					json,
					recurseSubmodules: flags["recurse-submodules"] ?? false,
				});
				return;
			case "switch":
				await switchWorktree({ cwd, idOrName: requireTarget(action, targets), json });
				return;
			case "switch-local":
				await switchLocalWorktree({ cwd, idOrName: requireTarget(action, targets), json });
				return;
			case "path":
				await pathWorktree({ cwd, idOrName: requireTarget(action, targets), json });
				return;
			case "merge":
				await mergeWorktree({ cwd, idOrName: requireTarget(action, targets), json });
				return;
			case "remove":
				await removeWorktree({ cwd, idOrName: requireTarget(action, targets), force: flags.force ?? false, json });
				return;
			case "branch":
				await branchWorktree({
					cwd,
					idOrName: requireTarget(action, targets),
					branch: flags.branch ?? flags["branch-ish"] ?? requireBranch(targets),
					json,
				});
				return;
			case "restore":
				await restoreWorktree({ cwd, idOrName: requireTarget(action, targets), json });
				return;
		}
	}
}

function requireTarget(action: WorktreeAction, targets: readonly string[]): string {
	const target = targets[0];
	if (!target) throw new Error(`Usage: omp worktree ${action} <id|name>`);
	return target;
}

function requireBranch(targets: readonly string[]): string {
	const branch = targets[1];
	if (!branch) throw new Error("Usage: omp worktree branch <id|name> <branch>");
	return branch;
}

function parseDirtyPolicy(value: string | undefined): ManagedWorktreeDirtyPolicy {
	if (value === "ignore" || value === "copy" || value === "move") return value;
	return "ignore";
}

function parseSessionStrategy(value: string | undefined): ManagedWorktreeSessionStrategy {
	if (value === "none" || value === "new" || value === "fork") return value;
	return "none";
}
