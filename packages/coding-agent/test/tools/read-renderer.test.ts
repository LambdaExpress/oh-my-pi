import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import type { TUI } from "@oh-my-pi/pi-tui";
import { theme as activeTheme, getThemeByName, initTheme } from "@oh-my-pi/pi-tui/theme";
import { readToolRenderer } from "@oh-my-pi/pi-tui/tools/read";

function framedContentRows(lines: readonly string[]): string[] {
	return lines
		.map(line => Bun.stripANSI(line).trimStart())
		.filter(line => line.startsWith("│") && line.endsWith("│"))
		.map(line => line.slice(1, -1).trimEnd());
}

function framedSectionContentRows(lines: readonly string[], label: string): string[] {
	const plainLines = lines.map(line => Bun.stripANSI(line).trimStart());
	const labelIndex = plainLines.findIndex(line => line.includes(label));
	expect(labelIndex).toBeGreaterThanOrEqual(0);

	const rows: string[] = [];
	for (const line of plainLines.slice(labelIndex + 1)) {
		if (!line.startsWith("│") || !line.endsWith("│")) {
			if (rows.length > 0) break;
			continue;
		}
		rows.push(line.slice(1, -1).trimEnd());
	}
	return rows;
}

function visiblePreviewRows(rows: readonly string[]): string[] {
	return rows.filter(line => !line.includes("more line"));
}

function hiddenPreviewRows(rows: readonly string[]): number {
	const marker = rows.find(line => line.includes("more line"));
	expect(marker).toBeDefined();
	const match = /… (\d+) more lines?/.exec(marker ?? "");
	expect(match).not.toBeNull();
	return Number(match?.[1]);
}

function extractLinkUris(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1]!);
}

beforeAll(async () => {
	await initTheme();
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
});

describe("readToolRenderer url preview windows", () => {
	it("windows a single long URL preview by visual rows while preserving metadata", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const previewTail = "EXPANDED-尾部";
		const hiddenTail = "END-隐藏";
		const contentBody = `HEAD-网址${"数据".repeat(70)}${previewTail}${"内容".repeat(170)}${hiddenTail}`;
		const result = {
			content: [{ type: "text", text: `---\n\n${contentBody}` }],
			details: {
				kind: "url",
				url: "http://example.com/start",
				finalUrl: "http://example.com/final",
				contentType: "text/plain",
				method: "fetch",
				truncated: false,
				notes: [],
			},
		} as const;

		const collapsed = readToolRenderer
			.renderResult(result as never, { expanded: false, isPartial: false }, theme!, {
				path: "http://example.com/start",
			})
			.render(64);
		const collapsedText = Bun.stripANSI(collapsed.join("\n"));
		const collapsedPreview = framedSectionContentRows(collapsed, "Content Preview");
		expect(visiblePreviewRows(collapsedPreview)).toHaveLength(3);
		expect(collapsedText).toContain("Content-Type: text/plain");
		expect(collapsedText).toContain("Method: fetch");
		expect(collapsedText).toContain("Lines: 1 line");
		expect(collapsedText).toContain(`Chars: ${contentBody.length}`);
		expect(collapsedText).not.toContain(previewTail);
		expect(collapsedText).not.toContain(hiddenTail);
		expect(collapsedText.toLowerCase()).toContain("ctrl+o");
		const collapsedHiddenRows = hiddenPreviewRows(collapsedPreview);

		const expanded = readToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, theme!, {
				path: "http://example.com/start",
			})
			.render(64);
		const expandedText = Bun.stripANSI(expanded.join("\n"));
		const expandedPreview = framedSectionContentRows(expanded, "Content Preview");
		expect(visiblePreviewRows(expandedPreview)).toHaveLength(12);
		expect(expandedPreview.join("").replace(/\s+/g, "")).toContain(previewTail);
		expect(expandedText).not.toContain(hiddenTail);
		expect(expandedText.toLowerCase()).not.toContain("ctrl+o");
		expect(hiddenPreviewRows(expandedPreview)).toBe(collapsedHiddenRows - 9);
		expect(expandedText).toContain("example.com /final");
		expect(extractLinkUris(expanded.join("\n"))).toContain("http://example.com/final");
	});
});

