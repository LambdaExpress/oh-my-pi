/**
 * Plugin CLI command handlers.
 *
 * Handles `omp plugin <command>` subcommands for plugin lifecycle management.
 */

import * as path from "node:path";
import { APP_NAME, getPluginsNodeModules, getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { resolveOrDefaultProjectRegistryPath } from "../discovery/helpers";
import { PluginManager, parseSettingValue, validateSetting } from "../extensibility/plugins";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
	parsePluginId,
} from "../extensibility/plugins/marketplace/index.js";
import type { InstalledPlugin } from "../extensibility/plugins/types";
import { t } from "../i18n";
import { theme } from "../modes/theme/theme";

// =============================================================================
// Types
// =============================================================================

export type PluginAction =
	| "install"
	| "uninstall"
	| "list"
	| "link"
	| "doctor"
	| "features"
	| "config"
	| "enable"
	| "disable"
	| "marketplace"
	| "discover"
	| "upgrade";

export interface PluginCommandArgs {
	action: PluginAction;
	args: string[];
	flags: {
		json?: boolean;
		fix?: boolean;
		force?: boolean;
		dryRun?: boolean;
		local?: boolean;
		enable?: string;
		disable?: string;
		set?: string;
		scope?: "user" | "project";
	};
}

// =============================================================================
// Argument Parser
// =============================================================================

const VALID_ACTIONS: PluginAction[] = [
	"install",
	"uninstall",
	"list",
	"link",
	"doctor",
	"features",
	"config",
	"enable",
	"disable",
	"marketplace",
	"discover",
	"upgrade",
];

/**
 * Parse plugin subcommand arguments.
 * Returns undefined if not a plugin command.
 */
export function parsePluginArgs(args: string[]): PluginCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "plugin") {
		return undefined;
	}

	if (args.length < 2) {
		return { action: "list", args: [], flags: {} };
	}

	const action = args[1];
	if (!VALID_ACTIONS.includes(action as PluginAction)) {
		console.error(chalk.red(t("Unknown plugin command: {action}", { action })));
		console.error(t("Valid commands: {commands}", { commands: VALID_ACTIONS.join(", ") }));
		process.exit(1);
	}

	const result: PluginCommandArgs = {
		action: action as PluginAction,
		args: [],
		flags: {},
	};

	// Parse remaining arguments
	for (let i = 2; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") {
			result.flags.json = true;
		} else if (arg === "--fix") {
			result.flags.fix = true;
		} else if (arg === "--force") {
			result.flags.force = true;
		} else if (arg === "--dry-run") {
			result.flags.dryRun = true;
		} else if (arg === "-l" || arg === "--local") {
			result.flags.local = true;
		} else if (arg === "--enable" && i + 1 < args.length) {
			result.flags.enable = args[++i];
		} else if (arg === "--disable" && i + 1 < args.length) {
			result.flags.disable = args[++i];
		} else if (arg === "--set" && i + 1 < args.length) {
			result.flags.set = args[++i];
		} else if (arg === "--scope" && i + 1 < args.length && !args[i + 1].startsWith("-")) {
			const s = args[++i];
			if (s === "user" || s === "project") {
				result.flags.scope = s;
			} else {
				console.error(chalk.red(t('Invalid --scope value: "{value}". Must be "user" or "project".', { value: s })));
				process.exit(1);
			}
		} else if (arg === "--scope") {
			// --scope with no value following
			console.error(chalk.red(t('--scope requires a value: "user" or "project".')));
			process.exit(1);
		} else if (!arg.startsWith("-")) {
			result.args.push(arg);
		}
	}

	return result;
}

import { classifyInstallTarget } from "./classify-install-target";

export { classifyInstallTarget } from "./classify-install-target";

// =============================================================================
// Command Handlers
// =============================================================================

/**
 * Run a plugin command.
 */
export async function runPluginCommand(cmd: PluginCommandArgs): Promise<void> {
	const manager = new PluginManager();

	switch (cmd.action) {
		case "install":
			await handleInstall(manager, cmd.args, cmd.flags);
			break;
		case "uninstall":
			await handleUninstall(manager, cmd.args, cmd.flags);
			break;
		case "list":
			await handleList(manager, cmd.flags);
			break;
		case "link":
			await handleLink(manager, cmd.args, cmd.flags);
			break;
		case "doctor":
			await handleDoctor(manager, cmd.flags);
			break;
		case "features":
			await handleFeatures(manager, cmd.args, cmd.flags);
			break;
		case "config":
			await handleConfig(manager, cmd.args, cmd.flags);
			break;
		case "enable":
			await handleEnable(manager, cmd.args, cmd.flags);
			break;
		case "disable":
			await handleDisable(manager, cmd.args, cmd.flags);
			break;
		case "marketplace":
			await handleMarketplace(cmd.args, cmd.flags);
			break;
		case "discover":
			await handleDiscover(cmd.args, cmd.flags);
			break;
		case "upgrade":
			await handleUpgrade(cmd.args, cmd.flags);
			break;
	}
}

