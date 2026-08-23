import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { COLLAB_GUEST_ALLOWED_COMMANDS } from "../collab/guest";
import { t } from "../i18n";
import { BUILTIN_COLLABORATION_SLASH_COMMANDS } from "./builtin-collaboration";
import {
	buildArgumentCompletions,
	buildDirectoryArgumentCompletions,
	buildMcpArgumentCompletions,
	buildStaticInlineHint,
	buildSubcommandInlineHint,
} from "./builtin-completions";
import { BUILTIN_CONTROL_SLASH_COMMANDS } from "./builtin-control";
import { BUILTIN_LIFECYCLE_SLASH_COMMANDS } from "./builtin-lifecycle";
import { BUILTIN_MARKETPLACE_SLASH_COMMANDS, reloadTuiPluginState } from "./builtin-marketplace";
import { BUILTIN_MODE_SLASH_COMMANDS } from "./builtin-modes";
import { BUILTIN_SESSION_SLASH_COMMANDS } from "./builtin-session";
import { parseSlashCommand } from "./helpers/parse";
import type {
	BuiltinSlashCommand,
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "./types";

export type { BuiltinSlashCommand, SubcommandDef } from "./types";

/** TUI-specific runtime accepted by `executeBuiltinSlashCommand`. */
export type BuiltinSlashCommandRuntime = TuiSlashCommandRuntime;

export interface TuiBuiltinSlashCommand extends BuiltinSlashCommand {
	getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	getInlineHint?: (argumentText: string) => string | null;
	getAutocompleteDescription?: () => string | undefined;
}

const BUILTIN_SLASH_COMMAND_REGISTRY: ReadonlyArray<SlashCommandSpec> = [
	...BUILTIN_MODE_SLASH_COMMANDS,
	...BUILTIN_COLLABORATION_SLASH_COMMANDS,
	...BUILTIN_SESSION_SLASH_COMMANDS,
	...BUILTIN_LIFECYCLE_SLASH_COMMANDS,
	...BUILTIN_MARKETPLACE_SLASH_COMMANDS,
	...BUILTIN_CONTROL_SLASH_COMMANDS,
];

const BUILTIN_SLASH_COMMAND_LOOKUP = new Map<string, SlashCommandSpec>();
for (const command of BUILTIN_SLASH_COMMAND_REGISTRY) {
	BUILTIN_SLASH_COMMAND_LOOKUP.set(command.name, command);
	for (const alias of command.aliases ?? []) {
		BUILTIN_SLASH_COMMAND_LOOKUP.set(alias, command);
	}
}

export const BUILTIN_SLASH_COMMAND_RESERVED_NAMES: ReadonlySet<string> = new Set(BUILTIN_SLASH_COMMAND_LOOKUP.keys());

/** Builtin command metadata used for slash-command autocomplete and help text. */
export const BUILTIN_SLASH_COMMAND_DEFS: ReadonlyArray<BuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_REGISTRY.map(
	command => ({
		name: command.name,
		aliases: command.aliases,
		allowArgs: command.allowArgs === true,
		description: command.description,
		icon: command.icon,
		subcommands: command.subcommands,
		inlineHint: command.inlineHint,
		getTuiAutocompleteDescription: command.getTuiAutocompleteDescription,
	}),
);

function materializeTuiBuiltinSlashCommand(
	cmd: BuiltinSlashCommand,
	runtime?: TuiSlashCommandRuntime,
): TuiBuiltinSlashCommand {
	const materialized: TuiBuiltinSlashCommand = { ...cmd };
	if (cmd.subcommands) {
		materialized.getArgumentCompletions =
			cmd.name === "mcp" && runtime
				? buildMcpArgumentCompletions(cmd.subcommands, runtime)
				: buildArgumentCompletions(cmd.subcommands);
		materialized.getInlineHint = buildSubcommandInlineHint(cmd.subcommands);
	} else if (cmd.name === "move") {
		materialized.getArgumentCompletions = buildDirectoryArgumentCompletions();
		if (cmd.inlineHint) materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	} else if (cmd.inlineHint) {
		materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	}
	if (runtime && cmd.getTuiAutocompleteDescription) {
		materialized.getAutocompleteDescription = () => cmd.getTuiAutocompleteDescription?.(runtime);
	}
	return materialized;
}

/** Materialized builtin slash commands with completion functions derived from declarative metadata. */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<TuiBuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_DEFS.map(cmd =>
	materializeTuiBuiltinSlashCommand(cmd),
);

export function buildTuiBuiltinSlashCommands(runtime: TuiSlashCommandRuntime): ReadonlyArray<TuiBuiltinSlashCommand> {
	return BUILTIN_SLASH_COMMAND_DEFS.map(cmd => materializeTuiBuiltinSlashCommand(cmd, runtime));
}

/** Unified registry exposed for cross-mode tooling. */
export const BUILTIN_SLASH_COMMANDS_INTERNAL: ReadonlyArray<SlashCommandSpec> = BUILTIN_SLASH_COMMAND_REGISTRY;

/** Execute a builtin slash command in the interactive TUI. */
export async function executeBuiltinSlashCommand(
	text: string,
	runtime: BuiltinSlashCommandRuntime,
): Promise<string | boolean> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;

	const command = BUILTIN_SLASH_COMMAND_LOOKUP.get(parsed.name);
	if (!command) return false;
	if (parsed.args.length > 0 && !command.allowArgs) return false;

	if (runtime.ctx.collabGuest && !COLLAB_GUEST_ALLOWED_COMMANDS[command.name]) {
		runtime.ctx.showStatus(t("/{name} is host-only during a collab session", { name: command.name }));
		runtime.ctx.editor.setText("");
		return true;
	}
	if (command.handleTui) {
		const result = await command.handleTui(parsed, runtime);
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	if (command.handle) {
		const ctx = runtime.ctx;
		const adapted: SlashCommandRuntime = {
			session: ctx.session,
			sessionManager: ctx.sessionManager,
			settings: ctx.settings,
			cwd: ctx.sessionManager.getCwd(),
			output: (message: string) => {
				ctx.showStatus(message);
			},
			refreshCommands: () => ctx.refreshSlashCommandState(),
			reloadPlugins: () => reloadTuiPluginState(ctx),
		};
		const result = await command.handle(parsed, adapted);
		ctx.editor.setText("");
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	return false;
}

/** Look up a unified spec by name or alias. Used by the ACP dispatcher. */
export function lookupBuiltinSlashCommand(name: string): SlashCommandSpec | undefined {
	return BUILTIN_SLASH_COMMAND_LOOKUP.get(name);
}

export type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, SlashCommandSpec, TuiSlashCommandRuntime };
