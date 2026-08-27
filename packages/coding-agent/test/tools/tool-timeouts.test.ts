import { describe, expect, it } from "bun:test";
import { clampTimeout, TOOL_TIMEOUTS } from "@oh-my-pi/pi-coding-agent/tools/tool-timeouts";

describe("clampTimeout", () => {
	it("returns the per-tool default when no raw timeout is given", () => {
		expect(clampTimeout("bash")).toBe(TOOL_TIMEOUTS.bash.default);
		expect(clampTimeout("eval")).toBe(TOOL_TIMEOUTS.eval.default);
		expect(TOOL_TIMEOUTS.adb).toEqual({ default: 180, min: 1, max: 3600 });
		expect(clampTimeout("adb")).toBe(180);
	});

	it("clamps explicit values to the per-tool min/max", () => {
		expect(clampTimeout("bash", 0.1)).toBe(TOOL_TIMEOUTS.bash.min);
		expect(clampTimeout("bash", 999_999)).toBe(TOOL_TIMEOUTS.bash.max);
		expect(clampTimeout("lsp", 1)).toBe(TOOL_TIMEOUTS.lsp.min);
		expect(clampTimeout("adb", 0)).toBe(1);
		expect(clampTimeout("adb", -10)).toBe(1);
		expect(clampTimeout("adb", 999_999)).toBe(3600);
	});

	it("caps the default-fallback path with a positive maxTimeout", () => {
		// Regression for #6294: omitting the raw timeout used the 300s bash
		// default and bypassed tools.maxTimeout entirely.
		expect(clampTimeout("bash", undefined, 30)).toBe(30);
		expect(clampTimeout("adb", undefined, 60)).toBe(60);
	});

	it("caps an explicit value above maxTimeout", () => {
		expect(clampTimeout("bash", 600, 30)).toBe(30);
		expect(clampTimeout("adb", 600, 30)).toBe(30);
	});

	it("lets an explicit value below maxTimeout win", () => {
		expect(clampTimeout("bash", 10, 30)).toBe(10);
		expect(clampTimeout("adb", 10, 30)).toBe(10);
	});

	it("treats maxTimeout <= 0 as no global cap", () => {
		expect(clampTimeout("bash", undefined, 0)).toBe(TOOL_TIMEOUTS.bash.default);
		expect(clampTimeout("bash", undefined, -1)).toBe(TOOL_TIMEOUTS.bash.default);
		expect(clampTimeout("adb", undefined, 0)).toBe(180);
		expect(clampTimeout("adb", undefined, -1)).toBe(180);
	});

	it("still enforces the per-tool min when maxTimeout is below it", () => {
		// maxTimeout under the floor cannot drive the effective timeout below
		// the tool's own minimum (bash min = 1s).
		expect(clampTimeout("bash", undefined, 0.1)).toBe(TOOL_TIMEOUTS.bash.min);
		expect(clampTimeout("adb", undefined, 0.1)).toBe(1);
		expect(clampTimeout("adb", 0.5, 0.1)).toBe(1);
	});
});
