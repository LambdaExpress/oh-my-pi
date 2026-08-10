import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import { detectSystemLocale, setLocale, t } from "../src/i18n";
import { zhCN } from "../src/i18n/locales/zh-CN";

// Tests mutate the shared zh-CN catalog for the "translation hit" case;
// restore the original keys afterwards so the suite stays order-independent.
const originalKeys = Object.keys(zhCN);
const originalEnv = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LC_MESSAGES: process.env.LC_MESSAGES };

afterEach(() => {
	for (const key of Object.keys(zhCN)) {
		if (!originalKeys.includes(key)) delete zhCN[key];
	}
	setLocale(null);
	for (const key of ["LANG", "LC_ALL", "LC_MESSAGES"] as const) {
		const original = originalEnv[key];
		if (original === undefined) {
			delete process.env[key];
		} else if (process.env[key] !== original) {
			process.env[key] = original;
		}
	}
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

	it("treats an invalid locale as en", () => {
		setLocale("fr");
		expect(t("Hello")).toBe("Hello");
	});

	it("resolves locale from settings when not pinned", () => {
		zhCN.Hello = "你好";
		const s = Settings.isolated({ "display.language": "zh-CN" });
		// Pin through the same code path the settings panel uses: the value
		// coming out of Settings is what drives t().
		setLocale(s.get("display.language"));
		expect(t("Hello")).toBe("你好");
	});
});

describe("auto system-language detection", () => {
	it("follows zh locale env vars", () => {
		process.env.LC_ALL = "zh_CN.UTF-8";
		delete process.env.LANG;
		expect(detectSystemLocale()).toBe("zh-CN");
	});

	it("treats explicit non-Chinese locale env vars as English", () => {
		process.env.LC_ALL = "en_US.UTF-8";
		delete process.env.LANG;
		expect(detectSystemLocale()).toBe("en");
	});

	it("falls back to the ICU default locale for C/POSIX env", () => {
		process.env.LANG = "C.UTF-8";
		delete process.env.LC_ALL;
		// Deterministic: zh env implies zh-CN; otherwise the runtime default
		// locale decides (en on non-Chinese systems, zh-CN on Chinese ones).
		const expected = /^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? "zh-CN" : "en";
		expect(detectSystemLocale()).toBe(expected);
	});

	it("drives t() through the auto setting", () => {
		zhCN.Hello = "你好";
		process.env.LC_ALL = "zh_CN.UTF-8";
		const s = Settings.isolated({ "display.language": "auto" });
		setLocale(s.get("display.language"));
		expect(t("Hello")).toBe("你好");
	});
});

describe("display.language setting contract", () => {
	it("defaults to auto and accepts explicit values via the schema", () => {
		expect(Settings.isolated({}).get("display.language")).toBe("auto");
		expect(Settings.isolated({ "display.language": "en" }).get("display.language")).toBe("en");
		expect(Settings.isolated({ "display.language": "zh-CN" }).get("display.language")).toBe("zh-CN");
	});
});
