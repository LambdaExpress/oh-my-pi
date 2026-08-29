/**
 * Bootstrap-safe top-level command identities.
 *
 * Keep this module free of runtime imports. Profile selection imports it before
 * modules such as settings or env are allowed to observe the agent directory.
 */

export const COMMAND_NAMES = [
	"launch",
	"acp",
	"auth-broker",
	"auth-gateway",
	"agents",
	"bench",
	"browser-relay",
	"cleanse",
	"commit",
	"completions",
	"__complete",
	"compress",
	"config",
	"dry-balance",
	"gc",
	"grep",
	"gallery",
	"git",
	"grievances",
	"images",
	"if-bench",
	"install",
	"join",
	"models",
	"plugin",
	"ps",
	"say",
	"share",
	"setup",
	"shell",
	"read",
	"render",
	"ssh",
	"stats",
	"update",
	"usage",
	"tiny-models",
	"token",
	"ttsr",
	"worktree",
	"search",
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

const COMMAND_ALIASES: Partial<Record<CommandName, readonly string[]>> = {
	images: ["img"],
	worktree: ["wt"],
	search: ["q"],
};

export interface CommandIdentity {
	name: CommandName;
	aliases?: string[];
}

/** Return the canonical identity consumed by the full command registry. */
export function commandIdentity(name: CommandName): CommandIdentity {
	const aliases = COMMAND_ALIASES[name];
	return aliases ? { name, aliases: [...aliases] } : { name };
}

const SUBCOMMAND_WORDS = new Set<string>([
	...COMMAND_NAMES,
	...Object.values(COMMAND_ALIASES).flatMap(aliases => aliases ?? []),
]);

/** Return true when `first` matches a registered subcommand name or alias. */
export function isSubcommand(first: string | undefined): boolean {
	return Boolean(first && !first.startsWith("-") && !first.startsWith("@") && SUBCOMMAND_WORDS.has(first));
}

/** Commands that share the launch flag surface. */
export const LAUNCH_FLAG_COMMANDS: Readonly<Record<string, true>> = { launch: true, acp: true };
