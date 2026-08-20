import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setProjectDir } from "@oh-my-pi/pi-utils";
import { applyProviderGlobalsFromSettings } from "../config/provider-globals";
import { t } from "../i18n";
import { memoryStatsUnavailableMessage, resolveMemoryBackend } from "../memory-backend";
import type { FreshSessionResult } from "../session/agent-session";
import { COMPACT_MODES, parseCompactArgs } from "../session/compact-modes";
import { resolveResumableSession } from "../session/session-listing";
import { formatShakeSummary, type ShakeMode } from "../session/shake-types";
import { resolveToCwd } from "../tools/path-utils";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import { handleSshAcp } from "./helpers/ssh";
import type {
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "./types";

function formatFreshSessionResult(result: FreshSessionResult): string {
	const stateLabel = result.closedProviderSessions === 1 ? "provider state" : "provider states";
	return t("Fresh provider session started ({count} {stateLabel} pruned).", {
		count: result.closedProviderSessions,
		stateLabel,
	});
}

export const shutdownHandlerTui = (
	_command: ParsedSlashCommand,
	runtime: TuiSlashCommandRuntime,
): SlashCommandResult => {
	runtime.ctx.editor.setText("");
	void runtime.ctx.shutdown();
	return commandConsumed();
};

/** Parse the `/shake` subcommand into a {@link ShakeMode}; empty defaults to elide. */
function parseShakeMode(args: string): ShakeMode | { error: string } {
	const verb = args.trim().toLowerCase();
	if (verb === "" || verb === "elide") return "elide";
	if (verb === "images") return "images";
	return { error: t('Unknown /shake mode "{mode}". Use elide or images.', { mode: verb }) };
}

/** Format the session's workspace directories (cwd + additional) for display. */
function formatWorkspaceDirectories(runtime: SlashCommandRuntime, note?: string): string {
	const cwd = runtime.sessionManager.getCwd();
	const additional = runtime.sessionManager.getAdditionalDirectories();
	const lines = [
		t("Workspace directories:"),
		`  ${cwd} ${t("(working directory)")}`,
		...additional.map(d => `  ${d}`),
	];
	return note ? `${note}\n${lines.join("\n")}` : lines.join("\n");
}

export const BUILTIN_LIFECYCLE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "ssh",
		description: t("Manage SSH hosts (add, list, remove)"),
		acpDescription: t("Manage SSH connections"),
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				description: t("Add an SSH host"),
				usage: "<name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>] [--scope project|user]",
			},
			{ name: "list", description: t("List all configured SSH hosts") },
			{ name: "remove", description: t("Remove an SSH host"), usage: "<name> [--scope project|user]" },
			{ name: "help", description: t("Show help message") },
		],
		allowArgs: true,
		handle: handleSshAcp,
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleSSHCommand(command.text);
		},
	},
	{
		name: "new",
		description: t("Start a new session"),
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleClearCommand();
		},
	},
	{
		name: "fresh",
		description: t("Reset provider stream state without changing the local transcript"),
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.session.isStreaming ? t("Fresh: unavailable while streaming") : t("Fresh: ready"),
		handle: async (_command, runtime) => {
			const result = runtime.session.freshSession();
			if (!result) {
				await runtime.output(
					t("Wait for the current response to finish or abort it before refreshing provider state."),
				);
				return commandConsumed();
			}
			await runtime.output(formatFreshSessionResult(result));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleFreshCommand();
		},
	},
	{
		name: "clear",
		description: t("Clear the conversation context in place, keeping the session"),
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.session.isStreaming
				? t("Clear: unavailable while streaming")
				: t("Clear: drop context, keep session"),
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleResetContextCommand();
		},
	},
	{
		name: "drop",
		description: t("Delete the current session and start a new one"),
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleDropCommand();
		},
	},
	{
		name: "compact",
		description: t("Manually compact the session context"),
		acpDescription: t("Compact the conversation"),
		subcommands: COMPACT_MODES.map(mode => ({
			name: mode.name,
			description: mode.description,
			usage: mode.rejectsFocus ? undefined : "[focus]",
		})),
		acpInputHint: `[${COMPACT_MODES.map(mode => mode.name).join("|")}] [focus]`,
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const usage = runtime.ctx.session.getContextUsage();
			return usage
				? t("Compact: context {percent}% used", { percent: Math.round(usage.percent) })
				: t("Compact: context unavailable");
		},
		handle: async (command, runtime) => {
			const parsed = parseCompactArgs(command.args);
			if ("error" in parsed) return usage(parsed.error, runtime);
			const before = runtime.session.getContextUsage?.();
			const beforeTokens = before?.tokens;
			try {
				await runtime.session.compact(parsed.instructions, parsed.mode ? { mode: parsed.mode } : undefined);
			} catch (err) {
				// Compaction precondition failures (no model, already compacted, too
				// small) and provider errors propagate as plain Errors; surface them
				// via runtime.output so they don't fail the ACP prompt turn.
				return usage(t("Compaction failed: {error}", { error: errorMessage(err) }), runtime);
			}
			const after = runtime.session.getContextUsage?.();
			const afterTokens = after?.tokens;
			if (beforeTokens != null && afterTokens != null) {
				const saved = beforeTokens - afterTokens;
				await runtime.output(
					t("Compaction complete. Tokens: {before} -> {after} (saved {saved}).", {
						before: beforeTokens,
						after: afterTokens,
						saved,
					}),
				);
			} else {
				await runtime.output(t("Compaction complete."));
			}
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const parsed = parseCompactArgs(command.args);
			runtime.ctx.editor.setText("");
			if ("error" in parsed) {
				runtime.ctx.showWarning(parsed.error);
				return;
			}
			await runtime.ctx.handleCompactCommand(parsed.instructions, parsed.mode);
		},
	},
	{
		name: "shake",
		description: t("Drop heavy content from context (tool results, large blocks)"),
		acpDescription: t("Shake heavy content out of the conversation context"),
		subcommands: [
			{ name: "elide", description: t("Strip tool results + large blocks (default)") },
			{ name: "images", description: t("Strip image blocks") },
		],
		acpInputHint: "[elide|images]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const mode = parseShakeMode(command.args);
			if (typeof mode !== "string") return usage(mode.error, runtime);
			const result = await runtime.session.shake(mode);
			await runtime.output(formatShakeSummary(result));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const mode = parseShakeMode(command.args);
			if (typeof mode !== "string") {
				runtime.ctx.showWarning(mode.error);
				return;
			}
			await runtime.ctx.handleShakeCommand(mode);
		},
	},
	{
		name: "handoff",
		description: t("Hand off session context to a new session"),
		inlineHint: t("[focus instructions]"),
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const customInstructions = command.args || undefined;
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleHandoffCommand(customInstructions);
		},
	},
	{
		name: "resume",
		description: t("Resume a different session"),
		inlineHint: "[session id|@claude|@codex]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const sessionArg = command.args.trim();
			runtime.ctx.editor.setText("");
			const foreignSource = sessionArg === "@claude" ? "claude" : sessionArg === "@codex" ? "codex" : undefined;
			if (foreignSource) {
				runtime.ctx.showSessionSelector(foreignSource);
				return;
			}
			if (!sessionArg) {
				runtime.ctx.showSessionSelector();
				return;
			}
			const match = await resolveResumableSession(
				sessionArg,
				runtime.ctx.sessionManager.getCwd(),
				runtime.ctx.sessionManager.getSessionDir(),
				{ allowGlobalFallback: true },
			);
			if (!match) {
				runtime.ctx.showError(t('Session "{id}" not found', { id: sessionArg }));
				return;
			}
			await runtime.ctx.handleResumeSession(match.session.path);
		},
	},
	{
		name: "btw",
		description: t("Ask an ephemeral side question using the current session context"),
		inlineHint: "<question>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const question = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleBtwCommand(question);
		},
	},
	{
		name: "tan",
		description: t("Run a full background agent on tangential work"),
		inlineHint: "<work>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const work = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleTanCommand(work);
		},
	},
	{
		name: "omfg",
		description: t("Forge a TTSR rule from a complaint to stop a recurring behavior"),
		inlineHint: "<complaint>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const complaint = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleOmfgCommand(complaint);
		},
	},
	{
		name: "cleanse",
		description: t("Detect and fix project diagnostics with weighted parallel subagents"),
		inlineHint: "[request] [--all]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const args = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleCleanseCommand(args);
		},
	},
	{
		name: "retry",
		description: t("Retry the last failed agent turn"),
		handleTui: async (_command, runtime) => {
			const didRetry = await runtime.ctx.session.retry();
			if (!didRetry) {
				runtime.ctx.showStatus(t("Nothing to retry"));
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "debug",
		description: t("Open debug tools selector"),
		handleTui: async (_command, runtime) => {
			await runtime.ctx.showDebugSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "memory",
		description: t("Inspect and operate memory maintenance"),
		acpDescription: t("Manage memory"),
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "view", description: t("Show current memory injection payload") },
			{ name: "stats", description: t("Show memory backend statistics") },
			{ name: "diagnose", description: t("Run memory backend diagnostics") },
			{ name: "clear", description: t("Clear persisted memory data and artifacts") },
			{ name: "reset", description: t("Alias for clear") },
			{ name: "enqueue", description: t("Enqueue memory consolidation maintenance") },
			{ name: "rebuild", description: t("Alias for enqueue") },
			{ name: "mm list", description: t("List mental models on the active bank") },
			{ name: "mm show", description: t("Show one mental model (id required)") },
			{
				name: "mm refresh",
				description: t("Refresh auto-refresh models bank-wide, or one model by id"),
			},
			{ name: "mm history", description: t("Diff the change history of a mental model") },
			{ name: "mm seed", description: t("Create any built-in mental models that are missing") },
			{ name: "mm delete", description: t("Delete a mental model from the bank (id required)") },
			{ name: "mm reload", description: t("Re-pull the cached <mental_models> block") },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const verb = (command.args.trim().split(/\s+/)[0] ?? "").toLowerCase() || "view";
			const backend = await resolveMemoryBackend(runtime.settings);
			switch (verb) {
				case "view": {
					const payload = await backend.buildDeveloperInstructions(
						runtime.settings.getAgentDir(),
						runtime.settings,
						runtime.session,
					);
					await runtime.output(payload || t("Memory payload is empty."));
					return commandConsumed();
				}
				case "clear":
				case "reset": {
					await backend.clear(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.session.refreshBaseSystemPrompt();
					await runtime.output(t("Memory cleared."));
					return commandConsumed();
				}
				case "enqueue":
				case "rebuild": {
					await backend.enqueue(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output(t("Memory consolidation enqueued."));
					return commandConsumed();
				}
				case "stats":
				case "diagnose": {
					const hook = verb === "stats" ? backend.stats : backend.diagnose;
					const payload = await hook?.(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output(payload ?? memoryStatsUnavailableMessage(backend.id, verb));
					return commandConsumed();
				}
				case "mm":
					return usage(
						t(
							"Mental-model maintenance via /memory mm is unsupported in ACP mode; use the hindsight HTTP API directly.",
						),
						runtime,
					);
				default:
					return usage(t("Usage: /memory <view|stats|diagnose|clear|reset|enqueue|rebuild>"), runtime);
			}
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMemoryCommand(command.text);
		},
	},
	{
		name: "rename",
		description: t("Rename the current session"),
		inlineHint: "<title>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (!command.args) return usage(t("Usage: /rename <title>"), runtime);
			const ok = await runtime.sessionManager.setSessionName(command.args, "user");
			if (!ok) {
				await runtime.output(t("Session name not changed (a user-set name takes precedence)."));
				return commandConsumed();
			}
			await runtime.notifyTitleChanged?.();
			await runtime.output(t("Session renamed to {title}.", { title: command.args }));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const title = command.args.trim();
			if (!title) {
				runtime.ctx.showError(t("Usage: /rename <title>"));
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleRenameCommand(title);
		},
	},
	{
		name: "move",
		description: t("Move the current session to a different directory"),
		acpDescription: t("Move the current session to a different directory"),
		inlineHint: "[<path>]",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage(t("Cannot move while streaming."), runtime);
			if (!command.args) return usage(t("Usage: /move <path>"), runtime);
			const resolvedPath = resolveToCwd(command.args, runtime.cwd);
			try {
				const stat = await fs.stat(resolvedPath);
				if (!stat.isDirectory()) {
					return usage(t("Not a directory: {path}", { path: resolvedPath }), runtime);
				}
			} catch {
				return usage(t("Directory does not exist: {path}", { path: resolvedPath }), runtime);
			}
			try {
				await runtime.settings.flush();
			} catch (err) {
				return usage(t("Failed to save pending settings: {error}", { error: errorMessage(err) }), runtime);
			}
			try {
				await runtime.session.moveSession(resolvedPath);
			} catch (err) {
				return usage(t("Move failed: {error}", { error: errorMessage(err) }), runtime);
			}
			setProjectDir(resolvedPath);
			await runtime.settings.reloadForCwd(resolvedPath);
			applyProviderGlobalsFromSettings(runtime.settings);
			// Reload plugin/capability caches so the next prompt sees commands and
			// capabilities scoped to the new cwd.
			await runtime.reloadPlugins();
			await runtime.notifyConfigChanged?.();
			await runtime.notifyTitleChanged?.();
			await runtime.output(t("Moved to {path}.", { path: runtime.sessionManager.getCwd() }));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.addToHistory(command.text);
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMoveCommand(command.args || undefined);
		},
	},
	{
		name: "add-dir",
		description: t("Add a workspace directory to this session (multi-root)"),
		acpDescription: t("Add a workspace directory to this session"),
		inlineHint: "<path>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage(t("Cannot add a directory while streaming."), runtime);
			if (!command.args) return usage(formatWorkspaceDirectories(runtime, t("Usage: /add-dir <path>")), runtime);
			const resolved = resolveToCwd(command.args, runtime.cwd);
			try {
				const stat = await fs.stat(resolved);
				if (!stat.isDirectory()) return usage(t("Not a directory: {path}", { path: resolved }), runtime);
			} catch {
				return usage(t("Directory does not exist: {path}", { path: resolved }), runtime);
			}
			let added: string | null;
			try {
				added = await runtime.sessionManager.addWorkspaceDirectory(resolved);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			if (added === null) {
				await runtime.output(t("Already in the workspace: {path}", { path: resolved }));
				return commandConsumed();
			}
			await runtime.session.refreshBaseSystemPrompt();
			await runtime.output(formatWorkspaceDirectories(runtime, t("Added {path}.", { path: added })));
			return commandConsumed();
		},
	},
	{
		name: "remove-dir",
		description: t("Remove a workspace directory from this session"),
		acpDescription: t("Remove a workspace directory from this session"),
		inlineHint: "<path>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage(t("Cannot remove a directory while streaming."), runtime);
			if (!command.args) return usage(t("Usage: /remove-dir <path>"), runtime);
			const resolved = resolveToCwd(command.args, runtime.cwd);
			if (resolved === path.resolve(runtime.cwd)) {
				return usage(t("Cannot remove the working directory; use /move to change it."), runtime);
			}
			let removed: string | null;
			try {
				removed = await runtime.sessionManager.removeWorkspaceDirectory(resolved);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			if (removed === null) {
				await runtime.output(t("Not a workspace directory: {path}", { path: resolved }));
				return commandConsumed();
			}
			await runtime.session.refreshBaseSystemPrompt();
			await runtime.output(formatWorkspaceDirectories(runtime, t("Removed {path}.", { path: removed })));
			return commandConsumed();
		},
	},
	{
		name: "dirs",
		description: t("List this session's workspace directories"),
		acpDescription: t("List this session's workspace directories"),
		handle: async (_command, runtime) => {
			await runtime.output(formatWorkspaceDirectories(runtime));
			return commandConsumed();
		},
	},
	{
		name: "exit",
		description: t("Exit the application"),
		handleTui: shutdownHandlerTui,
	},
];
