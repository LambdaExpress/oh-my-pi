/**
 * Public shape of the `shake` operation, kept in a dependency-free leaf module
 * so slash-command registries and controllers can import `formatShakeSummary`
 * without pulling in the heavy `agent-session` module graph (which would form
 * an import cycle through the slash-command registry).
 */

import { t } from "../i18n";

/** Mode selector for `AgentSession.shake`. */
export type ShakeMode = "elide" | "images";

/** Outcome of an `AgentSession.shake` run. */
export interface ShakeResult {
	mode: ShakeMode;
	/** Whole tool-call results dropped. */
	toolResultsDropped: number;
	/** Large fenced/XML blocks dropped. */
	blocksDropped: number;
	/** Image blocks removed (images mode only). */
	imagesDropped?: number;
	/** Estimated context tokens reclaimed. */
	tokensFreed: number;
	/** Session artifact holding the dropped originals, when persisted. */
	artifactId?: string;
}

/** One-line operator summary of a {@link ShakeResult} (shared by TUI + ACP). */
export function formatShakeSummary(result: ShakeResult): string {
	if (result.mode === "images") {
		const n = result.imagesDropped ?? 0;
		return n === 0
			? t("No images found in this session.")
			: n === 1
				? t("Dropped {count} image from this session.", { count: n })
				: t("Dropped {count} images from this session.", { count: n });
	}
	const parts: string[] = [];
	if (result.toolResultsDropped > 0) {
		parts.push(
			result.toolResultsDropped === 1
				? t("{count} tool result", { count: result.toolResultsDropped })
				: t("{count} tool results", { count: result.toolResultsDropped }),
		);
	}
	if (result.blocksDropped > 0) {
		parts.push(
			result.blocksDropped === 1
				? t("{count} block", { count: result.blocksDropped })
				: t("{count} blocks", { count: result.blocksDropped }),
		);
	}
	if (parts.length === 0) return t("Nothing to shake.");
	return t("Shook {parts} (~{tokens} tokens freed).", {
		parts: parts.join(" + "),
		tokens: result.tokensFreed,
	});
}
