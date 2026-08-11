import * as os from "node:os";
import type { CollabHostContext } from "./host-context";

/** Display name for this process's user in collab sessions. */
export function collabDisplayName(ctx: Pick<CollabHostContext, "settings">): string {
	const configured = (ctx.settings.get("collab.displayName") ?? "").trim();
	if (configured) return configured;
	try {
		return os.userInfo().username;
	} catch {
		return "anonymous";
	}
}
