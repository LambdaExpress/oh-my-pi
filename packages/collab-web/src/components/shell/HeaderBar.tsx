import { ArrowLeft, LogOut, PanelRight, Settings } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { GuestSnapshot } from "../../lib/client";
import { fmtPercent, shortenPath } from "../../lib/format";

export interface HeaderBarProps {
	snapshot: GuestSnapshot;
	subCount: number;
	railOpen: boolean;
	onToggleRail(): void;
	onLeave(): void;
	/** Open the model picker dropdown (requests the model list when not yet loaded). */
	onModelList(): void;
	/** Switch the session model. */
	onModelChange(provider: string, id: string): void;
	settingsOpen: boolean;
	onToggleSettings(): void;
	/** Optional back entry on the header's left (control-mode session view). */
	onBack?: () => void;
}

/**
 * Model picker dropdown. Requests the model list through `onModelList` on
 * first open (the host answers with a targeted `model-list` frame); the
 * current model is highlighted from the session state broadcast.
 */
function ModelPicker({
	snapshot,
	onModelList,
	onModelChange,
}: {
	snapshot: GuestSnapshot;
	onModelList(): void;
	onModelChange(provider: string, id: string): void;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const model = snapshot.state?.model;
	const models = snapshot.models;
	const currentId = model?.id;
	const currentProvider = model?.provider;
	return (
		<div className="sh-model-picker">
			<button
				type="button"
				className="sh-btn sh-model-picker-trigger"
				onClick={() => {
					if (!open && models === null) onModelList();
					setOpen(open => !open);
				}}
				title="switch model"
			>
				<span className="sh-model-picker-name">{model?.name ?? "model"}</span>
			</button>
			{open && (
				<div className="sh-model-picker-menu">
					{models === null ? (
						<div className="sh-model-picker-empty">loading models…</div>
					) : models.length === 0 ? (
						<div className="sh-model-picker-empty">no models available</div>
					) : (
						models.map(m => (
							<button
								key={`${m.provider}/${m.id}`}
								type="button"
								className={
									m.id === currentId && m.provider === currentProvider
										? "sh-model-picker-item sh-model-picker-on"
										: "sh-model-picker-item"
								}
								onClick={() => {
									setOpen(false);
									onModelChange(m.provider, m.id);
								}}
							>
								<span className="sh-model-picker-item-name">{m.name}</span>
								<span className="sh-model-picker-item-provider">{m.provider}</span>
							</button>
						))
					)}
				</div>
			)}
		</div>
	);
}

export function HeaderBar({
	snapshot,
	subCount,
	railOpen,
	onToggleRail,
	onLeave,
	onModelList,
	onModelChange,
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
		<header className="sh-header">
			<div className="sh-header-left">
				{onBack && (
					<button
						type="button"
						className="sh-btn sh-btn-icon sh-header-back"
						onClick={onBack}
						title="back to session list"
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
			<div className="sh-header-right">
				{readOnly && (
					<span className="sh-chip" title="you joined with a read-only link — watching only">
						read-only
					</span>
				)}
				<ModelPicker snapshot={snapshot} onModelList={onModelList} onModelChange={onModelChange} />
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
					className={settingsOpen ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
					onClick={onToggleSettings}
					title="settings"
					aria-label="open settings"
				>
					<Settings size={14} />
				</button>
				<button
					type="button"
					className={railOpen ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
					onClick={onToggleRail}
					title={railOpen ? "hide agents" : "show agents"}
				>
					<PanelRight size={14} />
					{subCount > 0 && <span className="sh-badge">{subCount}</span>}
				</button>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onLeave} title="leave session">
					<LogOut size={14} />
				</button>
			</div>
		</header>
	);
}
