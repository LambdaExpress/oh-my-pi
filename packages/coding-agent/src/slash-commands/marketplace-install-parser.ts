import { t } from "../i18n";

const USAGE = "Usage: /marketplace install [--force] [--scope user|project] <name@marketplace>";

export interface MarketplaceInstallArgs {
	force: boolean;
	scope: "user" | "project";
	installSpec: string;
}

/**
 * Parse the argument string following `/marketplace install`.
 *
 * Returns either the parsed args or an `{ error }` object whose message is
 * suitable for direct display to the user via `ctx.showStatus`.
 *
 * Accepted flags (any order):
 *   --force                 Force-reinstall even if already installed
 *   --scope user|project    Installation scope (default: user)
 *
 * Exactly one positional argument is required: `name@marketplace`.
 */
export function parseMarketplaceInstallArgs(rest: string): MarketplaceInstallArgs | { error: string } {
	const tokens = rest.split(/\s+/).filter(Boolean);
	let force = false;
	let scope: "user" | "project" = "user";
	let installSpec = "";

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i] === "--force") {
			force = true;
		} else if (tokens[i] === "--scope" && i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
			const s = tokens[++i];
			if (s === "user" || s === "project") {
				scope = s;
			} else {
				return { error: t('Invalid --scope value: "{value}". Must be "user" or "project".', { value: s }) };
			}
		} else if (tokens[i] === "--scope") {
			// --scope with no value, or next token is another flag
			return { error: t('--scope requires a value: "user" or "project".') };
		} else if (tokens[i].startsWith("-")) {
			return { error: t('Unknown flag: "{flag}". {usage}', { flag: tokens[i]!, usage: t(USAGE) }) };
		} else {
			if (installSpec) {
				return {
					error: t('Unexpected argument: "{argument}". {usage}', { argument: tokens[i]!, usage: t(USAGE) }),
				};
			}
			installSpec = tokens[i];
		}
	}

	if (!installSpec.includes("@")) {
		return { error: t(USAGE) };
	}

	return { force, scope, installSpec };
}

// ── Shared scope+id parser for uninstall / upgrade / enable / disable ───────

export interface PluginScopeArgs {
	pluginId: string;
	scope?: "user" | "project";
}

/**
 * Parse `[--scope user|project] <name@marketplace>` for commands that accept a
 * single plugin ID and an optional scope flag.
 *
 * Returns parsed args or `{ error }` ready for `ctx.showStatus`.
 */
export function parsePluginScopeArgs(rest: string, usageHint: string): PluginScopeArgs | { error: string } {
	const tokens = rest.split(/\s+/).filter(Boolean);
	let scope: "user" | "project" | undefined;
	let pluginId = "";

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i] === "--scope" && i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
			const s = tokens[++i];
			if (s === "user" || s === "project") {
				scope = s;
			} else {
				return { error: t('Invalid --scope value: "{value}". Must be "user" or "project".', { value: s }) };
			}
		} else if (tokens[i] === "--scope") {
			return { error: t('--scope requires a value: "user" or "project".') };
		} else if (tokens[i].startsWith("-")) {
			return { error: t('Unknown flag: "{flag}". {usage}', { flag: tokens[i]!, usage: usageHint }) };
		} else if (pluginId) {
			return { error: t('Unexpected argument: "{argument}". {usage}', { argument: tokens[i]!, usage: usageHint }) };
		} else {
			pluginId = tokens[i];
		}
	}

	if (!pluginId) {
		return { error: usageHint };
	}

	return { pluginId, scope };
}
