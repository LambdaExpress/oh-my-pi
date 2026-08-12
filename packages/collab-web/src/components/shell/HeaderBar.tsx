import { ArrowLeft, LogOut, PanelRight, Settings } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import type { GuestSnapshot } from "../../lib/client";
import { fmtPercent, shortenPath } from "../../lib/format";

export interface HeaderBarProps {
	snapshot: GuestSnapshot;
	subCount: number;
	railOpen: boolean;
	agentsButtonRef?: RefObject<HTMLButtonElement | null>;
	onToggleRail(): void;
	onLeave(): void;
	settingsOpen: boolean;
	onToggleSettings(): void;
	/** Optional back entry on the header's left (control-mode session view). */
	onBack?: () => void;
}

export function HeaderBar({
	snapshot,
	subCount,
	railOpen,
	agentsButtonRef,
	onToggleRail,
	onLeave,
	settingsOpen,
	onToggleSettings,
	onBack,
}: HeaderBarProps): ReactNode {
	const { header, state, phase, readOnly } = snapshot;
	const title = header?.title ?? state?.sessionName ?? "session";
	const usage = state?.contextUsage;
	let pct: number | null = null;
	if (usage) {
		pct =
			usage.percent ??
			(usage.tokens != null && usage.contextWindow !== null && usage.contextWindow > 0
				? (usage.tokens / usage.contextWindow) * 100
				: null);
	}

	return (
		<header className="sh-header-bar">
			<div className="sh-header-bar-left">
				{onBack && (
					<button
						type="button"
						className="sh-header-bar-action sh-header-back"
						onClick={onBack}
						title="back to session list"
						aria-label="back to session list"
					>
						<ArrowLeft size={14} />
					</button>
				)}
				<span className="sh-title" title={title}>
					{title}
				</span>
				{state?.cwd && (
					<span className="sh-cwd" title={state.cwd}>
						{shortenPath(state.cwd)}
					</span>
				)}
			</div>
			<div className="sh-header-bar-right">
				{readOnly && (
					<span className="sh-chip" title="you joined with a read-only link — watching only">
						read-only
					</span>
				)}
				{state?.thinkingLevel && <span className="sh-chip sh-chip-meta">{state.thinkingLevel}</span>}
				{pct != null && (
					<span
						className={pct > 80 ? "sh-gauge sh-gauge-warn" : "sh-gauge"}
						title={`context · ${fmtPercent(pct)}`}
					>
						<span className="sh-gauge-track">
							<span className="sh-gauge-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
						</span>
						<span className="sh-gauge-pct">{fmtPercent(pct)}</span>
					</span>
				)}
				{state && state.participants.length > 0 && (
					<span className="sh-avatars">
						{state.participants.map((p, i) => (
							<span
								key={`${p.name}:${i}`}
								className={p.role === "host" ? "sh-avatar sh-avatar-host" : "sh-avatar"}
								title={`${p.name} · ${p.role}${p.readOnly ? " · view-only" : ""}`}
							>
								{(p.name[0] ?? "?").toUpperCase()}
							</span>
						))}
					</span>
				)}
				<span className={`sh-dot sh-dot-${phase}`} title={phase} />
				<button
					type="button"
					className={settingsOpen ? "sh-header-bar-action sh-header-bar-action-on" : "sh-header-bar-action"}
					onClick={onToggleSettings}
					title="settings"
					aria-label="open settings"
				>
					<Settings size={14} />
				</button>
				<button
					ref={agentsButtonRef}
					type="button"
					className={railOpen ? "sh-header-bar-action sh-header-bar-action-on" : "sh-header-bar-action"}
					onClick={onToggleRail}
					title={railOpen ? "hide agents" : "show agents"}
					aria-label={railOpen ? "hide agents" : "show agents"}
				>
					<PanelRight size={14} />
					{subCount > 0 && <span className="sh-badge">{subCount}</span>}
				</button>
				<button
					type="button"
					className="sh-header-bar-action"
					onClick={onLeave}
					title="leave session"
					aria-label="leave session"
				>
					<LogOut size={14} />
				</button>
			</div>
		</header>
	);
}
