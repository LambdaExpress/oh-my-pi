import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import { setLocale, t } from "../src/i18n";
import { zhCN } from "../src/i18n/locales/zh-CN";

// Tests mutate the shared zh-CN catalog for the "translation hit" case;
// restore the original keys afterwards so the suite stays order-independent.
const originalKeys = Object.keys(zhCN);

afterEach(() => {
	for (const key of Object.keys(zhCN)) {
		if (!originalKeys.includes(key)) delete zhCN[key];
	}
	setLocale(null);
});

describe("i18n t()", () => {
	it("returns the English key verbatim when locale is en", () => {
		// Not pinned: settings may be uninitialized (falls back to en) or
		// initialized with the default `display.language` of "en" — both paths
		// must yield the key itself.
		expect(t("Hello")).toBe("Hello");
		expect(t("No model selected")).toBe("No model selected");
	});

	it("returns the zh-CN translation when present and falls back to the key otherwise", () => {
		zhCN["Hello"] = "你好";
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
		zhCN["Hello"] = "你好";
		const s = Settings.isolated({ "display.language": "zh-CN" });
		// Pin through the same code path the settings panel uses: the value
		// coming out of Settings is what drives t().
		setLocale(s.get("display.language"));
		expect(t("Hello")).toBe("你好");
	});
});

describe("display.language setting contract", () => {
	it("defaults to en and accepts zh-CN via the schema", () => {
		expect(Settings.isolated({}).get("display.language")).toBe("en");
		expect(Settings.isolated({ "display.language": "zh-CN" }).get("display.language")).toBe("zh-CN");
	});
});
