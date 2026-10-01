import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import { detectSystemLocale, setLocale, t } from "../src/i18n";
import { zhCN } from "../src/i18n/locales/zh-CN";
import { cfgDisplayLanguage } from "../src/modes/settings";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let settingsState: SettingsTestState | undefined;
let originalCatalog: Record<string, string>;
let tempDir: TempDir;

beforeEach(async () => {
	originalCatalog = { ...zhCN };
	settingsState = beginSettingsTest();
	tempDir = TempDir.createSync("@pi-i18n-");
	delete process.env.PI_CONFIG_FILES;
	for (const key of ["LANG", "LC_ALL", "LC_MESSAGES"] as const) delete process.env[key];
	await Settings.init({ inMemory: true, cwd: tempDir.path(), agentDir: tempDir.join("agent") });
	cfgDisplayLanguage.set(Settings.instance, "en");
	setLocale(null);
});

afterEach(async () => {
	for (const key of Object.keys(zhCN)) {
		if (!(key in originalCatalog)) delete zhCN[key];
	}
	Object.assign(zhCN, originalCatalog);
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	setLocale(null);
	await tempDir.remove();
});

describe("i18n t()", () => {
	it("returns the English key verbatim when locale is en", () => {
		setLocale("en");
		expect(t("Hello")).toBe("Hello");
		expect(t("No model selected")).toBe("No model selected");
	});

	it("returns the zh-CN translation when present and falls back to the key otherwise", () => {
		zhCN.Hello = "你好";
		setLocale("zh-CN");
		expect(t("Hello")).toBe("你好");
		expect(t("Untranslated string")).toBe("Untranslated string");
	});

	it("interpolates {name} placeholders and preserves missing ones", () => {
		expect(t("Hi {name}", { name: "om" })).toBe("Hi om");
		expect(t("Hi {name}")).toBe("Hi {name}");
		zhCN["Hi {name}"] = "你好，{name}";
		setLocale("zh-CN");
		expect(t("Hi {name}", { name: "om" })).toBe("你好，om");
		expect(t("Hi {name}")).toBe("你好，{name}");
	});

	it("restores settings-driven translation after an invalid locale pin", () => {
		zhCN.Hello = "你好";
		cfgDisplayLanguage.set(Settings.instance, "zh-CN");
		setLocale("en");
		expect(t("Hello")).toBe("Hello");
		setLocale("fr");
		expect(t("Hello")).toBe("你好");
	});

	it("resolves locale from settings when not pinned", () => {
		zhCN.Hello = "你好";
		cfgDisplayLanguage.set(Settings.instance, "zh-CN");
		setLocale(null);
		expect(t("Hello")).toBe("你好");
	});
});

describe("auto system-language detection", () => {
	it("follows zh locale env vars", () => {
		process.env.LC_ALL = "zh_CN.UTF-8";
		delete process.env.LANG;
		expect(detectSystemLocale()).toBe("zh-CN");
	});

	it("gives LC_ALL precedence over LC_MESSAGES and LANG", () => {
		process.env.LANG = "en_US.UTF-8";
		process.env.LC_MESSAGES = "en_US.UTF-8";
		process.env.LC_ALL = "zh_CN.UTF-8";
		expect(detectSystemLocale()).toBe("zh-CN");
	});

	it("gives LC_MESSAGES precedence over LANG when LC_ALL is absent", () => {
		process.env.LANG = "zh_CN.UTF-8";
		process.env.LC_MESSAGES = "en_US.UTF-8";
		expect(detectSystemLocale()).toBe("en");
	});

	it("treats explicit non-Chinese locale env vars as English", () => {
		process.env.LC_ALL = "en_US.UTF-8";
		delete process.env.LANG;
		expect(detectSystemLocale()).toBe("en");
	});

	it("falls back to the ICU default locale for C/POSIX env", () => {
		process.env.LANG = "C.UTF-8";
		delete process.env.LC_ALL;
		const expected = /^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? "zh-CN" : "en";
		expect(detectSystemLocale()).toBe(expected);
	});

	it("drives t() through the auto setting", () => {
		zhCN.Hello = "你好";
		process.env.LANG = "en_US.UTF-8";
		process.env.LC_ALL = "zh_CN.UTF-8";
		cfgDisplayLanguage.set(Settings.instance, "auto");
		setLocale(null);
		expect(t("Hello")).toBe("你好");
	});
});