// =============================================================================
// Marketplace Handlers
// =============================================================================

async function makeMarketplaceManager(): Promise<MarketplaceManager> {
	return new MarketplaceManager({
		marketplacesRegistryPath: getMarketplacesRegistryPath(),
		installedRegistryPath: getInstalledPluginsRegistryPath(),
		projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(getProjectDir()),
		marketplacesCacheDir: getMarketplacesCacheDir(),
		pluginsCacheDir: getPluginsCacheDir(),
	});
}

async function handleMarketplace(args: string[], _flags: PluginCommandArgs["flags"]): Promise<void> {
	const subcommand = args[0] ?? "list";
	const manager = await makeMarketplaceManager();

	switch (subcommand) {
		case "add": {
			const source = args[1];
			if (!source) {
				console.error(chalk.red(t("Usage: {app} plugin marketplace add <source>", { app: APP_NAME })));
				process.exit(1);
			}
			try {
				await manager.addMarketplace(source);
				console.log(chalk.green(`${theme.status.success} ${t("Added marketplace: {name}", { name: source })}`));
			} catch (err) {
				console.error(
					chalk.red(`${theme.status.error} ${t("Failed to add marketplace: {error}", { error: err })}`),
				);
				process.exit(1);
			}
			break;
		}
		case "remove":
		case "rm": {
			const name = args[1];
			if (!name) {
				console.error(chalk.red(t("Usage: {app} plugin marketplace remove <name>", { app: APP_NAME })));
				process.exit(1);
			}
			try {
				await manager.removeMarketplace(name);
				console.log(chalk.green(`${theme.status.success} ${t("Removed marketplace: {name}", { name })}`));
			} catch (err) {
				console.error(
					chalk.red(`${theme.status.error} ${t("Failed to remove marketplace: {error}", { error: err })}`),
				);
				process.exit(1);
			}
			break;
		}
		case "update": {
			try {
				const name = args[1];
				if (name) {
					await manager.updateMarketplace(name);
					console.log(chalk.green(`${theme.status.success} ${t("Updated marketplace: {name}", { name })}`));
				} else {
					const results = await manager.updateAllMarketplaces();
					console.log(
						chalk.green(
							`${theme.status.success} ${t("Updated {count} marketplace(s)", { count: results.length })}`,
						),
					);
				}
			} catch (err) {
				console.error(
					chalk.red(`${theme.status.error} ${t("Failed to update marketplace: {error}", { error: err })}`),
				);
				process.exit(1);
			}
			break;
		}
		default: {
			if (subcommand !== "list") {
				console.error(chalk.red(t("Unknown marketplace subcommand: {subcommand}", { subcommand })));
				console.error(chalk.dim(t("Valid subcommands: add, remove, update, list")));
				process.exit(1);
			}
			try {
				const marketplaces = await manager.listMarketplaces();
				if (marketplaces.length === 0) {
					console.log(chalk.dim(t("No marketplaces configured")));
					console.log(chalk.dim(t("\nAdd one with: {app} plugin marketplace add <source>", { app: APP_NAME })));
					return;
				}
				console.log(chalk.bold(t("Configured Marketplaces:\n")));
				for (const mp of marketplaces) {
					console.log(`  ${chalk.cyan(mp.name)}  ${chalk.dim(mp.sourceUri)}`);
				}
			} catch (err) {
				console.error(
					chalk.red(`${theme.status.error} ${t("Failed to list marketplaces: {error}", { error: err })}`),
				);
				process.exit(1);
			}
			break;
		}
	}
}

async function handleDiscover(args: string[], _flags: PluginCommandArgs["flags"]): Promise<void> {
	const marketplace = args[0];
	const manager = await makeMarketplaceManager();
	try {
		const plugins = await manager.listAvailablePlugins(marketplace);

		if (plugins.length === 0) {
			console.log(
				chalk.dim(
					marketplace ? t("No plugins found in {marketplace}", { marketplace }) : t("No plugins available"),
				),
			);
			return;
		}

		console.log(
			chalk.bold(
				marketplace ? t("Available Plugins ({marketplace}):\n", { marketplace }) : t("Available Plugins:\n"),
			),
		);
		for (const plugin of plugins) {
			console.log(`  ${chalk.cyan(plugin.name)}${plugin.version ? `@${plugin.version}` : ""}`);
			if (plugin.description) {
				console.log(chalk.dim(`    ${plugin.description}`));
			}
		}
	} catch (err) {
		console.error(chalk.red(`${theme.status.error} ${t("Failed to discover plugins: {error}", { error: err })}`));
		process.exit(1);
	}
}

