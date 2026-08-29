/**
 * Top-level CLI command table.
 *
 * Lives in its own module (importable without side effects) so that tests can
 * inspect the registered subcommands without triggering the side-effectful
 * top-level await in `cli.ts`. Adding a new subcommand here is enough to make
 * `runCli` route to it instead of forwarding the argv as a prompt to
 * `launch` — see #1496 for the original "args silently leak to the LLM"
 * regression that motivated the split.
 */
import type { CommandEntry } from "@oh-my-pi/pi-utils/cli";
import * as commandHelp from "./cli/command-help";
import { commandIdentity, isSubcommand, LAUNCH_FLAG_COMMANDS } from "./cli/command-routing";
import {
	EXTENSION_SHADOWABLE_STRING_FLAGS,
	flagConsumesValue,
	OPTIONAL_VALUE_FLAGS,
	STRING_VALUE_FLAGS,
	VALUELESS_FLAGS,
} from "./cli/flag-tables";
import { launchHelp } from "./commands/launch-help";

export { isSubcommand, LAUNCH_FLAG_COMMANDS } from "./cli/command-routing";

type Translate = (key: string) => string;

const identityTranslate: Translate = key => key;

export const commands: CommandEntry[] = [
	{ ...commandIdentity("launch"), load: () => import("./commands/launch").then(m => m.default), help: launchHelp },
	{
		...commandIdentity("acp"),
		load: () => import("./commands/acp").then(m => m.default),
		help: commandHelp.acpHelp,
	},
	{
		...commandIdentity("auth-broker"),
		load: () => import("./commands/auth-broker").then(m => m.default),
		help: commandHelp.authBrokerHelp,
	},
	{
		...commandIdentity("auth-gateway"),
		load: () => import("./commands/auth-gateway").then(m => m.default),
		help: commandHelp.authGatewayHelp,
	},
	{
		...commandIdentity("agents"),
		load: () => import("./commands/agents").then(m => m.default),
		help: commandHelp.agentsHelp,
	},
	{
		...commandIdentity("bench"),
		load: () => import("./commands/bench").then(m => m.default),
		help: commandHelp.benchHelp,
	},
	{
		...commandIdentity("browser-relay"),
		load: () => import("./commands/browser-relay").then(m => m.default),
		help: commandHelp.browserRelayHelp,
	},
	{
		...commandIdentity("cleanse"),
		load: () => import("./commands/cleanse").then(m => m.default),
		help: commandHelp.cleanseHelp,
	},
	{
		...commandIdentity("commit"),
		load: () => import("./commands/commit").then(m => m.default),
		help: commandHelp.commitHelp,
	},
	{
		...commandIdentity("completions"),
		load: () => import("./commands/completions").then(m => m.default),
		help: commandHelp.completionsHelp,
	},
	{
		...commandIdentity("__complete"),
		load: () => import("./commands/complete").then(m => m.default),
		help: commandHelp.completeHelp,
	},
	{
		...commandIdentity("compress"),
		load: () => import("./commands/compress").then(m => m.default),
		help: commandHelp.compressHelp,
	},
	{
		...commandIdentity("config"),
		load: () => import("./commands/config").then(m => m.default),
		help: commandHelp.configHelp,
	},
	{
		...commandIdentity("dry-balance"),
		load: () => import("./commands/dry-balance").then(m => m.default),
		help: commandHelp.dryBalanceHelp,
	},
	{
		...commandIdentity("gc"),
		load: () => import("./commands/gc").then(m => m.default),
		help: commandHelp.gcHelp,
	},
	{
		...commandIdentity("grep"),
		load: () => import("./commands/grep").then(m => m.default),
		help: commandHelp.grepHelp,
	},
	{
		...commandIdentity("gallery"),
		load: () => import("./commands/gallery").then(m => m.default),
		help: commandHelp.galleryHelp,
	},
	{
		...commandIdentity("git"),
		load: () => import("./commands/git").then(m => m.default),
		help: commandHelp.gitHelp,
	},
	{
		...commandIdentity("grievances"),
		load: () => import("./commands/grievances").then(m => m.default),
		help: commandHelp.grievancesHelp,
	},
	{
		...commandIdentity("images"),
		load: () => import("./commands/images").then(m => m.default),
		help: commandHelp.imagesHelp,
	},
	{
		...commandIdentity("if-bench"),
		load: () => import("./commands/if-bench").then(m => m.default),
		help: commandHelp.ifBenchHelp,
	},
	{
		...commandIdentity("install"),
		load: () => import("./commands/install").then(m => m.default),
		help: commandHelp.installHelp,
	},
	{
		...commandIdentity("join"),
		load: () => import("./commands/join").then(m => m.default),
		help: commandHelp.joinHelp,
	},
	{
		...commandIdentity("models"),
		load: () => import("./commands/models").then(m => m.default),
		help: commandHelp.modelsHelp,
	},
	{
		...commandIdentity("plugin"),
		load: () => import("./commands/plugin").then(m => m.default),
		help: commandHelp.pluginHelp,
	},
	{
		...commandIdentity("ps"),
		load: () => import("./commands/ps").then(m => m.default),
		help: commandHelp.psHelp,
	},
	{
		...commandIdentity("say"),
		load: () => import("./commands/say").then(m => m.default),
		help: commandHelp.sayHelp,
	},
	{
		...commandIdentity("share"),
		load: () => import("./commands/share").then(m => m.default),
		help: commandHelp.shareHelp,
	},
	{
		...commandIdentity("setup"),
		load: () => import("./commands/setup").then(m => m.default),
		help: commandHelp.setupHelp,
	},
	{
		...commandIdentity("shell"),
		load: () => import("./commands/shell").then(m => m.default),
		help: commandHelp.shellHelp,
	},
	{
		...commandIdentity("read"),
		load: () => import("./commands/read").then(m => m.default),
		help: commandHelp.readHelp,
	},
	{
		...commandIdentity("render"),
		load: () => import("./commands/render").then(m => m.default),
		help: commandHelp.renderHelp,
	},
	{
		...commandIdentity("ssh"),
		load: () => import("./commands/ssh").then(m => m.default),
		help: commandHelp.sshHelp,
	},
	{
		...commandIdentity("stats"),
		load: () => import("./commands/stats").then(m => m.default),
		help: commandHelp.statsHelp,
	},
	{
		...commandIdentity("update"),
		load: () => import("./commands/update").then(m => m.default),
		help: commandHelp.updateHelp,
	},
	{
		...commandIdentity("usage"),
		load: () => import("./commands/usage").then(m => m.default),
		help: commandHelp.usageHelp,
	},
	{
		...commandIdentity("tiny-models"),
		load: () => import("./commands/tiny-models").then(m => m.default),
		help: commandHelp.tinyModelsHelp,
	},
	{
		...commandIdentity("token"),
		load: () => import("./commands/token").then(m => m.default),
		help: commandHelp.tokenHelp,
	},
	{
		...commandIdentity("ttsr"),
		load: () => import("./commands/ttsr").then(m => m.default),
		help: commandHelp.ttsrHelp,
	},
	{
		...commandIdentity("worktree"),
		load: () => import("./commands/worktree").then(m => m.default),
		help: commandHelp.worktreeHelp,
	},
	{
		...commandIdentity("search"),
		load: () => import("./commands/web-search").then(m => m.default),
		help: commandHelp.searchHelp,
	},
];

