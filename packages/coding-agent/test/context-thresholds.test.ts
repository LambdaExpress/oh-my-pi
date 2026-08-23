/**
 * Contract for the context gauge's fixed escalation palette.
 *
 * The status-line context% tier colors are theme-independent by design:
 * green → yellow → orange → red. Historically the middle tier mapped to the
 * theme's `thinkingHigh` slot, which most themes share with `statusLineContext`
 * (e.g. dark-github renders both as the same purple), so "normal" and the
 * middle tier were indistinguishable. The palette must stay fixed and
 * distinguishable under any theme, with dark/light variants keyed off the
 * status-line background for contrast.
 *
 * Tier boundaries are percent thresholds (35/60/75) that may be superseded by
 * token thresholds (150k/270k/500k) on windows where the token-derived
 * percentage trips earlier — whichever fires first wins.
 */
import { describe, expect, it } from "bun:test";
import {
	getContextUsageLevel,
	getContextUsageThemeColor,
} from "@oh-my-pi/pi-coding-agent/modes/components/status-line/context-thresholds";

describe("getContextUsageLevel", () => {
	it("uses token thresholds for 1M windows", () => {
		expect(getContextUsageLevel(5, 1_000_000)).toBe("normal");
		expect(getContextUsageLevel(16, 1_000_000)).toBe("warning");
		expect(getContextUsageLevel(30, 1_000_000)).toBe("high");
		expect(getContextUsageLevel(60, 1_000_000)).toBe("error");
	});

	it("flips tiers exactly at the 1M token-derived boundaries", () => {
		// 150k / 1M = 15%, 270k / 1M = 27%, 500k / 1M = 50%.
		expect(getContextUsageLevel(14.9, 1_000_000)).toBe("normal");
		expect(getContextUsageLevel(15, 1_000_000)).toBe("warning");
		expect(getContextUsageLevel(26.9, 1_000_000)).toBe("warning");
		expect(getContextUsageLevel(27, 1_000_000)).toBe("high");
		expect(getContextUsageLevel(49.9, 1_000_000)).toBe("high");
		expect(getContextUsageLevel(50, 1_000_000)).toBe("error");
	});

	it("uses percent thresholds for 128k windows", () => {
		expect(getContextUsageLevel(34.9, 128_000)).toBe("normal");
		expect(getContextUsageLevel(35, 128_000)).toBe("warning");
		expect(getContextUsageLevel(59.9, 128_000)).toBe("warning");
		expect(getContextUsageLevel(60, 128_000)).toBe("high");
		expect(getContextUsageLevel(74.9, 128_000)).toBe("high");
		expect(getContextUsageLevel(75, 128_000)).toBe("error");
	});

	it("keeps unknown windows on percent thresholds", () => {
		expect(getContextUsageLevel(34.9, 0)).toBe("normal");
		expect(getContextUsageLevel(35, 0)).toBe("warning");
		expect(getContextUsageLevel(60, 0)).toBe("high");
		expect(getContextUsageLevel(75, 0)).toBe("error");
	});

	it("never escalates from empty or non-finite usage", () => {
		expect(getContextUsageLevel(0, 1_000_000)).toBe("normal");
		expect(getContextUsageLevel(-1, 1_000_000)).toBe("normal");
		expect(getContextUsageLevel(Number.NaN, 1_000_000)).toBe("normal");
	});
});

describe("getContextUsageThemeColor", () => {
	it("maps tiers to a fixed green → yellow → orange → red escalation on dark themes", () => {
		expect(getContextUsageThemeColor("normal", false)).toBe("#3fb950");
		expect(getContextUsageThemeColor("warning", false)).toBe("#d29922");
		expect(getContextUsageThemeColor("high", false)).toBe("#ffa657");
		expect(getContextUsageThemeColor("error", false)).toBe("#f85149");
	});

	it("uses darker variants on light themes", () => {
		expect(getContextUsageThemeColor("normal", true)).toBe("#1a7f37");
		expect(getContextUsageThemeColor("warning", true)).toBe("#9a6700");
		expect(getContextUsageThemeColor("high", true)).toBe("#bc4c00");
		expect(getContextUsageThemeColor("error", true)).toBe("#cf222e");
	});

	it("keeps every tier pair distinct within a mode", () => {
		const dark = (["normal", "warning", "high", "error"] as const).map(level =>
			getContextUsageThemeColor(level, false),
		);
		const light = (["normal", "warning", "high", "error"] as const).map(level =>
			getContextUsageThemeColor(level, true),
		);
		expect(new Set(dark).size).toBe(4);
		expect(new Set(light).size).toBe(4);
	});
});
