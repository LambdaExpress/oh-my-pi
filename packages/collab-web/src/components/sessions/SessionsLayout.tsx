import { Menu } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { ControlClient, ControlSnapshot } from "../../lib/control-client";
import { desktopBridge } from "../../lib/desktop-bridge";
import { useControlSnapshot } from "../../lib/use-control";
import { NewSessionComposer } from "../shell/Composer";
import { SettingsModal } from "../shell/SettingsModal";
import { SessionsPanel } from "./SessionsPanel";

export interface SessionsLayoutProps {
	client: ControlClient;
	/** Authoritative id from the active ctrl-session reply; null on the home view. */
	activeSessionId?: string | null;
	/** A create/resume request is awaiting its directed ctrl-session reply. */
	pending?: boolean;
	/** Active session view, or null for the empty state (no session open). */
	content: ReactNode;
	onOpenSession(id: string): void;
	onNewSession(initialPrompt?: string): void;
	onDropSession(id: string): void;
	onLeave(): void;
}

/**
 * Control-mode frame: project/session navigation + active session or neutral home.
 * The sidebar remains mounted so ctrl-sessions broadcasts keep its state fresh.
 */
export function SessionsLayout({
	client,
	activeSessionId = null,
	pending = false,
	content,
	onOpenSession,
	onNewSession,
	onDropSession,
	onLeave,
}: SessionsLayoutProps): ReactNode {
	const snap = useControlSnapshot(client);
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [sidebarOverlay, setSidebarOverlay] = useState(() => window.matchMedia("(max-width: 900px)").matches);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const sidebarRef = useRef<HTMLElement | null>(null);
	const sidebarTriggerRef = useRef<HTMLButtonElement | null>(null);

	const openSession = (id: string): void => {
		setSidebarOpen(false);
		onOpenSession(id);
	};
	const newSession = (initialPrompt?: string): void => {
		setSidebarOpen(false);
		onNewSession(initialPrompt);
	};

	useEffect(() => {
		const media = window.matchMedia("(max-width: 900px)");
		const update = (): void => setSidebarOverlay(media.matches);
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);

	useEffect(() => {
		const handleShortcut = (event: globalThis.KeyboardEvent): void => {
			if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
			const key = event.key.toLowerCase();
			const settingsVisible = document.querySelector(".sh-settings-backdrop") !== null;
			if (settingsVisible && key !== ",") return;
			switch (key) {
				case ",":
					if (content !== null) return;
					event.preventDefault();
					setSettingsOpen(open => !open);
					break;
				case "n":
					if (pending || snap.readOnly || snap.phase !== "live") return;
					event.preventDefault();
					setSidebarOpen(false);
					onNewSession();
					break;
				case "o":
					if (!desktopBridge.available) return;
					event.preventDefault();
					void desktopBridge.openProject().catch(() => {});
					break;
				case "b":
					event.preventDefault();
					if (sidebarOverlay) setSidebarOpen(open => !open);
					else setSidebarCollapsed(collapsed => !collapsed);
					break;
				case "k": {
					const composer = document.querySelector<HTMLTextAreaElement>(".sh-composer-input:not(:disabled)");
					if (composer === null) return;
					event.preventDefault();
					composer.focus();
					break;
				}
			}
		};
		document.addEventListener("keydown", handleShortcut);
		return () => document.removeEventListener("keydown", handleShortcut);
	}, [content, onNewSession, pending, sidebarOverlay, snap.phase, snap.readOnly]);

	useEffect(() => {
		if (!sidebarOpen || !sidebarOverlay) return;
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		const focusFrame = requestAnimationFrame(() => {
			sidebarRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
		});
		const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			setSidebarOpen(false);
			sidebarTriggerRef.current?.focus();
		};
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			cancelAnimationFrame(focusFrame);
			document.removeEventListener("keydown", closeOnEscape);
			document.body.style.overflow = previousOverflow;
		};
	}, [sidebarOpen, sidebarOverlay]);

	const trapSidebarFocus = (event: KeyboardEvent<HTMLElement>): void => {
		if (event.key !== "Tab") return;
		const focusable = sidebarRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), [href]");
		if (!focusable || focusable.length === 0) return;
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

	return (
		<div className="sh-control" data-sidebar-collapsed={sidebarCollapsed ? "true" : undefined}>
			{settingsOpen && (
				<SettingsModal
					onClose={() => setSettingsOpen(false)}
					project={snap.sessions[0]?.cwd}
					readOnly={snap.readOnly}
					connection={snap.phase}
				/>
			)}
			{sidebarOpen && sidebarOverlay && (
				<button
					type="button"
					className="sh-sidebar-backdrop"
					onClick={() => {
						setSidebarOpen(false);
						requestAnimationFrame(() => sidebarTriggerRef.current?.focus());
					}}
					aria-label="Close project navigation"
				/>
			)}
			<aside
				ref={sidebarRef}
				className="sh-sidebar"
				data-open={sidebarOpen ? "true" : "false"}
				role={sidebarOpen && sidebarOverlay ? "dialog" : undefined}
				aria-modal={sidebarOpen && sidebarOverlay ? "true" : undefined}
				aria-label={sidebarOpen && sidebarOverlay ? "Project navigation" : undefined}
				onKeyDown={trapSidebarFocus}
			>
				<SessionsPanel
					snapshot={snap}
					activeSessionId={activeSessionId}
					pending={pending}
					onOpenSettings={() => setSettingsOpen(true)}
					onOpenSession={openSession}
					onNewSession={newSession}
					onDropSession={onDropSession}
					onCollapse={() => {
						if (sidebarOverlay) setSidebarOpen(false);
						else setSidebarCollapsed(true);
						requestAnimationFrame(() => sidebarTriggerRef.current?.focus());
					}}
					onLeave={onLeave}
				/>
			</aside>
			<div className="sh-control-main">
				<button
					ref={sidebarTriggerRef}
					type="button"
					className="sh-sidebar-toggle"
					onClick={() => {
						setSidebarCollapsed(false);
						setSidebarOpen(true);
					}}
					aria-label="Show project navigation"
				>
					<Menu size={18} aria-hidden="true" />
				</button>
				<div className="sh-control-view">
					{content ?? <SessionsEmpty snap={snap} pending={pending} onNewSession={newSession} />}
				</div>
			</div>
		</div>
	);
}

