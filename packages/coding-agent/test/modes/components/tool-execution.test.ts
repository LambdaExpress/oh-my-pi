import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Component, Text } from "@oh-my-pi/pi-tui";
import { Settings, settings } from "../../../src/config/settings";
import { renderMCPResult } from "../../../src/mcp/render";
import type { MCPToolDetails } from "../../../src/mcp/tool-bridge";
import { ToolExecutionComponent, type ToolExecutionUi } from "../../../src/modes/components/tool-execution";
import { getThemeByName, setThemeInstance, theme } from "../../../src/modes/theme/theme";

class BoldTypeErrorComponent implements Component {
	render(_width: number): readonly string[] {
		throw new TypeError("th.bold is not a function");
	}
}

function visibleText(lines: readonly string[]): string {
	let text = lines.join("\n");
	text = text.replace(/\x1b\]8;[^\x1b\x07]*(?:\x07|\x1b\\)/g, "");
	text = text.replace(/\x1b\[[0-9;]*m/g, "");
	return text;
}

describe("ToolExecutionComponent custom renderer failures", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	afterEach(() => {
		settings.set("mcp.renderMarkdownResults", true);
	});

	it("falls back to the custom tool label when a renderCall child component throws during render", () => {
		const tool: AgentTool = {
			name: "graphify_graph",
			label: "Graphify Graph",
			description: "renders a graph",
			parameters: { type: "object", additionalProperties: true },
			renderCall() {
				return new BoldTypeErrorComponent();
			},
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		const ui: ToolExecutionUi = {
			requestRender() {},
			requestComponentRender(_component: Component) {},
			resetDisplay() {},
		};
		const component = new ToolExecutionComponent(
			"graphify_graph",
			{},
			{ showImages: false },
			tool,
			ui,
			process.cwd(),
		);
		let text = "";

		expect(() => {
			text = visibleText(component.render(80));
		}).not.toThrow();
		expect(text).toContain("Graphify Graph");
	});

	it("preserves raw result text when a renderResult child component throws during render", () => {
		const rawResultText = "raw result survives child renderer failure";
		const tool: AgentTool = {
			name: "crashy_result_renderer",
			label: "Crashy Result Renderer",
			description: "renders result output",
			parameters: { type: "object", additionalProperties: true },
			renderCall() {
				return new Text(theme.fg("toolTitle", theme.bold("Crashy Result Renderer")), 0, 0);
			},
			renderResult() {
				return new BoldTypeErrorComponent();
			},
			async execute() {
				return { content: [{ type: "text", text: rawResultText }] };
			},
		};
		const ui: ToolExecutionUi = {
			requestRender() {},
			requestComponentRender(_component: Component) {},
			resetDisplay() {},
		};
		const component = new ToolExecutionComponent(
			"crashy_result_renderer",
			{},
			{ showImages: false },
			tool,
			ui,
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: rawResultText }] }, false);
		let text = "";

		expect(() => {
			text = visibleText(component.render(80));
		}).not.toThrow();
		expect(text).toContain(rawResultText);
	});

	it("renders a same-named extension tool result with the generic renderer", () => {
		const resultText = "recalled postgres memory";
		const tool: AgentTool = {
			name: "recall",
			label: "Extension Recall",
			description: "recalls external memory",
			parameters: { type: "object", additionalProperties: true },
			async execute() {
				return { content: [{ type: "text", text: resultText }] };
			},
		};
		const ui: ToolExecutionUi = {
			requestRender() {},
			requestComponentRender(_component: Component) {},
			resetDisplay() {},
		};
		const component = new ToolExecutionComponent(
			"recall",
			{ query: "project context" },
			{ showImages: false, useBuiltInRenderer: false },
			tool,
			ui,
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: resultText }] }, false);

		const rendered = visibleText(component.render(80));
		expect(rendered).toContain(resultText);
		expect(rendered).not.toContain("no matches");
	});
});