async function handleUpgrade(args: string[], flags: PluginCommandArgs["flags"]): Promise<void> {
	const manager = await makeMarketplaceManager();
	const pluginId = args[0];
	try {
		if (pluginId) {
			if (flags.scope) {
				const result = await manager.upgradePlugin(pluginId, flags.scope);
				console.log(
					chalk.green(
						t("Upgraded {plugin} ({scope}) to {version}", {
							plugin: pluginId,
							scope: flags.scope,
							version: result.version,
						}),
					),
				);
			} else {
				const entries = await manager.upgradePluginAcrossScopes(pluginId);
				for (const entry of entries) {
					console.log(
						chalk.green(
							t("Upgraded {plugin} ({scope}) to {version}", {
								plugin: pluginId,
								scope: entry.scope,
								version: entry.version,
							}),
						),
					);
				}
			}
		} else {
			if (flags.scope) {
				console.error(
					chalk.yellow(
						t(
							"Warning: --scope is ignored when upgrading all plugins. Use 'omp plugin upgrade <id> --scope {scope}' to target a specific plugin and scope.",
							{ scope: flags.scope },
						),
					),
				);
			}
			const results = await manager.upgradeAllPlugins();
			if (results.length === 0) {
				console.log(t("All marketplace plugins are up to date."));
			} else {
				for (const r of results) {
					console.log(chalk.green(`  ${r.pluginId} (${r.scope}): ${r.from} -> ${r.to}`));
				}
			}
		}
	} catch (err) {
		console.error(chalk.red(t("Failed to upgrade: {error}", { error: err })));
		process.exit(1);
	}
}

async function handleInstall(
	manager: PluginManager,
	packages: string[],
	flags: { json?: boolean; force?: boolean; dryRun?: boolean; scope?: "user" | "project" },
): Promise<void> {
	if (packages.length === 0) {
		console.error(chalk.red(t("Usage: {app} plugin install <source>[features] ...", { app: APP_NAME })));
		console.error(chalk.dim(t("Examples:")));
		console.error(chalk.dim(`  ${APP_NAME} plugin install @oh-my-pi/exa`));
		console.error(chalk.dim(`  ${APP_NAME} plugin install name@marketplace`));
		console.error(chalk.dim(`  ${APP_NAME} plugin install github:user/repo`));
		console.error(chalk.dim(`  ${APP_NAME} plugin install https://github.com/user/repo#v1.0`));
		console.error(chalk.dim(`  ${APP_NAME} plugin install ./path/to/local/plugin`));
		process.exit(1);
	}

	// Build known marketplace set for classification
	const mktMgr = await makeMarketplaceManager();
	const knownMarketplaces = new Set((await mktMgr.listMarketplaces()).map(m => m.name));

	for (const spec of packages) {
		const target = classifyInstallTarget(spec, knownMarketplaces);

		if (target.type === "marketplace") {
			try {
				const entry = await mktMgr.installPlugin(target.name, target.marketplace, {
					force: flags.force,
					scope: flags.scope,
				});
				console.log(
					chalk.green(
						`${theme.status.success} ${t("Installed {name} from {marketplace} ({version})", {
							name: target.name,
							marketplace: target.marketplace,
							version: entry.version,
						})}`,
					),
				);
			} catch (err) {
				console.error(
					chalk.red(`${theme.status.error} ${t("Failed to install {spec}: {error}", { spec, error: err })}`),
				);
				process.exit(1);
			}
			continue;
		}

		if (target.type === "local") {
			// Local paths route to link(): symlink the directory into the plugins
			// node_modules tree so source edits show up without a reinstall. Matches
			// `omp plugin link <path>` so users can use either verb interchangeably.
			if (flags.scope) {
				console.error(
					chalk.yellow(
						t(
							"Warning: --scope is only supported for marketplace installs (name@marketplace). Ignoring for {spec}.",
							{ spec },
						),
					),
				);
			}
			if (flags.force) {
				console.error(
					chalk.yellow(
						t(
							"Warning: --force has no effect for local path installs (link is already idempotent). Ignoring for {spec}.",
							{ spec },
						),
					),
				);
			}
			if (flags.dryRun) {
				if (flags.json) {
					console.log(JSON.stringify({ dryRun: true, action: "link", path: target.path }, null, 2));
				} else {
					console.log(chalk.dim(t("[dry-run] Would link {spec}", { spec })));
				}
				continue;
			}
			try {
				const result = await manager.link(target.path);
				if (flags.json) {
					console.log(JSON.stringify(result, null, 2));
				} else {
					console.log(
						chalk.green(`${theme.status.success} ${t("Linked {name} from {spec}", { name: result.name, spec })}`),
					);
					if (result.manifest.description) {
						console.log(chalk.dim(`  ${result.manifest.description}`));
					}
				}
			} catch (err) {
				console.error(
					chalk.red(`${theme.status.error} ${t("Failed to install {spec}: {error}", { spec, error: err })}`),
				);
				process.exit(1);
			}
			continue;
		}

		// --scope only applies to marketplace installs; warn when it would be silently no-op'd for npm.
		if (flags.scope) {
			console.error(
				chalk.yellow(
					t(
						"Warning: --scope is only supported for marketplace installs (name@marketplace). Ignoring for {spec}.",
						{ spec },
					),
				),
			);
		}

		// npm path
		try {
			const result = await manager.install(spec, { force: flags.force, dryRun: flags.dryRun });

			if (flags.json) {
				console.log(JSON.stringify(result, null, 2));
			} else {
				if (flags.dryRun) {
					console.log(chalk.dim(t("[dry-run] Would install {spec}", { spec })));
				} else {
					console.log(
						chalk.green(
							`${theme.status.success} ${t("Installed {name}@{version}", {
								name: result.name,
								version: result.version,
							})}`,
						),
					);
					if (result.enabledFeatures && result.enabledFeatures.length > 0) {
						console.log(chalk.dim(t("  Features: {features}", { features: result.enabledFeatures.join(", ") })));
					}
					if (result.manifest.description) {
						console.log(chalk.dim(`  ${result.manifest.description}`));
					}
				}
			}
		} catch (err) {
			console.error(
				chalk.red(`${theme.status.error} ${t("Failed to install {spec}: {error}", { spec, error: err })}`),
			);
			process.exit(1);
		}
	}
}

