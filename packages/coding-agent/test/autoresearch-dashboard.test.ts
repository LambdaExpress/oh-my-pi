import { afterEach, describe, expect, it } from "bun:test";
import { createSessionRuntime } from "../src/autoresearch/state";
import { setLocale } from "../src/i18n";
import { renderDashboardLines } from "@oh-my-pi/pi-tui/apps/autoresearch-dashboard";
import type { Theme } from "@oh-my-pi/pi-tui/theme";

const plainTheme = {
	fg: (_color: string, text: string): string => text,
} as unknown as Theme;

afterEach(() => {
	setLocale(null);
});

describe("autoresearch dashboard localization", () => {
	it("renders the baseline-pending state in Simplified Chinese", () => {
		setLocale("zh-CN");
		const runtime = createSessionRuntime();
		runtime.autoresearchMode = true;

		expect(renderDashboardLines(runtime, 120, plainTheme, 8)).toEqual([
			"当前分段：0 次运行",
			"基准：待运行",
			"下一步：运行并记录基准实验。",
		]);
	});
});