describe("ToolExecutionComponent merged abort rendering", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	it("keeps identifying call arguments above generic signal-abort output", () => {
		const fixtures = [
			{ name: "glob", args: { path: "src/audit-*.ts" }, expected: ["Glob", "src/audit-*.ts"] },
			{
				name: "grep",
				args: { pattern: "renderer-audit-token", path: "src", case: true, gitignore: true },
				expected: ["Grep", "renderer-audit-token", "in src"],
			},
			{
				name: "todo",
				args: { op: "append", phase: "Audit", items: ["renderer audit item"] },
				expected: ["Todo", "append Audit 1 item"],
			},
			{
				name: "goal",
				args: { op: "create", objective: "Audit merged rendering", token_budget: 2048 },
				expected: ["Goal", "set", "Audit merged rendering", "budget"],
			},
			{
				name: "ask",
				args: { question: "Which renderer?", options: ["Merged", "Separate"] },
				expected: ["Ask", "Which renderer?", "Merged", "Separate"],
			},
			{
				name: "web_search",
				args: { query: "renderer abort behavior" },
				expected: ["Web Search", "renderer abort behavior"],
			},
		] as const;
		const ui: ToolExecutionUi = {
			requestRender() {},
			requestComponentRender(_component: Component) {},
			resetDisplay() {},
		};
		const missing: string[] = [];

		for (const fixture of fixtures) {
			const component = new ToolExecutionComponent(
				fixture.name,
				fixture.args,
				{ showImages: false },
				undefined,
				ui,
				process.cwd(),
			);
			component.updateResult({ content: [{ type: "text", text: "aborted" }], details: {}, isError: true }, false);
			const rendered = visibleText(component.render(120));
			for (const expected of [...fixture.expected, "aborted"]) {
				if (!rendered.includes(expected)) missing.push(`${fixture.name}: ${expected}`);
			}
		}

		expect(missing).toEqual([]);
	});

	it("renders an abandoned PowerShell call as one frame with abort in its output", () => {
		const script = "Write-Output 'abort-card-sentinel'";
		const args = { script };
		const ui: ToolExecutionUi = {
			requestRender() {},
			requestComponentRender(_component: Component) {},
			resetDisplay() {},
		};
		const component = new ToolExecutionComponent("pwsh", args, { showImages: false }, undefined, ui, process.cwd());
		component.updateResult({ content: [{ type: "text", text: "aborted" }], details: {}, isError: true }, false);

		const rendered = visibleText(component.render(120));
		expect(rendered.match(/abort-card-sentinel/g)).toHaveLength(1);
		expect(rendered).toContain("Output");
		expect(rendered).toContain("aborted");
	});

	it("preserves generic signal-abort arguments for a custom merged renderer", () => {
		const tool: AgentTool & { mergeCallAndResult: true } = {
			name: "custom_lookup",
			label: "Custom Lookup",
			description: "looks up a custom target",
			parameters: { type: "object", additionalProperties: true },
			mergeCallAndResult: true,
			renderCall(args) {
				const target =
					args && typeof args === "object" && "target" in args && typeof args.target === "string"
						? args.target
						: "";
				return new Text(`Custom Lookup ${target}`, 0, 0);
			},
			renderResult(result) {
				return new Text(result.content.find(block => block.type === "text")?.text ?? "", 0, 0);
			},
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		const ui: ToolExecutionUi = {
			requestRender() {},
			requestComponentRender(_component: Component) {},
			resetDisplay() {},
		};
		const component = new ToolExecutionComponent(
			"custom_lookup",
			{ target: "renderer-target" },
			{ showImages: false },
			tool,
			ui,
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "aborted" }], details: {}, isError: true }, false);

		const rendered = visibleText(component.render(120));
		expect(rendered).toContain("Custom Lookup renderer-target");
		expect(rendered).toContain("aborted");
	});

	it("leaves normal merged success and direct errors result-only", () => {
		const ui: ToolExecutionUi = {
			requestRender() {},
			requestComponentRender(_component: Component) {},
			resetDisplay() {},
		};
		const success = new ToolExecutionComponent(
			"glob",
			{ path: "src/audit-*.ts" },
			{ showImages: false },
			undefined,
			ui,
			process.cwd(),
		);
		success.updateResult(
			{
				content: [{ type: "text", text: "src/audit-result.ts" }],
				details: { fileCount: 1, files: ["src/audit-result.ts"] },
			},
			false,
		);
		const successRendered = visibleText(success.render(120));
		expect(successRendered.match(/src\/audit-\*\.ts/g)).toHaveLength(1);
		expect(successRendered).toContain("src/audit-result.ts");

		for (const fixture of [
			{ name: "glob", args: { path: "src/direct-error-*.ts" } },
			{ name: "grep", args: { pattern: "direct-error-token", path: "src" } },
		]) {
			const component = new ToolExecutionComponent(
				fixture.name,
				fixture.args,
				{ showImages: false },
				undefined,
				ui,
				process.cwd(),
			);
			component.updateResult(
				{
					content: [{ type: "text", text: "ordinary direct failure: Aborted: Signal" }],
					details: {},
					isError: true,
				},
				false,
			);
			const rendered = visibleText(component.render(120));
			expect(rendered.split("\n").filter(line => line.trim().length > 0)).toHaveLength(1);
			expect(rendered).toContain("ordinary direct failure: Aborted: Signal");
			expect(rendered).not.toContain(fixture.name === "glob" ? "direct-error-*" : "direct-error-token");
		}
	});

	it("keeps an xd-mounted abort in its delegated renderer", () => {
		const ui: ToolExecutionUi = {
			requestRender() {},
			requestComponentRender(_component: Component) {},
			resetDisplay() {},
		};
		const component = new ToolExecutionComponent(
			"write",
			{ path: "xd://glob", content: JSON.stringify({ path: "src/mounted-*.ts" }) },
			{ showImages: false },
			undefined,
			ui,
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "Aborted: Cancelled" }],
				details: {
					xdev: {
						tool: "glob",
						mode: "execute",
						args: { path: "src/mounted-*.ts" },
						aborted: true,
					},
				},
				isError: true,
			},
			false,
		);

		const rendered = visibleText(component.render(120));
		expect(rendered).toContain("Glob");
		expect(rendered).toContain("src/mounted-*.ts");
		expect(rendered).toContain("Aborted: Cancelled");
		expect(rendered).not.toContain("Write");
	});
});

