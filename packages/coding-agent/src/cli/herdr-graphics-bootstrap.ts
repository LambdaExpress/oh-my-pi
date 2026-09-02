import * as os from "node:os";
import * as path from "node:path";

export interface HerdrGraphicsBootstrapOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	homeDir?: string;
	readConfig?: (configPath: string) => Promise<string>;
}

function resolveHerdrConfigPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, homeDir: string): string {
	const override = env.HERDR_CONFIG_PATH?.trim();
	if (override) return override;
	if (platform === "win32") {
		const configHome = env.APPDATA?.trim() || path.win32.join(homeDir, "AppData", "Roaming");
		return path.win32.join(configHome, "herdr", "config.toml");
	}
	const configHome = env.XDG_CONFIG_HOME?.trim() || path.posix.join(homeDir, ".config");
	return path.posix.join(configHome, "herdr", "config.toml");
}

function hasKittyGraphicsEnabled(config: unknown): boolean {
	if (typeof config !== "object" || config === null) return false;
	const experimental = (config as Record<string, unknown>).experimental;
	if (typeof experimental !== "object" || experimental === null) return false;
	return (experimental as Record<string, unknown>).kitty_graphics === true;
}

function hasKnownKittyGraphicsHost(env: NodeJS.ProcessEnv): boolean {
	if (env.HERDR_KITTY_GRAPHICS === "1" || env.KITTY_WINDOW_ID || env.GHOSTTY_RESOURCES_DIR || env.WEZTERM_PANE) {
		return true;
	}
	const termProgram = env.TERM_PROGRAM?.trim().toLowerCase();
	return termProgram === "kitty" || termProgram === "ghostty" || termProgram === "wezterm";
}

/** Apply OMP's image protocol before the TUI graph loads when Herdr explicitly enables Kitty graphics. */
export async function bootstrapHerdrGraphics(options: HerdrGraphicsBootstrapOptions = {}): Promise<boolean> {
	const env = options.env ?? process.env;
	if (env.HERDR_ENV !== "1") return false;

	const platform = options.platform ?? process.platform;
	const homeDir = options.homeDir ?? os.homedir();
	const configPath = resolveHerdrConfigPath(env, platform, homeDir);
	const readConfig = options.readConfig ?? (async (filePath: string) => Bun.file(filePath).text());

	try {
		const config = Bun.TOML.parse(await readConfig(configPath));
		if (!hasKittyGraphicsEnabled(config)) return false;
		const forcedProtocol = env.PI_FORCE_IMAGE_PROTOCOL?.trim().toLowerCase();
		if (forcedProtocol !== undefined && forcedProtocol !== "kitty") return false;
		if (forcedProtocol === undefined) {
			if (!hasKnownKittyGraphicsHost(env)) return false;
			env.PI_FORCE_IMAGE_PROTOCOL = "kitty";
		}
		if (
			(forcedProtocol ?? "kitty") === "kitty" &&
			env.PI_KITTY_PLACEHOLDERS === undefined &&
			env.PI_NO_KITTY_PLACEHOLDERS === undefined
		) {
			env.PI_KITTY_PLACEHOLDERS = "1";
		}
		return true;
	} catch {
		return false;
	}
}