const RESERVED_TOP_LEVEL_WORDS: Record<string, string> = {
	extensions:
		'`omp extensions` is not a management command. Use `omp plugin list` / `omp plugin install`, or run `omp launch extensions` if you meant to send "extensions" as a prompt.',
	list: '`omp list` is not a top-level command. Use `omp plugin list` to list installed plugins, or run `omp launch list` if you meant to send "list" as a prompt.',
	remove:
		'`omp remove` is not a top-level command. Use `omp plugin uninstall <name>` to remove a plugin, or run `omp launch remove` if you meant to send "remove" as a prompt.',
	uninstall:
		'`omp uninstall` is not a top-level command. Use `omp plugin uninstall <name@marketplace>` to remove a plugin, or run `omp launch uninstall` if you meant to send "uninstall" as a prompt.',
	marketplace:
		'`omp marketplace` is not a top-level command. Use `omp plugin marketplace <add|remove|update|list>` to manage marketplaces, or run `omp launch marketplace` if you meant to send "marketplace" as a prompt.',
	discover:
		'`omp discover` is not a top-level command. Use `omp plugin discover [marketplace]` to browse available plugins, or run `omp launch discover` if you meant to send "discover" as a prompt.',
	upgrade:
		'`omp upgrade` is not a top-level command. Use `omp plugin upgrade [name@marketplace]` to upgrade plugins, or run `omp launch upgrade` if you meant to send "upgrade" as a prompt.',
	enable:
		'`omp enable` is not a top-level command. Use `omp plugin enable <name@marketplace>` to enable a plugin, or run `omp launch enable` if you meant to send "enable" as a prompt.',
	disable:
		'`omp disable` is not a top-level command. Use `omp plugin disable <name@marketplace>` to disable a plugin, or run `omp launch disable` if you meant to send "disable" as a prompt.',
};

// Sub-actions that make `omp marketplace <sub>` unambiguously a management
// command even when multi-word (the reporter's `omp marketplace add xyz`,
// #4845). Mirrors the switch in `handleMarketplace` (cli/plugin-cli.ts).
const MARKETPLACE_SUBCOMMANDS: Record<string, true> = { add: true, remove: true, rm: true, update: true, list: true };

