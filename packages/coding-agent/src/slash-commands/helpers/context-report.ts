import { computeSessionContextBreakdown } from "../../session/context-usage-runtime";
import { t } from "../../i18n";
import type { SlashCommandRuntime } from "../types";
import { renderAsciiBar } from "@oh-my-pi/pi-tui/chrome/format";

/**
 * Build the `/context` ACP-mode text. Tries the rich breakdown first
 * (categories + auto-compact buffer + free slack) and falls back to the
 * minimal "window/used" lines when the breakdown helper throws.
 */
export function buildContextReportText(runtime: SlashCommandRuntime): string {
	try {
		const breakdown = computeSessionContextBreakdown(runtime.session, { snapcompactSavings: true });
		if (breakdown.contextWindow <= 0) {
			return t("Context usage is unavailable: no model is selected for this session.");
		}
		const usedPct = Math.round((breakdown.usedTokens / breakdown.contextWindow) * 100);
		const lines = [
			t("Context window: {count} tokens ({pct}% used)", {
				count: breakdown.contextWindow,
				pct: usedPct,
			}),
		];
		for (const category of breakdown.categories) {
			if (category.tokens === 0) continue;
			const fraction = category.tokens / breakdown.contextWindow;
			lines.push(
				t("  {label} {bar}  {count} tokens", {
					label: category.label.padEnd(16),
					bar: renderAsciiBar(fraction),
					count: category.tokens,
				}),
			);
		}
		if (breakdown.autoCompactBufferTokens > 0) {
			const fraction = breakdown.autoCompactBufferTokens / breakdown.contextWindow;
			lines.push(
				t("  {label} {bar}  {count} tokens", {
					label: t("Auto-compact buf").padEnd(16),
					bar: renderAsciiBar(fraction),
					count: breakdown.autoCompactBufferTokens,
				}),
			);
		}
		if (breakdown.freeTokens > 0) {
			const fraction = breakdown.freeTokens / breakdown.contextWindow;
			lines.push(
				t("  {label} {bar}  {count} tokens", {
					label: t("Free").padEnd(16),
					bar: renderAsciiBar(fraction),
					count: breakdown.freeTokens,
				}),
			);
		}
		const snap = breakdown.snapcompact;
		if (snap) {
			if (!snap.visionCapable) {
				lines.push(t("Snapcompact: inactive (model has no image input)"));
			} else {
				lines.push(t("Snapcompact (estimated wire savings):"));
				if (snap.systemPrompt) {
					const sp = snap.systemPrompt;
					lines.push(
						sp.applied
							? t("  System prompt: {text} text tokens → {frames} frame(s) ≈ {image} tokens (saves ~{saved})", {
									text: sp.textTokens,
									frames: sp.frames,
									image: sp.imageTokens,
									saved: sp.savedTokens,
								})
							: t("  System prompt: stays text (no net savings)"),
					);
				}
				if (snap.toolResults) {
					const tr = snap.toolResults;
					lines.push(
						tr.swapped > 0
							? t(
									"  Tool results: {swapped} of {total} imaged, {text} text tokens → {frames} frames ≈ {image} tokens (saves ~{saved})",
									{
										swapped: tr.swapped,
										total: tr.total,
										text: tr.textTokens,
										frames: tr.frames,
										image: tr.imageTokens,
										saved: tr.savedTokens,
									},
								)
							: t("  Tool results: none imaged ({total} in history)", { total: tr.total }),
					);
				}
				if (snap.savedTokens > 0) {
					lines.push(
						t("  Estimated next request: ~{count} tokens on the wire", {
							count: breakdown.usedTokens - snap.savedTokens,
						}),
					);
				}
			}
		}
		return lines.join("\n");
	} catch {
		const fallback = runtime.session.getContextUsage();
		if (!fallback) return t("Context usage is unavailable.");
		return [
			t("Context"),
			t("Window: {count}", { count: fallback.contextWindow }),
			t("Used: {count}", { count: fallback.tokens ?? 0 }),
		].join("\n");
	}
}
