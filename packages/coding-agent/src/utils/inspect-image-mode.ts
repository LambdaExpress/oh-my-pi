/**
 * Effective-state resolution for the `inspect_image` tool.
 *
 * The tool delegates image understanding to a (possibly different)
 * vision-capable model. That indirection is only useful when the active model
 * cannot consume images itself; when it can (`model.input` includes
 * `"image"`), the tool is redundant and its presence actively degrades the
 * `read` tool, which reduces image reads to metadata-only plus an
 * inspect_image suggestion. `auto` mode therefore exposes the tool only for
 * models without native image input. `on`/`off` force registration regardless
 * of model capability. A session-scoped override (the `/vision` command)
 * takes precedence over the persisted setting for the current session only.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import type { Settings } from "../config/settings";

export type InspectImageMode = "auto" | "on" | "off";

export const INSPECT_IMAGE_MODES = ["auto", "on", "off"] as const;

/** Minimal session surface needed to resolve the effective inspect_image state. */
export interface InspectImageModeContext {
	settings: Pick<Settings, "get">;
	getActiveModel?: () => Model | undefined;
	getInspectImageModeOverride?: () => InspectImageMode | undefined;
}

/**
 * Whether the `inspect_image` tool should be registered/active right now.
 * `auto` registers it only when the active model lacks native image input;
 * an unresolved model is treated as text-only so the tool stays available.
 */
export function isInspectImageToolActive(session: InspectImageModeContext): boolean {
	const mode = session.getInspectImageModeOverride?.() ?? session.settings.get("inspect_image.mode");
	if (mode === "on") return true;
	if (mode === "off") return false;
	const model = session.getActiveModel?.();
	return !(model?.input?.includes("image") ?? false);
}

/** Session surface needed to resolve whether `inspect_image` is reachable right now. */
export interface InspectImageAvailabilityContext extends InspectImageModeContext {
	/** Whether a built-in tool is active in this turn's tool set. */
	isToolActive?: (name: string) => boolean | undefined;
	/** `xd://` presentation state (mounted devices stay executable via `write xd://inspect_image`). */
	xdev?: { mountedNames?: ReadonlySet<string> } | undefined;
}

/**
 * Whether the `inspect_image` tool can actually be reached in this session:
 * exposed top-level, or mounted as an `xd://` device while the effective mode
 * wants it (mounted devices stay executable via `write xd://inspect_image`, so
 * a metadata-only read remains actionable). Sessions with neither availability
 * signal (tests, embedded use) fall back to the mode computation alone.
 * Restricted slates (subagents without the tool and without a mount) report
 * false so image reads keep inlining blocks instead of pointing at an absent tool.
 */
export function isInspectImageToolAvailable(session: InspectImageAvailabilityContext): boolean {
	const topLevel = session.isToolActive?.("inspect_image");
	const xdev = session.xdev;
	if (topLevel === undefined && xdev === undefined) return isInspectImageToolActive(session);
	if (topLevel === true) return true;
	return xdev?.mountedNames?.has("inspect_image") === true && isInspectImageToolActive(session);
}