/**
 * Hint for a reserved plugin/marketplace verb used as a top-level command, or
 * `undefined` when the argv should fall through to `launch`.
 *
 * Plugin/marketplace verbs keep their narrower historical behavior: a bare
 * verb (`omp marketplace`) always hints, while a multi-word invocation only
 * hints when the arguments follow the documented plugin grammar — a
 * marketplace sub-action (`omp marketplace add …`) or a `name@marketplace`
 * plugin id (`omp uninstall foo@bar`). Genuine prompts that merely begin with
 * those words (`omp list all my files`, `omp upgrade the deps`) still launch.
 *
 * Flags (`-…`) and `@file` arguments in the verb slot are never management
 * commands; those fall through to the default `launch` command.
 */
export function reservedTopLevelWordMessage(
	argv: readonly string[],
	translate: Translate = identityTranslate,
): string | undefined {
	const first = argv[0];
	if (!first || first.startsWith("-") || first.startsWith("@")) return undefined;
	const hintKey = RESERVED_TOP_LEVEL_WORDS[first];
	if (!hintKey) return undefined;
	const hint = translate(hintKey);
	const second = argv[1];
	if (second === undefined) return hint;
	if (first === "marketplace" && MARKETPLACE_SUBCOMMANDS[second]) return hint;
	for (let index = 1; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("-") && arg.includes("@")) return hint;
	}
	return undefined;
}

export type ResolvedCliArgv = { argv: string[] } | { error: string };

/**
 * Index of the first argv token that names a registered subcommand, skipping
 * leading global option flags (and any value they consume) with the same
 * contract as the launch parser ({@link flagConsumesValue}). Returns -1 when
 * scanning hits a non-subcommand positional, an end-of-options `--`, or the end
 * of argv first.
 */
function leadingSubcommandIndex(argv: string[]): number {
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--") return -1;
		if (!arg.startsWith("-")) return isSubcommand(arg) ? index : -1;
		if (flagConsumesValue(arg, argv[index + 1])) index += 1;
	}
	return -1;
}

/** Whether `arg` names a flag from the launch surface (bare or `--flag=value`). */
function isLaunchGlobalFlag(arg: string): boolean {
	const eq = arg.indexOf("=");
	const name = arg.startsWith("--") && eq !== -1 ? arg.slice(0, eq) : arg;
	return (
		STRING_VALUE_FLAGS.has(name) ||
		OPTIONAL_VALUE_FLAGS.has(name) ||
		VALUELESS_FLAGS.has(name) ||
		EXTENSION_SHADOWABLE_STRING_FLAGS.has(name)
	);
}

/**
 * Drop recognized launch-global flags (and any value they consume) from the
 * leading segment before a hoisted non-launch subcommand. `--cwd` and friends
 * belong to the launch surface and mean nothing to a subcommand like `update`,
 * whose strict parser would otherwise reject them with a cryptic
 * `node:util.parseArgs` error (#8891). Tokens the launch tables don't recognize
 * are kept, so a subcommand's own leading flags still reach it.
 */
function stripLaunchGlobalFlags(leading: readonly string[]): string[] {
	const kept: string[] = [];
	for (let index = 0; index < leading.length; index += 1) {
		const arg = leading[index];
		if (isLaunchGlobalFlag(arg)) {
			if (flagConsumesValue(arg, leading[index + 1])) index += 1;
			continue;
		}
		kept.push(arg);
	}
	return kept;
}

/**
 * Decide what the CLI runner should do with raw argv: reject bare reserved
 * management words, pass help/version through untouched, route a recognized
 * subcommand (even behind leading global flags like `--approval-mode=yolo`) to
 * that command, and forward everything else to `launch` (#2970). Leading
 * launch-global flags are forwarded to launch-shaped commands but stripped for
 * other subcommands that cannot parse them (#8891).
 */
export function resolveCliArgv(argv: string[], translate: Translate = identityTranslate): ResolvedCliArgv {
	const first = argv[0];
	const reservedMessage = reservedTopLevelWordMessage(argv, translate);
	if (reservedMessage) return { error: reservedMessage };
	if (first === "--help" || first === "-h" || first === "--version" || first === "-v" || first === "help") {
		return { argv };
	}
	if (isSubcommand(first)) return { argv };
	// A subcommand can hide behind leading global option flags
	// (`omp --approval-mode=yolo acp`). `run` dispatches strictly on argv[0], so
	// hoist the subcommand to the front. Launch-shaped commands share the launch
	// flag surface, so their leading flags are forwarded and applied; every other
	// subcommand parses only its own flags, so launch-global flags placed before
	// it (`omp --cwd <dir> update`) are stripped rather than forwarded into a
	// crash (#8891). Genuine launch prompts (no trailing subcommand) are untouched.
	const subIndex = leadingSubcommandIndex(argv);
	if (subIndex >= 0) {
		const sub = argv[subIndex];
		const leading = argv.slice(0, subIndex);
		const trailing = argv.slice(subIndex + 1);
		const forwardedLeading = LAUNCH_FLAG_COMMANDS[sub] === true ? leading : stripLaunchGlobalFlags(leading);
		return { argv: [sub, ...forwardedLeading, ...trailing] };
	}
	return { argv: ["launch", ...argv] };
}
