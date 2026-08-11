/**
 * Guest-side replica for a core-mode control room.
 *
 * Mirrors {@link GuestClient} (in `./client`) — same socket lifecycle, hello
 * handshake, welcome timeout, reconnect semantics and
 * `useSyncExternalStore`-compatible subscribe/getSnapshot pair — but for the
 * session-registry control room instead of a live session. The host replies
 * with `ctrl-sessions` list broadcasts every ~2s, so the snapshot refreshes
 * on its own; App-level flows (create/resume/drop) are fired through
 * `sendCreate`/`sendResume`/`sendDrop` and consumed via the `onSession`
 * / `onError` callbacks.
 */

import type { ControlHostFrame, SessionSummary } from "@oh-my-pi/pi-wire";
import { importRoomKey } from "./codec";
import { COLLAB_PROTO, encodeBase64Url, parseCollabLink } from "./link";
import { CollabSocket } from "./socket";

export interface ControlSnapshot {
	phase: "connecting" | "waiting" | "live" | "reconnecting" | "ended";
	endedReason: string | null;
	/** True when this client joined with a view link (no write token). */
	readOnly: boolean;
	sessions: readonly SessionSummary[];
}

/** Directed reply to a `ctrl-create` / `ctrl-resume` request (consumed by the App). */
export interface ControlSessionInfo {
	op: "created" | "resumed";
	id: string;
	link: string;
	title?: string;
}

/** Mirrors the session guest's WELCOME_TIMEOUT_MS. */
const WELCOME_TIMEOUT_MS = 30_000;

export class ControlClient {
	readonly #socket: CollabSocket;
	readonly #name: string;
	/** base64url write token from a full link; absent when joined via a view link. */
	readonly #writeToken: string | undefined;
	readonly #listeners = new Set<() => void>();
	#everConnected = false;
	#welcomed = false;
	#welcomeTimer: Timer | null = null;

	#phase: ControlSnapshot["phase"] = "connecting";
	#endedReason: string | null = null;
	#readOnly = false;
	#sessions: readonly SessionSummary[] = [];
	#snapshot: ControlSnapshot;

	/** Host-side `ctrl-error` frames surface here (the App shows a toast). */
	onError?: (message: string) => void;
	/** Directed `ctrl-session` replies surface here (the App verifies its pending op). */
	onSession?: (info: ControlSessionInfo) => void;

	/** @throws Error when the link does not parse or is not a control-room link. */
	constructor(link: string, displayName: string) {
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		if (!parsed.roomId.startsWith("ctrl-")) throw new Error("not a control-room link");
		this.#name = displayName;
		this.#writeToken = parsed.writeToken ? encodeBase64Url(parsed.writeToken) : undefined;
		this.#socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: importRoomKey(parsed.key) });
		this.#socket.onOpen = () => this.#handleOpen();
		this.#socket.onFrame = frame => this.#applyFrameSafe(frame as ControlHostFrame);
		this.#socket.onControl = msg => {
			if (msg.t === "room-closed") this.#end("room closed");
		};
		this.#socket.onClose = (reason, willReconnect) => this.#handleClose(reason, willReconnect);
		this.#snapshot = this.#buildSnapshot();
	}

	connect(): void {
		if (this.#phase === "ended") {
			this.#phase = "connecting";
			this.#endedReason = null;
			this.#commit();
		}
		this.#socket.connect();
		if (!this.#welcomed && this.#welcomeTimer === null) {
			this.#welcomeTimer = setTimeout(() => {
				this.#welcomeTimer = null;
				if (!this.#welcomed) this.#end("timed out waiting for the host's welcome");
			}, WELCOME_TIMEOUT_MS);
		}
	}

	close(): void {
		this.#clearWelcomeTimer();
		this.#socket.close();
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Cached stable reference; replaced (with fresh collection refs) per applied frame. */
	getSnapshot(): ControlSnapshot {
		return this.#snapshot;
	}

	sendList(): void {
		this.#socket.send({ t: "ctrl-list" });
	}

	sendCreate(): void {
		this.#socket.send({ t: "ctrl-create" });
	}

	sendResume(id: string): void {
		this.#socket.send({ t: "ctrl-resume", id });
	}

	sendDrop(id: string): void {
		this.#socket.send({ t: "ctrl-drop", id });
	}

	#handleOpen(): void {
		this.#socket.send({ t: "ctrl-hello", proto: COLLAB_PROTO, name: this.#name, writeToken: this.#writeToken });
		this.#phase = this.#everConnected ? "reconnecting" : "waiting";
		this.#everConnected = true;
		this.#commit();
	}

	#handleClose(reason: string, willReconnect: boolean): void {
		if (this.#phase === "ended") return;
		if (willReconnect) {
			this.#phase = "reconnecting";
			this.#commit();
			return;
		}
		this.#end(reason);
	}

	#end(reason: string): void {
		if (this.#phase === "ended") return;
		this.#clearWelcomeTimer();
		this.#phase = "ended";
		this.#endedReason = reason;
		this.#commit();
		this.#socket.close();
	}

	#clearWelcomeTimer(): void {
		if (this.#welcomeTimer !== null) {
			clearTimeout(this.#welcomeTimer);
			this.#welcomeTimer = null;
		}
	}

	/** Surfaces apply failures instead of letting the socket's recv chain swallow them. */
	#applyFrameSafe(frame: ControlHostFrame): void {
		try {
			this.#applyFrame(frame);
		} catch (err) {
			console.warn("collab: failed to apply control frame", frame.t, err);
			this.onError?.(`failed to apply ${frame.t} frame`);
		}
	}

	#applyFrame(frame: ControlHostFrame): void {
		switch (frame.t) {
			case "ctrl-welcome":
				this.#readOnly = frame.readOnly === true;
				this.#welcomed = true;
				this.#clearWelcomeTimer();
				this.#phase = "live";
				this.#endedReason = null;
				// Ask for the initial list right away; the host also re-broadcasts
				// on its own, so this is only a freshness kick.
				this.sendList();
				break;
			case "ctrl-sessions":
				this.#sessions = frame.sessions;
				break;
			case "ctrl-session":
				// Consumed by the App (pending-op verification + switch); the
				// snapshot intentionally does not change for these frames.
				this.onSession?.(frame);
				return;
			case "ctrl-error":
				this.onError?.(frame.message);
				return;
			case "ctrl-bye":
				this.#end(frame.reason);
				return; // #end already committed
			default:
				// unknown frame type from a newer host — ignore
				return;
		}
		this.#commit();
	}

	#buildSnapshot(): ControlSnapshot {
		return {
			phase: this.#phase,
			endedReason: this.#endedReason,
			readOnly: this.#readOnly,
			sessions: this.#sessions,
		};
	}

	#commit(): void {
		this.#snapshot = this.#buildSnapshot();
		for (const listener of this.#listeners) listener();
	}
}
