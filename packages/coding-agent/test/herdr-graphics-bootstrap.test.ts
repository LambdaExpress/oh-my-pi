import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { bootstrapHerdrGraphics } from "../src/cli/herdr-graphics-bootstrap";

describe("bootstrapHerdrGraphics", () => {
	it("enables Kitty thumbnails when Herdr explicitly enables graphics", async () => {
		const env: NodeJS.ProcessEnv = {
			HERDR_ENV: "1",
			WEZTERM_PANE: "1",
			WT_SESSION: "inherited-windows-terminal-session",
			APPDATA: "C:\\Users\\test\\AppData\\Roaming",
		};
		let configPath: string | undefined;

		const enabled = await bootstrapHerdrGraphics({
			env,
			platform: "win32",
			homeDir: "C:\\Users\\test",
			readConfig: async filePath => {
				configPath = filePath;
				return "[experimental]\nkitty_graphics = true\n";
			},
		});

		expect(enabled).toBe(true);
		expect(configPath).toBe(path.win32.join(env.APPDATA!, "herdr", "config.toml"));
		expect(env.PI_FORCE_IMAGE_PROTOCOL).toBe("kitty");
		expect(env.PI_KITTY_PLACEHOLDERS).toBe("1");
	});

	it("leaves graphics disabled unless the Herdr config opts in", async () => {
		const env: NodeJS.ProcessEnv = { HERDR_ENV: "1", XDG_CONFIG_HOME: "/tmp/config" };

		const enabled = await bootstrapHerdrGraphics({
			env,
			platform: "linux",
			homeDir: "/home/test",
			readConfig: async () => "[experimental]\nkitty_graphics = false\n",
		});

		expect(enabled).toBe(false);
		expect(env.PI_FORCE_IMAGE_PROTOCOL).toBeUndefined();
		expect(env.PI_KITTY_PLACEHOLDERS).toBeUndefined();
	});

	it("does not enable Kitty graphics when Windows Terminal hosts Herdr", async () => {
		const env: NodeJS.ProcessEnv = {
			HERDR_ENV: "1",
			WT_SESSION: "windows-terminal-session",
			APPDATA: "C:\\Users\\test\\AppData\\Roaming",
		};

		const enabled = await bootstrapHerdrGraphics({
			env,
			platform: "win32",
			homeDir: "C:\\Users\\test",
			readConfig: async () => "[experimental]\nkitty_graphics = true\n",
		});

		expect(enabled).toBe(false);
		expect(env.PI_FORCE_IMAGE_PROTOCOL).toBeUndefined();
		expect(env.PI_KITTY_PLACEHOLDERS).toBeUndefined();
	});

	it("enables pane Kitty output when Herdr advertises host conversion", async () => {
		const env: NodeJS.ProcessEnv = {
			HERDR_ENV: "1",
			HERDR_KITTY_GRAPHICS: "1",
			WT_SESSION: "windows-terminal-session",
			APPDATA: "C:\\Users\\test\\AppData\\Roaming",
		};

		const enabled = await bootstrapHerdrGraphics({
			env,
			platform: "win32",
			homeDir: "C:\\Users\\test",
			readConfig: async () => "[experimental]\nkitty_graphics = true\n",
		});

		expect(enabled).toBe(true);
		expect(env.PI_FORCE_IMAGE_PROTOCOL).toBe("kitty");
		expect(env.PI_KITTY_PLACEHOLDERS).toBe("1");
	});

	it("preserves explicit image protocol and placeholder overrides", async () => {
		const env: NodeJS.ProcessEnv = {
			HERDR_ENV: "1",
			HERDR_CONFIG_PATH: "/tmp/herdr.toml",
			PI_FORCE_IMAGE_PROTOCOL: "sixel",
			PI_KITTY_PLACEHOLDERS: "0",
		};

		const enabled = await bootstrapHerdrGraphics({
			env,
			platform: "linux",
			homeDir: "/home/test",
			readConfig: async filePath => {
				expect(filePath).toBe(env.HERDR_CONFIG_PATH!);
				return "[experimental]\nkitty_graphics = true\n";
			},
		});

		expect(enabled).toBe(false);
		expect(env.PI_FORCE_IMAGE_PROTOCOL).toBe("sixel");
		expect(env.PI_KITTY_PLACEHOLDERS).toBe("0");
	});
});
