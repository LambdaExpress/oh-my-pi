import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { type AutocompleteItem, Spacer } from "@oh-my-pi/pi-tui";
import { APP_NAME, getMCPConfigPath, getProjectDir, logger, setProjectDir } from "@oh-my-pi/pi-utils";
import { reset as resetCapabilities } from "../capability";
import { COLLAB_GUEST_ALLOWED_COMMANDS, CollabGuestLink } from "../collab/guest";
import { CollabHost } from "../collab/host";
import {
	expandRoleAlias,
	formatModelString,
	getModelMatchPreferences,
	resolveCliModel,
} from "../config/model-resolver";
import { applyProviderGlobalsFromSettings } from "../config/provider-globals";
import type { SettingPath, SettingValue } from "../config/settings";
import { settings } from "../config/settings";
import {
	clearPluginRootsAndCaches,
	resolveActiveProjectRegistryPath,
	resolveOrDefaultProjectRegistryPath,
} from "../discovery/helpers.js";
import { parseExportArgs } from "../export/html/args";
import { shareSession } from "../export/share";
import { PluginManager } from "../extensibility/plugins";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../extensibility/plugins/marketplace";
import { t } from "../i18n";
import { readMCPConfigFile } from "../mcp/config-writer";
import { memoryStatsUnavailableMessage, resolveMemoryBackend } from "../memory-backend";
import { runPauseScreen } from "../modes/components/pause-screen";
import { collectMcpServerNames, MCPCommandController } from "../modes/controllers/mcp-command-controller";
import { describeLoopLimitRuntime } from "../modes/loop-limit";
import { theme } from "../modes/theme/theme";
import type { InteractiveModeContext } from "../modes/types";
import { extractLastCodeBlock, extractLastCommand } from "../modes/utils/copy-targets";
import type { AgentSession, FreshSessionResult } from "../session/agent-session";
import type { SessionOAuthAccountList } from "../session/agent-session-types";
import { COMPACT_MODES, parseCompactArgs } from "../session/compact-modes";
import { resolveResumableSession } from "../session/session-listing";
import { formatShakeSummary, type ShakeMode } from "../session/shake-types";
import type { ComputerTool } from "../tools/computer";
import { computerExposureMode } from "../tools/computer/exposure";
import { expandTilde, resolveToCwd } from "../tools/path-utils";
import { urlHyperlinkAlways } from "../tui";
import {
	getChangelogPath,
	parseChangelog,
	RECENT_CHANGELOG_ENTRY_LIMIT,
	renderChangelogEntries,
} from "../utils/changelog";
import { copyToClipboard } from "../utils/clipboard";
import type { InspectImageMode } from "../utils/inspect-image-mode";
import { CollabQrCodeComponent } from "./helpers/collab-qrcode";
import { buildContextReportText } from "./helpers/context-report";
import { formatDuration } from "./helpers/format";
import { createMarketplaceManager } from "./helpers/marketplace-manager";
import { handleMcpAcp } from "./helpers/mcp";
import { commandConsumed, errorMessage, parseSlashCommand, parseSubcommand, usage } from "./helpers/parse";
import { describeRedeemOutcome, type ResetUsageAccount, toResetUsageAccounts } from "./helpers/reset-usage";
import { handleSecurityCommand } from "./helpers/security";
import { matchSessionPinAccounts, toSessionPinAccounts } from "./helpers/session-pin";
import { handleSshAcp } from "./helpers/ssh";
import { launchStatsDashboard, parseStatsDashboardArgs } from "./helpers/stats-dashboard";
import { handleTodoAcp } from "./helpers/todo";
import { buildUsageReportText } from "./helpers/usage-report";
import { parseMarketplaceInstallArgs, parsePluginScopeArgs } from "./marketplace-install-parser";
import type {
	BuiltinSlashCommand,
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	SubcommandDef,
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

function refreshStatusLine(ctx: InteractiveModeContext): void {
	ctx.statusLine.invalidate();
	ctx.ui.requestRender();
}

/** `/fast status` label for the active model: "on" when its family is priority, else "off". */
function formatFastModeStatus(session: AgentSession): string {
	return session.isFastModeEnabled() ? "on" : "off";
}

/** Detailed, session-effective `/computer status` diagnostics. */
async function formatComputerUseStatus(session: AgentSession): Promise<string> {
	const enabled = session.settings.get("computer.enabled");
	const active = session.getEnabledToolNames().includes("computer");
	const model = session.model;
	const modelName = model ? formatModelString(model) : "none";
	const exposure = !enabled
		? t("not exposed (disabled)")
		: !active
			? t("not exposed (tool inactive)")
			: computerExposureMode(model);
	const configured = {
		display: session.settings.get("computer.display"),
		maxWidth: session.settings.get("computer.maxWidth"),
		maxHeight: session.settings.get("computer.maxHeight"),
	};
	const computerTool = active
		? (session.getToolByName("computer") as Pick<ComputerTool, "capabilities"> | undefined)
		: undefined;
	const capabilities = await computerTool?.capabilities();
	const capabilityStatus = capabilities
		? [
				`backend=${capabilities.backend}${capabilities.displayServer ? `/${capabilities.displayServer}` : ""}`,
				`capture=${capabilities.capture} (${capabilities.capturePermission})`,
				`input=${capabilities.input} (${capabilities.inputPermission})`,
				`ax=${capabilities.ax} (${capabilities.axPermission})`,
				`backgroundWindowInput=${capabilities.backgroundWindowInput}`,
				`deliveryModes=${capabilities.deliveryModes.join(",") || "none"}`,
			].join(", ")
		: t("session not started");
	return [
		t("Computer use: {status}", { status: enabled ? "enabled" : "disabled" }),
		t("tool: {status}", { status: active ? "active" : "inactive" }),
		t("exposure: {exposure}", { exposure }),
		t("model: {model}", { model: modelName }),
		t("configured: display={display}, maxWidth={maxWidth}, maxHeight={maxHeight}", {
			display: configured.display,
			maxWidth: configured.maxWidth,
			maxHeight: configured.maxHeight,
		}),
		t("capabilities: {status}", { status: capabilityStatus }),
	].join(" · ");
}

/**
 * Apply a session-scoped computer-use toggle: flip the active tool slate first
 * (so a failed enable never leaves a stale settings override), then record the
 * runtime override — never `settings.set`, which would persist to settings.json.
 * Returns the operator feedback line.
 */
async function applyComputerUseToggle(session: AgentSession, enable: boolean): Promise<string> {
	const applied = await session.setComputerToolEnabled(enable);
	if (enable && !applied) {
		return t("Computer use is unavailable in this session.");
	}
	session.settings.override("computer.enabled", enable);
	return enable
		? t("Computer use enabled for this session. {status}", { status: await formatComputerUseStatus(session) })
		: t("Computer use disabled for this session.");
}

/** Session-effective `/vision status` line. */
function formatVisionStatus(session: AgentSession): string {
	const { mode, active, model } = session.inspectImageState();
	const override = session.getInspectImageModeOverride();
	const modelObj = session.model;
	const capability = modelObj
		? modelObj.input.includes("image")
			? t("native image input")
			: t("no native image input")
		: t("no active model");
	return [
		t("inspect_image: {status}", { status: active ? "active" : "inactive" }),
		t("mode: {mode}{override}", { mode, override: override ? t(" (session override)") : "" }),
		...(override ? [t("configured: {mode}", { mode: session.settings.get("inspect_image.mode") })] : []),
		t("model: {model} ({capability})", { model: model ?? "none", capability }),
	].join(" · ");
}

/** Applies a `/vision` mode for this session and returns the operator feedback line. */
async function applyVisionMode(session: AgentSession, mode: InspectImageMode): Promise<string> {
	const applied = await session.setInspectImageMode(mode);
	if (!applied) {
		return t("inspect_image is unavailable in this session.");
	}
	return t("Vision mode: {mode}. {status}", { mode, status: formatVisionStatus(session) });
}

const AUTOCOMPLETE_DETAIL_LIMIT = 48;

function shortDetail(value: string, limit = AUTOCOMPLETE_DETAIL_LIMIT): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	return singleLine.length <= limit ? singleLine : `${singleLine.slice(0, limit - 1)}…`;
}

function formatTokenCount(value: number): string {
	return value.toLocaleString();
}

/** Scheme-less display form of a browser deep link: accent + underline, OSC-8 linked to the full URL. */
function collabWebLinkClickable(webLink: string): string {
	const display = theme.fg("accent", `\x1b[4m${webLink.replace(/^https?:\/\//, "")}\x1b[24m`);
	return urlHyperlinkAlways(webLink, display);
}

/** Join hint printed by /collab: compact terminal link + clickable browser deep link. */
function collabLinkHint(host: CollabHost, heading: string, view = false): string {
	const bullet = theme.fg("accent", theme.format.bullet);
	const link = view ? host.viewLink : host.link;
	const webLink = view ? host.webViewLink : host.webLink;
	return [
		theme.fg("success", heading),
		` ${bullet} ${theme.fg("muted", view ? t("Watch from another terminal:") : t("Join from another terminal:"))} ${APP_NAME} join "${link}"`,
		` ${bullet} ${theme.fg("muted", t("or any web browser:"))} ${collabWebLinkClickable(webLink)}`,
		theme.fg(
			"dim",
			view
				? t("Anyone with this link can watch the session but cannot prompt the agent.")
				: t("Anyone with the link can read the session and prompt the agent. Read-only link: /collab view"),
		),
	].join("\n");
}

function showCollabQrCode(ctx: InteractiveModeContext, webLink: string): void {
	try {
		ctx.present([new Spacer(1), new CollabQrCodeComponent(webLink)]);
	} catch (err) {
		ctx.showError(t("Failed to render collab QR code: {error}", { error: errorMessage(err) }));
	}
}

