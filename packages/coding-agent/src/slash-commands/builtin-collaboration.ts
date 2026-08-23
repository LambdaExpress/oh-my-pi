import { Spacer } from "@oh-my-pi/pi-tui";
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { CollabGuestLink } from "../collab/guest";
import { CollabHost } from "../collab/host";
import type { SettingPath, SettingValue } from "../config/settings";
import { settings } from "../config/settings";
import { parseExportArgs } from "../export/html/args";
import { shareSession } from "../export/share";
import { t } from "../i18n";
import { theme } from "../modes/theme/theme";
import type { InteractiveModeContext } from "../modes/types";
import { extractLastCodeBlock, extractLastCommand } from "../modes/utils/copy-targets";
import { urlHyperlinkAlways } from "../tui";
import { copyToClipboard } from "../utils/clipboard";
import { refreshStatusLine } from "./builtin-modes";
import { CollabQrCodeComponent } from "./helpers/collab-qrcode";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

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

export const BUILTIN_COLLABORATION_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "advisor",
		icon: "advisor",
		description: "Toggle the advisor (a second model that reviews each turn and injects notes)",
		acpDescription: "Toggle advisor",
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
			if (stats.active && stats.advisors.length > 1) {
				return t("Advisor: on ({count} advisors)", { count: stats.advisors.length });
			}
			if (stats.active && stats.model) {
				return t("Advisor: on ({model})", { model: `${stats.model.provider}/${stats.model.id}` });
			}
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
					"/advisor configure opens an interactive editor and is only available in the interactive TUI.",
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
		icon: "export",
		description: "Export session to HTML file",
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
		icon: "clipboard",
		description: "Copy session transcript to clipboard (and write LLM request JSON to tmp)",
		acpDescription: "Return full transcript as plain text, with LLM request JSON path",
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
		icon: "share",
		description: "Share session via an encrypted link (share server or secret gist)",
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
		icon: "broadcast",
		description: "Share this session live via a relay",
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
						p.role === "host" ? `${p.name} (host)` : p.readOnly ? `${p.name} (view-only)` : p.name,
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
		icon: "signIn",
		description: "Join a shared collab session",
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
		icon: "signOut",
		description: "Leave the collab session",
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
		icon: "globe",
		description: "Toggle browser headless vs visible mode",
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
		icon: "copy",
		description: "Pick text or code from the conversation to copy",
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
];
