import { X } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentDrawer } from "./components/agents/AgentDrawer";
import { AgentsPanel } from "./components/agents/AgentsPanel";
import { SessionsLayout } from "./components/sessions/SessionsLayout";
import { Banners } from "./components/shell/Banners";
import { Composer } from "./components/shell/Composer";
import { ConnectScreen } from "./components/shell/ConnectScreen";
import { HeaderBar } from "./components/shell/HeaderBar";
import { SettingsModal } from "./components/shell/SettingsModal";
import { Toasts } from "./components/shell/Toasts";
import { Transcript } from "./components/transcript/Transcript";
import { GuestClient, type GuestSnapshot, type Notice } from "./lib/client";
import { ControlClient, type ControlSessionInfo } from "./lib/control-client";
import { ControlSessionFlow } from "./lib/control-session-flow";
import { fmtPercent, fmtTokens } from "./lib/format";
import { parseCollabLink } from "./lib/link";
import { useGuestSnapshot } from "./lib/use-guest";
import type { ToolRenderHost } from "./tool-render";
import "./components/shell/shell.css";

const NAME_KEY = "omp.collab.name";
const CONTROL_KEY = "omp.collab.control";
const MAX_CONTROL_NOTICES = 50;

/**
 * `control`: joined a core-mode control room (session sidebar). The control
 * client lives in state so the sidebar keeps receiving `ctrl-sessions`
 * broadcasts while a session is open. `sessionId` is the authoritative id
 * supplied by that session's directed `ctrl-session` reply.
 * `session`: a plain session deep link, no control room.
 */
type AppState =
	| { kind: "control"; client: ControlClient; session: GuestClient | null; sessionId: string | null }
	| { kind: "session"; client: GuestClient }
	| null;

interface Creds {
	link: string;
	name: string;
}

function storedName(): string {
	try {
		return localStorage.getItem(NAME_KEY) ?? "guest";
	} catch {
		return "guest";
	}
}

function storedControlLink(): string | null {
	try {
		return localStorage.getItem(CONTROL_KEY);
	} catch {
		return null;
	}
}

/** Deep link = everything after the FIRST `#` (legacy links carry a second `#` inside the fragment). */
function hashLink(): string | null {
	const href = window.location.href;
	const i = href.indexOf("#");
	if (i < 0 || i + 1 >= href.length) return null;
	return href.slice(i + 1);
}

function contextLabel(snapshot: GuestSnapshot): string | null {
	const usage = snapshot.state?.contextUsage;
	if (!usage) return null;
	if (usage.percent != null) return fmtPercent(usage.percent);
	if (usage.tokens != null) return `${fmtTokens(usage.tokens)} tokens`;
	return null;
}