async function handleUninstall(
	manager: PluginManager,
	packages: string[],
	flags: { json?: boolean; dryRun?: boolean; scope?: "user" | "project" },
): Promise<void> {
	if (packages.length === 0) {
		console.error(chalk.red(t("Usage: {app} plugin uninstall <package> ...", { app: APP_NAME })));
		process.exit(1);
	}

	// For uninstall, check the installed plugins registry directly.
	// This works even if the marketplace entry was later removed from marketplaces.json.
	const mktMgr = await makeMarketplaceManager();
	const installedIds = (await mktMgr.listInstalledPlugins()).map(p => p.id);
	const installedPlugins = new Set(installedIds);

	// Installed marketplace IDs are `name@marketplace`, so a bare name never matches one
	// exactly. Resolve it when exactly one marketplace supplies that name: without this the
	// bare form falls through to the npm path, where `bun uninstall` exits 0 for a package
	// that was never a dependency and the command reports a removal that did not happen.
	const marketplaceIdsFor = (name: string): string[] =>
		installedIds.filter(id => id.slice(0, id.lastIndexOf("@")) === name);

	for (const rawName of packages) {
		let name = rawName;
		if (!installedPlugins.has(name)) {
			const candidates = marketplaceIdsFor(name);
			if (candidates.length === 1) {
				name = candidates[0] as string;
			} else if (candidates.length > 1) {
				console.error(
					chalk.red(
						`${theme.status.error} ${t(
							"{name} is installed from {count} marketplaces. Qualify it: {candidates}",
							{
								name: rawName,
								count: candidates.length,
								candidates: candidates.join(", "),
							},
						)}`,
					),
				);
				process.exit(1);
			}
		}

		const viaMarketplace = installedPlugins.has(name);

		if (flags.dryRun) {
			if (viaMarketplace) {
				try {
					await mktMgr.uninstallPlugin(name, flags.scope, { dryRun: true });
				} catch (err) {
					console.error(
						chalk.red(`${theme.status.error} ${t("Failed to uninstall {name}: {error}", { name, error: err })}`),
					);
					process.exit(1);
				}
			}

			// Marketplace dry-runs validate the requested scope before reporting.
			if (flags.json) {
				console.log(
					JSON.stringify({
						dryRun: true,
						action: "uninstall",
						plugin: name,
						source: viaMarketplace ? "marketplace" : "npm",
					}),
				);
			} else {
				console.log(chalk.dim(t("[dry-run] Would uninstall {name}", { name })));
			}
			continue;
		}

		if (viaMarketplace) {
			// Exact match against installed marketplace plugin IDs (name@marketplace)
			try {
				await mktMgr.uninstallPlugin(name, flags.scope);
				console.log(chalk.green(`${theme.status.success} ${t("Uninstalled {name}", { name })}`));
			} catch (err) {
				console.error(
					chalk.red(`${theme.status.error} ${t("Failed to uninstall {name}: {error}", { name, error: err })}`),
				);
				process.exit(1);
			}
			continue;
		}

		// npm path. `bun uninstall` exits 0 for a package that is not a dependency, so an
		// unknown name would otherwise print a success line having removed nothing.
		const npmPlugins = await manager.list();
		if (!npmPlugins.some(p => p.name === name)) {
			console.error(chalk.red(`${theme.status.error} ${t("{name} is not installed", { name: rawName })}`));
			process.exit(1);
		}

		try {
			await manager.uninstall(name);
			if (flags.json) {
				console.log(JSON.stringify({ uninstalled: name }));
			} else {
				console.log(chalk.green(`${theme.status.success} ${t("Uninstalled {name}", { name })}`));
			}
		} catch (err) {
			console.error(
				chalk.red(`${theme.status.error} ${t("Failed to uninstall {name}: {error}", { name, error: err })}`),
			);
			process.exit(1);
		}
	}
}

