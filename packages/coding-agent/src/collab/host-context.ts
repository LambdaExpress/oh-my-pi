/**
 * Minimal context surface {@link CollabHost} needs from its host process.
 *
 * `InteractiveModeContext` satisfies this structurally, so the TUI path is
 * untouched; headless processes (core mode) implement the same surface with
 * no-ops and direct session access.
 */

import type { Settings } from "../config/settings";
import type { CollabStatus } from "../modes/components/status-line/types";
import type { AgentSession } from "../session/agent-session";
import type { SessionManager } from "../session/session-manager";
import type { EventBus } from "../utils/event-bus";
import type { CollabHost } from "./host";

export interface CollabHostContext {
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	eventBus?: EventBus;
	statusLine: {
		setCollabStatus(status: CollabStatus | null): void;
		invalidate(): void;
		getCachedContextBreakdown(): { usedTokens: number; contextWindow: number };
	};
	ui: { requestRender(): void };
	collabHost?: CollabHost;
	showStatus(message: string, options?: { dim?: boolean }): void;
	updatePendingMessagesDisplay(): void;
}
