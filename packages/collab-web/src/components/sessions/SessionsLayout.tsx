import { List, LogOut, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { ControlClient, ControlSnapshot } from "../../lib/control-client";
import { relTime } from "../../lib/format";
import { useControlSnapshot } from "../../lib/use-control";
import { SessionsPanel, sessionModifiedMs, sessionTitle } from "./SessionsPanel";

export interface SessionsLayoutProps {
	client: ControlClient;
	/** Active session view, or null for the empty state (no session open). */
	content: ReactNode;
	onOpenSession(id: string): void;
	onNewSession(): void;
	onDropSession(id: string): void;
	onLeave(): void;
}

/**
 * Control-mode frame: left session sidebar + right content area (empty state
 * or the active {@link Session}). The sidebar stays mounted while a session is
 * open so the 2s `ctrl-sessions` broadcasts keep streaming state fresh.
 */
export function SessionsLayout({
	client,
	content,
	onOpenSession,
	onNewSession,
	onDropSession,
	onLeave,
}: SessionsLayoutProps): ReactNode {
	const snap = useControlSnapshot(client);
	const [sidebarOpen, setSidebarOpen] = useState(false);

	const openSession = (id: string): void => {
		setSidebarOpen(false);
		onOpenSession(id);
	};
	const newSession = (): void => {
		setSidebarOpen(false);
		onNewSession();
	};

	return (
		<div className="sh-control">
			{sidebarOpen && <div className="sh-sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}
			<aside className="sh-sidebar" data-open={sidebarOpen ? "true" : "false"}>
				<SessionsPanel
					snapshot={snap}
					onOpenSession={openSession}
					onNewSession={newSession}
					onDropSession={onDropSession}
				/>
			</aside>
			<div className="sh-control-main">
				<div className="sh-control-toolbar">
					<button
						type="button"
						className="sh-btn sh-btn-icon sh-sidebar-toggle"
						onClick={() => setSidebarOpen(true)}
						title="show sessions"
					>
						<List size={14} />
					</button>
					<span className="sh-control-room">control room</span>
					<button type="button" className="sh-btn sh-btn-icon" onClick={onLeave} title="leave control room">
						<LogOut size={14} />
					</button>
				</div>
				<div className="sh-control-view">
					{content ?? <SessionsEmpty snap={snap} onOpenSession={openSession} onNewSession={newSession} />}
				</div>
			</div>
		</div>
	);
}

function SessionsEmpty({
	snap,
	onOpenSession,
	onNewSession,
}: {
	snap: ControlSnapshot;
	onOpenSession(id: string): void;
	onNewSession(): void;
}): ReactNode {
	const { sessions, readOnly } = snap;
	return (
		<div className="sh-sessions-empty">
			<div className="sh-sessions-empty-card">
				<h2 className="sh-sessions-empty-title">Your sessions</h2>
				<p className="sh-sessions-empty-sub">Pick a session to resume it, or start a fresh one.</p>
				{!readOnly && (
					<button type="button" className="sh-btn sh-btn-primary" onClick={onNewSession}>
						<Plus size={14} /> New session
					</button>
				)}
			</div>
			{sessions.length > 0 && (
				<div className="sh-sessions-recent">
					<div className="sh-sessions-recent-label">recent</div>
					{sessions.slice(0, 5).map(s => (
						<button
							key={s.id}
							type="button"
							className="sh-sessions-recent-item"
							disabled={readOnly}
							onClick={() => onOpenSession(s.id)}
						>
							<span className="sh-sessions-recent-name">{sessionTitle(s)}</span>
							<span className="sh-sessions-recent-meta">{relTime(sessionModifiedMs(s))}</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}