describe("MCP result Markdown rendering", () => {
	const details: MCPToolDetails = {
		serverName: "context-mode",
		mcpToolName: "ctx_search",
	};

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	afterEach(() => {
		settings.set("mcp.renderMarkdownResults", true);
	});

	it("renders inline Markdown by default", () => {
		const component = renderMCPResult(
			{ content: [{ type: "text", text: "**bold result** and `code`" }], details },
			{ expanded: true, isPartial: false },
			theme,
		);
		const rendered = visibleText(component.render(80));

		expect(rendered).toContain("bold result and code");
		expect(rendered).not.toContain("**bold result**");
		expect(rendered).not.toContain("`code`");
	});

	it("keeps Markdown syntax literal when the setting is disabled", () => {
		settings.set("mcp.renderMarkdownResults", false);
		const component = renderMCPResult(
			{ content: [{ type: "text", text: "**bold result**" }], details },
			{ expanded: true, isPartial: false },
			theme,
		);

		expect(visibleText(component.render(80))).toContain("**bold result**");
	});

	it("preserves structured JSON rendering when Markdown is enabled", () => {
		settings.set("mcp.renderMarkdownResults", true);
		const component = renderMCPResult(
			{ content: [{ type: "text", text: '{"status":"**ok**"}' }], details },
			{ expanded: true, isPartial: false },
			theme,
		);
		const rendered = visibleText(component.render(80));

		expect(rendered).toContain("status");
		expect(rendered).toContain("**ok**");
	});
});
