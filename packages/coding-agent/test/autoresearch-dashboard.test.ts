import { afterEach, describe, expect, it } from "bun:test";
import { renderDashboardLines } from "../src/autoresearch/dashboard";
import { createSessionRuntime } from "../src/autoresearch/state";
import { setLocale } from "../src/i18n";
import type { Theme } from "../src/modes/theme/theme";

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
