import type { ReactNode } from "react";
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
import { GuestClient, type Notice } from "./lib/client";
import { ControlClient, type ControlSessionInfo } from "./lib/control-client";
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
 * broadcasts while a session is open (`session` field).
 * `session`: a plain session deep link, no control room.
 */
type AppState =
	| { kind: "control"; client: ControlClient; session: GuestClient | null }
	| { kind: "session"; client: GuestClient }
	| null;

interface Creds {
	link: string;
	name: string;
}

/** Pending create/resume round trip awaiting a directed `ctrl-session` reply. */
interface PendingSessionOp {
	op: "created" | "resumed";
	/** null for create: the host assigns the id. */
	id: string | null;
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

export function App(): ReactNode {
	const [appState, setAppState] = useState<AppState>(null);
	const [connectError, setConnectError] = useState<string | null>(null);
	const [controlNotices, setControlNotices] = useState<Notice[]>([]);
	const credsRef = useRef<Creds | null>(null);
	/** The control-room client while one is active; survives session view switches. */
	const controlRef = useRef<ControlClient | null>(null);
	const pendingRef = useRef<PendingSessionOp | null>(null);
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
		(link: string): void => {
			let next: GuestClient;
			try {
				next = new GuestClient(link, storedName());
			} catch (err) {
				pushNotice("error", err instanceof Error ? err.message : String(err));
				return;
			}
			next.connect();
			credsRef.current = { link, name: storedName() };
			window.location.hash = link;
			const ctrl = controlRef.current;
			if (!ctrl) {
				// No control room (defensive — sidebar flows always have one):
				// fall back to a plain session.
				setAppState(prev => {
					if (prev?.kind === "session") prev.client.close();
					if (prev?.kind === "control") prev.session?.close();
					return { kind: "session", client: next };
				});
				return;
			}
			setAppState(prev => {
				if (prev?.kind === "session") prev.client.close();
				if (prev?.kind === "control") prev.session?.close();
				return { kind: "control", client: ctrl, session: next };
			});
		},
		[pushNotice],
	);

	/** Directed `ctrl-session` reply: honored only when it matches a pending op. */
	const handleCtrlSession = useCallback(
		(info: ControlSessionInfo): void => {
			const pending = pendingRef.current;
			if (!pending) return;
			if (pending.op !== info.op) return;
			if (pending.op === "resumed" && pending.id !== info.id) return;
			pendingRef.current = null;
			openSessionLink(info.link);
		},
		[openSessionLink],
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
					pendingRef.current = null;
					pushNotice("error", message);
				};
				ctrl.onSession = handleCtrlSession;
				ctrl.connect();
				try {
					localStorage.setItem(NAME_KEY, name);
					localStorage.setItem(CONTROL_KEY, link);
				} catch {
					// storage unavailable (private mode) — non-fatal
				}
				window.location.hash = link;
				controlRef.current?.close();
				controlRef.current = ctrl;
				setAppState(prev => {
					if (prev?.kind === "session") prev.client.close();
					if (prev?.kind === "control") prev.session?.close();
					return { kind: "control", client: ctrl, session: null };
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
			controlRef.current?.close();
			controlRef.current = null;
			setAppState(prev => {
				if (prev?.kind === "session") prev.client.close();
				if (prev?.kind === "control") prev.session?.close();
				return { kind: "session", client: next };
			});
		},
		[handleCtrlSession, pushNotice],
	);

	const leave = useCallback((): void => {
		setAppState(prev => {
			prev?.client.close();
			if (prev?.kind === "control") prev.session?.close();
			return null;
		});
		controlRef.current?.close();
		controlRef.current = null;
		history.replaceState(null, "", window.location.pathname + window.location.search);
	}, []);

	/** Control mode: return from a session view to the sidebar. */
	const backToSessions = useCallback((): void => {
		const ctrl = controlRef.current;
		if (!ctrl) {
			leave();
			return;
		}
		ctrl.sendList();
		setAppState(prev => {
			if (prev?.kind === "session") prev.client.close();
			if (prev?.kind === "control") prev.session?.close();
			return { kind: "control", client: ctrl, session: null };
		});
	}, [leave]);

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

	const startCreate = useCallback((client: ControlClient): void => {
		pendingRef.current = { op: "created", id: null };
		client.sendCreate();
	}, []);

	const startResume = useCallback((client: ControlClient, id: string): void => {
		pendingRef.current = { op: "resumed", id };
		client.sendResume(id);
	}, []);

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
				content={
					appState.session ? (
						<Session
							client={appState.session}
							onLeave={backToSessions}
							onRejoin={backToSessions}
							onBack={backToSessions}
							onEnded={backToSessions}
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
	/** Control mode: fired when the session ends so the app can return to the sidebar. */
	onEnded?: () => void;
}

function Session({ client, onLeave, onRejoin, onBack, onEnded }: SessionProps): ReactNode {
	const snap = useGuestSnapshot(client);
	const [railOpen, setRailOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const autoOpenedRef = useRef(false);

	const subCount = useMemo(() => snap.agents.filter(a => a.kind === "sub").length, [snap.agents]);

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
		if (subCount > 0 && !autoOpenedRef.current) {
			autoOpenedRef.current = true;
			setRailOpen(true);
		}
	}, [subCount]);

	// Control mode: a ended session returns to the sidebar automatically.
	useEffect(() => {
		if (snap.phase === "ended") onEnded?.();
	}, [snap.phase, onEnded]);

	const title = snap.header?.title ?? snap.state?.sessionName ?? "session";
	useEffect(() => {
		document.title = `${title} · omp collab`;
	}, [title]);

	const drawerAgent = selectedId != null ? snap.agents.find(a => a.id === selectedId) : undefined;

	return (
		<div className="sh-app">
			<HeaderBar
				snapshot={snap}
				subCount={subCount}
				railOpen={railOpen}
				onToggleRail={() => setRailOpen(open => !open)}
				onLeave={onLeave}
				onBack={onBack}
				onModelList={() => client.sendModelList()}
				onModelChange={(provider, id) => client.sendModelChange(provider, id)}
				settingsOpen={settingsOpen}
				onToggleSettings={() => setSettingsOpen(open => !open)}
			/>
			{settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
			<main className="sh-main">
				<section className="sh-content" data-rail={railOpen ? "true" : "false"}>
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
					<>
						<div className="sh-rail-backdrop" onClick={() => setRailOpen(false)} />
						<aside className="sh-rail">
							<AgentsPanel
								agents={snap.agents}
								progress={snap.progress}
								lifecycle={snap.lifecycle}
								selectedId={selectedId}
								onSelect={setSelectedId}
							/>
						</aside>
					</>
				)}
			</main>
			<Composer client={client} snapshot={snap} />
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
			<Banners phase={snap.phase} endedReason={snap.endedReason} onRejoin={onRejoin} onNewLink={onLeave} />
			<Toasts notices={snap.notices} />
		</div>
	);
}
