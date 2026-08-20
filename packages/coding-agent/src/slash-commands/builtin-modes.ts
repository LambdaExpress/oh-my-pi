import * as path from "node:path";
import {
	expandRoleAlias,
	formatModelString,
	getModelMatchPreferences,
	resolveCliModel,
} from "../config/model-resolver";
import type { SettingPath, Settings } from "../config/settings";
import { t } from "../i18n";
import { describeLoopLimitRuntime } from "../modes/loop-limit";
import type { InteractiveModeContext } from "../modes/types";
import type { AgentSession } from "../session/agent-session";
import type { ComputerTool } from "../tools/computer";
import { computerExposureMode } from "../tools/computer/exposure";
import type { InspectImageMode } from "../utils/inspect-image-mode";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import { handleSecurityCommand } from "./helpers/security";
import type { ParsedSlashCommand, SlashCommandSpec, TuiSlashCommandRuntime } from "./types";

export function refreshStatusLine(ctx: InteractiveModeContext): void {
	ctx.statusLine.invalidate();
	ctx.ui.requestRender();
}

async function runWithDetachedModeDraft(
	command: ParsedSlashCommand,
	runtime: TuiSlashCommandRuntime,
	run: () => Promise<boolean>,
): Promise<void> {
	const { editor } = runtime.ctx;
	if (!runtime.draftDetached) {
		editor.clearDraft();
	} else if (runtime.draftText !== undefined && editor.getText() === runtime.draftText) {
		editor.setText("");
	}
	try {
		const submitted = await run();
		if (!submitted) {
			if ((runtime.input?.images?.length ?? 0) > 0 || (runtime.input?.imageLinks?.length ?? 0) > 0) {
				editor.pendingImages = [...(runtime.input?.images ?? []), ...editor.pendingImages];
				editor.pendingImageLinks = [
					...(runtime.input?.imageLinks ?? runtime.input?.images?.map(() => undefined) ?? []),
					...editor.pendingImageLinks,
				];
				editor.imageLinks = editor.pendingImageLinks.length > 0 ? editor.pendingImageLinks : undefined;
			}
		}
	} catch (error) {
		if (!editor.getText() && editor.pendingImages.length === 0) {
			editor.setText(command.text);
			editor.pendingImages = runtime.input?.images ? [...runtime.input.images] : [];
			editor.pendingImageLinks = runtime.input?.imageLinks ? [...runtime.input.imageLinks] : [];
			editor.imageLinks = editor.pendingImageLinks.length > 0 ? editor.pendingImageLinks : undefined;
		}
		runtime.ctx.showError(error instanceof Error ? error.message : String(error));
	}
}

/** `/fast status` label for the active model: "on" when its family is priority, else "off". */
function formatFastModeStatus(session: AgentSession): string {
	return session.isFastModeEnabled() ? "on" : "off";
}

/** `/extended-context status` label for the premium long-context window setting. */
function formatExtendedContextStatus(settings: Settings): string {
	return settings.get("extendedContext") ? "on" : "off";
}

/** Applies an `/extended-context` argument and returns its operator feedback. */
function applyExtendedContextCommand(settings: Settings, args: string): string | undefined {
	const arg = args.trim().toLowerCase();
	const current = settings.get("extendedContext");
	if (!arg || arg === "toggle") {
		const enabled = !current;
		settings.set("extendedContext", enabled);
		return t("Extended context {status}.", { status: enabled ? "enabled" : "disabled" });
	}
	if (arg === "on") {
		settings.set("extendedContext", true);
		return t("Extended context enabled.");
	}
	if (arg === "off") {
		settings.set("extendedContext", false);
		return t("Extended context disabled.");
	}
	if (arg === "status") return t("Extended context is {status}.", { status: formatExtendedContextStatus(settings) });
	return undefined;
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

export function formatTokenCount(value: number): string {
	return value.toLocaleString();
}

export const BUILTIN_MODE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
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
			await runWithDetachedModeDraft(command, runtime, () =>
				runtime.ctx.handlePlanModeCommand(command.args || undefined, runtime.input),
			);
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
			await runWithDetachedModeDraft(command, runtime, () =>
				runtime.ctx.handleVibeModeCommand(command.args || undefined, runtime.input),
			);
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
				? t("Goal: {status} ({detail})", {
						status: state.goal.status,
						detail: shortDetail(state.goal.objective),
					})
				: t("Goal: off");
		},
		handleTui: async (command, runtime) => {
			await runWithDetachedModeDraft(command, runtime, () =>
				runtime.ctx.handleGoalModeCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "guided-goal",
		description: t("Have the agent interview you in chat, then set up goal mode"),
		inlineHint: t("[rough objective]"),
		allowArgs: true,
		handleTui: async (command, runtime) => {
			await runWithDetachedModeDraft(command, runtime, () =>
				runtime.ctx.handleGuidedGoalCommand(command.args || undefined, runtime.input),
			);
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
			if (runtime.ctx.loopLimit) {
				return t("Loop: on ({detail})", { detail: describeLoopLimitRuntime(runtime.ctx.loopLimit) });
			}
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
							{ model: modelId },
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
		name: "extended-context",
		description: t("Toggle premium long-context windows"),
		acpDescription: t("Toggle extended context"),
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: t("Enable premium long-context windows") },
			{ name: "off", description: t("Use standard-pricing context windows") },
			{ name: "status", description: t("Show extended context status") },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			t("Extended context: {status}", { status: formatExtendedContextStatus(runtime.ctx.settings) }),
		handle: async (command, runtime) => {
			const output = applyExtendedContextCommand(runtime.settings, command.args);
			if (!output) return usage(t("Usage: /extended-context [on|off|status]"), runtime);
			await runtime.output(output);
			return commandConsumed();
		},
		handleTui: (command, runtime) => {
			const output = applyExtendedContextCommand(runtime.ctx.settings, command.args);
			refreshStatusLine(runtime.ctx);
			runtime.ctx.showStatus(output ?? t("Usage: /extended-context [on|off|status]"));
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
			t("Computer: {status}", { status: runtime.ctx.session.settings.get("computer.enabled") ? "on" : "off" }),
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
];
