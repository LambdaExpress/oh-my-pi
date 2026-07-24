import { stripVTControlCharacters } from "node:util";
import type { TabBarTheme } from "@oh-my-pi/pi-tui";
import { theme } from "./theme/theme";

// ═══════════════════════════════════════════════════════════════════════════
// Text Sanitization
// ═══════════════════════════════════════════════════════════════════════════

/** Sanitize text for display in a single-line status. Strips ANSI/VT escape sequences, maps remaining C0/C1 control characters to spaces, collapses whitespace, trims. */
export function sanitizeStatusText(text: string): string {
	return stripVTControlCharacters(text)
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// Tab Bar Theme
// ═══════════════════════════════════════════════════════════════════════════

/** Shared tab bar theme used by fullscreen overlays (settings, agent hub). */
export function getTabBarTheme(): TabBarTheme {
	return {
		label: (text: string) => theme.bold(theme.fg("accent", text)),
		activeTab: (text: string) => theme.bold(theme.bg("selectedBg", theme.fg("text", text))),
		inactiveTab: (text: string) => theme.fg("muted", text),
		mutedTab: (text: string) => theme.fg("dim", text),
		hoverTab: (text: string) => theme.bg("selectedBg", theme.fg("text", text)),
		hint: (text: string) => theme.fg("dim", text),
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Working-message hint
// ═══════════════════════════════════════════════════════════════════════════

function formatWorkingElapsed(elapsedMs: number): string {
	const totalSeconds = Math.floor(Math.max(0, elapsedMs) / 1_000);
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

/**
 * Suffix appended to the loader's working message to remind users they can
 * interrupt with Esc. Without an elapsed value, returns the stable marker
 * used to identify standard working messages. With one, returns the final
 * visible suffix including the current activity window's elapsed time.
 *
 * The leading space separates the hint from the message body and is consumed
 * by `endsWith`/`slice` matching in the loader renderer.
 */
export function interruptHint(elapsedMs?: number): string {
	if (elapsedMs === undefined) return " (esc to interrupt)";
	return ` (${formatWorkingElapsed(elapsedMs)} · esc to interrupt)`;
}

export { parseCommandArgs } from "../utils/command-args";
