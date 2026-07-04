import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "../../config/settings";
import type { EvalToolDetails } from "../../eval/types";
import { getThemeByName, setThemeInstance, type Theme } from "../../modes/theme/theme";
import { renderCodeCell } from "../../tui";
import { evalToolRenderer } from "../eval-render";

function renderCellOutputRows(output: string, uiTheme: Theme): string[] {
	const details: EvalToolDetails = {
		language: "python",
		cells: [
			{
				index: 0,
				code: "print('value')",
				language: "python",
				output,
				status: "running",
			},
		],
	};
	const component = evalToolRenderer.renderResult(
		{ content: [], details },
		{ expanded: true, isPartial: true, spinnerFrame: 0 },
		uiTheme,
	);
	const lines = component.render(80).map(line => Bun.stripANSI(line));
	const outputHeaderIndex = lines.findIndex(line => line.includes(" Output "));
	expect(outputHeaderIndex).toBeGreaterThanOrEqual(0);

	const rows: string[] = [];
	for (const line of lines.slice(outputHeaderIndex + 1)) {
		if (line.startsWith(uiTheme.boxRound.bottomLeft) || line.startsWith(uiTheme.boxRound.teeRight)) {
			break;
		}

		const leftBorder = line.indexOf(uiTheme.boxRound.vertical);
		const rightBorder = line.lastIndexOf(uiTheme.boxRound.vertical);
		expect(leftBorder).toBeGreaterThanOrEqual(0);
		expect(rightBorder).toBeGreaterThan(leftBorder);

		const paddedContent = line.slice(leftBorder + uiTheme.boxRound.vertical.length, rightBorder);
		rows.push(paddedContent.replace(/^ /, "").trimEnd());
	}
	return rows;
}

function renderStrippedCodeCellRows(code: string, uiTheme: Theme): string[] {
	const lines = renderCodeCell(
		{
			code,
			language: "javascript",
			width: 48,
			codeTail: true,
			codeMaxLines: 3,
			expanded: false,
		},
		uiTheme,
	).map(line => Bun.stripANSI(line));

	return lines
		.filter(line => line.startsWith(uiTheme.boxRound.vertical))
		.map(line => {
			const leftBorder = line.indexOf(uiTheme.boxRound.vertical);
			const rightBorder = line.lastIndexOf(uiTheme.boxRound.vertical);
			expect(rightBorder).toBeGreaterThan(leftBorder);
			return line.slice(leftBorder + uiTheme.boxRound.vertical.length, rightBorder).trim();
		});
}

describe("eval cell result rendering", () => {
	let uiTheme: Theme;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		uiTheme = loaded;
		setThemeInstance(loaded);
	});

	it("omits the terminal blank output row when a running cell ends with a newline", () => {
		expect(renderCellOutputRows("running 10\n", uiTheme)).toEqual(["running 10"]);
	});

	it("preserves interior blank output rows while omitting the terminal trailing newline", () => {
		expect(renderCellOutputRows("a\n\nb\n", uiTheme)).toEqual(["a", "", "b"]);
	});

	it("renders a two-row wrapped code tail without an earlier-lines marker when it fits the preview budget", () => {
		const code = 'const previewValue = "abcdefghijklmnopqrstuvwxyz0123456789";';
		const rows = renderStrippedCodeCellRows(code, uiTheme);
		const stripped = rows.join("\n");

		expect(rows).toHaveLength(2);
		expect(stripped).toContain("const previewValue");
		expect(stripped).toContain("abcdefghijklmnopqrstuvwxyz0123456789");
		expect(stripped).not.toContain("earlier lines");
	});
});