async function handleList(manager: PluginManager, flags: { json?: boolean }): Promise<void> {
	const npmPlugins = await manager.list();
	const mktMgr = await makeMarketplaceManager();
	const mktPlugins = await mktMgr.listInstalledPlugins();

	if (flags.json) {
		console.log(JSON.stringify({ npm: npmPlugins, marketplace: mktPlugins }, null, 2));
		return;
	}

	if (npmPlugins.length === 0 && mktPlugins.length === 0) {
		console.log(chalk.dim(t("No plugins installed")));
		console.log(chalk.dim(t("\nInstall plugins with: {app} plugin install <package>", { app: APP_NAME })));
		return;
	}

	if (npmPlugins.length > 0) {
		console.log(chalk.bold(t("npm Plugins:\n")));
		for (const plugin of npmPlugins) {
			const status = plugin.enabled ? chalk.green(theme.status.enabled) : chalk.dim(theme.status.disabled);
			const nameVersion = `${plugin.name}@${plugin.version}`;
			console.log(`${status} ${nameVersion}`);
			if (plugin.manifest.description) {
				console.log(chalk.dim(`  ${plugin.manifest.description}`));
			}
			if (plugin.enabledFeatures && plugin.enabledFeatures.length > 0) {
				console.log(chalk.dim(t("  Features: {features}", { features: plugin.enabledFeatures.join(", ") })));
			}
			if (plugin.manifest.features) {
				const availableFeatures = Object.keys(plugin.manifest.features);
				if (availableFeatures.length > 0) {
					const enabledSet = new Set(plugin.enabledFeatures ?? []);
					const featureDisplay = availableFeatures
						.map(f => (enabledSet.has(f) ? chalk.green(f) : chalk.dim(f)))
						.join(", ");
					console.log(chalk.dim(t("  Available: [{features}]", { features: featureDisplay })));
				}
			}
		}
	}

	if (mktPlugins.length > 0) {
		if (npmPlugins.length > 0) console.log();
		console.log(chalk.bold(t("Marketplace Plugins:\n")));
		for (const plugin of mktPlugins) {
			const entry = plugin.entries[0];
			const version = entry?.version ?? t("unknown");
			const shadowLabel = plugin.shadowedBy ? chalk.dim(t(" [shadowed]")) : "";
			const scopeLabel = chalk.dim(` (${plugin.scope})`);
			console.log(`  ${plugin.id} (${version})${scopeLabel}${shadowLabel}`);
		}
	}
}

async function handleLink(manager: PluginManager, paths: string[], flags: { json?: boolean }): Promise<void> {
	if (paths.length === 0) {
		console.error(chalk.red(t("Usage: {app} plugin link <path>", { app: APP_NAME })));
		process.exit(1);
	}

	try {
		const result = await manager.link(paths[0]);

		if (flags.json) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			console.log(
				chalk.green(
					`${theme.status.success} ${t("Linked {name} from {spec}", { name: result.name, spec: paths[0] })}`,
				),
			);
		}
	} catch (err) {
		console.error(chalk.red(`${theme.status.error} ${t("Failed to link: {error}", { error: err })}`));
		process.exit(1);
	}
}

async function handleDoctor(manager: PluginManager, flags: { json?: boolean; fix?: boolean }): Promise<void> {
	const checks = await manager.doctor({ fix: flags.fix });

	if (flags.json) {
		console.log(JSON.stringify(checks, null, 2));
		return;
	}

	console.log(chalk.bold(t("Plugin Health Check\n")));

	for (const check of checks) {
		const icon =
			check.status === "ok"
				? chalk.green(theme.status.success)
				: check.status === "warning"
					? chalk.yellow(theme.status.warning)
					: chalk.red(theme.status.error);
		console.log(`${icon} ${check.name}: ${check.message}`);
		if (check.fixed) {
			console.log(chalk.dim(`  ${theme.nav.cursor} ${t("Fixed")}`));
		}
	}

	const errors = checks.filter(c => c.status === "error" && !c.fixed).length;
	const warnings = checks.filter(c => c.status === "warning" && !c.fixed).length;
	const ok = checks.filter(c => c.status === "ok").length;
	const fixed = checks.filter(c => c.fixed).length;

	console.log("");
	console.log(
		t(
			fixed > 0
				? "Summary: {ok} ok, {warnings} warnings, {errors} errors, {fixed} fixed"
				: "Summary: {ok} ok, {warnings} warnings, {errors} errors",
			{ ok, warnings, errors, fixed },
		),
	);

	if (errors > 0) {
		if (!flags.fix) {
			console.log(chalk.dim(t("\nRun with --fix to attempt automatic repair")));
		}
		process.exit(1);
	}
}

