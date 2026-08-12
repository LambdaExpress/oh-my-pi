import type { SessionSummary } from "@oh-my-pi/pi-wire";
import { ChevronRight, FolderOpen, LogOut, Plus, Settings, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { ControlSnapshot } from "../../lib/control-client";
import { type DesktopProject, desktopBridge } from "../../lib/desktop-bridge";
import { relTime } from "../../lib/format";

export interface SessionsPanelProps {
	snapshot: ControlSnapshot;
	activeSessionId?: string | null;
	pending?: boolean;
	onOpenSettings(): void;
	onOpenSession(id: string): void;
	onNewSession(): void;
	onDropSession(id: string): void;
	onLeave(): void;
}

interface ProjectGroup {
	path: string;
	name: string;
	sessions: readonly SessionSummary[];
	modifiedMs: number;
	desktopProject: DesktopProject | undefined;
}

/** Session title falls back to the basename of the working directory. */
function sessionTitle(s: SessionSummary): string {
	if (s.title && s.title.length > 0) return s.title;
	const base = s.cwd
		.split(/[\\/]+/)
		.filter(Boolean)
		.pop();
	return base && base.length > 0 ? base : s.cwd;
}

function sessionModifiedMs(s: SessionSummary): number {
	const t = Date.parse(s.modifiedAt);
	return Number.isFinite(t) ? t : 0;
}

/** Normalizes grouping keys without changing the path displayed to the user. */
function normalizeProjectPath(path: string): string {
	const slashPath = path.trim().replaceAll("\\", "/");
	const normalized = slashPath.startsWith("//")
		? `//${slashPath.slice(2).replace(/\/{2,}/g, "/")}`
		: slashPath.replace(/\/{2,}/g, "/");
	if (normalized === "/") return normalized;
	return normalized.replace(/\/+$/, "") || path.trim();
}

function comparableProjectPath(path: string): string {
	const normalized = normalizeProjectPath(path);
	return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLocaleLowerCase() : normalized;
}

function projectName(path: string): string {
	const normalized = normalizeProjectPath(path);
	return normalized.split("/").filter(Boolean).pop() || normalized || "Workspace";
}

export function groupSessionsByProject(
	sessions: readonly SessionSummary[],
	desktopProjects: readonly DesktopProject[] = [],
): readonly ProjectGroup[] {
	const groups = new Map<string, { path: string; sessions: SessionSummary[] }>();
	for (const session of sessions) {
		const path = normalizeProjectPath(session.cwd);
		const key = comparableProjectPath(path);
		const group = groups.get(key);
		if (group) group.sessions.push(session);
		else groups.set(key, { path, sessions: [session] });
	}

	const currentProject = desktopProjects.find(project => project.current);
	if (currentProject && groups.size > 0) {
		const currentKey = comparableProjectPath(currentProject.path);
		const sessionsInCurrentCore = Array.from(groups.values()).flatMap(group => group.sessions);
		groups.clear();
		groups.set(currentKey, { path: currentProject.path, sessions: sessionsInCurrentCore });
	}
	for (const project of desktopProjects) {
		const path = normalizeProjectPath(project.path);
		const key = comparableProjectPath(path);
		if (!groups.has(key)) {
			groups.set(key, { path: project.path, sessions: [] });
		}
	}

	return Array.from(groups.values())
		.map(group => {
			const sortedSessions = [...group.sessions].sort((a, b) => sessionModifiedMs(b) - sessionModifiedMs(a));
			const desktopProject = desktopProjects.find(
				project => comparableProjectPath(project.path) === comparableProjectPath(group.path),
			);
			const modifiedMs = sortedSessions[0] ? sessionModifiedMs(sortedSessions[0]) : 0;
			return {
				path: desktopProject?.path ?? group.path,
				name: desktopProject?.name || projectName(group.path),
				sessions: sortedSessions,
				modifiedMs,
				desktopProject,
			};
		})
		.sort(
			(a, b) =>
				Number(b.desktopProject?.current) - Number(a.desktopProject?.current) ||
				b.modifiedMs - a.modifiedMs ||
				a.name.localeCompare(b.name),
		);
}

function snapshotMessage(snapshot: ControlSnapshot): string {
	if (snapshot.phase === "ended")
		return snapshot.endedReason ? `Connection ended: ${snapshot.endedReason}` : "Connection ended.";
	if (snapshot.phase === "reconnecting") return "Reconnecting to sessions…";
	if (snapshot.phase === "connecting" || snapshot.phase === "waiting") return "Connecting to sessions…";
	return snapshot.readOnly ? "No sessions are available to view." : "No sessions yet. Start one above.";
}

export function SessionsPanel({
	snapshot,
	activeSessionId = null,
	pending = false,
	onOpenSettings,
	onOpenSession,
	onNewSession,
	onDropSession,
	onLeave,
}: SessionsPanelProps): ReactNode {
	const { sessions, readOnly, phase } = snapshot;
	const [desktopProjects, setDesktopProjects] = useState<readonly DesktopProject[]>([]);
	const [desktopAvailable, setDesktopAvailable] = useState(false);
	const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(() => new Set());
	const [desktopAction, setDesktopAction] = useState<string | null>(null);
	const [desktopError, setDesktopError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		void desktopBridge
			.listProjects()
			.then(projects => {
				if (active) {
					const available = desktopBridge.available;
					setDesktopAvailable(available);
					setDesktopProjects(available ? projects : []);
				}
			})
			.catch(() => {
				if (active) {
					setDesktopAvailable(false);
					setDesktopProjects([]);
				}
			});
		return () => {
			active = false;
		};
	}, []);

	const groups = useMemo(
		() => groupSessionsByProject(sessions, desktopAvailable ? desktopProjects : []),
		[desktopAvailable, desktopProjects, sessions],
	);
	const toggleProject = (path: string): void => {
		const key = comparableProjectPath(path);
		setCollapsedProjects(current => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};
	const runDesktopAction = async (key: string, action: () => Promise<void>): Promise<void> => {
		setDesktopAction(key);
		setDesktopError(null);
		try {
			await action();
		} catch {
			if (!desktopBridge.available) {
				setDesktopAvailable(false);
				setDesktopProjects([]);
			}
			setDesktopError("The desktop project action could not be completed.");
		} finally {
			setDesktopAction(null);
		}
	};

	return (
		<nav className="sh-sessions" aria-label="Projects and sessions">
			<div className="sh-sessions-brand">
				<span className="sh-sessions-mark" aria-hidden="true" />
				<div className="sh-sessions-brand-copy">
					<span className="sh-sessions-brand-name">Oh My Pi</span>
					<span className="sh-sessions-brand-status">
						<span className={`sh-sessions-dot sh-sessions-dot-${phase}`} aria-hidden="true" />
						{phase}
					</span>
				</div>
			</div>

			{!readOnly && (
				<button type="button" className="sh-sessions-action" onClick={onNewSession} disabled={pending}>
					<Plus size={16} aria-hidden="true" />
					<span>{pending ? "Starting session…" : "New session"}</span>
				</button>
			)}

			<div className="sh-sessions-projects">
				<div className="sh-sessions-section-title">Projects</div>
				{desktopAvailable && (
					<button
						type="button"
						className="sh-sessions-open-project"
						disabled={desktopAction !== null}
						onClick={() => void runDesktopAction("open", () => desktopBridge.openProject())}
					>
						<FolderOpen size={15} aria-hidden="true" />
						<span>{desktopAction === "open" ? "Opening project…" : "Open project"}</span>
					</button>
				)}
				{desktopError && (
					<p className="sh-sessions-project-error" role="status">
						{desktopError}
					</p>
				)}

				{groups.map(group => {
					const key = comparableProjectPath(group.path);
					const collapsed = collapsedProjects.has(key);
					const sessionsId = `sh-project-${encodeURIComponent(key).replaceAll("%", "-")}`;
					const switchPath = group.desktopProject?.current === false ? group.desktopProject.path : null;
					return (
						<section className="sh-project" key={key}>
							<div className="sh-project-row" data-current={group.desktopProject?.current ? "true" : undefined}>
								<button
									type="button"
									className="sh-project-disclosure"
									aria-expanded={!collapsed}
									aria-controls={sessionsId}
									onClick={() => toggleProject(group.path)}
									title={collapsed ? `Expand ${group.name}` : `Collapse ${group.name}`}
								>
									<ChevronRight size={15} aria-hidden="true" />
								</button>
								{desktopAvailable && switchPath !== null ? (
									<button
										type="button"
										className="sh-project-label sh-project-switch"
										title={`Switch to ${group.path}`}
										disabled={desktopAction !== null}
										onClick={() =>
											void runDesktopAction(switchPath, () => desktopBridge.switchProject(switchPath))
										}
									>
										<span className="sh-project-name">
											{desktopAction === switchPath ? `Switching to ${group.name}…` : group.name}
										</span>
										<span className="sh-project-path">{group.path}</span>
									</button>
								) : (
									<div className="sh-project-label" title={group.path}>
										<span className="sh-project-name">{group.name}</span>
										<span className="sh-project-path">{group.path}</span>
									</div>
								)}
							</div>

							<div className="sh-sessions-list" id={sessionsId} hidden={collapsed}>
								{group.sessions.map(session => (
									<div className="sh-sessions-item" key={session.id}>
										{readOnly ? (
											<div className="sh-sessions-item-open" title={sessionTitle(session)}>
												<span className="sh-sessions-item-copy">
													<span className="sh-sessions-item-title">{sessionTitle(session)}</span>
													<span className="sh-sessions-item-meta">
														{relTime(sessionModifiedMs(session))}
													</span>
												</span>
											</div>
										) : (
											<button
												type="button"
												className="sh-sessions-item-open"
												aria-current={session.id === activeSessionId ? "page" : undefined}
												title={`Open ${sessionTitle(session)}`}
												disabled={pending}
												onClick={() => onOpenSession(session.id)}
											>
												<span className="sh-sessions-item-copy">
													<span className="sh-sessions-item-title">{sessionTitle(session)}</span>
													<span className="sh-sessions-item-meta">
														{relTime(sessionModifiedMs(session))}
													</span>
												</span>
												<span
													className={`sh-sessions-state${session.streaming ? " sh-sessions-state-streaming" : session.status === "error" ? " sh-sessions-state-error" : ""}`}
													title={session.streaming ? "Streaming" : session.status}
													aria-label={session.streaming ? "Streaming" : session.status}
												/>
											</button>
										)}
										{!readOnly && (
											<button
												type="button"
												className="sh-sessions-drop"
												title={`Drop ${sessionTitle(session)}`}
												onClick={() => onDropSession(session.id)}
											>
												<Trash2 size={14} aria-hidden="true" />
												<span className="sh-visually-hidden">Drop {sessionTitle(session)}</span>
											</button>
										)}
									</div>
								))}
								{group.sessions.length === 0 && (
									<p className="sh-sessions-empty-hint">No sessions in this project.</p>
								)}
							</div>
						</section>
					);
				})}

				{groups.length === 0 && <p className="sh-sessions-empty-hint">{snapshotMessage(snapshot)}</p>}
			</div>

			<div className="sh-sessions-foot">
				{readOnly && <span className="sh-sessions-readonly">Read-only · watching</span>}
				<button type="button" className="sh-sessions-leave" onClick={onOpenSettings}>
					<Settings size={15} aria-hidden="true" />
					<span>Settings</span>
				</button>
				<button type="button" className="sh-sessions-leave" onClick={onLeave}>
					<LogOut size={15} aria-hidden="true" />
					<span>Leave control room</span>
				</button>
			</div>
		</nav>
	);
}
