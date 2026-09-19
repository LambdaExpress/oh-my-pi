import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { InjectNoticeComponent } from "@oh-my-pi/pi-tui/chat/inject-notice";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { setLocale } from "../../../src/i18n";
import type { ContextInjectionItem } from "@oh-my-pi/pi-tui/chat/context-injection";

const darkTheme = await getThemeByName("dark");

const AGENTS_MD: ContextInjectionItem = {
	kind: "context-file",
	label: "AGENTS.md",
	detail: "1.2 KB · ~/project/AGENTS.md",
	preview: "# Project rules\nRun bun check before yielding.\nThird line.",
};

function plain(component: InjectNoticeComponent): string {
	return stripVTControlCharacters(component.render(120).join("\n"));
}

beforeEach(() => {
	setLocale("en");
	if (!darkTheme) throw new Error("Failed to load dark theme");
	setThemeInstance(darkTheme);
});

afterEach(() => {
	setLocale(null);
});

describe("InjectNoticeComponent", () => {
	it("lists the injected sources with their previews", () => {
		const component = new InjectNoticeComponent([AGENTS_MD, { kind: "skill", label: "Skills", count: 12 }]);
		const rendered = plain(component);

		expect(rendered).toContain("Inject");
		expect(rendered).toContain("2 sources");
		expect(rendered).toContain("AGENTS.md");
		expect(rendered).toContain("~/project/AGENTS.md");
		expect(rendered).toContain("Skills");
		expect(rendered).toContain("(12)");
		// Collapsed previews stop at the line budget and advertise the expander.
		expect(rendered).toContain("# Project rules");
		expect(rendered).not.toContain("Third line.");
		expect(rendered).toContain("(ctrl+o to expand)");
	});

	it("shows the full preview once expanded", () => {
		const component = new InjectNoticeComponent([AGENTS_MD]);
		component.setExpanded(true);

		const rendered = plain(component);
		expect(rendered).toContain("Third line.");
		expect(rendered).not.toContain("(ctrl+o to expand)");
	});

	it("folds into one Inject row", () => {
		const single = new InjectNoticeComponent([AGENTS_MD]);
		single.setToolRowsFolded(true);
		expect(plain(single).trim()).toBe("Inject: AGENTS.md — 1.2 KB · ~/project/AGENTS.md");

		const several = new InjectNoticeComponent([
			AGENTS_MD,
			{ kind: "rulebook", label: "Rulebook", count: 3 },
			{ kind: "skill", label: "Skills", count: 12 },
			{ kind: "memory", label: "Memory", detail: "800 B" },
		]);
		several.setToolRowsFolded(true);
		expect(plain(several).trim()).toBe("Inject: AGENTS.md · Rulebook · Skills 1 more");

		// Same-named files from two levels collapse into a count instead of
		// repeating the name; the remaining name list keeps its order.
		const repeated = new InjectNoticeComponent([
			{ kind: "context-file", label: "AGENTS.md" },
			{ kind: "context-file", label: "AGENTS.md", detail: "packages/app" },
			{ kind: "skill", label: "Skills", count: 2 },
		]);
		repeated.setToolRowsFolded(true);
		expect(plain(repeated).trim()).toBe("Inject: AGENTS.md ×2 · Skills");
	});

	it("merges later sources into the same notice", () => {
		const component = new InjectNoticeComponent([AGENTS_MD]);
		component.addItems([{ kind: "skill", label: "Skills", count: 2 }]);

		expect(plain(component)).toContain("2 sources");
		expect(component.render(120).length).toBeGreaterThan(0);
	});

	it("hides with tool activity and stays hidden for an empty set", () => {
		const component = new InjectNoticeComponent([AGENTS_MD]);
		component.setToolActivityVisible(false);
		expect(component.render(120)).toEqual([]);

		component.setToolActivityVisible(true);
		expect(component.render(120).length).toBeGreaterThan(0);

		expect(new InjectNoticeComponent([]).render(120)).toEqual([]);
	});

	it("localizes the label for zh-CN", () => {
		setLocale("zh-CN");
		const component = new InjectNoticeComponent([AGENTS_MD, { kind: "rulebook", label: "Rulebook", count: 3 }]);

		const rendered = plain(component);
		expect(rendered).toContain("注入");
		expect(rendered).toContain("共 2 处");
		expect(rendered).toContain("规则库");
		expect(rendered).toContain("(3)");

		component.setToolRowsFolded(true);
		expect(plain(component).trim()).toBe("注入: AGENTS.md · 规则库");
	});
});