function SessionsEmpty({
	snap,
	pending,
	onNewSession,
}: {
	snap: ControlSnapshot;
	pending: boolean;
	onNewSession(initialPrompt?: string): void;
}): ReactNode {
	const { readOnly, phase } = snap;
	const unavailable = phase === "connecting" || phase === "waiting" || phase === "reconnecting" || phase === "ended";
	const title = readOnly
		? "Select a session to view"
		: phase === "ended"
			? "The control room has ended"
			: "What should we do?";
	const hint =
		phase === "ended"
			? snap.endedReason || "This control room is no longer available."
			: phase === "reconnecting"
				? "Reconnecting to the control room…"
				: phase === "connecting" || phase === "waiting"
					? "Connecting to the control room…"
					: readOnly
						? "Choose a session from the project navigation."
						: "Start a new session in the current project.";

	return (
		<div className="sh-sessions-empty">
			<div className="sh-sessions-empty-stack">
				<h1 className="sh-sessions-empty-title">{title}</h1>
				{readOnly || unavailable ? (
					<div className="sh-sessions-empty-composer" data-disabled="true">
						<p>{hint}</p>
					</div>
				) : (
					<NewSessionComposer
						cwd={snap.sessions[0]?.cwd}
						pending={pending}
						disabled={false}
						onSubmit={onNewSession}
					/>
				)}
			</div>
		</div>
	);
}
