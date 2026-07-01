import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { browserToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/browser/render";
import { evalToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { pwshToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/pwsh";

describe("code preview renderers prefer streamed raw partial JSON", () => {
	let theme: Theme;

	beforeAll(async () => {
		theme = (await getThemeByName("dark")) ?? (await getThemeByName("light"))!;
		expect(theme).toBeDefined();
	});

	it("renders streamed PowerShell script text instead of stale parsed script text", () => {
		const component = pwshToolRenderer.renderCall(
			{ script: "Write-Output 'stale'", __partialJson: '{"script":"Write-Output \'streamed' },
			{ expanded: false, isPartial: true },
			theme,
		);
		const rendered = Bun.stripANSI(component.render(120).join("\n"));

		expect(rendered).toContain("streamed");
		expect(rendered).not.toContain("stale");
	});

	it("renders streamed browser run code instead of stale parsed code", () => {
		const component = browserToolRenderer.renderCall(
			{
				action: "run",
				code: "return 'stale';",
				__partialJson: '{"action":"run","code":"return \'streamed\';',
			},
			{ expanded: false, isPartial: true },
			theme,
		);
		const rendered = Bun.stripANSI(component.render(120).join("\n"));

		expect(rendered).toContain("streamed");
		expect(rendered).not.toContain("stale");
	});

	it("renders streamed eval code instead of stale parsed code", () => {
		const component = evalToolRenderer.renderCall(
			{
				language: "js",
				code: "return 'stale';",
				__partialJson: '{"language":"js","code":"return \'streamed\';',
			},
			{ expanded: false, isPartial: true },
			theme,
		);
		const rendered = Bun.stripANSI(component.render(120).join("\n"));

		expect(rendered).toContain("streamed");
		expect(rendered).not.toContain("stale");
	});
});