describe("read ToolExecutionComponent framing", () => {
	it("renders framed read results inside the standard tool container padding", () => {
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const component = new ToolExecutionComponent("read", { path: "src/example.ts" }, {}, undefined, uiStub);
		component.updateResult(
			{
				content: [{ type: "text", text: "export const x = 1;" }],
				details: {
					displayContent: { text: "export const x = 1;", startLine: 1 },
					contentType: "text/plain",
				},
			},
			false,
		);

		try {
			const lines = component.render(80).map(line => Bun.stripANSI(line));
			const topBorderIndex = lines.findIndex(
				line => line.includes(activeTheme.boxRound.topLeft) && line.includes("Read"),
			);
			const bottomBorderIndex = lines.findIndex(
				(line, index) => index > topBorderIndex && line.includes(activeTheme.boxRound.bottomLeft),
			);

			expect(topBorderIndex).toBeGreaterThanOrEqual(0);
			expect(lines[topBorderIndex + 1]).toContain("export const x = 1;");
			expect(bottomBorderIndex).toBeGreaterThan(topBorderIndex);
		} finally {
			component.stopAnimation();
		}
	});

	it("reflows a CJK JSON read by visual rows across width and expansion changes", () => {
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const headSentinel = "HEAD-首部";
		const tailSentinel = "TAIL-尾部";
		const content = `{"head":"${headSentinel}","payload":"${"数据".repeat(260)}","tail":"${tailSentinel}"}`;
		const component = new ToolExecutionComponent(
			"read",
			{ path: "agent://LongJson", selector: "raw" },
			{},
			undefined,
			uiStub,
		);
		component.updateResult(
			{
				content: [{ type: "text", text: content }],
				details: {
					displayContent: { text: content, startLine: 120 },
					contentType: "application/json",
				},
			},
			false,
		);

		const assertNarrowCollapsed = (lines: readonly string[]): number => {
			const text = Bun.stripANSI(lines.join("\n"));
			const bodyRows = framedContentRows(lines);
			const contentRows = visiblePreviewRows(bodyRows);
			expect(contentRows, "collapsed Read body should use its 12-row visual budget").toHaveLength(12);
			expect(bodyRows.length, "collapsed Read body should add only its marker row").toBeLessThanOrEqual(13);
			expect(text).toContain(headSentinel);
			expect(text).not.toContain(tailSentinel);
			expect(text).toContain("more line");
			expect(text).toContain("120");
			expect(text).toContain(`{"head":"${headSentinel}`);
			expect(lines.some(line => line.includes(headSentinel) && line.includes("\x1b["))).toBe(true);
			return hiddenPreviewRows(bodyRows);
		};

		try {
			const firstCollapsedHiddenRows = assertNarrowCollapsed(component.render(64));

			const wide = component.render(1400);
			const wideText = Bun.stripANSI(wide.join("\n"));
			expect(visiblePreviewRows(framedContentRows(wide))).toHaveLength(1);
			expect(wideText).toContain(headSentinel);
			expect(wideText).toContain(tailSentinel);
			expect(wideText).not.toContain("more line");

			expect(assertNarrowCollapsed(component.render(64))).toBe(firstCollapsedHiddenRows);

			component.setExpanded(true);
			const expanded = component.render(64);
			const expandedText = Bun.stripANSI(expanded.join("\n"));
			const expandedBody = framedContentRows(expanded);
			expect(expandedText).toContain(headSentinel);
			expect(expandedBody.join("").replace(/\s+/g, "")).toContain(tailSentinel);
			expect(expandedText).not.toContain("more line");
			expect(firstCollapsedHiddenRows).toBe(expandedBody.length - 12);

			component.setExpanded(false);
			expect(assertNarrowCollapsed(component.render(64))).toBe(firstCollapsedHiddenRows);
		} finally {
			component.stopAnimation();
		}
	});
});
