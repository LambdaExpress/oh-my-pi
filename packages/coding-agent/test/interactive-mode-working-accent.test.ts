import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import * as sessionColor from "@oh-my-pi/pi-coding-agent/utils/session-color";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { adjustHsv, TempDir } from "@oh-my-pi/pi-utils";
import { setLocale } from "../src/i18n";

type Harness = {
	mode: InteractiveMode;
	sessionManager: SessionManager;
	tempDir: TempDir;
};

let harness: Harness | undefined;

function defined<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Expected value to be defined");
	return value;
}
/**
 * ANSI of the loader's leading interrupt glyph for a session name: the dim
 * accent variant. Unlike `main`, which only surfaces inside the time-swept
 * shimmer band of the message, the glyph is painted every render, so it is
 * the deterministic marker for "this session's accent reached the loader".
 */
function accentGlyphAnsi(sessionName: string): string {
	const hex = sessionColor.getSessionAccentHex(sessionName, theme.sessionAccentInputs);
	return defined(sessionColor.getSessionAccentAnsi(adjustHsv(hex, { s: 0.55, v: 0.65 })));
}

async function createHarness(sessionName: string): Promise<Harness> {
	if (harness) {
		harness.mode.loadingAnimation?.stop();
		harness.mode.loadingAnimation = undefined;
		harness.mode.statusContainer.disposeChildren();
		await harness.sessionManager.setSessionName(sessionName, "user");
		return harness;
	}

	const tempDir = TempDir.createSync("@pi-working-accent-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	await initTheme(false);
	const sessionManager = SessionManager.inMemory(tempDir.path());
	await sessionManager.setSessionName(sessionName, "user");
	const session = {
		sessionManager,
		settings,
		agent: {
			state: { tools: [] },
			metadataForProvider: () => undefined,
		},
		getAsyncJobSnapshot: () => null,
		customCommands: [],
		skills: [],
		autoCompactionEnabled: true,
		messages: [],
		systemPrompt: [],
		state: { model: undefined },
		isStreaming: true,
		model: undefined,
		thinkingLevel: undefined,
	} as unknown as AgentSession;
	const mode = new InteractiveMode(session, "test");
	harness = { mode, sessionManager, tempDir };
	return harness;
}

function startStableLoader(mode: InteractiveMode): void {
	mode.ensureLoadingAnimation();
	mode.loadingAnimation?.stop();
}

function renderLoader(mode: InteractiveMode): string {
	return mode.statusContainer.render(120).join("\n");
}

function shadowAccentSurfaceLuminance(value: number | undefined): () => void {
	Object.defineProperty(theme, "accentSurfaceLuminance", {
		configurable: true,
		get: () => value,
	});
	return () => {
		delete (theme as unknown as { accentSurfaceLuminance?: number }).accentSurfaceLuminance;
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

afterAll(() => {
	harness?.mode.stop();
	harness?.tempDir.removeSync();
	harness = undefined;
	resetSettingsForTest();
	setLocale(null);
});

beforeEach(() => {
	// Assertions below are English literal texts; pin the locale so the suite
	// is deterministic on non-English (e.g. zh-CN) developer machines.
	setLocale("en");
});

describe("InteractiveMode working-message session accent cache", () => {
	it("reuses one computed accent across loader spinner and message colorizers", async () => {
		const { mode } = await createHarness("Cached session");
		const getHex = vi.spyOn(sessionColor, "getSessionAccentHex");
		const getAnsi = vi.spyOn(sessionColor, "getSessionAccentAnsi");

		// Colorizers run lazily at render time (loader layout cache); the accent
		// computation is observable only after a render.
		startStableLoader(mode);
		renderLoader(mode);
		expect(getHex).toHaveBeenCalledTimes(1);
		expect(getAnsi).toHaveBeenCalledTimes(2);

		mode.loadingAnimation?.setMessage("Still working");
		renderLoader(mode);
		expect(getHex).toHaveBeenCalledTimes(1);
		expect(getAnsi).toHaveBeenCalledTimes(2);
	});

	it("recomputes for session renames and repaints the loader glyph with the new accent", async () => {
		const initialName = "Alpha session";
		const renamedName = "Beta session";
		const { mode, sessionManager } = await createHarness(initialName);
		const initialAnsi = accentGlyphAnsi(initialName);
		const renamedAnsi = accentGlyphAnsi(renamedName);
		const getHex = vi.spyOn(sessionColor, "getSessionAccentHex");

		startStableLoader(mode);
		expect(renderLoader(mode)).toContain(initialAnsi);
		expect(getHex).toHaveBeenCalledTimes(1);

		await sessionManager.setSessionName(renamedName, "user");
		mode.loadingAnimation?.setMessage("Renamed session");
		expect(renderLoader(mode)).toContain(renamedAnsi);
		expect(getHex).toHaveBeenCalledTimes(2);
	});

	it("keys cached accents by theme accent-surface luminance", async () => {
		const sessionName = "Luminance session";
		const { mode } = await createHarness(sessionName);
		const restoreInitial = shadowAccentSurfaceLuminance(undefined);
		const getHex = vi.spyOn(sessionColor, "getSessionAccentHex");

		try {
			startStableLoader(mode);
			renderLoader(mode);
			expect(getHex).toHaveBeenCalledTimes(1);
			expect(getHex.mock.calls[0]).toEqual([sessionName, theme.sessionAccentInputs]);

			restoreInitial();
			const restoreLight = shadowAccentSurfaceLuminance(0.72);
			try {
				mode.loadingAnimation?.setMessage("Light theme");
				renderLoader(mode);
				expect(getHex).toHaveBeenCalledTimes(2);
				expect(getHex.mock.calls[1]).toEqual([sessionName, theme.sessionAccentInputs]);
			} finally {
				restoreLight();
			}
		} finally {
			restoreInitial();
		}
	});

	it("caches disabled session accents and recomputes when the setting is enabled again", async () => {
		const sessionName = "Toggle session";
		const { mode } = await createHarness(sessionName);
		const accentAnsi = accentGlyphAnsi(sessionName);
		const getHex = vi.spyOn(sessionColor, "getSessionAccentHex");

		startStableLoader(mode);
		expect(renderLoader(mode)).toContain(accentAnsi);
		expect(getHex).toHaveBeenCalledTimes(1);

		settings.set("statusLine.sessionAccent", false);
		mode.loadingAnimation?.setMessage("Accent disabled");
		expect(renderLoader(mode)).not.toContain(accentAnsi);
		expect(getHex).toHaveBeenCalledTimes(1);

		settings.set("statusLine.sessionAccent", true);
		mode.loadingAnimation?.setMessage("Accent enabled");
		expect(renderLoader(mode)).toContain(accentAnsi);
		expect(getHex).toHaveBeenCalledTimes(2);
	});
});

describe("InteractiveMode working activity", () => {
	it("keeps elapsed time advancing across intent changes and resets it for the next run", async () => {
		const { mode } = await createHarness("Timed session");
		vi.useFakeTimers();
		const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
		mode.statusLine.resetActiveTime();
		mode.statusLine.markActivityStart();
		mode.ensureLoadingAnimation();

		try {
			clock.mockReturnValue(69_900);
			vi.advanceTimersByTime(200);
			expect(stripVTControlCharacters(renderLoader(mode))).toContain("(59s)");

			mode.setWorkingMessage("Inspecting existing patch convention");
			expect(stripVTControlCharacters(renderLoader(mode))).toContain("Inspecting existing patch convention (59s)");

			clock.mockReturnValue(70_100);
			vi.advanceTimersByTime(200);
			expect(stripVTControlCharacters(renderLoader(mode))).toContain("(1m 0s)");
			mode.setWorkingMessage();
			expect(stripVTControlCharacters(renderLoader(mode))).toContain("(1m 0s)");

			mode.statusLine.markActivityEnd();
			mode.statusContainer.disposeChildren();
			mode.loadingAnimation = undefined;
			clock.mockReturnValue(200_000);
			mode.statusLine.markActivityStart();
			mode.ensureLoadingAnimation();
			expect(stripVTControlCharacters(renderLoader(mode))).toContain("(0s)");
		} finally {
			mode.loadingAnimation?.stop();
			mode.statusLine.markActivityEnd();
		}
	});

	it("wraps a pending intent with its live hour timer within the terminal width", async () => {
		const { mode } = await createHarness("Wrapped timer session");
		vi.useFakeTimers();
		const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
		mode.statusLine.resetActiveTime();
		mode.statusLine.markActivityStart();
		mode.setWorkingMessage("Inspecting existing patch convention");
		mode.ensureLoadingAnimation();

		try {
			clock.mockReturnValue(10_000 + 3_599_900);
			vi.advanceTimersByTime(200);
			expect(stripVTControlCharacters(renderLoader(mode))).toContain("(59m 59s)");

			clock.mockReturnValue(10_000 + 3_600_100);
			vi.advanceTimersByTime(200);
			const lines = mode.statusContainer.render(32).map(stripVTControlCharacters);
			expect(lines.map(line => line.trim()).join(" ")).toContain("Inspecting existing patch convention (1h 0m 0s)");
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(32);
			}
		} finally {
			mode.loadingAnimation?.stop();
			mode.statusLine.markActivityEnd();
		}
	});

	it("preserves the active loader when blank /rename reports usage", async () => {
		const { mode } = await createHarness("Active rename session");
		mode.ensureLoadingAnimation();
		const loader = defined(mode.loadingAnimation);
		expect(mode.session.isStreaming).toBe(true);

		try {
			const handled = await executeBuiltinSlashCommand("/rename", { ctx: mode });

			expect(handled).toBe(true);
			expect(mode.session.isStreaming).toBe(true);
			expect(mode.loadingAnimation).toBe(loader);
			expect(stripVTControlCharacters(renderLoader(mode))).toContain("Working");
		} finally {
			loader.stop();
		}
	});
});
