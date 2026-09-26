import * as os from "node:os";
import type { CollabHostContext } from "./host-context";

import { cfgCollabDisplayName } from "./settings";

/** Display name for this process's user in collab sessions. */
export function collabDisplayName(ctx: Pick<CollabHostContext, "settings">): string {
	const configured = cfgCollabDisplayName.get(ctx.settings).trim();
	if (configured) return configured;
	try {
		return os.userInfo().username;
	} catch {
		return "anonymous";
	}
}
