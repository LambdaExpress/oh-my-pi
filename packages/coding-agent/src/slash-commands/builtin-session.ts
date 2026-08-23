import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { settings } from "../config/settings";
import { t } from "../i18n";
import type { AgentSession } from "../session/agent-session";
import type { SessionOAuthAccountList } from "../session/agent-session-types";
import {
	getChangelogPath,
	parseChangelog,
	RECENT_CHANGELOG_ENTRY_LIMIT,
	renderChangelogEntries,
} from "../utils/changelog";
import { formatTokenCount, refreshStatusLine } from "./builtin-modes";
import { buildContextReportText } from "./helpers/context-report";
import { formatDuration } from "./helpers/format";
import { handleMcpAcp } from "./helpers/mcp";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";
import { describeRedeemOutcome, type ResetUsageAccount, toResetUsageAccounts } from "./helpers/reset-usage";
import { matchSessionPinAccounts, toSessionPinAccounts } from "./helpers/session-pin";
import { launchStatsDashboard, parseStatsDashboardArgs } from "./helpers/stats-dashboard";
import { handleTodoAcp } from "./helpers/todo";
import { buildUsageReportText } from "./helpers/usage-report";
import type { SlashCommandRuntime, SlashCommandSpec } from "./types";

async function handleUsageResetCommand(
	arg: string,
	session: AgentSession,
	output: SlashCommandRuntime["output"],
): Promise<boolean> {
	let accounts: ResetUsageAccount[];
	try {
		accounts = toResetUsageAccounts(await session.listResetCredits());
	} catch (error) {
		await output(t("Could not load saved resets: {error}", { error: errorMessage(error) }));
		return false;
	}
	if (accounts.length === 0) {
		await output(t("No Codex accounts found. Use /login to add one."));
		return false;
	}
	const targetArg = arg.trim();
	if (!targetArg) {
		const lines = [t("Saved Codex rate-limit resets:")];
		for (const account of accounts) {
			const detail = account.error ? `unavailable (${account.error})` : `${account.availableCount} available`;
			lines.push(
				t("- {label}: {detail}", {
					label: account.label,
					detail: `${detail}${account.active ? " (active)" : ""}`,
				}),
			);
		}
		lines.push("", t("Spend one with `/usage reset <account email>` or `/usage reset active`."));
		await output(lines.join("\n"));
		return false;
	}
	const wanted = targetArg.toLowerCase();
	const target =
		wanted === "active"
			? accounts.find(account => account.active)
			: accounts.find(
					account =>
						account.label.toLowerCase() === wanted ||
						account.target.email?.toLowerCase() === wanted ||
						account.target.accountId?.toLowerCase() === wanted,
				);
	if (!target) {
		await output(t('No Codex account matches "{name}".', { name: targetArg }));
		return false;
	}
	if (target.availableCount <= 0) {
		await output(t("{label}: no saved resets to spend.", { label: target.label }));
		return false;
	}
	const outcome = await session.redeemResetCredit(target.target);
	await output(describeRedeemOutcome(outcome, target.label));
	return outcome.ok;
}

