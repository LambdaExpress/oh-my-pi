import type { SessionSummary } from "@oh-my-pi/pi-wire";
import { Play, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import type { ControlSnapshot } from "../../lib/control-client";
import { relTime } from "../../lib/format";

export interface SessionsPanelProps {
	snapshot: ControlSnapshot;
	onOpenSession(id: string): void;
	onNewSession(): void;
	onDropSession(id: string): void;
}

/** Session title falls back to the basename of the working directory. */
export function sessionTitle(s: SessionSummary): string {
	if (s.title && s.title.length > 0) return s.title;
	const base = s.cwd
		.split(/[\\/]+/)
		.filter(Boolean)
		.pop();
	return base && base.length > 0 ? base : s.cwd;
}

export function sessionModifiedMs(s: SessionSummary): number {
	const t = Date.parse(s.modifiedAt);
	return Number.isFinite(t) ? t : Date.now();
}

export function SessionsPanel({ snapshot, onOpenSession, onNewSession, onDropSession }: SessionsPanelProps): ReactNode {
	const { sessions, readOnly, phase } = snapshot;

	return (
		<div className="sh-sessions">
			<div className="sh-sessions-head">
				<span className="sh-sessions-title">Sessions</span>
				<span className={`sh-sessions-dot sh-sessions-dot-${phase}`} title={phase} />
			</div>
			<div className="sh-sessions-list">
				{sessions.map(s => (
					<div
						key={s.id}
						className="sh-sessions-item"
						role={readOnly ? undefined : "button"}
						title={s.cwd}
						onClick={() => {
							if (!readOnly) onOpenSession(s.id);
						}}
					>
						<div className="sh-sessions-item-main">
							<span className="sh-sessions-item-title">{sessionTitle(s)}</span>
							<span className="sh-sessions-item-meta">
								<span>{relTime(sessionModifiedMs(s))}</span>
								{s.status && <span className="sh-sessions-status">{s.status}</span>}
								{s.streaming && <span className="sh-sessions-streaming" title="streaming" />}
							</span>
						</div>
						{!readOnly && (
							<div className="sh-sessions-item-actions">
								<button
									type="button"
									className="sh-btn sh-btn-icon"
									title="resume session"
									onClick={e => {
										e.stopPropagation();
										onOpenSession(s.id);
									}}
								>
									<Play size={13} />
								</button>
								<button
									type="button"
									className="sh-btn sh-btn-icon"
									title="drop session"
									onClick={e => {
										e.stopPropagation();
										onDropSession(s.id);
									}}
								>
									<Trash2 size={13} />
								</button>
							</div>
						)}
					</div>
				))}
				{sessions.length === 0 && <div className="sh-sessions-empty-hint">no sessions yet — start one below</div>}
			</div>
			<div className="sh-sessions-foot">
				{readOnly ? (
					<span className="sh-sessions-readonly">read-only — watching</span>
				) : (
					<button type="button" className="sh-btn sh-btn-primary sh-sessions-new" onClick={onNewSession}>
						<Plus size={14} /> New session
					</button>
				)}
			</div>
		</div>
	);
}