export function App(): ReactNode {
	const [appState, setAppState] = useState<AppState>(null);
	const [controlPending, setControlPending] = useState(false);
	const [connectError, setConnectError] = useState<string | null>(null);
	const [controlNotices, setControlNotices] = useState<Notice[]>([]);
	const credsRef = useRef<Creds | null>(null);
	const [controlFlow] = useState(() => new ControlSessionFlow());
	const noticeSeqRef = useRef(0);

	const pushNotice = useCallback((level: Notice["level"], message: string): void => {
		setControlNotices(prev => {
			const next = [...prev, { id: ++noticeSeqRef.current, level, message, at: Date.now() }];
			if (next.length > MAX_CONTROL_NOTICES) next.splice(0, next.length - MAX_CONTROL_NOTICES);
			return next;
		});
	}, []);

	/** Open a session room from the control sidebar; the control client stays connected. */
	const openSessionLink = useCallback(
		(ctrl: ControlClient, link: string, sessionId: string): void => {
			let next: GuestClient;
			try {
				next = new GuestClient(link, storedName());
			} catch (err) {
				pushNotice("error", err instanceof Error ? err.message : String(err));
				return;
			}
			next.connect();
			if (controlFlow.activeClient !== ctrl) {
				next.close();
				return;
			}
			credsRef.current = { link, name: storedName() };
			window.location.hash = link;
			setAppState(prev => {
				if (prev?.kind === "session") prev.client.close();
				if (prev?.kind === "control") prev.session?.close();
				return { kind: "control", client: ctrl, session: next, sessionId };
			});
		},
		[controlFlow, pushNotice],
	);

	/** Directed `ctrl-session` reply: honored only when it matches a pending op. */
	const handleCtrlSession = useCallback(
		(source: ControlClient, info: ControlSessionInfo): void => {
			const accepted = controlFlow.accept(source, info);
			if (!accepted) return;
			setControlPending(false);
			openSessionLink(source, accepted.link, accepted.id);
		},
		[controlFlow, openSessionLink],
	);

	const connect = useCallback(
		(link: string, name: string): void => {
			const parsed = parseCollabLink(link);
			if ("error" in parsed) {
				setConnectError(parsed.error);
				return;
			}
			credsRef.current = { link, name };
			setConnectError(null);

			if (parsed.roomId.startsWith("ctrl-")) {
				let ctrl: ControlClient;
				try {
					ctrl = new ControlClient(link, name);
				} catch (err) {
					setConnectError(err instanceof Error ? err.message : String(err));
					return;
				}
				ctrl.onError = message => {
					// A failed op ends the pending create/resume round trip.
					if (controlFlow.fail(ctrl)) setControlPending(false);
					pushNotice("error", message);
				};
				ctrl.onSession = info => handleCtrlSession(ctrl, info);
				ctrl.connect();
				try {
					localStorage.setItem(NAME_KEY, name);
					localStorage.setItem(CONTROL_KEY, link);
				} catch {
					// storage unavailable (private mode) — non-fatal
				}
				window.location.hash = link;
				controlFlow.activate(ctrl)?.close();
				setControlPending(false);
				setAppState(prev => {
					if (prev?.kind === "session") prev.client.close();
					if (prev?.kind === "control") prev.session?.close();
					return { kind: "control", client: ctrl, session: null, sessionId: null };
				});
				return;
			}

			let next: GuestClient;
			try {
				next = new GuestClient(link, name);
			} catch (err) {
				setConnectError(err instanceof Error ? err.message : String(err));
				return;
			}
			next.connect();
			try {
				localStorage.setItem(NAME_KEY, name);
			} catch {
				// storage unavailable (private mode) — non-fatal
			}
			window.location.hash = link;
			// A plain session deep link replaces any active control room.
			controlFlow.deactivate()?.close();
			setControlPending(false);
			setAppState(prev => {
				if (prev?.kind === "session") prev.client.close();
				if (prev?.kind === "control") prev.session?.close();
				return { kind: "session", client: next };
			});
		},
		[controlFlow, handleCtrlSession, pushNotice],
	);

	const leave = useCallback((): void => {
		const control = controlFlow.deactivate();
		setControlPending(false);
		setAppState(prev => {
			prev?.client.close();
			if (prev?.kind === "control") prev.session?.close();
			return null;
		});
		control?.close();
		history.replaceState(null, "", window.location.pathname + window.location.search);
	}, [controlFlow]);

	/** Control mode: return from a session view to the sidebar. */
	const backToSessions = useCallback((): void => {
		controlFlow.cancelPending();
		setControlPending(false);
		const ctrl = controlFlow.activeClient;
		if (!ctrl) {
			leave();
			return;
		}
		ctrl.sendList();
		setAppState(prev => {
			if (prev?.kind === "session") prev.client.close();
			if (prev?.kind === "control") prev.session?.close();
			return { kind: "control", client: ctrl, session: null, sessionId: null };
		});
	}, [controlFlow, leave]);

	const rejoin = useCallback((): void => {
		const creds = credsRef.current;
		if (creds) connect(creds.link, creds.name);
	}, [connect]);

	// Visual Viewport: adjust app height to fit screen space when mobile keyboard opens.
	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;

		const updateHeight = () => {
			document.documentElement.style.setProperty("--viewport-height", `${vv.height}px`);
			window.scrollTo(0, 0);
		};

		updateHeight();
		vv.addEventListener("resize", updateHeight);
		vv.addEventListener("scroll", updateHeight);

		return () => {
			vv.removeEventListener("resize", updateHeight);
			vv.removeEventListener("scroll", updateHeight);
		};
	}, []);

	// Deep link: a page load with a hash auto-connects.
	useEffect(() => {
		const link = hashLink();
		if (link) connect(link, storedName());
	}, [connect]);

	useEffect(() => {
		if (!appState) document.title = "omp collab";
		else if (appState.kind === "control" && !appState.session) document.title = "sessions · omp collab";
	}, [appState]);

	const startCreate = useCallback(
		(client: ControlClient): void => {
			if (!controlFlow.startCreate(client)) return;
			setControlPending(true);
		},
		[controlFlow],
	);

	const startResume = useCallback(
		(client: ControlClient, id: string): void => {
			if (!controlFlow.startResume(client, id)) return;
			setControlPending(true);
		},
		[controlFlow],
	);

	const startDrop = useCallback((client: ControlClient, id: string): void => {
		// The sidebar is authoritative: the entry disappears on the next
		// ctrl-sessions broadcast; a ctrl-error surfaces as a toast.
		client.sendDrop(id);
	}, []);

	if (!appState) {
		return (
			<>
				<ConnectScreen
					defaultName={storedName()}
					error={connectError}
					savedControlLink={storedControlLink()}
					onConnect={connect}
				/>
				<Toasts notices={controlNotices} />
			</>
		);
	}

	if (appState.kind === "session") {
		return (
			<>
				<Session client={appState.client} onLeave={leave} onRejoin={rejoin} />
				<Toasts notices={controlNotices} />
			</>
		);
	}

	return (
		<>
			<SessionsLayout
				client={appState.client}
				activeSessionId={appState.sessionId}
				pending={controlPending}
				content={
					appState.session ? (
						<Session
							client={appState.session}
							onLeave={backToSessions}
							onRejoin={backToSessions}
							onBack={backToSessions}
						/>
					) : null
				}
				onOpenSession={id => startResume(appState.client, id)}
				onNewSession={() => startCreate(appState.client)}
				onDropSession={id => startDrop(appState.client, id)}
				onLeave={leave}
			/>
			<Toasts notices={controlNotices} />
		</>
	);
}