async function handleFeatures(
	manager: PluginManager,
	args: string[],
	flags: { json?: boolean; enable?: string; disable?: string; set?: string },
): Promise<void> {
	if (args.length === 0) {
		console.error(
			chalk.red(
				t("Usage: {app} plugin features <plugin> [--enable f1,f2] [--disable f1] [--set f1,f2]", {
					app: APP_NAME,
				}),
			),
		);
		process.exit(1);
	}

	const pluginName = args[0];
	const plugin = await manager.getPlugin(pluginName, { path: path.join(getPluginsNodeModules(), pluginName) });

	if (!plugin) {
		console.error(chalk.red(t('Plugin "{plugin}" not found', { plugin: pluginName })));
		process.exit(1);
	}

	// Handle modifications
	if (flags.enable || flags.disable || flags.set) {
		let currentFeatures = new Set((await manager.getEnabledFeatures(pluginName)) ?? []);

		if (flags.set) {
			// --set replaces all features
			currentFeatures = new Set(
				flags.set
					.split(",")
					.map(f => f.trim())
					.filter(Boolean),
			);
		} else {
			if (flags.enable) {
				for (const f of flags.enable
					.split(",")
					.map(f => f.trim())
					.filter(Boolean)) {
					currentFeatures.add(f);
				}
			}
			if (flags.disable) {
				for (const f of flags.disable
					.split(",")
					.map(f => f.trim())
					.filter(Boolean)) {
					currentFeatures.delete(f);
				}
			}
		}

		await manager.setEnabledFeatures(pluginName, [...currentFeatures]);
		console.log(chalk.green(`${theme.status.success} ${t("Updated features for {plugin}", { plugin: pluginName })}`));
	}

	// Display current state
	const updatedFeatures = await manager.getEnabledFeatures(pluginName);

	if (flags.json) {
		console.log(
			JSON.stringify(
				{
					plugin: pluginName,
					enabledFeatures: updatedFeatures,
					availableFeatures: plugin.manifest.features ? Object.keys(plugin.manifest.features) : [],
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(chalk.bold(t("Features for {plugin}:\n", { plugin: pluginName })));

	if (!plugin.manifest.features || Object.keys(plugin.manifest.features).length === 0) {
		console.log(chalk.dim(t("  No optional features available")));
		return;
	}

	const enabledSet = new Set(updatedFeatures ?? []);
	for (const [name, feat] of Object.entries(plugin.manifest.features)) {
		const enabled = enabledSet.has(name);
		const icon = enabled ? chalk.green(theme.status.enabled) : chalk.dim(theme.status.disabled);
		const defaultLabel = feat.default ? chalk.dim(t(" (default)")) : "";
		console.log(`${icon} ${name}${defaultLabel}`);
		if (feat.description) {
			console.log(chalk.dim(`    ${feat.description}`));
		}
	}
}

async function handleConfig(
	manager: PluginManager,
	args: string[],
	flags: { json?: boolean; local?: boolean },
): Promise<void> {
	if (args.length === 0) {
		console.error(
			chalk.red(
				t("Usage: {app} plugin config <list|get|set|delete|validate> <plugin> [key] [value]", {
					app: APP_NAME,
				}),
			),
		);
		process.exit(1);
	}

	const [subcommand, pluginName, key, ...valueArgs] = args;

	// Special case: validate doesn't need a plugin name
	if (subcommand === "validate") {
		await handleConfigValidate(manager, flags);
		return;
	}

	if (!pluginName) {
		console.error(chalk.red(t("Plugin name required")));
		process.exit(1);
	}

	const plugin = await manager.getPlugin(pluginName);

	if (!plugin) {
		console.error(chalk.red(t('Plugin "{plugin}" not found', { plugin: pluginName })));
		process.exit(1);
	}

	switch (subcommand) {
		case "list": {
			const settings = await manager.getPluginSettings(pluginName);
			const schema = plugin.manifest.settings || {};

			if (flags.json) {
				console.log(JSON.stringify({ settings, schema }, null, 2));
				return;
			}

			console.log(chalk.bold(t("Settings for {plugin}:\n", { plugin: pluginName })));

			if (Object.keys(schema).length === 0) {
				console.log(chalk.dim(t("  No settings defined")));
				return;
			}

			for (const [k, s] of Object.entries(schema)) {
				const value = settings[k] ?? s.default;
				const displayValue = s.secret && value ? "********" : String(value ?? chalk.dim(t("(not set)")));
				console.log(`  ${k}: ${displayValue}`);
				if (s.description) {
					console.log(chalk.dim(`    ${s.description}`));
				}
				if (s.env) {
					console.log(chalk.dim(t("    env: {env}", { env: s.env })));
				}
			}
			break;
		}

		case "get": {
			if (!key) {
				console.error(chalk.red(t("Key required")));
				process.exit(1);
			}

			const settings = await manager.getPluginSettings(pluginName);
			const schema = plugin.manifest.settings?.[key];
			const value = settings[key] ?? schema?.default;

			if (flags.json) {
				console.log(JSON.stringify({ [key]: value }));
			} else {
				const displayValue = schema?.secret && value ? "********" : String(value ?? t("(not set)"));
				console.log(displayValue);
			}
			break;
		}

		case "set": {
			if (!key) {
				console.error(chalk.red(t("Key required")));
				process.exit(1);
			}

			const valueStr = valueArgs.join(" ");
			const schema = plugin.manifest.settings?.[key];

			// Parse value according to type
			let value: unknown = valueStr;
			if (schema) {
				value = parseSettingValue(valueStr, schema);

				// Validate
				const validation = validateSetting(value, schema);
				if (!validation.valid) {
					console.error(chalk.red(validation.error!));
					process.exit(1);
				}
			}

			await manager.setPluginSetting(pluginName, key, value);
			console.log(chalk.green(`${theme.status.success} ${t("Set {key}", { key })}`));
			break;
		}

		case "delete": {
			if (!key) {
				console.error(chalk.red(t("Key required")));
				process.exit(1);
			}

			await manager.deletePluginSetting(pluginName, key);
			console.log(chalk.green(`${theme.status.success} ${t("Deleted {key}", { key })}`));
			break;
		}

		default:
			console.error(chalk.red(t("Unknown config subcommand: {subcommand}", { subcommand })));
			console.error(chalk.dim(t("Valid subcommands: list, get, set, delete, validate")));
			process.exit(1);
	}
}

/**
 * Enumerate every installed plugin to validate — npm/link plugins from
 * {@link PluginManager.list} plus marketplace runtime packages, which `list()`
 * intentionally omits. Marketplace summaries are resolved through their trusted
 * install path; deduped by resolved package name using the same active-scope
 * precedence as runtime loading.
 */
async function collectPluginsForValidation(manager: PluginManager): Promise<InstalledPlugin[]> {
	const byName = new Map<string, InstalledPlugin>();
	for (const plugin of await manager.list()) {
		byName.set(plugin.name, plugin);
	}
	const mktMgr = await makeMarketplaceManager();
	for (const summary of await mktMgr.listInstalledPlugins()) {
		const entry = summary.entries[0];
		if (!entry) continue;
		const fallbackName = parsePluginId(summary.id)?.name ?? summary.id;
		const resolved = await manager.getPlugin(fallbackName, { path: entry.installPath });
		if (!resolved) continue;
		byName.set(resolved.name, (await manager.getPlugin(resolved.name)) ?? resolved);
	}
	return [...byName.values()];
}

async function handleConfigValidate(manager: PluginManager, flags: { json?: boolean }): Promise<void> {
	const plugins = await collectPluginsForValidation(manager);
	const results: Array<{ plugin: string; key: string; error: string }> = [];

	for (const plugin of plugins) {
		const settings = await manager.getPluginSettings(plugin.name);
		const schema = plugin.manifest.settings || {};

		for (const [key, s] of Object.entries(schema)) {
			const value = settings[key];
			if (value !== undefined) {
				const validation = validateSetting(value, s);
				if (!validation.valid) {
					results.push({ plugin: plugin.name, key, error: validation.error! });
				}
			}
		}
	}

	if (flags.json) {
		console.log(JSON.stringify({ valid: results.length === 0, errors: results }, null, 2));
		return;
	}

	if (results.length === 0) {
		console.log(chalk.green(`${theme.status.success} ${t("All settings valid")}`));
	} else {
		for (const { plugin, key, error } of results) {
			console.log(chalk.red(`${theme.status.error} ${plugin}.${key}: ${error}`));
		}
		process.exit(1);
	}
}

async function handleEnable(
	manager: PluginManager,
	plugins: string[],
	flags: { json?: boolean; scope?: "user" | "project" },
): Promise<void> {
	return handleSetEnabled(manager, plugins, flags, true);
}

async function handleDisable(
	manager: PluginManager,
	plugins: string[],
	flags: { json?: boolean; scope?: "user" | "project" },
): Promise<void> {
	return handleSetEnabled(manager, plugins, flags, false);
}

async function handleSetEnabled(
	manager: PluginManager,
	plugins: string[],
	flags: { json?: boolean; scope?: "user" | "project" },
	enabled: boolean,
): Promise<void> {
	const action = enabled ? "enable" : "disable";
	const successKey = enabled ? "Enabled {name}" : "Disabled {name}";
	const failureKey = enabled ? "Failed to enable {name}: {error}" : "Failed to disable {name}: {error}";
	const jsonKey = enabled ? "enabled" : "disabled";

	if (plugins.length === 0) {
		console.error(chalk.red(t("Usage: {app} plugin {action} <plugin> ...", { app: APP_NAME, action })));
		process.exit(1);
	}

	const mktMgr = await makeMarketplaceManager();
	const installedPlugins = new Set((await mktMgr.listInstalledPlugins()).map(p => p.id));

	for (const name of plugins) {
		if (installedPlugins.has(name)) {
			try {
				await mktMgr.setPluginEnabled(name, enabled, flags.scope);
				if (flags.json) {
					console.log(JSON.stringify({ [jsonKey]: name }));
				} else {
					console.log(chalk.green(`${theme.status.success} ${t(successKey, { name })}`));
				}
			} catch (err) {
				console.error(chalk.red(`${theme.status.error} ${t(failureKey, { name, error: err })}`));
				process.exit(1);
			}
			continue;
		}

		try {
			await manager.setEnabled(name, enabled);
			if (flags.json) {
				console.log(JSON.stringify({ [jsonKey]: name }));
			} else {
				console.log(chalk.green(`${theme.status.success} ${t(successKey, { name })}`));
			}
		} catch (err) {
			console.error(chalk.red(`${theme.status.error} ${t(failureKey, { name, error: err })}`));
			process.exit(1);
		}
	}
}

// =============================================================================
// Help
// =============================================================================

export function printPluginHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} plugin`)} - ${t("Plugin lifecycle management")}

${chalk.bold(t("Commands:"))}
${t("  install <source>[features]     Install plugins from npm, GitHub, or git URL")}
${t("  uninstall <pkg>                Remove plugins")}
${t("  list                           Show installed plugins")}
${t("  link <path>                    Link local plugin for development")}
${t("  doctor                         Check plugin health")}
${t("  features <pkg>                 View/modify enabled features")}
${t("  config <cmd> <pkg> [key] [val] Manage plugin settings")}
${t("  enable <pkg>                   Enable a disabled plugin")}
${t("  disable <pkg>                  Disable plugin without uninstalling")}
${t("  marketplace <cmd>            Manage marketplace sources (add, remove, update, list)")}
${t("  discover [marketplace]        Browse available marketplace plugins")}

${chalk.bold(t("Feature Syntax:"))}
${t("  pkg                Install with default features")}
${t("  pkg[feat1,feat2]   Install with specific features")}
${t("  pkg[*]             Install with all features")}
${t("  pkg[]              Install with no optional features")}

${chalk.bold(t("Sources:"))}
${t("  pkg, pkg@1.2.3                  npm package (optionally pinned)")}
${t("  github:user/repo[#ref]          GitHub shorthand (also gitlab:, bitbucket:, codeberg:, sourcehut:)")}
${t("  https://github.com/user/repo    Full git URL (https, ssh, or git protocol)")}
${t("  name@marketplace                Marketplace plugin (see marketplace command)")}
${t("  ./path, ../path, /abs, ~/path   Local plugin directory (symlinked, same as plugin link)")}

${chalk.bold(t("Config Subcommands:"))}
${t("  config list <pkg>              List all settings")}
${t("  config get <pkg> <key>         Get a setting value")}
${t("  config set <pkg> <key> <val>   Set a setting value")}
${t("  config delete <pkg> <key>      Delete a setting")}
${t("  config validate                Validate all plugin settings")}

${chalk.bold(t("Options:"))}
${t("  --json           Output as JSON")}
${t("  --fix            Attempt automatic fixes (doctor)")}
${t("  --force          Overwrite without prompting (install)")}
${t("  --scope <scope>  Install scope: user (default) or project (install name@marketplace)")}
${t("  --dry-run        Preview changes without applying (install)")}
${t("  -l, --local      Use project-local overrides")}

${chalk.bold(t("Examples:"))}
  ${APP_NAME} plugin install @oh-my-pi/exa[search]
  ${APP_NAME} plugin list --json
  ${APP_NAME} plugin features my-plugin --enable search,web
  ${APP_NAME} plugin config set my-plugin apiKey sk-xxx
  ${APP_NAME} plugin doctor --fix
  ${APP_NAME} plugin install --scope project name@marketplace
  ${APP_NAME} plugin install github:user/repo#v1.0
`);
}