function showCollabLink(ctx: InteractiveModeContext, host: CollabHost, heading: string, view = false): void {
	ctx.showStatus(collabLinkHint(host, heading, view), { dim: false });
	showCollabQrCode(ctx, view ? host.webViewLink : host.webLink);
}

function formatFreshSessionResult(result: FreshSessionResult): string {
	const stateLabel = result.closedProviderSessions === 1 ? "provider state" : "provider states";
	return t("Fresh provider session started ({count} {stateLabel} pruned).", {
		count: result.closedProviderSessions,
		stateLabel,
	});
}

const shutdownHandlerTui = (_command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime): SlashCommandResult => {
	runtime.ctx.editor.setText("");
	void runtime.ctx.shutdown();
	return commandConsumed();
};

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

const BUILTIN_SLASH_COMMAND_REGISTRY: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "security",
		description: t("Plan, run, inspect, import, and compare OMP-native security scans"),
		allowArgs: true,
		acpInputHint: "<plan|scan|status|cancel|scans|show|import|export|validate|compare|disposition>",
		subcommands: [
			{ name: "plan", description: t("Create an immutable security scan plan") },
			{ name: "scan", description: t("Start a planned or newly planned native scan") },
			{ name: "status", description: t("Show native scan operation status") },
			{ name: "cancel", description: t("Cancel a running native scan") },
			{ name: "scans", description: t("List stored project security scans") },
			{ name: "show", description: t("Render a scan or security:// resource") },
			{ name: "import", description: t("Import SARIF or a Codex Security bundle") },
			{ name: "export", description: t("Export a canonical bundle, SARIF, or report") },
			{ name: "validate", description: t("Validate one finding with OMP-native tools") },
			{ name: "compare", description: t("Compare finding lineage across two scans") },
			{ name: "disposition", description: t("Set a finding disposition with rationale") },
		],
		handle: handleSecurityCommand,
	},
	{
		name: "settings",
		description: t("Open settings menu"),
		handleTui: (_command, runtime) => {
			runtime.ctx.showSettingsSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "setup",
		aliases: ["providers"],
		description: t("Open provider setup"),
		allowArgs: true,
		subcommands: [{ name: "providers", description: t("Configure sign-in and web search providers") }],
		handleTui: async (command, runtime) => {
			const args = command.args.trim().toLowerCase();
			const opensProviders = args === "" || args === "providers";
			if (opensProviders) {
				await runtime.ctx.showProviderSetup();
			} else {
				runtime.ctx.showWarning(t("Usage: /{name} [providers]", { name: command.name }));
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "plan",
		description: t("Toggle plan mode (agent plans before executing)"),
		inlineHint: "[prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.settings.get("plan.enabled" as SettingPath)) return t("Plan: disabled in settings");
			if (runtime.ctx.planModeEnabled) {
				const planFile = runtime.ctx.planModePlanFilePath;
				return t("Plan: on{details}", { details: planFile ? ` (${path.basename(planFile)})` : "" });
			}
			if (runtime.ctx.goalModeEnabled) return t("Plan: blocked by goal mode");
			return t("Plan: off");
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handlePlanModeCommand(command.args || undefined);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "plan-review",
		description: t("Re-open the plan review for the latest plan (plan mode only)"),
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.planModeEnabled ? t("Plan review: available") : t("Plan review: plan mode inactive"),
		handleTui: async (_command, runtime) => {
			await runtime.ctx.openPlanReview();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "vibe",
		description: t("Toggle vibe mode (direct persistent fast/good worker sessions; read-only toolset)"),
		inlineHint: "[prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.vibeModeEnabled) return t("Vibe: on");
			if (runtime.ctx.planModeEnabled) return t("Vibe: blocked by plan mode");
			if (runtime.ctx.goalModeEnabled) return t("Vibe: blocked by goal mode");
			return t("Vibe: off");
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleVibeModeCommand(command.args || undefined);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "goal",
		description: t("Toggle goal mode (persistent autonomous objective for this session)"),
		subcommands: [
			{ name: "set", description: t("Set or replace the goal"), usage: "<objective>" },
			{ name: "show", description: t("Show current goal details") },
			{ name: "pause", description: t("Pause the current goal") },
			{ name: "resume", description: t("Resume a paused goal") },
			{ name: "drop", description: t("Drop the current goal") },
			{ name: "budget", description: t("Adjust the token budget"), usage: "<N|off>" },
		],
		inlineHint: "[objective]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.settings.get("goal.enabled" as SettingPath)) return t("Goal: disabled in settings");
			if (runtime.ctx.planModeEnabled) return t("Goal: blocked by plan mode");
			const state = runtime.ctx.session.getGoalModeState();
			return state
				? t("Goal: {status} ({detail})", { status: state.goal.status, detail: shortDetail(state.goal.objective) })
				: t("Goal: off");
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleGoalModeCommand(command.args || undefined);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "guided-goal",
		description: t("Have the agent interview you in chat, then set up goal mode"),
		inlineHint: t("[rough objective]"),
		allowArgs: true,
		handleTui: async (command, runtime) => {
			// Clear the slash draft BEFORE the await: the handler blocks for the
			// whole kickoff turn, and a post-await clear would wipe an answer the
			// user starts typing while the first interview question streams.
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleGuidedGoalCommand(command.args || undefined);
		},
	},
	{
		name: "loop",
		description: t(
			"Toggle loop mode. While enabled, the next prompt you send re-submits after every yield. Esc cancels the current iteration; /loop again to disable.",
		),
		inlineHint: "[count|duration] [prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.loopModeEnabled) return t("Loop: off");
			if (runtime.ctx.loopModePaused) return t("Loop: paused");
			if (runtime.ctx.loopLimit)
				return t("Loop: on ({detail})", { detail: describeLoopLimitRuntime(runtime.ctx.loopLimit) });
			if (runtime.ctx.loopPrompt) return t("Loop: on (repeating prompt)");
			return t("Loop: on (waiting for next prompt)");
		},
		handleTui: async (command, runtime) => {
			const prompt = await runtime.ctx.handleLoopCommand(command.args);
			runtime.ctx.editor.setText("");
			// Surface any inline prompt so the dispatcher returns it and the normal
			// submit flow runs the first loop iteration (recording it as the loop prompt).
			if (prompt) return { prompt };
		},
	},
	{
		name: "queue",
		description: t("Queue a message for after the agent yields"),
		inlineHint: "<message>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleQueueCommand(command.args);
		},
	},
	{
		name: "model",
		aliases: ["models"],
		description: t("Switch model for this session"),
		acpDescription: t("Show current model selection"),
		getTuiAutocompleteDescription: runtime => {
			const model = runtime.ctx.session.model;
			return model ? t("Model: {model}", { model: `${model.provider}/${model.id}` }) : t("Model: none selected");
		},
		handle: async (command, runtime) => {
			if (command.args) {
				const modelId = command.args.trim();
				const availableModels = runtime.session.getAvailableModels?.() ?? [];
				const match = availableModels.find(
					model => model.id === modelId || `${model.provider}/${model.id}` === modelId,
				);
				if (!match) {
					return usage(
						t(
							"Unknown model: {model}. Use ACP `session/setModel` for picker-driven selection or list available models with /model.",
							{
								model: modelId,
							},
						),
						runtime,
					);
				}
				try {
					await runtime.session.setModel(match);
					await runtime.output(t("Model set to {model}.", { model: `${match.provider}/${match.id}` }));
					await runtime.notifyTitleChanged?.();
					await runtime.notifyConfigChanged?.();
					return commandConsumed();
				} catch (err) {
					return usage(t("Failed to set model: {error}", { error: errorMessage(err) }), runtime);
				}
			}

			const model = runtime.session.model;
			await runtime.output(
				model
					? t("Current model: {model}", { model: `${model.provider}/${model.id}` })
					: t("No model is currently selected."),
			);
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.showModelSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "switch",
		description: t("Switch model for this session (same as alt+p)"),
		getTuiAutocompleteDescription: runtime => {
			const model = runtime.ctx.session.model;
			return model ? t("Model: {model}", { model: `${model.provider}/${model.id}` }) : t("Model: none selected");
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.showModelSelector({ temporaryOnly: true });
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "fast",
		description: t("Toggle priority service tier (OpenAI service_tier=priority, Anthropic speed=fast)"),
		acpDescription: t("Toggle fast mode"),
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: t("Enable fast mode") },
			{ name: "off", description: t("Disable fast mode") },
			{ name: "status", description: t("Show fast mode status") },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			t("Fast: {status}", { status: formatFastModeStatus(runtime.ctx.session) }),
		handle: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.session.toggleFastMode();
				await runtime.output(t("Fast mode {status}.", { status: enabled ? "enabled" : "disabled" }));
				return commandConsumed();
			}
			if (arg === "on") {
				const supported = runtime.session.setFastMode(true);
				await runtime.output(
					supported ? t("Fast mode enabled.") : t("Fast mode is unavailable for the current model."),
				);
				return commandConsumed();
			}
			if (arg === "off") {
				runtime.session.setFastMode(false);
				await runtime.output(t("Fast mode disabled."));
				return commandConsumed();
			}
			if (arg === "status") {
				await runtime.output(t("Fast mode is {status}.", { status: formatFastModeStatus(runtime.session) }));
				return commandConsumed();
			}
			return usage(t("Usage: /fast [on|off|status]"), runtime);
		},
		handleTui: (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.ctx.session.toggleFastMode();
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(t("Fast mode {status}.", { status: enabled ? "enabled" : "disabled" }));
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "on") {
				const supported = runtime.ctx.session.setFastMode(true);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(
					supported ? t("Fast mode enabled.") : t("Fast mode is unavailable for the current model."),
				);
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "off") {
				runtime.ctx.session.setFastMode(false);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(t("Fast mode disabled."));
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "status") {
				runtime.ctx.showStatus(t("Fast mode is {status}.", { status: formatFastModeStatus(runtime.ctx.session) }));
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus(t("Usage: /fast [on|off|status]"));
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "computer",
		description: t("Toggle the native computer-use tool for this session"),
		acpDescription: t("Toggle computer use"),
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: t("Enable computer use for this session") },
			{ name: "off", description: t("Disable computer use for this session") },
			{ name: "status", description: t("Show computer use status") },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			t("Computer: {status}", {
				status: runtime.ctx.session.settings.get("computer.enabled") ? "on" : "off",
			}),
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				await runtime.output(await formatComputerUseStatus(runtime.session));
				return commandConsumed();
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enable = arg === "off" ? false : arg === "on" || !runtime.session.settings.get("computer.enabled");
				await runtime.output(await applyComputerUseToggle(runtime.session, enable));
				return commandConsumed();
			}
			return usage(t("Usage: /computer [on|off|status]"), runtime);
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				runtime.ctx.showStatus(await formatComputerUseStatus(runtime.ctx.session));
				runtime.ctx.editor.setText("");
				return;
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enable =
					arg === "off" ? false : arg === "on" || !runtime.ctx.session.settings.get("computer.enabled");
				runtime.ctx.showStatus(await applyComputerUseToggle(runtime.ctx.session, enable));
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus(t("Usage: /computer [on|off|status]"));
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "vision",
		description: t("Control the inspect_image vision-delegation tool for this session"),
		acpDescription: t("Toggle vision delegation"),
		acpInputHint: "[on|off|auto|status]",
		subcommands: [
			{ name: "on", description: t("Always expose inspect_image this session") },
			{ name: "off", description: t("Never expose inspect_image this session") },
			{ name: "auto", description: t("Follow inspect_image.mode (auto hides it for vision-capable models)") },
			{ name: "status", description: t("Show inspect_image status") },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			t("Vision: {mode}", { mode: runtime.ctx.session.inspectImageState().mode }),
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				await runtime.output(formatVisionStatus(runtime.session));
				return commandConsumed();
			}
			if (arg === "on" || arg === "off" || arg === "auto") {
				await runtime.output(await applyVisionMode(runtime.session, arg));
				return commandConsumed();
			}
			return usage(t("Usage: /vision [on|off|auto|status]"), runtime);
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				runtime.ctx.showStatus(formatVisionStatus(runtime.ctx.session));
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "on" || arg === "off" || arg === "auto") {
				runtime.ctx.showStatus(await applyVisionMode(runtime.ctx.session, arg));
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus(t("Usage: /vision [on|off|auto|status]"));
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "prewalk",
		description: t("Switch to a fast/cheap model at the next action (works even without --prewalk)"),
		acpDescription: t("Prewalk at the next action"),
		handle: async (_command, runtime) => {
			const rolePattern = expandRoleAlias("@smol", runtime.settings);
			const resolved = resolveCliModel({
				cliModel: rolePattern,
				modelRegistry: runtime.session.modelRegistry,
				preferences: getModelMatchPreferences(runtime.settings),
			});
			if (resolved.error || !resolved.model) {
				return usage(resolved.error ?? t('Model "{model}" not found', { model: rolePattern }), runtime);
			}
			if (!runtime.session.modelRegistry.hasConfiguredAuth(resolved.model)) {
				return usage(
					t("No API key for {model}", { model: `${resolved.model.provider}/${resolved.model.id}` }),
					runtime,
				);
			}
			// Only report success when the requested arm remains active: arming
			// a no-op target (already on it) or a target that loses to an
			// existing arm is silent, so the status line is not spammed.
			const armed = runtime.session.armPrewalk(resolved.model, resolved.thinkingLevel);
			if (armed) {
				await runtime.output(
					t("Prewalk on: switching to {model} at the next edit/write (todo-gated).", {
						model: `${resolved.model.provider}/${resolved.model.id}`,
					}),
				);
			}
			return commandConsumed();
		},
	},
	{
		name: "advisor",
		description: t("Toggle the advisor (a second model that reviews each turn and injects notes)"),
		acpDescription: t("Toggle advisor"),
		acpInputHint: "[on|off|status|dump [raw]|configure]",
		subcommands: [
			{ name: "on", description: t("Enable the advisor") },
			{ name: "off", description: t("Disable the advisor") },
			{ name: "status", description: t("Show advisor status") },
			{ name: "dump", description: t("Copy the advisor's transcript to clipboard"), usage: "[raw]" },
			{ name: "configure", description: t("Open the advisor configuration editor (TUI)") },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const stats = runtime.ctx.session.getAdvisorStats();
			if (stats.active && stats.advisors.length > 1)
				return t("Advisor: on ({count} advisors)", { count: stats.advisors.length });
			if (stats.active && stats.model)
				return t("Advisor: on ({model})", { model: `${stats.model.provider}/${stats.model.id}` });
			if (stats.configured) return t("Advisor: configured, no model");
			return t("Advisor: off");
		},
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || verb === "toggle") {
				const active = runtime.session.toggleAdvisorEnabled();
				const configured = runtime.session.isAdvisorEnabled();
				if (active) {
					await runtime.output(t("Advisor enabled."));
				} else if (configured) {
					await runtime.output(t("Advisor setting enabled, but no model is assigned to the 'advisor' role."));
				} else {
					await runtime.output(t("Advisor disabled."));
				}
				return commandConsumed();
			}
			if (verb === "on") {
				const active = runtime.session.setAdvisorEnabled(true);
				await runtime.output(
					active
						? t("Advisor enabled.")
						: t("Advisor setting enabled, but no model is assigned to the 'advisor' role."),
				);
				return commandConsumed();
			}
			if (verb === "off") {
				runtime.session.setAdvisorEnabled(false);
				await runtime.output(t("Advisor disabled."));
				return commandConsumed();
			}
			if (verb === "status") {
				await runtime.output(runtime.session.formatAdvisorStatus());
				return commandConsumed();
			}
			if (verb === "dump") {
				const isRaw = rest.toLowerCase() === "raw";
				const text = runtime.session.formatAdvisorHistoryAsText({ compact: !isRaw });
				await runtime.output(text ?? t("Advisor is not active for this session."));
				return commandConsumed();
			}
			if (verb === "configure") {
				await runtime.output(
					t("/advisor configure opens an interactive editor and is only available in the interactive TUI."),
				);
				return commandConsumed();
			}
			return usage(t("Usage: /advisor [on|off|status|dump [raw]|configure]"), runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || verb === "toggle") {
				const active = runtime.ctx.session.toggleAdvisorEnabled();
				const configured = runtime.ctx.session.isAdvisorEnabled();
				if (active) {
					runtime.ctx.showStatus(t("Advisor enabled."));
				} else if (configured) {
					runtime.ctx.showStatus(t("Advisor setting enabled, but no model is assigned to the 'advisor' role."));
				} else {
					runtime.ctx.showStatus(t("Advisor disabled."));
				}
				refreshStatusLine(runtime.ctx);
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "on") {
				const active = runtime.ctx.session.setAdvisorEnabled(true);
				runtime.ctx.showStatus(
					active
						? t("Advisor enabled.")
						: t("Advisor setting enabled, but no model is assigned to the 'advisor' role."),
				);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "off") {
				runtime.ctx.session.setAdvisorEnabled(false);
				runtime.ctx.showStatus(t("Advisor disabled."));
				refreshStatusLine(runtime.ctx);
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "status") {
				await runtime.ctx.handleAdvisorStatusCommand();
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "dump") {
				const isRaw = rest.toLowerCase() === "raw";
				runtime.ctx.handleAdvisorDumpCommand(isRaw);
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "configure") {
				runtime.ctx.showAdvisorConfigure();
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus(t("Usage: /advisor [on|off|status|dump [raw]|configure]"));
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "export",
		description: t("Export session to HTML file"),
		inlineHint: "[--themes] [path]",
		allowArgs: true,
		handle: async (command, runtime) => {
			try {
				const { outputPath, useUserThemes } = parseExportArgs(command.args);
				if (outputPath === "--copy" || outputPath === "clipboard" || outputPath === "copy") {
					return usage(t("Use /dump to copy the session to clipboard."), runtime);
				}
				const filePath = await runtime.session.exportToHtml(outputPath, useUserThemes);
				await runtime.output(t("Session exported to: {path}", { path: filePath }));
				return commandConsumed();
			} catch (err) {
				return usage(t("Failed to export session: {error}", { error: errorMessage(err) }), runtime);
			}
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleExportCommand(command.text);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "dump",
		description: t("Copy session transcript to clipboard (and write LLM request JSON to tmp)"),
		acpDescription: t("Return full transcript as plain text, with LLM request JSON path"),
		allowArgs: true,
		handle: async (_command, runtime) => {
			const text = runtime.session.formatSessionAsText();
			if (!text) {
				await runtime.output(t("No messages to dump yet."));
				return commandConsumed();
			}
			let sidecarPath: string | undefined;
			try {
				sidecarPath = await runtime.session.dumpLlmRequestToTmpDir();
			} catch {
				// Sidecar is best-effort; the transcript is still output below.
			}
			const lines = [text];
			if (sidecarPath)
				lines.push(
					"",
					t("LLM request JSON: {path}", { path: sidecarPath }),
					t("This file persists on disk and may contain raw context/secrets — treat accordingly."),
				);
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleDumpCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "share",
		description: t("Share session via an encrypted link (share server or secret gist)"),
		handle: async (_command, runtime) => {
			try {
				const result = await shareSession(runtime.sessionManager, {
					serverUrl: runtime.settings.get("share.serverUrl"),
					store: runtime.settings.get("share.store"),
					state: runtime.session.state,
					obfuscator: runtime.settings.get("share.redactSecrets") ? runtime.session.obfuscator : undefined,
				});
				const lines = [t("Share URL: {url}", { url: result.url })];
				if (result.gistUrl) lines.push(t("Gist: {url}", { url: result.gistUrl }));
				if (result.truncated) lines.push(t("Note: large content was trimmed to fit the share size limit."));
				await runtime.output(lines.join("\n"));
				return commandConsumed();
			} catch (err) {
				return usage(t("Failed to share session: {error}", { error: errorMessage(err) }), runtime);
			}
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleShareCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "collab",
		description: t("Share this session live via a relay"),
		inlineHint: "[start|view|stop|status] [relayUrl]",
		subcommands: [
			{ name: "view", description: t("Share a read-only link (guests can watch, not prompt)") },
			{ name: "status", description: t("Show link + participants") },
			{ name: "stop", description: t("Stop sharing") },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.collabHost) {
				return t("Collab: hosting ({count} guests)", {
					count: Math.max(0, runtime.ctx.collabHost.participants.length - 1),
				});
			}
			if (runtime.ctx.collabGuest?.readOnly) return t("Collab: read-only guest");
			if (runtime.ctx.collabGuest) return t("Collab: guest");
			return t("Collab: off");
		},
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			const args = command.args.trim();
			const { verb, rest } = parseSubcommand(args);
			if (verb === "stop") {
				if (!ctx.collabHost) {
					ctx.showStatus(t("Not hosting a collab session"));
					return;
				}
				await ctx.collabHost.stop("host stopped");
				ctx.showStatus(t("Collab stopped"));
				return;
			}
			if (verb === "status") {
				if (ctx.collabHost) {
					const names = ctx.collabHost.participants.map(p =>
						p.role === "host"
							? `${p.name} ${t("(host)")}`
							: p.readOnly
								? `${p.name} ${t("(view-only)")}`
								: p.name,
					);
					ctx.showStatus(
						t("Collab: {names} — {link}", {
							names: names.join(", "),
							link: collabWebLinkClickable(ctx.collabHost.webLink),
						}),
					);
				} else if (ctx.collabGuest) {
					ctx.showStatus(
						ctx.collabGuest.readOnly
							? t("In a collab session as a read-only guest (/leave to exit)")
							: t("In a collab session as a guest (/leave to exit)"),
					);
				} else {
					ctx.showStatus(t("Not in a collab session"));
				}
				return;
			}
			if (ctx.collabGuest) {
				ctx.showError(t("Already in a collab session as a guest (/leave first)"));
				return;
			}
			const knownStartVerb = verb === "start" || verb === "view";
			const view = verb === "view";
			if (ctx.collabHost) {
				showCollabLink(
					ctx,
					ctx.collabHost,
					view ? t("Read-only collab session active") : t("Collab session active"),
					view,
				);
				return;
			}
			const explicitUrl = knownStartVerb ? rest : args;
			const relayInput = explicitUrl || ctx.settings.get("collab.relayUrl") || "";
			if (!relayInput) {
				ctx.showError(
					t("No relay configured. Set collab.relayUrl in /settings or pass one: /collab relay.example.com"),
				);
				return;
			}
			// Scheme-less relay args default to wss (ws:// must be spelled out for localhost).
			const relayUrl = relayInput.includes("://") ? relayInput : `wss://${relayInput}`;
			const webUrl = ctx.settings.get("collab.webUrl") || "";
			const host = new CollabHost(ctx);
			try {
				await host.start(relayUrl, webUrl);
			} catch (err) {
				ctx.showError(t("Failed to start collab session: {error}", { error: errorMessage(err) }));
				return;
			}
			ctx.collabHost = host;
			showCollabLink(ctx, host, t("Collab session started!"), view);
		},
	},
	{
		name: "join",
		description: t("Join a shared collab session"),
		inlineHint: "<link>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			const link = command.args.trim();
			if (!link) {
				ctx.showError(t("Usage: /join <link>"));
				return;
			}
			if (ctx.collabHost) {
				ctx.showError(t("Stop hosting first (/collab stop)"));
				return;
			}
			if (ctx.collabGuest) {
				ctx.showError(t("Already in a collab session (/leave first)"));
				return;
			}
			try {
				await new CollabGuestLink(ctx).join(link);
			} catch (err) {
				ctx.showError(t("Failed to join collab session: {error}", { error: errorMessage(err) }));
			}
		},
	},
	{
		name: "leave",
		description: t("Leave the collab session"),
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.collabHost) return t("Leave collab: hosting");
			if (runtime.ctx.collabGuest) return t("Leave collab: guest");
			return t("Leave collab: not in collab");
		},
		handleTui: async (_command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			if (ctx.collabGuest) {
				await ctx.collabGuest.leave("left");
				return;
			}
			if (ctx.collabHost) {
				await ctx.collabHost.stop("host stopped");
				ctx.showStatus(t("Collab stopped"));
				return;
			}
			ctx.showStatus(t("Not in a collab session"));
		},
	},
	{
		name: "browser",
		description: t("Toggle browser headless vs visible mode"),
		acpInputHint: "[headless|visible]",
		subcommands: [
			{ name: "headless", description: t("Switch to headless mode") },
			{ name: "visible", description: t("Switch to visible mode") },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.settings.get("browser.enabled" as SettingPath)) return t("Browser: disabled");
			return runtime.ctx.settings.get("browser.headless" as SettingPath)
				? t("Browser: headless")
				: t("Browser: visible");
		},
		handle: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			const enabled = runtime.settings.get("browser.enabled" as SettingPath) as boolean;
			if (!enabled) return usage(t("Browser tool is disabled (enable in settings)."), runtime);
			const current = runtime.settings.get("browser.headless" as SettingPath) as boolean;
			let next = current;
			if (!arg) next = !current;
			else if (arg === "headless" || arg === "hidden") next = true;
			else if (arg === "visible" || arg === "show" || arg === "headful") next = false;
			else return usage(t("Usage: /browser [headless|visible]"), runtime);
			runtime.settings.set("browser.headless" as SettingPath, next as SettingValue<SettingPath>);
			const tool = runtime.session.getToolByName("browser");
			if (tool && "restartForModeChange" in tool) {
				try {
					await (tool as { restartForModeChange: () => Promise<void> }).restartForModeChange();
				} catch (err) {
					// Setting was already mutated; surface the restart failure so the
					// user knows the browser is in an inconsistent state.
					await runtime.output(
						t("Browser mode set to {mode}, but restart failed: {error}", {
							mode: next ? "headless" : "visible",
							error: errorMessage(err),
						}),
					);
					return commandConsumed();
				}
			}
			await runtime.output(t("Browser mode: {mode}", { mode: next ? "headless" : "visible" }));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			const current = settings.get("browser.headless" as SettingPath) as boolean;
			let next = current;
			if (!(settings.get("browser.enabled" as SettingPath) as boolean)) {
				runtime.ctx.showWarning(t("Browser tool is disabled (enable in settings)"));
				runtime.ctx.editor.setText("");
				return;
			}
			if (!arg) {
				next = !current;
			} else if (arg === "headless" || arg === "hidden") {
				next = true;
			} else if (arg === "visible" || arg === "show" || arg === "headful") {
				next = false;
			} else {
				runtime.ctx.showStatus(t("Usage: /browser [headless|visible]"));
				runtime.ctx.editor.setText("");
				return;
			}
			settings.set("browser.headless" as SettingPath, next as SettingValue<SettingPath>);
			const tool = runtime.ctx.session.getToolByName("browser");
			if (tool && "restartForModeChange" in tool) {
				try {
					await (tool as { restartForModeChange: () => Promise<void> }).restartForModeChange();
				} catch (error) {
					runtime.ctx.showWarning(t("Failed to restart browser: {error}", { error: errorMessage(error) }));
					runtime.ctx.editor.setText("");
					return;
				}
			}
			runtime.ctx.showStatus(t("Browser mode: {mode}", { mode: next ? "headless" : "visible" }));
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "copy",
		description: t("Pick text or code from the conversation to copy"),
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg) {
				runtime.ctx.showCopySelector();
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "code") {
				const block = extractLastCodeBlock(runtime.ctx.session.messages);
				if (!block) {
					runtime.ctx.showStatus(t("No code block to copy."));
					runtime.ctx.editor.setText("");
					return;
				}
				await copyToClipboard(block.code);
				runtime.ctx.showStatus(t("Copied code block to clipboard"));
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "cmd" || arg === "command") {
				const lastCommand = extractLastCommand(runtime.ctx.session.messages);
				if (!lastCommand) {
					runtime.ctx.showStatus(t("No command to copy."));
					runtime.ctx.editor.setText("");
					return;
				}
				await copyToClipboard(lastCommand.code);
				runtime.ctx.showStatus(
					t("Copied {kind} to clipboard", {
						kind: lastCommand.kind === "bash" ? "bash command" : "eval code",
					}),
				);
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus(t("Usage: /copy [code|cmd]"));
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "todo",
		description: t("View or modify the agent's todo list"),
		acpDescription: t("Manage todos"),
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
		description: t("Session management commands"),
		acpDescription: t("Show or configure the current session"),
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
		description: t("Show async background jobs status"),
		acpDescription: t("Show background jobs"),
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
					lines.push(
						t("  [{id}] {type} ({status}) — {duration}", {
							id: job.id,
							type: job.type,
							status: job.status,
							duration: formatDuration(now - job.startTime),
						}),
					);
					lines.push(`    ${job.label}`);
				}
			}
			if (snapshot.recent.length > 0) {
				lines.push("", t("Recent Jobs"));
				for (const job of snapshot.recent) {
					lines.push(
						t("  [{id}] {type} ({status}) — {duration}", {
							id: job.id,
							type: job.type,
							status: job.status,
							duration: formatDuration(now - job.startTime),
						}),
					);
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
		description: t("Show provider usage and limits"),
		acpDescription: t("Show token usage"),
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
		description: t("Launch the local stats dashboard"),
		inlineHint: "[--port <port>]",
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
		description: t("Show changelog entries"),
		acpDescription: t("Show changelog"),
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
		description: t("Show all keyboard shortcuts"),
		handleTui: (_command, runtime) => {
			runtime.ctx.handleHotkeysCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "tools",
		description: t("Show tools currently visible to the agent"),
		acpDescription: t("Show available tools"),
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
		description: t("Show estimated context usage breakdown"),
		acpDescription: t("Show context usage"),
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
		description: t("Open Extension Control Center dashboard"),
		handleTui: (_command, runtime) => {
			runtime.ctx.showExtensionsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "agents",
		description: t("Open Agent Control Center dashboard"),
		handleTui: (_command, runtime) => {
			runtime.ctx.showAgentsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "branch",
		description: t("Create a new branch from a previous message"),
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
		description: t("Create a new fork from a previous message"),
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleForkCommand();
		},
	},
	{
		name: "tree",
		description: t("Navigate session tree (switch branches)"),
		handleTui: (_command, runtime) => {
			runtime.ctx.showTreeSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "login",
		description: t("Login with OAuth provider"),
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
		description: t("Logout from OAuth provider"),
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
		description: t("Manage MCP servers (add, list, remove, test)"),
		acpDescription: t("Manage MCP servers"),
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
	{
		name: "ssh",
		description: t("Manage SSH hosts (add, list, remove)"),
		acpDescription: t("Manage SSH connections"),
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				description: t("Add an SSH host"),
				usage: "<name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>] [--password <password>]",
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
	{
		name: "marketplace",
		description: t("Manage marketplace plugin sources and installed plugins"),
		acpDescription: t("Manage plugins from marketplaces"),
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "add", description: t("Add a marketplace source"), usage: "<source>" },
			{ name: "remove", description: t("Remove a marketplace source"), usage: "<name>" },
			{ name: "update", description: t("Update marketplace catalog(s)"), usage: "[name]" },
			{ name: "list", description: t("List configured marketplaces") },
			{ name: "discover", description: t("Browse available plugins"), usage: "[marketplace]" },
			{
				name: "install",
				description: t("Install a plugin (interactive browser if no args)"),
				usage: "[--force] [name@marketplace]",
			},
			{ name: "uninstall", description: t("Uninstall a plugin (selector if no args)"), usage: "[name@marketplace]" },
			{ name: "installed", description: t("List installed marketplace plugins") },
			{ name: "upgrade", description: t("Upgrade outdated plugins"), usage: "[name@marketplace]" },
			{ name: "help", description: t("Show usage guide") },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb) {
				try {
					const manager = await createMarketplaceManager(runtime);
					const marketplaces = await manager.listMarketplaces();
					if (marketplaces.length === 0) {
						await runtime.output(
							t(
								"No marketplaces configured.\n\nGet started:\n  /marketplace add anthropics/claude-plugins-official\n\nThen browse with /marketplace discover",
							),
						);
					} else {
						const lines = marketplaces.map(m => `  ${m.name}  ${m.sourceUri}`);
						await runtime.output(
							t(
								"Marketplaces:\n{list}\n\nUse /marketplace discover to browse plugins, or /marketplace help for all commands",
								{ list: lines.join("\n") },
							),
						);
					}
					return commandConsumed();
				} catch (err) {
					return usage(t("Marketplace error: {error}", { error: errorMessage(err) }), runtime);
				}
			}
			if (verb === "help") {
				await runtime.output(
					t(
						"Marketplace commands:\n  /marketplace                              List configured marketplaces\n  /marketplace add <source>                  Add a marketplace (e.g. owner/repo)\n  /marketplace remove <name>                 Remove a marketplace\n  /marketplace update [name]                 Re-fetch catalog(s)\n  /marketplace list                          List configured marketplaces\n  /marketplace discover [marketplace]        Browse available plugins\n  /marketplace install <name@marketplace>    Install a plugin\n  /marketplace uninstall <name@marketplace>  Uninstall a plugin\n  /marketplace installed                     List installed plugins\n  /marketplace upgrade [name@marketplace]    Upgrade plugin(s)\n\nQuick start:\n  /marketplace add anthropics/claude-plugins-official",
					),
				);
				return commandConsumed();
			}
			if ((verb === "install" || verb === "uninstall") && !rest) {
				return usage(
					t("Interactive plugin pickers are TUI-only. Pass an explicit name@marketplace argument."),
					runtime,
				);
			}
			try {
				const manager = await createMarketplaceManager(runtime);
				switch (verb) {
					case "add": {
						if (!rest) return usage(t("Usage: /marketplace add <source>"), runtime);
						const entry = await manager.addMarketplace(rest);
						await runtime.output(t("Added marketplace: {name}", { name: entry.name }));
						return commandConsumed();
					}
					case "remove":
					case "rm": {
						if (!rest) return usage(t("Usage: /marketplace remove <name>"), runtime);
						await manager.removeMarketplace(rest);
						await runtime.output(t("Removed marketplace: {name}", { name: rest }));
						return commandConsumed();
					}
					case "update": {
						if (rest) {
							await manager.updateMarketplace(rest);
							await runtime.output(t("Updated marketplace: {name}", { name: rest }));
						} else {
							const results = await manager.updateAllMarketplaces();
							await runtime.output(t("Updated {count} marketplace(s)", { count: results.length }));
						}
						return commandConsumed();
					}
					case "list": {
						const marketplaces = await manager.listMarketplaces();
						if (marketplaces.length === 0) {
							await runtime.output(t("No marketplaces configured."));
						} else {
							const lines = marketplaces.map(m => `  ${m.name}  ${m.sourceUri}`);
							await runtime.output(t("Marketplaces:\n{list}", { list: lines.join("\n") }));
						}
						return commandConsumed();
					}
					case "discover": {
						const plugins = await manager.listAvailablePlugins(rest || undefined);
						if (plugins.length === 0) {
							const marketplaces = await manager.listMarketplaces();
							await runtime.output(
								marketplaces.length === 0
									? t(
											"No marketplaces configured. Try:\n  /marketplace add anthropics/claude-plugins-official",
										)
									: t("No plugins available in configured marketplaces"),
							);
							return commandConsumed();
						}
						const lines = [t("Available plugins:")];
						for (const plugin of plugins) {
							lines.push(`  - ${plugin.name}${plugin.version ? `@${plugin.version}` : ""}`);
							if (plugin.description) lines.push(`      ${plugin.description}`);
						}
						await runtime.output(lines.join("\n"));
						return commandConsumed();
					}
					case "install": {
						const parsed = parseMarketplaceInstallArgs(rest);
						if ("error" in parsed) return usage(parsed.error, runtime);
						const atIndex = parsed.installSpec.lastIndexOf("@");
						const pluginName = parsed.installSpec.slice(0, atIndex);
						const marketplace = parsed.installSpec.slice(atIndex + 1);
						await manager.installPlugin(pluginName, marketplace, { force: parsed.force, scope: parsed.scope });
						await runtime.reloadPlugins();
						await runtime.output(t("Installed {name} from {marketplace}", { name: pluginName, marketplace }));
						return commandConsumed();
					}
					case "uninstall": {
						const parsed = parsePluginScopeArgs(
							rest,
							t("Usage: /marketplace uninstall [--scope user|project] <name@marketplace>"),
						);
						if ("error" in parsed) return usage(parsed.error, runtime);
						await manager.uninstallPlugin(parsed.pluginId, parsed.scope);
						await runtime.reloadPlugins();
						await runtime.output(t("Uninstalled {name}", { name: parsed.pluginId }));
						return commandConsumed();
					}
					case "installed": {
						const installed = await manager.listInstalledPlugins();
						if (installed.length === 0) {
							await runtime.output(t("No marketplace plugins installed"));
						} else {
							const lines = installed.map(
								p => `  ${p.id} [${p.scope}]${p.shadowedBy ? " [shadowed]" : ""} (${p.entries.length} entry)`,
							);
							await runtime.output(t("Installed plugins:\n{list}", { list: lines.join("\n") }));
						}
						return commandConsumed();
					}
					case "upgrade": {
						if (rest) {
							const parsed = parsePluginScopeArgs(
								rest,
								t("Usage: /marketplace upgrade [--scope user|project] <name@marketplace>"),
							);
							if ("error" in parsed) return usage(parsed.error, runtime);
							const result = await manager.upgradePlugin(parsed.pluginId, parsed.scope);
							await runtime.reloadPlugins();
							await runtime.output(
								t("Upgraded {name} to {version}", { name: parsed.pluginId, version: result.version }),
							);
							return commandConsumed();
						}
						const results = await manager.upgradeAllPlugins();
						if (results.length === 0) {
							await runtime.output(t("All marketplace plugins are up to date"));
						} else {
							await runtime.reloadPlugins();
							const lines = results.map(r => `  ${r.pluginId}: ${r.from} -> ${r.to}`);
							await runtime.output(
								t("Upgraded {count} plugin(s):\n{list}", { count: results.length, list: lines.join("\n") }),
							);
						}
						return commandConsumed();
					}
					default:
						return usage(
							t("Unknown /marketplace subcommand: {verb}. Use /marketplace help for available commands.", {
								verb,
							}),
							runtime,
						);
				}
			} catch (err) {
				return usage(t("Marketplace error: {error}", { error: errorMessage(err) }), runtime);
			}
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const args = command.args.trim().split(/\s+/);
			const sub = args[0] || "install";
			const rest = args.slice(1).join(" ").trim();

			// /marketplace (no args) or /marketplace install (no args) → interactive browser
			if ((sub === "install" && !rest) || (!args[0] && !command.args.trim())) {
				try {
					runtime.ctx.showPluginSelector("install");
				} catch (err) {
					runtime.ctx.showStatus(t("Marketplace error: {error}", { error: err }));
				}
				return;
			}

			const mgr = new MarketplaceManager({
				marketplacesRegistryPath: getMarketplacesRegistryPath(),
				installedRegistryPath: getInstalledPluginsRegistryPath(),
				projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(
					runtime.ctx.sessionManager.getCwd(),
				),
				marketplacesCacheDir: getMarketplacesCacheDir(),
				pluginsCacheDir: getPluginsCacheDir(),
				clearPluginRootsCache: clearPluginRootsAndCaches,
			});

			try {
				switch (sub) {
					case "add": {
						if (!rest) {
							runtime.ctx.showStatus(t("Usage: /marketplace add <source>"));
							return;
						}
						const entry = await mgr.addMarketplace(rest);
						runtime.ctx.showStatus(t("Added marketplace: {name}", { name: entry.name }));
						break;
					}
					case "remove":
					case "rm": {
						if (!rest) {
							runtime.ctx.showStatus(t("Usage: /marketplace remove <name>"));
							return;
						}
						await mgr.removeMarketplace(rest);
						runtime.ctx.showStatus(t("Removed marketplace: {name}", { name: rest }));
						break;
					}
					case "update": {
						if (rest) {
							await mgr.updateMarketplace(rest);
							runtime.ctx.showStatus(t("Updated marketplace: {name}", { name: rest }));
						} else {
							const results = await mgr.updateAllMarketplaces();
							runtime.ctx.showStatus(t("Updated {count} marketplace(s)", { count: results.length }));
						}
						break;
					}
					case "discover": {
						const plugins = await mgr.listAvailablePlugins(rest || undefined);
						if (plugins.length === 0) {
							const marketplaces = await mgr.listMarketplaces();
							if (marketplaces.length === 0) {
								runtime.ctx.showStatus(
									t("No marketplaces configured. Try:\n  /marketplace add anthropics/claude-plugins-official"),
								);
							} else {
								runtime.ctx.showStatus(t("No plugins available in configured marketplaces"));
							}
						} else {
							const lines = plugins.map(
								p =>
									`  ${p.name}${p.version ? `@${p.version}` : ""}${p.description ? ` - ${p.description}` : ""}`,
							);
							runtime.ctx.showStatus(t("Available plugins:\n{list}", { list: lines.join("\n") }));
						}
						break;
					}
					case "install": {
						// Parse: /marketplace install [--force] [--scope user|project] name@marketplace
						const parsed = parseMarketplaceInstallArgs(rest);
						if ("error" in parsed) {
							runtime.ctx.showStatus(parsed.error);
							return;
						}
						const atIdx = parsed.installSpec.lastIndexOf("@");
						const name = parsed.installSpec.slice(0, atIdx);
						const marketplace = parsed.installSpec.slice(atIdx + 1);
						await mgr.installPlugin(name, marketplace, { force: parsed.force, scope: parsed.scope });
						runtime.ctx.showStatus(t("Installed {name} from {marketplace}", { name, marketplace }));
						break;
					}
					case "uninstall": {
						if (!rest) {
							// No args → open interactive uninstall selector
							runtime.ctx.showPluginSelector("uninstall");
							return;
						}
						const uninstArgs = parsePluginScopeArgs(
							rest,
							t("Usage: /marketplace uninstall [--scope user|project] <name@marketplace>"),
						);
						if ("error" in uninstArgs) {
							runtime.ctx.showStatus(uninstArgs.error);
							return;
						}
						await mgr.uninstallPlugin(uninstArgs.pluginId, uninstArgs.scope);
						runtime.ctx.showStatus(t("Uninstalled {name}", { name: uninstArgs.pluginId }));
						break;
					}
					case "installed": {
						const installed = await mgr.listInstalledPlugins();
						if (installed.length === 0) {
							runtime.ctx.showStatus(t("No marketplace plugins installed"));
						} else {
							const lines = installed.map(
								p => `  ${p.id} [${p.scope}]${p.shadowedBy ? " [shadowed]" : ""} (${p.entries.length} entry)`,
							);
							runtime.ctx.showStatus(t("Installed plugins:\n{list}", { list: lines.join("\n") }));
						}
						break;
					}
					case "upgrade": {
						if (rest) {
							const upArgs = parsePluginScopeArgs(
								rest,
								t("Usage: /marketplace upgrade [--scope user|project] <name@marketplace>"),
							);
							if ("error" in upArgs) {
								runtime.ctx.showStatus(upArgs.error);
								return;
							}
							const result = await mgr.upgradePlugin(upArgs.pluginId, upArgs.scope);
							runtime.ctx.showStatus(
								t("Upgraded {name} to {version}", { name: upArgs.pluginId, version: result.version }),
							);
						} else {
							const results = await mgr.upgradeAllPlugins();
							if (results.length === 0) {
								runtime.ctx.showStatus(t("All marketplace plugins are up to date"));
							} else {
								const lines = results.map(r => `  ${r.pluginId}: ${r.from} -> ${r.to}`);
								runtime.ctx.showStatus(
									t("Upgraded {count} plugin(s):\n{list}", {
										count: results.length,
										list: lines.join("\n"),
									}),
								);
							}
						}
						break;
					}
					case "help": {
						runtime.ctx.showStatus(
							t(
								"Marketplace commands:\n  /marketplace                              Browse and install plugins\n  /marketplace add <source>                  Add a marketplace (e.g. owner/repo)\n  /marketplace remove <name>                 Remove a marketplace\n  /marketplace update [name]                 Re-fetch catalog(s)\n  /marketplace list                          List configured marketplaces\n  /marketplace discover [marketplace]        Browse available plugins\n  /marketplace install <name@marketplace>    Install a plugin\n  /marketplace uninstall <name@marketplace>  Uninstall a plugin\n  /marketplace installed                     List installed plugins\n  /marketplace upgrade [name@marketplace]    Upgrade plugin(s)\n\nQuick start:\n  /marketplace add anthropics/claude-plugins-official\n  /marketplace                               (opens interactive browser)",
							),
						);
						break;
					}
					default: {
						const marketplaces = await mgr.listMarketplaces();
						if (marketplaces.length === 0) {
							runtime.ctx.showStatus(
								t(
									"No marketplaces configured.\n\nGet started:\n  /marketplace add anthropics/claude-plugins-official\n\nThen browse plugins with /marketplace or /marketplace discover",
								),
							);
						} else {
							const lines = marketplaces.map(m => `  ${m.name}  ${m.sourceUri}`);
							runtime.ctx.showStatus(
								t(
									"Marketplaces:\n{list}\n\nUse /marketplace discover to browse plugins, or /marketplace help for all commands",
									{ list: lines.join("\n") },
								),
							);
						}
						break;
					}
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				runtime.ctx.showStatus(t("Marketplace error: {error}", { error: msg }));
			}
		},
	},
	{
		name: "plugins",
		description: t("View and manage installed plugins"),
		acpDescription: t("Manage plugins"),
		acpInputHint: "[list|enable|disable]",
		subcommands: [
			{ name: "list", description: t("List all installed plugins (npm + marketplace)") },
			{ name: "enable", description: t("Enable a marketplace plugin"), usage: "<name@marketplace>" },
			{ name: "disable", description: t("Disable a marketplace plugin"), usage: "<name@marketplace>" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			try {
				if (verb === "enable" || verb === "disable") {
					const parsed = parsePluginScopeArgs(
						rest,
						t("Usage: /plugins {verb} [--scope user|project] <name@marketplace>", { verb }),
					);
					if ("error" in parsed) return usage(parsed.error, runtime);
					const manager = await createMarketplaceManager(runtime);
					const isEnable = verb === "enable";
					await manager.setPluginEnabled(parsed.pluginId, isEnable, parsed.scope);
					await runtime.reloadPlugins();
					await runtime.output(
						t("{action} {name}", { action: isEnable ? "Enabled" : "Disabled", name: parsed.pluginId }),
					);
					return commandConsumed();
				}
				// Default: list
				const lines: string[] = [];
				const npmManager = new PluginManager();
				const npmPlugins = await npmManager.list();
				if (npmPlugins.length > 0) {
					lines.push(t("npm plugins:"));
					for (const plugin of npmPlugins) {
						const status = plugin.enabled === false ? ` ${t("(disabled)")}` : "";
						lines.push(`  ${plugin.name}@${plugin.version}${status}`);
					}
				}

				const marketplaceManager = await createMarketplaceManager(runtime);
				const marketplacePlugins = await marketplaceManager.listInstalledPlugins();
				if (marketplacePlugins.length > 0) {
					if (lines.length > 0) lines.push("");
					lines.push(t("marketplace plugins:"));
					for (const plugin of marketplacePlugins) {
						const entry = plugin.entries[0];
						const status = entry?.enabled === false ? ` ${t("(disabled)")}` : "";
						const shadowed = plugin.shadowedBy ? ` ${t("[shadowed]")}` : "";
						lines.push(`  ${plugin.id} v${entry?.version ?? "?"}${status} [${plugin.scope}]${shadowed}`);
					}
				}

				await runtime.output(lines.length === 0 ? t("No plugins installed") : lines.join("\n"));
				return commandConsumed();
			} catch (err) {
				return usage(t("Plugin error: {error}", { error: errorMessage(err) }), runtime);
			}
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const args = command.args.trim().split(/\s+/);
			const sub = args[0] || "list";
			const rest = args.slice(1).join(" ").trim();

			try {
				const mgr = new MarketplaceManager({
					marketplacesRegistryPath: getMarketplacesRegistryPath(),
					installedRegistryPath: getInstalledPluginsRegistryPath(),
					projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(
						runtime.ctx.sessionManager.getCwd(),
					),
					marketplacesCacheDir: getMarketplacesCacheDir(),
					pluginsCacheDir: getPluginsCacheDir(),
					clearPluginRootsCache: clearPluginRootsAndCaches,
				});

				switch (sub) {
					case "enable":
					case "disable": {
						const parsed = parsePluginScopeArgs(
							rest ?? "",
							t("Usage: /plugins {verb} [--scope user|project] <name@marketplace>", { verb: sub }),
						);
						if ("error" in parsed) {
							runtime.ctx.showStatus(parsed.error);
							return;
						}
						const isEnable = sub === "enable";
						await mgr.setPluginEnabled(parsed.pluginId, isEnable, parsed.scope);
						runtime.ctx.showStatus(
							t("{action} {name}", { action: isEnable ? "Enabled" : "Disabled", name: parsed.pluginId }),
						);
						break;
					}
					default: {
						const lines: string[] = [];

						const npm = new PluginManager();
						const npmPlugins = await npm.list();
						if (npmPlugins.length > 0) {
							lines.push(t("npm plugins:"));
							for (const p of npmPlugins) {
								const status = p.enabled === false ? ` ${t("(disabled)")}` : "";
								lines.push(`  ${p.name}@${p.version}${status}`);
							}
						}

						const mktPlugins = await mgr.listInstalledPlugins();
						if (mktPlugins.length > 0) {
							if (lines.length > 0) lines.push("");
							lines.push(t("marketplace plugins:"));
							for (const p of mktPlugins) {
								const entry = p.entries[0];
								const status = entry?.enabled === false ? ` ${t("(disabled)")}` : "";
								const shadowed = p.shadowedBy ? ` ${t("[shadowed]")}` : "";
								lines.push(`  ${p.id} v${entry?.version ?? "?"}${status} [${p.scope}]${shadowed}`);
							}
						}

						if (lines.length === 0) {
							runtime.ctx.showStatus(t("No plugins installed"));
						} else {
							runtime.ctx.showStatus(lines.join("\n"));
						}
						break;
					}
				}
			} catch (err) {
				runtime.ctx.showStatus(t("Plugin error: {error}", { error: err }));
			}
		},
	},
	{
		name: "reload-plugins",
		description: t("Reload all plugins (skills, commands, hooks, tools, agents, MCP)"),
		acpDescription: t("Reload all plugins"),
		handle: async (_command, runtime) => {
			await runtime.reloadPlugins();
			await runtime.output(t("Plugins reloaded."));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await reloadTuiPluginState(runtime.ctx);
			runtime.ctx.showStatus(t("Plugins reloaded."));
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "force",
		description: t("Force next turn to use a specific tool"),
		aliases: ["force:"],
		inlineHint: "<tool-name> [prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const count = runtime.ctx.session.getActiveToolNames().length;
			return count === 0 ? t("Force: no active tools") : t("Force: {count} active tools", { count });
		},
		handle: async (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();
			if (!toolName) return usage(t("Usage: /force:<tool-name> [prompt]"), runtime);
			try {
				runtime.session.setForcedToolChoice(toolName);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			await runtime.output(t("Next turn forced to use {tool}.", { tool: toolName }));
			return prompt ? { prompt } : commandConsumed();
		},
		handleTui: (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();

			if (!toolName) {
				runtime.ctx.showError(t("Usage: /force:<tool-name> [prompt]"));
				runtime.ctx.editor.setText("");
				return;
			}

			try {
				runtime.ctx.session.setForcedToolChoice(toolName);
				runtime.ctx.showStatus(t("Next turn forced to use {tool}.", { tool: toolName }));
			} catch (error) {
				runtime.ctx.showError(errorMessage(error));
				runtime.ctx.editor.setText("");
				return;
			}

			runtime.ctx.editor.setText("");

			// If a prompt was provided, pass it through as input
			if (prompt) return { prompt };
		},
	},
	{
		name: "live",
		description: t("Start Codex-backed realtime voice mode"),
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleLiveCommand();
		},
	},
	{
		name: "pause",
		description: t("Freeze all agents (main, subagents, advisor) until resumed"),
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runPauseScreen(runtime.ctx);
		},
	},
	{
		name: "quit",
		aliases: ["q"],
		description: t("Quit the application"),
		handleTui: shutdownHandlerTui,
	},
];

const BUILTIN_SLASH_COMMAND_LOOKUP = new Map<string, SlashCommandSpec>();
for (const command of BUILTIN_SLASH_COMMAND_REGISTRY) {
	BUILTIN_SLASH_COMMAND_LOOKUP.set(command.name, command);
	for (const alias of command.aliases ?? []) {
		BUILTIN_SLASH_COMMAND_LOOKUP.set(alias, command);
	}
}

export const BUILTIN_SLASH_COMMAND_RESERVED_NAMES: ReadonlySet<string> = new Set(BUILTIN_SLASH_COMMAND_LOOKUP.keys());

/**
 * Build getArgumentCompletions from declarative subcommand definitions.
 * Returns subcommand names filtered by prefix in the dropdown.
 */
function buildArgumentCompletions(subcommands: SubcommandDef[]): (prefix: string) => AutocompleteItem[] | null {
	return (argumentPrefix: string) => {
		if (argumentPrefix.includes(" ")) return null; // past the subcommand
		const lower = argumentPrefix.toLowerCase();
		const matches = subcommands
			.filter(s => s.name.startsWith(lower))
			.map(s => ({
				value: `${s.name} `,
				label: s.name,
				description: s.description,
				hint: s.usage,
			}));
		return matches.length > 0 ? matches : null;
	};
}

/** /mcp subcommands whose argument is a server name (per their `usage: "<name>..."`). */
const MCP_SERVER_NAME_SUBCOMMANDS: Readonly<Record<string, true>> = {
	enable: true,
	disable: true,
	test: true,
	remove: true,
	reconnect: true,
	reauth: true,
	unauth: true,
};

/** Subcommands that accept names found only in `userConfig.disabledServers`. */
const MCP_DISABLED_ONLY_ELIGIBLE_SUBCOMMANDS: Readonly<Record<string, true>> = {
	enable: true,
	disable: true,
};

/**
 * Subcommands that accept configured servers whose `enabled` flag is false.
 * `unauth` can clear persisted credentials without connecting; test,
 * reconnect, and reauth explicitly require an enabled server.
 */
const MCP_DISABLED_CONFIG_ELIGIBLE_SUBCOMMANDS: Readonly<Record<string, true>> = {
	enable: true,
	disable: true,
	unauth: true,
};

/**
 * Build getArgumentCompletions for /mcp. Delegates to the generic
 * declarative subcommand completer while the subcommand name itself is
 * still being typed, then switches to MCP server-name completion (sourced
 * from {@link collectMcpServerNames}) once a recognized server-name
 * subcommand (enable/disable/test/remove/reconnect/reauth/unauth) is
 * followed by a space. `remove` gets its own scope-aware completions (see
 * {@link buildMcpRemoveCompletions}) since — unlike the others —
 * it only ever succeeds against a config-file entry. Subcommands with a
 * different argument shape (add, smithery-search, ...) get no argument
 * completion.
 */
function buildMcpArgumentCompletions(
	subcommands: SubcommandDef[],
	runtime: TuiSlashCommandRuntime,
): (argumentPrefix: string) => Promise<AutocompleteItem[] | null> {
	const genericCompletions = buildArgumentCompletions(subcommands);
	return async (argumentPrefix: string) => {
		const spaceIndex = argumentPrefix.indexOf(" ");
		if (spaceIndex === -1) return genericCompletions(argumentPrefix);

		const rawSubcommand = argumentPrefix.slice(0, spaceIndex);
		const lowerSubcommand = rawSubcommand.toLowerCase();
		if (MCP_SERVER_NAME_SUBCOMMANDS[lowerSubcommand] !== true) return null;
		const namePrefix = argumentPrefix.slice(spaceIndex + 1).toLowerCase();
		if (lowerSubcommand === "remove") {
			return await buildMcpRemoveCompletions(rawSubcommand, namePrefix);
		}

		let serverNames: string[];
		try {
			serverNames = await collectMcpServerNames(
				runtime.ctx,
				undefined,
				MCP_DISABLED_ONLY_ELIGIBLE_SUBCOMMANDS[lowerSubcommand] === true,
				MCP_DISABLED_CONFIG_ELIGIBLE_SUBCOMMANDS[lowerSubcommand] === true,
			);
		} catch (error) {
			logger.warn("MCP server-name autocomplete failed to read config", { error });
			return null;
		}
		const matches: AutocompleteItem[] = serverNames
			.filter(name => name.toLowerCase().startsWith(namePrefix))
			.map(name => ({ value: `${rawSubcommand} ${name} `, label: name }));
		return matches.length > 0 ? matches : null;
	};
}

/**
 * Build `/mcp remove <name>` completions. Unlike the other server-name
 * subcommands, `#handleRemove` only ever succeeds against a config-file
 * `mcpServers` entry in the target scope (project by default, user with an
 * explicit `--scope user`) — a purely runtime-discovered server has no
 * config entry to remove and always fails with `Server "<name>" not found
 * in <scope> config.`. Completions are therefore restricted to config-file
 * names, and a name that exists only in the user config is completed with
 * `--scope user` appended so the inserted command is directly executable.
 */
async function buildMcpRemoveCompletions(
	rawSubcommand: string,
	namePrefix: string,
): Promise<AutocompleteItem[] | null> {
	const cwd = getProjectDir();
	let projectNames: string[];
	let userNames: string[];
	try {
		const [projectConfig, userConfig] = await Promise.all([
			readMCPConfigFile(getMCPConfigPath("project", cwd)),
			readMCPConfigFile(getMCPConfigPath("user", cwd)),
		]);
		projectNames = Object.keys(projectConfig.mcpServers ?? {});
		userNames = Object.keys(userConfig.mcpServers ?? {});
	} catch (error) {
		logger.warn("MCP remove autocomplete failed to read config", { error });
		return null;
	}

	const projectNameSet = new Set(projectNames);
	const allNames = new Set([...projectNames, ...userNames]);
	const matches: AutocompleteItem[] = [...allNames]
		.filter(name => name.toLowerCase().startsWith(namePrefix))
		.map(name =>
			projectNameSet.has(name)
				? { value: `${rawSubcommand} ${name} `, label: name }
				: { value: `${rawSubcommand} ${name} --scope user `, label: `${name} ${t("(user)")}` },
		)
		.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
	return matches.length > 0 ? matches : null;
}

/**
 * Build getInlineHint from declarative subcommand definitions.
 * Shows remaining completion + usage as dim ghost text after cursor.
 */
function buildSubcommandInlineHint(subcommands: SubcommandDef[]): (argumentText: string) => string | null {
	return (argumentText: string) => {
		const trimmed = argumentText.trimStart();
		const spaceIndex = trimmed.indexOf(" ");

		if (spaceIndex === -1) {
			// Still typing subcommand name — show remaining chars + usage
			const prefix = trimmed.toLowerCase();
			if (prefix.length === 0) return null;
			const match = subcommands.find(s => s.name.startsWith(prefix));
			if (!match) return null;
			const remaining = match.name.slice(prefix.length);
			return remaining + (match.usage ? ` ${match.usage}` : "");
		}

		// Subcommand typed — show remaining usage params
		const subName = trimmed.slice(0, spaceIndex).toLowerCase();
		const afterSub = trimmed.slice(spaceIndex + 1);
		const sub = subcommands.find(s => s.name === subName);
		if (!sub?.usage) return null;

		if (afterSub.length > 0) {
			const usageParts = sub.usage.split(" ");
			const inputParts = afterSub.trim().split(/\s+/);
			const remaining = usageParts.slice(inputParts.length);
			return remaining.length > 0 ? remaining.join(" ") : null;
		}

		return sub.usage;
	};
}

/**
 * Build getInlineHint for commands with a simple static hint string.
 * Shows the hint only when no arguments have been typed yet.
 */
function buildStaticInlineHint(hint: string): (argumentText: string) => string | null {
	return (argumentText: string) => (argumentText.trim().length === 0 ? hint : null);
}

/**
 * Build getArgumentCompletions that suggests directories relative to the
 * current project directory. Used by /move so users can Tab-complete the
 * destination directory.
 */
function buildDirectoryArgumentCompletions(): (prefix: string) => Promise<AutocompleteItem[] | null> {
	return async (argumentPrefix: string) => {
		const prefix = argumentPrefix.trim();

		const cwd = getProjectDir();
		const expandedPrefix = expandTilde(prefix);
		const isAbsolute = path.isAbsolute(expandedPrefix);

		let searchDir: string;
		let searchPrefix: string;
		if (
			prefix === "" ||
			prefix === "." ||
			prefix === "./" ||
			prefix === ".." ||
			prefix === "../" ||
			prefix === "~" ||
			prefix === "~/" ||
			prefix === "/"
		) {
			searchDir = isAbsolute ? expandedPrefix : path.join(cwd, expandedPrefix);
			searchPrefix = "";
		} else if (expandedPrefix.endsWith("/")) {
			searchDir = isAbsolute ? expandedPrefix : path.join(cwd, expandedPrefix);
			searchPrefix = "";
		} else {
			const dir = path.dirname(expandedPrefix);
			searchDir = isAbsolute ? dir : path.join(cwd, dir);
			searchPrefix = path.basename(expandedPrefix);
		}

		try {
			const entries = await fs.readdir(searchDir, { withFileTypes: true });
			const suggestions: AutocompleteItem[] = [];
			for (const entry of entries) {
				if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) continue;
				if (entry.name === ".git") continue;

				let isDirectory = entry.isDirectory();
				if (!isDirectory && entry.isSymbolicLink()) {
					try {
						isDirectory = (await fs.stat(path.join(searchDir, entry.name))).isDirectory();
					} catch {
						continue;
					}
				}
				if (!isDirectory) continue;

				const absoluteValue = path.join(searchDir, entry.name);
				const displayValue = buildDirectoryCompletionDisplayValue(prefix, absoluteValue, cwd);
				suggestions.push({ value: displayValue, label: `${entry.name}/` });
			}
			suggestions.sort((a, b) => a.label.localeCompare(b.label));
			return suggestions.length > 0 ? suggestions : null;
		} catch {
			return null;
		}
	};
}
function buildDirectoryCompletionDisplayValue(prefix: string, absoluteValue: string, cwd: string): string {
	// Preserve the user's prefix style where possible, but always return a
	// value that /move can resolve (absolute or relative) without escaping.
	const normalized = path.normalize(absoluteValue);

	if (prefix.startsWith("~/")) {
		const home = os.homedir();
		const homeRelative = path.relative(home, normalized);
		return `~/${homeRelative.replaceAll("\\", "/")}/`;
	}
	if (prefix === "~") {
		const home = os.homedir();
		const homeRelative = path.relative(home, normalized);
		return `~/${homeRelative.replaceAll("\\", "/")}/`;
	}
	if (prefix.startsWith("/")) {
		return `${normalized.replaceAll("\\", "/")}/`;
	}
	if (prefix.startsWith("./")) {
		const relative = path.relative(cwd, normalized);
		return `./${relative.replaceAll("\\", "/")}/`;
	}
	if (prefix.startsWith("../")) {
		const relative = path.relative(cwd, normalized);
		return `${relative.replaceAll("\\", "/")}/`;
	}
	if (prefix === "..") {
		const relative = path.relative(cwd, normalized);
		return `${relative.replaceAll("\\", "/")}/`;
	}

	// Default: relative to cwd.
	const relative = path.relative(cwd, normalized);
	return `${relative.replaceAll("\\", "/")}/`;
}

/** Builtin command metadata used for slash-command autocomplete and help text. */
export const BUILTIN_SLASH_COMMAND_DEFS: ReadonlyArray<BuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_REGISTRY.map(
	command => ({
		name: command.name,
		aliases: command.aliases,
		allowArgs: command.allowArgs === true,
		description: command.description,
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

/**
 * Materialized builtin slash commands with completion functions derived from
 * declarative subcommand/hint definitions.
 */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<TuiBuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_DEFS.map(cmd =>
	materializeTuiBuiltinSlashCommand(cmd),
);

export function buildTuiBuiltinSlashCommands(runtime: TuiSlashCommandRuntime): ReadonlyArray<TuiBuiltinSlashCommand> {
	return BUILTIN_SLASH_COMMAND_DEFS.map(cmd => materializeTuiBuiltinSlashCommand(cmd, runtime));
}

/**
 * Unified registry exposed for cross-mode tooling. Each spec carries at least
 * one of `handle` / `handleTui`. The TUI dispatcher prefers `handleTui`; the
 * ACP dispatcher requires `handle` and skips TUI-only entries.
 */
export const BUILTIN_SLASH_COMMANDS_INTERNAL: ReadonlyArray<SlashCommandSpec> = BUILTIN_SLASH_COMMAND_REGISTRY;

/**
 * Reload the interactive session's plugin runtime: invalidate fs/plugin-root
 * caches, rediscover skills and file slash commands, reset the capability
 * cache, and reconnect MCP servers (rebinding the session's MCP tools). Shared
 * by `/reload-plugins`'s TUI handler and the `handle`-adapter's `reloadPlugins`
 * hook so both honor the command's documented MCP reload scope (#7189).
 */
async function reloadTuiPluginState(ctx: InteractiveModeContext): Promise<void> {
	const projectPath = await resolveActiveProjectRegistryPath(ctx.sessionManager.getCwd());
	clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
	await ctx.refreshSkillState();
	await ctx.refreshSlashCommandState();
	resetCapabilities();
	if (ctx.mcpManager) {
		await new MCPCommandController(ctx).reloadServers();
	}
}

/**
 * Execute a builtin slash command in the interactive TUI.
 *
 * Returns `false` when no builtin matched. Returns `true` when a command
 * consumed the input entirely. Returns a `string` when the command was handled
 * but remaining text should be sent as a prompt.
 */
export async function executeBuiltinSlashCommand(
	text: string,
	runtime: BuiltinSlashCommandRuntime,
): Promise<string | boolean> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;

	const command = BUILTIN_SLASH_COMMAND_LOOKUP.get(parsed.name);
	if (!command) return false;
	if (parsed.args.length > 0 && !command.allowArgs) {
		return false;
	}
	// Collab guests run a read-mostly replica: session-mutating builtins are
	// host-only; the allowlist covers purely local/read-only commands.
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
		// No TUI-specific override → adapt the ACP/text-mode `handle` to the
		// TUI by routing `runtime.output` through `ctx.showStatus`, clearing
		// the editor after the call, and reusing the active session's plugin
		// reload pipeline. Spec authors get a single body usable from either
		// dispatcher without forcing every TUI test to construct the full
		// `SlashCommandRuntime` shape.
		const ctx = runtime.ctx;
		const adapted: SlashCommandRuntime = {
			session: ctx.session,
			sessionManager: ctx.sessionManager,
			settings: ctx.settings,
			cwd: ctx.sessionManager.getCwd(),
			output: (text: string) => {
				ctx.showStatus(text);
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