async function handleSessionPinCommand(
	arg: string,
	session: AgentSession,
	output: SlashCommandRuntime["output"],
): Promise<void> {
	if (session.isStreaming) {
		await output(t("Cannot pin an account while the session is streaming."));
		return;
	}
	let accountList: SessionOAuthAccountList | undefined;
	try {
		accountList = await session.listCurrentProviderOAuthAccounts();
	} catch (error) {
		await output(t("Could not load provider accounts: {error}", { error: errorMessage(error) }));
		return;
	}
	if (!accountList) {
		await output(t("Select a model before pinning a provider account."));
		return;
	}
	const provider = getOAuthProviders().find(candidate => candidate.id === accountList.provider);
	const providerName = provider?.name ?? accountList.provider;
	const accounts = toSessionPinAccounts(accountList.accounts);
	if (accounts.length === 0) {
		const source = session.modelRegistry.authStorage.describeCredentialSource(
			accountList.provider,
			session.sessionId,
		);
		await output(
			source
				? t("No stored OAuth accounts for {provider}. Current auth comes from {source}.", {
						provider: providerName,
						source,
					})
				: t("No stored OAuth accounts for {provider}. Use /login to add one.", { provider: providerName }),
		);
		return;
	}

	const selector = arg.trim();
	if (!selector) {
		const lines = [t("OAuth accounts for {provider}:", { provider: providerName })];
		for (const account of accounts) {
			lines.push(
				t("{position}. {label}", {
					position: account.position + 1,
					label: `${account.label}${account.active ? " (active)" : ""}`,
				}),
			);
		}
		lines.push("", t("Pin one with `/session pin <number|email|account id>`."));
		await output(lines.join("\n"));
		return;
	}

	const matches = matchSessionPinAccounts(accounts, selector);
	if (matches.length === 0) {
		await output(t('No {provider} account matches "{selector}".', { provider: providerName, selector }));
		return;
	}
	if (matches.length > 1) {
		await output(
			t('"{selector}" matches multiple {provider} accounts: {list}. Use the account number.', {
				selector,
				provider: providerName,
				list: matches.map(account => `${account.position + 1}. ${account.label}`).join(", "),
			}),
		);
		return;
	}
	const account = matches[0];
	if (!account || !session.pinCurrentProviderOAuthAccount(account.credentialId)) {
		await output(t("{label} is no longer available to pin.", { label: account?.label ?? selector }));
		return;
	}
	await output(t("Pinned {label} to this session for {provider}.", { label: account.label, provider: providerName }));
}