interface SessionProps {
	client: GuestClient;
	onLeave(): void;
	onRejoin(): void;
	/** Control mode: back entry shown in the header; also the post-end auto-return. */
	onBack?: () => void;
}

function Session({ client, onLeave, onRejoin, onBack }: SessionProps): ReactNode {
	const snap = useGuestSnapshot(client);
	const [railOpen, setRailOpen] = useState(false);
	const [railOverlay, setRailOverlay] = useState(() => window.matchMedia("(max-width: 1024px)").matches);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const autoOpenedRef = useRef(false);
	const agentsButtonRef = useRef<HTMLButtonElement | null>(null);
	const railRef = useRef<HTMLElement | null>(null);
	const closeRail = useCallback((): void => {
		setRailOpen(false);
		requestAnimationFrame(() => agentsButtonRef.current?.focus());
	}, []);
	const toggleRail = useCallback((): void => {
		if (railOpen) closeRail();
		else {
			setSettingsOpen(false);
			setRailOpen(true);
		}
	}, [closeRail, railOpen]);

	const subCount = useMemo(() => snap.agents.filter(a => a.kind === "sub").length, [snap.agents]);

	useEffect(() => {
		const media = window.matchMedia("(max-width: 1024px)");
		const update = (): void => setRailOverlay(media.matches);
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);

	// Task-card agent chips drill into the same drawer the rail uses.
	const agentIds = useMemo(() => new Set(snap.agents.map(a => a.id)), [snap.agents]);
	const toolHost = useMemo<ToolRenderHost>(
		() => ({
			hasAgent: id => agentIds.has(id),
			openAgent: id => {
				if (agentIds.has(id)) setSelectedId(id);
			},
		}),
		[agentIds],
	);

	// Auto-open the rail the first time a subagent appears.
	useEffect(() => {
		if (subCount > 0 && !railOverlay && !autoOpenedRef.current) {
			autoOpenedRef.current = true;
			setRailOpen(true);
		}
	}, [railOverlay, subCount]);

	useEffect(() => {
		if (!railOpen) return;
		const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			closeRail();
		};
		document.addEventListener("keydown", closeOnEscape);
		return () => document.removeEventListener("keydown", closeOnEscape);
	}, [closeRail, railOpen]);

	useEffect(() => {
		if (!railOpen || !railOverlay) return;
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		const frame = requestAnimationFrame(() => {
			const rail = railRef.current;
			(rail?.querySelector<HTMLElement>("button:not(:disabled)") ?? rail)?.focus();
		});
		return () => {
			cancelAnimationFrame(frame);
			document.body.style.overflow = previousOverflow;
		};
	}, [railOpen, railOverlay]);

	const trapRailFocus = (event: KeyboardEvent<HTMLElement>): void => {
		if (!railOverlay || event.key !== "Tab") return;
		const focusable = railRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), [href]");
		if (!focusable || focusable.length === 0) {
			event.preventDefault();
			railRef.current?.focus();
			return;
		}
		const first = focusable.item(0);
		const last = focusable.item(focusable.length - 1);
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	};

	const title = snap.header?.title ?? snap.state?.sessionName ?? "session";
	useEffect(() => {
		document.title = `${title} · omp collab`;
	}, [title]);

	const drawerAgent = selectedId != null ? snap.agents.find(a => a.id === selectedId) : undefined;

	return (
		<div className="sh-app">
			<div inert={railOpen && railOverlay ? true : undefined}>
				<HeaderBar
					snapshot={snap}
					subCount={subCount}
					railOpen={railOpen}
					agentsButtonRef={agentsButtonRef}
					onToggleRail={toggleRail}
					onLeave={onLeave}
					onBack={onBack}
					settingsOpen={settingsOpen}
					onToggleSettings={() => {
						if (!settingsOpen) setRailOpen(false);
						setSettingsOpen(open => !open);
					}}
				/>
			</div>
			{settingsOpen && (
				<SettingsModal
					onClose={() => setSettingsOpen(false)}
					project={snap.state?.cwd}
					session={title}
					readOnly={snap.readOnly}
					connection={snap.phase}
					model={snap.state?.model?.name}
					context={contextLabel(snap)}
				/>
			)}
			<main className="sh-main">
				{railOpen && railOverlay && <div className="sh-rail-backdrop" aria-hidden="true" onClick={closeRail} />}
				<section
					className="sh-content"
					data-rail={railOpen ? "true" : "false"}
					inert={railOpen && railOverlay ? true : undefined}
				>
					<div className="sh-transcript">
						<Transcript
							entries={snap.entries}
							stream={snap.stream}
							streamDone={snap.streamDone}
							activeTools={snap.activeTools}
							working={snap.working}
							host={toolHost}
						/>
					</div>
				</section>
				{railOpen && (
					<aside
						ref={railRef}
						className="sh-rail"
						role={railOverlay ? "dialog" : undefined}
						aria-modal={railOverlay ? "true" : undefined}
						aria-label="Agents"
						tabIndex={railOverlay ? -1 : undefined}
						onKeyDown={trapRailFocus}
					>
						<div className="sh-rail-header">
							<span className="sh-rail-title">Agents</span>
							<button type="button" className="sh-rail-close" onClick={closeRail} aria-label="Close agents">
								<X size={14} />
							</button>
						</div>
						<AgentsPanel
							agents={snap.agents}
							progress={snap.progress}
							lifecycle={snap.lifecycle}
							selectedId={selectedId}
							onSelect={setSelectedId}
						/>
					</aside>
				)}
			</main>
			{snap.phase === "ended" ? (
				<Banners phase={snap.phase} endedReason={snap.endedReason} onRejoin={onRejoin} onNewLink={onLeave} />
			) : (
				<Composer client={client} snapshot={snap} />
			)}
			{drawerAgent && (
				<>
					<div className="ag-drawer-backdrop" onClick={() => setSelectedId(null)} />
					<AgentDrawer
						agent={drawerAgent}
						progress={snap.progress.get(drawerAgent.id)}
						client={client}
						readOnly={snap.readOnly}
						host={toolHost}
						onClose={() => setSelectedId(null)}
					/>
				</>
			)}
			{snap.phase !== "ended" && (
				<Banners phase={snap.phase} endedReason={snap.endedReason} onRejoin={onRejoin} onNewLink={onLeave} />
			)}
			<Toasts notices={snap.notices} />
		</div>
	);
}
