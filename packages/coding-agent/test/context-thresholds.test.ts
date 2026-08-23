/**
 * Contract for the 17.4 context gauge escalation.
 *
 * Tier boundaries are percent thresholds (50/70/90) that may be superseded by
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
		expect(getContextUsageLevel(30, 1_000_000)).toBe("purple");
		expect(getContextUsageLevel(60, 1_000_000)).toBe("error");
	});

	it("flips tiers exactly at the 1M token-derived boundaries", () => {
		// 150k / 1M = 15%, 270k / 1M = 27%, 500k / 1M = 50%.
		expect(getContextUsageLevel(14.9, 1_000_000)).toBe("normal");
		expect(getContextUsageLevel(15, 1_000_000)).toBe("warning");
		expect(getContextUsageLevel(26.9, 1_000_000)).toBe("warning");
		expect(getContextUsageLevel(27, 1_000_000)).toBe("purple");
		expect(getContextUsageLevel(49.9, 1_000_000)).toBe("purple");
		expect(getContextUsageLevel(50, 1_000_000)).toBe("error");
	});

	it("uses percent thresholds for 128k windows", () => {
		expect(getContextUsageLevel(49.9, 128_000)).toBe("normal");
		expect(getContextUsageLevel(50, 128_000)).toBe("warning");
		expect(getContextUsageLevel(69.9, 128_000)).toBe("warning");
		expect(getContextUsageLevel(70, 128_000)).toBe("purple");
		expect(getContextUsageLevel(89.9, 128_000)).toBe("purple");
		expect(getContextUsageLevel(90, 128_000)).toBe("error");
	});

	it("keeps unknown windows on percent thresholds", () => {
		expect(getContextUsageLevel(49.9, 0)).toBe("normal");
		expect(getContextUsageLevel(50, 0)).toBe("warning");
		expect(getContextUsageLevel(70, 0)).toBe("purple");
		expect(getContextUsageLevel(90, 0)).toBe("error");
	});

	it("never escalates from empty or non-finite usage", () => {
		expect(getContextUsageLevel(0, 1_000_000)).toBe("normal");
		expect(getContextUsageLevel(-1, 1_000_000)).toBe("normal");
		expect(getContextUsageLevel(Number.NaN, 1_000_000)).toBe("normal");
	});
});

describe("getContextUsageThemeColor", () => {
	it("maps tiers through the 17.4 theme color slots", () => {
		expect(getContextUsageThemeColor("normal")).toBe("statusLineContext");
		expect(getContextUsageThemeColor("warning")).toBe("warning");
		expect(getContextUsageThemeColor("purple")).toBe("thinkingHigh");
		expect(getContextUsageThemeColor("error")).toBe("error");
	});
});
