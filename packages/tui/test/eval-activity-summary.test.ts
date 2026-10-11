import { beforeAll, describe, expect, it } from "bun:test";
import { ToolExecutionComponent } from "../src/chat/tool-execution";
import { initTheme } from "../src/theme";
import type { EvalToolDetails } from "../src/tools/eval";
import type { TUI } from "../src/tui";

const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

function createFoldedEval(args: { language?: string; code?: string; title?: string }) {
	const component = new ToolExecutionComponent("eval", args, {}, undefined, ui);
	component.setToolRowsFolded(true);
	return component;
}

function row(component: ToolExecutionComponent): string {
	return Bun.stripANSI(component.render(100).join("\n"));
}

describe("folded eval activity classification", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("switches at browser entry and keeps the classification after a failed mixed execution", () => {
		const component = createFoldedEval({
			language: "js",
			code: "await tab.screenshot(); print(1 + 2)",
			title: "Inspect page",
		});
		try {
			expect(row(component)).toContain("Eval: Inspect page");
			component.updateResult({ content: [], details: { hasBrowserActivity: true } }, true);
			expect(row(component)).toContain("Browser: Inspect page");
			component.updateResult(
				{ content: [{ type: "text", text: "aborted" }], details: { hasBrowserActivity: true }, isError: true },
				false,
			);
			expect(row(component)).toContain("Browser: Inspect page");
		} finally {
			component.dispose();
		}
	});

	it("recognizes historical browser events in both aggregate and per-cell results", () => {
		const historicalDetails: EvalToolDetails[] = [
			{ statusEvents: [{ op: "browser", error: "connection failed" }] },
			{
				cells: [
					{
						index: 0,
						code: "await tab.title()",
						output: "",
						status: "complete",
						statusEvents: [{ op: "browser", detail: "main.title()" }],
					},
				],
			},
		];
		for (const details of historicalDetails) {
			const component = createFoldedEval({
				language: "py",
				code: "await tab.title()",
				title: "Replay page inspection",
			});
			try {
				component.updateResult({ content: [], details }, false);
				expect(row(component)).toContain("Browser: Replay page inspection");
			} finally {
				component.dispose();
			}
		}
	});

	it("does not infer browser activity from code, titles, or unrelated event text", () => {
		const component = createFoldedEval({ language: "js", code: "await tab.screenshot()", title: "browser" });
		try {
			component.updateResult({ content: [], details: { statusEvents: [{ op: "read", detail: "browser" }] } }, false);
			expect(row(component)).toContain("Eval: browser");
			component.updateResult({ content: [], details: {} }, false);
			expect(row(component)).toContain("Eval: browser");
		} finally {
			component.dispose();
		}
	});

	it("keeps untitled Python and JavaScript executions in the same Eval category", () => {
		for (const language of ["py", "js"]) {
			const component = createFoldedEval({ language, code: "1 + 2" });
			try {
				component.updateResult({ content: [] }, false);
				expect(row(component).trim()).toBe("Eval");
			} finally {
				component.dispose();
			}
		}
	});
});