export const BUILTIN_SESSION_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "todo",
		icon: "todo",
		description: "View or modify the agent's todo list",
		acpDescription: "Manage todos",
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "edit", description: t("Open todos in $EDITOR (Markdown round-trip)") },
			{ name: "copy", description: t("Copy todos as Markdown to clipboard") },
			{ name: "export", description: t("Write todos as Markdown to a file (default: TODO.md)"), usage: "[<path>]" },
			{ name: "import", description: t("Replace todos from a Markdown file (default: TODO.md)"), usage: "[<path>]" },
			{
				name: "append",
				description: t("Append a task; phase fuzzy-matched or auto-created"),
				usage: "[<phase>] <task...>",
			},
			{ name: "start", description: t("Mark task in_progress (fuzzy-matched)"), usage: "<task>" },
			{ name: "done", description: t("Mark task/phase/all completed (fuzzy-matched)"), usage: "[<task|phase>]" },
			{ name: "drop", description: t("Mark task/phase/all abandoned (fuzzy-matched)"), usage: "[<task|phase>]" },
			{ name: "rm", description: t("Remove task/phase/all (fuzzy-matched)"), usage: "[<task|phase>]" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const tasks = runtime.ctx.todoPhases.flatMap(phase => phase.tasks);
			if (tasks.length === 0) return t("Todos: none");
			const pending = tasks.filter(task => task.status === "pending").length;
			const inProgress = tasks.filter(task => task.status === "in_progress").length;
			const completed = tasks.filter(task => task.status === "completed").length;
			return t("Todos: {open} open ({inProgress} in progress, {done} done)", {
				open: pending + inProgress,
				inProgress,
				done: completed,
			});
		},
		handle: handleTodoAcp,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleTodoCommand(command.args);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "session",
		icon: "session",
		description: "Session management commands",
		acpDescription: "Show or configure the current session",
		acpInputHint: "[info|delete|pin [account]]",
		subcommands: [
			{ name: "info", description: t("Show session info and stats") },
			{ name: "delete", description: t("Delete current session and return to selector") },
			{
				name: "pin",
				description: t("Pin the current provider to a stored OAuth account"),
				usage: "[account]",
			},
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "info" && !rest)) {
				await runtime.output(
					[
						t("Session: {id}", { id: runtime.session.sessionId }),
						t("Title: {title}", { title: runtime.session.sessionName }),
						t("CWD: {cwd}", { cwd: runtime.cwd }),
					].join("\n"),
				);
				return commandConsumed();
			}
			if (verb === "delete" && !rest) {
				if (runtime.session.isStreaming) return usage(t("Cannot delete the session while streaming."), runtime);
				const sessionFile = runtime.sessionManager.getSessionFile();
				if (!sessionFile) return usage(t("No session file to delete (in-memory session)."), runtime);
				// Route through the active SessionManager so the persist writer is
				// closed before the file is deleted. Constructing a fresh
				// FileSessionStorage and calling deleteSessionWithArtifacts leaves
				// the active writer attached to the now-deleted path, so the next
				// prompt would silently resurrect or corrupt the "deleted" file.
				try {
					await runtime.sessionManager.dropSession(sessionFile);
				} catch (err) {
					return usage(t("Failed to delete session: {error}", { error: errorMessage(err) }), runtime);
				}
				await runtime.output(
					t("Session deleted: {file}. Use ACP `session/load` to switch to another session.", {
						file: sessionFile,
					}),
				);
				return commandConsumed();
			}
			if (verb === "pin") {
				await handleSessionPinCommand(rest, runtime.session, runtime.output);
				return commandConsumed();
			}
			return usage(t("Usage: /session [info|delete|pin [account]]"), runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (verb === "delete" && !rest) {
				runtime.ctx.editor.setText("");
				await runtime.ctx.handleSessionDeleteCommand();
				return;
			}
			if (verb === "pin") {
				if (rest) {
					await handleSessionPinCommand(rest, runtime.ctx.session, text => runtime.ctx.showStatus(text));
					refreshStatusLine(runtime.ctx);
				} else {
					await runtime.ctx.showSessionPinSelector();
				}
				runtime.ctx.editor.setText("");
				return;
			}
			if (!verb || (verb === "info" && !rest)) {
				await runtime.ctx.handleSessionCommand();
			} else {
				runtime.ctx.showStatus(t("Usage: /session [info|delete|pin [account]]"));
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "jobs",
		icon: "jobs",
		description: "Show async background jobs status",
		acpDescription: "Show background jobs",
		getTuiAutocompleteDescription: runtime => {
			const snapshot = runtime.ctx.session.getAsyncJobSnapshot({ recentLimit: 5 });
			if (!snapshot || (snapshot.running.length === 0 && snapshot.recent.length === 0)) return t("Jobs: none");
			return t("Jobs: {running} running, {recent} recent", {
				running: snapshot.running.length,
				recent: snapshot.recent.length,
			});
		},
		handle: async (_command, runtime) => {
			const snapshot = runtime.session.getAsyncJobSnapshot({ recentLimit: 5 });
			if (!snapshot || (snapshot.running.length === 0 && snapshot.recent.length === 0)) {
				await runtime.output(
					t(
						"No background jobs running. (Background jobs run async tools — e.g. long-running bash, debug, or task subagents that would otherwise tie up a turn. They appear here while alive and for ~5 minutes after.)",
					),
				);
				return commandConsumed();
			}
			const now = Date.now();
			const lines: string[] = [t("Background Jobs"), t("Running: {count}", { count: snapshot.running.length })];
			if (snapshot.running.length > 0) {
				lines.push("", t("Running Jobs"));
				for (const job of snapshot.running) {
					lines.push(`  [${job.id}] ${job.type} (${job.status}) — ${formatDuration(now - job.startTime)}`);
					lines.push(`    ${job.label}`);
				}
			}
			if (snapshot.recent.length > 0) {
				lines.push("", t("Recent Jobs"));
				for (const job of snapshot.recent) {
					lines.push(`  [${job.id}] ${job.type} (${job.status}) — ${formatDuration(now - job.startTime)}`);
					lines.push(`    ${job.label}`);
				}
			}
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleJobsCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "usage",
		icon: "gauge",
		description: "Show provider usage and limits",
		acpDescription: "Show token usage",
		acpInputHint: "[show|reset [account|active]]",
		subcommands: [
			{ name: "show", description: t("Show provider usage and limits") },
			{ name: "reset", description: t("Spend a saved Codex rate-limit reset"), usage: "[account|active]" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "show" && !rest)) {
				await runtime.output(await buildUsageReportText(runtime));
				return commandConsumed();
			}
			if (verb === "reset") {
				await handleUsageResetCommand(rest, runtime.session, runtime.output);
				return commandConsumed();
			}
			return usage(t("Usage: /usage [show|reset [account|active]]"), runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "show" && !rest)) {
				await runtime.ctx.handleUsageCommand();
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "reset") {
				if (rest) {
					const usageChanged = await handleUsageResetCommand(rest, runtime.ctx.session, text =>
						runtime.ctx.showStatus(text),
					);
					if (usageChanged) {
						runtime.ctx.statusLine.refreshUsage();
						runtime.ctx.ui.requestRender();
					}
				} else {
					await runtime.ctx.showResetUsageSelector();
				}
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus(t("Usage: /usage [show|reset [account|active]]"));
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "stats",
		icon: "stats",
		description: "Launch the local stats dashboard",
		inlineHint: "[--port <port>] [--host <host>]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const parsed = parseStatsDashboardArgs(command.args);
			if ("error" in parsed) return usage(parsed.error, runtime);

			await runtime.output(t("Syncing session files..."));
			try {
				const result = await launchStatsDashboard(parsed);
				await runtime.output(result.message);
			} catch (error) {
				await runtime.output(t("Stats dashboard failed: {error}", { error: errorMessage(error) }));
			}
			return commandConsumed();
		},
	},
	{
		name: "changelog",
		icon: "news",
		description: "Show changelog entries",
		acpDescription: "Show changelog",
		acpInputHint: "[full]",
		subcommands: [{ name: "full", description: t("Show complete changelog") }],
		allowArgs: true,
		handle: async (command, runtime) => {
			const changelogPath = getChangelogPath();
			const allEntries = await parseChangelog(changelogPath);
			const showFull = command.args.trim().toLowerCase() === "full";
			const entriesToShow = showFull ? allEntries : allEntries.slice(0, RECENT_CHANGELOG_ENTRY_LIMIT);
			if (entriesToShow.length === 0) {
				await runtime.output(t("No changelog entries found."));
				return commandConsumed();
			}
			await runtime.output(renderChangelogEntries(entriesToShow).markdown);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const showFull = command.args.split(/\s+/).filter(Boolean).includes("full");
			await runtime.ctx.handleChangelogCommand(showFull);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "hotkeys",
		icon: "keyboard",
		description: "Show all keyboard shortcuts",
		handleTui: (_command, runtime) => {
			runtime.ctx.handleHotkeysCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "tools",
		icon: "tools",
		description: "Show tools currently visible to the agent",
		acpDescription: "Show available tools",
		getTuiAutocompleteDescription: runtime => {
			const active = runtime.ctx.session.getActiveToolNames().length;
			const all = runtime.ctx.session.getAllToolNames().length;
			return all === 0 ? t("Tools: none available") : t("Tools: {active} active / {all} available", { active, all });
		},
		handle: async (_command, runtime) => {
			const active = runtime.session.getActiveToolNames();
			const all = runtime.session.getAllToolNames();
			if (all.length === 0) {
				await runtime.output(t("No tools are available."));
				return commandConsumed();
			}
			const lines = all.map(name => `${active.includes(name) ? "*" : "-"} ${name}`);
			for (const mounted of runtime.session.getXdevToolEntries()) {
				lines.push(`~ xd://${mounted.name}`);
			}
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleToolsCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "context",
		icon: "context",
		description: "Show estimated context usage breakdown",
		acpDescription: "Show context usage",
		getTuiAutocompleteDescription: runtime => {
			const usage = runtime.ctx.session.getContextUsage();
			if (!usage) return t("Context: unavailable");
			return t("Context: {percent}% ({used}/{total})", {
				percent: Math.round(usage.percent),
				used: formatTokenCount(usage.tokens),
				total: formatTokenCount(usage.contextWindow),
			});
		},
		handle: async (_command, runtime) => {
			await runtime.output(buildContextReportText(runtime));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleContextCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "extensions",
		aliases: ["status"],
		icon: "extension",
		description: "Open Extension Control Center dashboard",
		handleTui: (_command, runtime) => {
			runtime.ctx.showExtensionsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "agents",
		icon: "agents",
		description: "Open the agents hub (per-agent model, prewalk, and advisor)",
		handleTui: (_command, runtime) => {
			runtime.ctx.showAgentsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "branch",
		icon: "branch",
		description: "Create a new branch from a previous message",
		handleTui: (_command, runtime) => {
			if (settings.get("doubleEscapeAction") === "tree") {
				runtime.ctx.showTreeSelector();
			} else {
				runtime.ctx.showUserMessageSelector();
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "fork",
		icon: "branch",
		description: "Create a new fork from a previous message",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleForkCommand();
		},
	},
	{
		name: "tree",
		icon: "tree",
		description: "Navigate session tree (switch branches)",
		handleTui: (_command, runtime) => {
			runtime.ctx.showTreeSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "login",
		icon: "signIn",
		description: "Login with OAuth provider",
		inlineHint: "[provider|redirect URL]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.oauthManualInput.hasPending()
				? t("Login: waiting for {provider} callback", {
						provider: runtime.ctx.oauthManualInput.pendingProviderId ?? "OAuth",
					})
				: t("Login: choose provider"),
		handleTui: (command, runtime) => {
			const manualInput = runtime.ctx.oauthManualInput;
			const args = command.args.trim();
			if (args.length > 0) {
				const matchedProvider = getOAuthProviders().find(provider => provider.id === args);
				if (matchedProvider) {
					if (manualInput.hasPending()) {
						const pendingProvider = manualInput.pendingProviderId;
						const message = pendingProvider
							? t("OAuth login already in progress for {provider}. Paste the redirect URL with /login <url>.", {
									provider: pendingProvider,
								})
							: t("OAuth login already in progress. Paste the redirect URL with /login <url>.");
						runtime.ctx.showWarning(message);
						runtime.ctx.editor.setText("");
						return;
					}
					void runtime.ctx.showOAuthSelector("login", matchedProvider.id);
					runtime.ctx.editor.setText("");
					return;
				}
				const submitted = manualInput.submit(args);
				if (submitted) {
					runtime.ctx.showStatus(t("OAuth callback received; completing login…"));
				} else {
					runtime.ctx.showWarning(t("No OAuth login is waiting for a manual callback."));
				}
				runtime.ctx.editor.setText("");
				return;
			}

			if (manualInput.hasPending()) {
				const provider = manualInput.pendingProviderId;
				const message = provider
					? t("OAuth login already in progress for {provider}. Paste the redirect URL with /login <url>.", {
							provider,
						})
					: t("OAuth login already in progress. Paste the redirect URL with /login <url>.");
				runtime.ctx.showWarning(message);
				runtime.ctx.editor.setText("");
				return;
			}

			void runtime.ctx.showOAuthSelector("login");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "logout",
		icon: "signOut",
		description: "Logout from OAuth provider",
		inlineHint: "[provider]",
		allowArgs: true,
		handleTui: (command, runtime) => {
			const providerId = command.args.trim();
			if (providerId) {
				const matchedProvider = getOAuthProviders().find(provider => provider.id === providerId);
				if (!matchedProvider) {
					runtime.ctx.showWarning(t("Unknown OAuth provider: {provider}", { provider: providerId }));
					runtime.ctx.editor.setText("");
					return;
				}
				void runtime.ctx.showOAuthSelector("logout", matchedProvider.id);
				runtime.ctx.editor.setText("");
				return;
			}
			void runtime.ctx.showOAuthSelector("logout");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "mcp",
		icon: "mcp",
		description: "Manage MCP servers (add, list, remove, test)",
		acpDescription: "Manage MCP servers",
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				description: t("Add a new MCP server"),
				usage: "<name> [--scope project|user] [--url <url>] [-- <command...>]",
			},
			{ name: "list", description: t("List all configured MCP servers") },
			{ name: "remove", description: t("Remove an MCP server"), usage: "<name> [--scope project|user]" },
			{ name: "test", description: t("Test connection to a server"), usage: "<name>" },
			{ name: "reauth", description: t("Reauthorize OAuth for a server"), usage: "<name>" },
			{ name: "unauth", description: t("Remove OAuth auth from a server"), usage: "<name>" },
			{ name: "enable", description: t("Enable an MCP server"), usage: "<name>" },
			{ name: "disable", description: t("Disable an MCP server"), usage: "<name>" },
			{
				name: "smithery-search",
				description: t("Search Smithery registry and deploy an MCP server"),
				usage: "<keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			},
			{ name: "smithery-login", description: t("Login to Smithery and cache API key") },
			{ name: "smithery-logout", description: t("Remove cached Smithery API key") },
			{ name: "reconnect", description: t("Reconnect to a specific MCP server"), usage: "<name>" },
			{ name: "reload", description: t("Force reload MCP runtime tools") },
			{ name: "resources", description: t("List available resources from connected servers") },
			{ name: "prompts", description: t("List available prompts from connected servers") },
			{ name: "notifications", description: t("Show notification capabilities and subscriptions") },
			{ name: "help", description: t("Show help message") },
		],
		allowArgs: true,
		handle: handleMcpAcp,
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMCPCommand(command.text);
		},
	},
];
