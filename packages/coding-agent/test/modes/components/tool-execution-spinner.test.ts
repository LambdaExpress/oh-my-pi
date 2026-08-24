import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { RegisteredTool } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { wrapRegisteredTool } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import {
	SPINNER_RENDER_INTERVAL_MS,
	stopSharedSpinnerTicker,
	ToolExecutionComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { customToolToDefinition } from "@oh-my-pi/pi-coding-agent/sdk";
import { webSearchCustomTool } from "@oh-my-pi/pi-coding-agent/web/search";
import type { TUI } from "@oh-my-pi/pi-tui";

function createBridgedWebSearchTool() {
	const definition = customToolToDefinition(webSearchCustomTool);
	return wrapRegisteredTool(
		{ definition, extensionPath: "<sdk>" } as RegisteredTool,
		{ createContext: () => ({}) } as unknown as ExtensionRunner,
	);
}

// Contract under test: live tool previews that render a pending/running status
// must keep the spinner glyph tied to the shared tool-frame ticker. This covers
// both the shared ToolExecutionComponent interval and renderer-local caches that
// would otherwise keep serving the first pending frame.
describe("ToolExecutionComponent live preview spinners", () => {
	beforeAll(async () => {
		await initTheme();
	});

	// Earlier test files may leak live blocks (components never stopAnimation'd),
	// which keeps the shared ticker armed on a REAL interval and makes these
	// fake-timer assertions observe a pre-existing timer instead of a fresh one.
	beforeEach(() => {
		stopSharedSpinnerTicker();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("animates the eval pending cell while the call is live", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const component = new ToolExecutionComponent(
			"eval",
			{ language: "py", code: "import time\ntime.sleep(10)" },
			{},
			undefined,
			{ requestRender, requestComponentRender } as unknown as TUI,
			process.cwd(),
		);

		try {
			const firstFrame = stripVTControlCharacters(component.render(80).join("\n"));
			vi.advanceTimersByTime(120);
			const secondFrame = stripVTControlCharacters(component.render(80).join("\n"));

			expect(requestComponentRender).toHaveBeenCalledWith(component);
			expect(requestRender).not.toHaveBeenCalled();
			expect(firstFrame).toContain("time.sleep(10)");
			expect(secondFrame).toContain("time.sleep(10)");
			expect(secondFrame).not.toBe(firstFrame);
		} finally {
			component.stopAnimation();
		}
	});

	it("does not tick headerless bash pending previews", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const component = new ToolExecutionComponent(
			"bash",
			{ command: "sleep 600" },
			{},
			undefined,
			{ requestRender, requestComponentRender } as unknown as TUI,
			process.cwd(),
		);

		try {
			requestRender.mockClear();
			requestComponentRender.mockClear();
			vi.advanceTimersByTime(500);
			expect(requestRender).not.toHaveBeenCalled();
			expect(requestComponentRender).not.toHaveBeenCalled();
		} finally {
			component.stopAnimation();
		}
	});

	it("does not tick detached async bash result snapshots", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const component = new ToolExecutionComponent(
			"bash",
			{ command: "sleep 600", async: true },
			{},
			undefined,
			{ requestRender, requestComponentRender } as unknown as TUI,
			process.cwd(),
		);

		try {
			component.updateResult(
				{
					content: [{ type: "text", text: "started background job" }],
					details: {
						command: "sleep 600",
						async: { state: "running", jobId: "job-1", type: "bash" },
					},
				},
				true,
			);
			requestRender.mockClear();
			requestComponentRender.mockClear();
			vi.advanceTimersByTime(500);
			expect(requestRender).not.toHaveBeenCalled();
			expect(requestComponentRender).not.toHaveBeenCalled();
		} finally {
			component.stopAnimation();
		}
	});

	it("does not tick github pending previews whose Text is materialized per rebuild", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const component = new ToolExecutionComponent(
			"github",
			{ op: "run_watch", run: "12345" },
			{},
			undefined,
			{ requestRender, requestComponentRender } as unknown as TUI,
			process.cwd(),
		);

		try {
			requestRender.mockClear();
			requestComponentRender.mockClear();
			vi.advanceTimersByTime(500);
			expect(requestRender).not.toHaveBeenCalled();
			expect(requestComponentRender).not.toHaveBeenCalled();
		} finally {
			component.stopAnimation();
		}
	});

	it("does not tick custom tools whose pending label is a static tool-name Text", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		// A renderResult-only custom tool renders the static tool-name label
		// while pending, so the spinner interval must not start.
		const tool = { name: "ext_tool", renderResult: () => undefined };
		const component = new ToolExecutionComponent(
			"ext_tool",
			{ input: 1 },
			{},
			tool as never,
			{ requestRender, requestComponentRender } as unknown as TUI,
			process.cwd(),
		);

		try {
			requestRender.mockClear();
			requestComponentRender.mockClear();
			vi.advanceTimersByTime(500);
			expect(requestRender).not.toHaveBeenCalled();
			expect(requestComponentRender).not.toHaveBeenCalled();
		} finally {
			component.stopAnimation();
		}
	});

	it("replaces an adapted Web Search pending preview with one completed query-and-answer card", () => {
		const query = "ORIGINAL WEB SEARCH QUERY";
		const answer = "FINAL WEB SEARCH ANSWER";
		const component = new ToolExecutionComponent(
			"web_search",
			{ query },
			{ useBuiltInRenderer: false },
			createBridgedWebSearchTool(),
			{ requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
			process.cwd(),
		);

		try {
			const pending = stripVTControlCharacters(component.render(100).join("\n"));
			expect(pending).toContain(theme.status.pending);
			expect(pending).toContain("Web Search");
			expect(pending).toContain(query);

			component.updateResult({
				content: [{ type: "text", text: answer }],
				details: {
					response: {
						provider: "tavily",
						answer,
						sources: [{ title: "Search source", url: "https://example.com/source" }],
					},
				},
			});

			const completed = stripVTControlCharacters(component.render(100).join("\n"));
			expect(completed.match(/Web Search/g) ?? []).toHaveLength(1);
			expect(completed).not.toContain(theme.status.pending);
			expect(completed).toContain(`Query: ${query}`);
			expect(completed).toContain("Answer");
			expect(completed).toContain(answer);
		} finally {
			component.stopAnimation();
		}
	});

	it("replaces an adapted Web Search pending preview with one terminal error card", () => {
		const component = new ToolExecutionComponent(
			"web_search",
			{ query: "FAILING WEB SEARCH QUERY" },
			{ useBuiltInRenderer: false },
			createBridgedWebSearchTool(),
			{ requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
			process.cwd(),
		);

		try {
			expect(stripVTControlCharacters(component.render(100).join("\n"))).toContain(theme.status.pending);

			component.updateResult({
				content: [{ type: "text", text: "Provider unavailable" }],
				details: {
					response: { provider: "tavily", sources: [] },
					error: "Provider unavailable",
				},
				isError: true,
			});

			const failed = stripVTControlCharacters(component.render(100).join("\n"));
			expect(failed.match(/Web Search/g) ?? []).toHaveLength(1);
			expect(failed).not.toContain(theme.status.pending);
			expect(failed).toContain("Error: Provider unavailable");
		} finally {
			component.stopAnimation();
		}
	});

	// Regression (issue #8731): concurrent live tool blocks — e.g. parallel task
	// subagents — must share ONE spinner timer, not one per block, or active-work
	// CPU scales with block count.
	it("drives every concurrent live block from a single shared spinner timer", () => {
		vi.useFakeTimers();
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const renders = [vi.fn(), vi.fn(), vi.fn()];
		const components = renders.map(
			requestComponentRender =>
				new ToolExecutionComponent(
					"eval",
					{ language: "py", code: "import time\ntime.sleep(10)" },
					{},
					undefined,
					{ requestRender: vi.fn(), requestComponentRender } as unknown as TUI,
					process.cwd(),
				),
		);

		try {
			const spinnerTimers = setIntervalSpy.mock.calls.filter(([, ms]) => ms === SPINNER_RENDER_INTERVAL_MS).length;
			// One shared ticker for all three live blocks, not three.
			expect(spinnerTimers).toBe(1);

			// A single tick repaints every registered block in lockstep.
			vi.advanceTimersByTime(SPINNER_RENDER_INTERVAL_MS);
			for (const requestComponentRender of renders) {
				expect(requestComponentRender).toHaveBeenCalledTimes(1);
			}
		} finally {
			for (const component of components) component.stopAnimation();
		}
	});

	it("keeps the full tool renderer under transcript pressure", () => {
		const component = new ToolExecutionComponent(
			"bash",
			{ command: "bun test packages/tui" },
			{},
			undefined,
			{ requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
			process.cwd(),
		);
		try {
			const full = component.render(80);
			const plain = stripVTControlCharacters(full.join("\n"));
			expect(full.length).toBeGreaterThanOrEqual(3);
			expect(plain).toContain("bun test packages/tui");
			expect(plain).not.toContain("bash · bun test packages/tui");
		} finally {
			component.stopAnimation();
		}
	});
});
