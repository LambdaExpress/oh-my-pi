import { Link2, RefreshCw, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import type { ConnectionPhase } from "../../lib/client";

export interface BannersProps {
	phase: ConnectionPhase;
	endedReason: string | null;
	onRejoin(): void;
	onNewLink(): void;
}

export function Banners({ phase, endedReason, onRejoin, onNewLink }: BannersProps): ReactNode {
	if (phase === "connecting" || phase === "waiting") {
		return (
			<div className="sh-banner" role="status" aria-live="polite" aria-label="Connection status">
				<RefreshCw className="sh-banner-spinner" size={14} aria-hidden="true" />
				<span>{phase === "connecting" ? "Connecting to relay…" : "Joining session…"}</span>
			</div>
		);
	}
	if (phase === "reconnecting") {
		return (
			<div className="sh-banner" role="status" aria-live="polite" aria-label="Connection status">
				<RefreshCw className="sh-banner-spinner" size={14} aria-hidden="true" />
				<span>Reconnecting…</span>
			</div>
		);
	}
	if (phase === "ended") {
		return (
			<section className="sh-ended" role="status" aria-live="polite" aria-labelledby="sh-ended-title">
				<div className="sh-ended-card">
					<div>
						<div className="sh-ended-eyebrow">Connection closed</div>
						<h2 className="sh-ended-title" id="sh-ended-title">
							Session ended
						</h2>
					</div>
					<p className="sh-ended-reason">{endedReason || "The host ended this collaboration session."}</p>
					<div className="sh-ended-actions">
						<button type="button" className="sh-btn sh-btn-primary" onClick={onRejoin}>
							<RotateCcw size={14} aria-hidden="true" /> Rejoin
						</button>
						<button type="button" className="sh-btn" onClick={onNewLink}>
							<Link2 size={14} aria-hidden="true" /> New link
						</button>
					</div>
				</div>
			</section>
		);
	}
	return null;
}
