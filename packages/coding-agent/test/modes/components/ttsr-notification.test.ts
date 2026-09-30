import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { TtsrNotificationComponent } from "@oh-my-pi/pi-tui/chat/ttsr-notification";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { setLocale } from "../../../src/i18n";

const darkTheme = await getThemeByName("dark");
const RULE_DESCRIPTION = "Prefer Record<K, V> for small static literals; use Set/Map for anything dynamic";
const RULE_CONTENT = "Small, static string-keyed lookup tables: `Record<K, V>` / `Record<K, true>`.";

function builtinRule(name: string, description: string = RULE_DESCRIPTION): Rule {
	return {
		name,
		path: `/builtin-defaults/${name}.md`,
		content: RULE_CONTENT,
		description,
		_source: {
			provider: BUILTIN_DEFAULTS_PROVIDER_ID,
			providerName: "Built-in Defaults",
			path: `/builtin-defaults/${name}.md`,
			level: "native",
		},
	};
}

function plain(component: TtsrNotificationComponent): string {
	return stripVTControlCharacters(component.render(120).join("\n"));
}

describe("TtsrNotificationComponent localization", () => {
	beforeEach(() => {
		setLocale("zh-CN");
		if (!darkTheme) throw new Error("Failed to load dark theme");
		setThemeInstance(darkTheme);
	});

	afterEach(() => {
		setLocale(null);
	});

	it("localizes the visible title and built-in summary without mutating the rule sent to the model", () => {
		const rule = builtinRule("ts-set-map");
		const rendered = plain(new TtsrNotificationComponent([rule]));

		expect(rendered).toContain("正在注入规则：ts-set-map");
		expect(rendered).toContain("小型静态字面量优先使用 Record<K, V>；动态场景使用 Set/Map");
		expect(rendered).not.toContain("Injecting rule");
		expect(rendered).not.toContain(RULE_DESCRIPTION);
		expect(rule.description).toBe(RULE_DESCRIPTION);
		expect(rule.content).toBe(RULE_CONTENT);
	});

	it("keeps localized copy when merged notifications rebuild and expand", () => {
		const component = new TtsrNotificationComponent([builtinRule("ts-set-map")]);
		component.addRules([builtinRule("ts-no-any", "Avoid any in TypeScript")]);
		component.setExpanded(true);
		const rendered = plain(component);

		expect(rendered).toContain("正在注入 2 条规则：");
		expect(rendered).toContain("小型静态字面量优先使用 Record<K, V>；动态场景使用 Set/Map");
		expect(rendered).toContain("Avoid any in TypeScript");
	});

	it("labels the folded single row as TTSR", () => {
		const component = new TtsrNotificationComponent([builtinRule("ts-set-map")]);
		component.setToolRowsFolded(true);

		expect(plain(component).trim()).toStartWith("TTSR: ts-set-map — ");
	});
});

describe("TtsrNotificationComponent folding", () => {
	beforeEach(() => {
		setLocale("en");
		if (!darkTheme) throw new Error("Failed to load dark theme");
		setThemeInstance(darkTheme);
	});

	afterEach(() => {
		setLocale(null);
	});

	it("folds an injected rule into one row instead of the banner", () => {
		const component = new TtsrNotificationComponent([builtinRule("ts-no-tiny-functions", "Inline tiny wrappers.")]);
		expect(component.render(120).length).toBeGreaterThan(1);

		component.setToolRowsFolded(true);

		expect(component.render(120).map(line => stripVTControlCharacters(line).trim())).toEqual([
			"TTSR: ts-no-tiny-functions — Inline tiny wrappers.",
		]);
	});

	it("summarizes several injected rules on one row", () => {
		const component = new TtsrNotificationComponent([builtinRule("ts-set-map"), builtinRule("ts-no-any")]);
		component.addRules([builtinRule("ts-no-tiny-functions")]);
		component.setToolRowsFolded(true);

		const rows = component.render(200);
		expect(rows).toHaveLength(1);
		const row = stripVTControlCharacters(rows[0]!).trim();
		expect(row).toStartWith("TTSR: 3 rules · ");
		expect(row).toContain("ts-no-any");
	});
});
