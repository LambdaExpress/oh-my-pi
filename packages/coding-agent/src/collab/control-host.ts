/**
 * Host of the control room — a session-management channel that runs
 * alongside the per-session collab rooms. `omp --mode core` prints the
 * control link; the web UI opens it to list, create, resume, and drop
 * sessions. The room reuses the collab relay and wire (`COLLAB_PROTO`) but
 * carries only the `ControlGuestFrame`/`ControlHostFrame` variants and never
 * touches session-room frames.
 */

import { timingSafeEqual } from "node:crypto";
import { logger } from "@oh-my-pi/pi-utils";
import { generateRoomKey, generateWriteToken, importRoomKey } from "./crypto";
import {
	COLLAB_PROTO,
	type CollabFrame,
	type ControlGuestFrame,
	type ControlHostFrame,
	type SessionSummary,
	formatCollabWebLink,
	generateRoomId,
	parseCollabLink,
} from "./protocol";
import { CollabSocket } from "./relay-client";
import type { SessionRegistry } from "./session-registry";

const CONNECT_TIMEOUT_MS = 15_000;
/** Debounce for list broadcasts triggered by registry events. */
const SESSIONS_DEBOUNCE_MS = 100;
/** Periodic full-list refresh so late mutations always converge. */
const SESSIONS_INTERVAL_MS = 2000;

/** Mutating control frames; only peers with a valid write token may send these. */
type MutationFrame = Extract<ControlGuestFrame, { t: "ctrl-create" | "ctrl-resume" | "ctrl-drop" }>;

export class ControlHost {
	#registry: SessionRegistry;
	#socket: CollabSocket | null = null;
	#webLink = "";
	#writeToken: Uint8Array | null = null;
	#peers = new Map<number, { name: string; canWrite: boolean }>();
	#helloDone = new Set<number>();
	#sessionsDebounce: Timer | null = null;
	#sessionsInterval: Timer | null = null;
	#onSessionEventUnsubscribe?: () => void;
	#stopped = false;
	/** Set before an intentional socket close that is not a full stop (protocol-mismatch rejection). */
	#closing = false;

	constructor(registry: SessionRegistry) {
		this.#registry = registry;
	}

	/** Browser deep link for the control room (full read-write access). */
	get webLink(): string {
		return this.#webLink;
	}

	async start(relayUrl: string, webUrl: string): Promise<void> {
		const rawKey = generateRoomKey();
		const writeToken = generateWriteToken();
		// The "ctrl-" prefix distinguishes control rooms from session rooms
		// and keeps the id inside ROOM_PATH_RE's 10-64 char window.
		const roomId = `ctrl-${generateRoomId()}`;
		this.#writeToken = writeToken;
		this.#webLink = formatCollabWebLink(relayUrl, roomId, rawKey, writeToken, webUrl);
		const parsed = parseCollabLink(this.#webLink);
		if ("error" in parsed) throw new Error(parsed.error);
		const key = await importRoomKey(rawKey);

		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "host", key });
		this.#socket = socket;

		const firstOpen = Promise.withResolvers<void>();
		let opened = false;
		socket.onOpen = () => {
			if (!opened) {
				opened = true;
				firstOpen.resolve();
			}
		};
		socket.onFrame = (frame, fromPeer) => this.#handleFrame(frame, fromPeer);
		socket.onControl = msg => {
			if (msg.t === "peer-left") this.#handlePeerLeft(msg.peer);
		};
		socket.onClose = (reason, willReconnect) => {
			if (this.#stopped || this.#closing) return;
			if (!opened) {
				firstOpen.reject(new Error(reason));
				return;
			}
			// CollabSocket auto-reconnects transient drops on its own; fatal
			// closes end the room (peers are gone), so there is no host-side
			// state to transition — just log.
			if (willReconnect) {
				logger.info("control host relay connection lost, reconnecting", { reason });
			} else {
				logger.warn("control host room closed", { reason });
			}
		};
		socket.connect();

		const timeout = setTimeout(
			() => firstOpen.reject(new Error("timed out connecting to relay")),
			CONNECT_TIMEOUT_MS,
		);
		try {
			await firstOpen.promise;
		} catch (err) {
			this.#stopped = true;
			socket.close();
			this.#socket = null;
			throw err;
		} finally {
			clearTimeout(timeout);
		}

		this.#onSessionEventUnsubscribe = this.#registry.onSessionEvent(() => this.#scheduleSessionsBroadcast());
		this.#sessionsInterval = setInterval(() => void this.#broadcastSessions(), SESSIONS_INTERVAL_MS);
	}

	/** Broadcast ctrl-bye, close the room, and detach all taps. Idempotent. */
	async stop(reason: string): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		for (const peerId of this.#helloDone) {
			this.#socket?.send({ t: "ctrl-bye", reason }, peerId);
		}
		this.#socket?.close();
		this.#socket = null;
		if (this.#sessionsDebounce) {
			clearTimeout(this.#sessionsDebounce);
			this.#sessionsDebounce = null;
		}
		if (this.#sessionsInterval) {
			clearInterval(this.#sessionsInterval);
			this.#sessionsInterval = null;
		}
		this.#onSessionEventUnsubscribe?.();
		this.#onSessionEventUnsubscribe = undefined;
		this.#peers.clear();
		this.#helloDone.clear();
	}

	#handleFrame(frame: CollabFrame, fromPeer: number): void {
		// A peer must complete ctrl-hello before its frames are processed;
		// anything else from an un-helped peer is ignored outright.
		if (!this.#helloDone.has(fromPeer) && frame.t !== "ctrl-hello") return;
		switch (frame.t) {
			case "ctrl-hello":
				this.#handleHello(frame.name, frame.proto, frame.writeToken, fromPeer);
				break;
			case "ctrl-list":
				void this.#handleList(fromPeer);
				break;
			case "ctrl-create":
			case "ctrl-resume":
			case "ctrl-drop":
				void this.#handleMutation(frame, fromPeer);
				break;
			default:
				logger.debug("control host ignoring unexpected frame", { type: frame.t, fromPeer });
		}
	}

	#handleHello(name: string, proto: number, writeToken: string | undefined, fromPeer: number): void {
		if (proto !== COLLAB_PROTO) {
			this.#socket?.send(
				{ t: "ctrl-error", message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${proto}` },
				fromPeer,
			);
			this.#closing = true;
			this.#socket?.close();
			return;
		}
		const cleanName = name.trim().slice(0, 64) || `guest-${fromPeer}`;
		const canWrite = this.#verifyWriteToken(writeToken);
		this.#peers.set(fromPeer, { name: cleanName, canWrite });
		this.#helloDone.add(fromPeer);
		this.#socket?.send({ t: "ctrl-welcome", proto: COLLAB_PROTO, readOnly: canWrite ? undefined : true }, fromPeer);
	}

	async #handleList(fromPeer: number): Promise<void> {
		const peer = this.#peers.get(fromPeer);
		const socket = this.#socket;
		if (!peer || !socket) return;
		try {
			const sessions = await this.#registry.list();
			socket.send({ t: "ctrl-sessions", sessions: this.#visibleSessions(sessions, peer.canWrite) }, fromPeer);
		} catch (err) {
			socket.send({ t: "ctrl-error", message: String(err) }, fromPeer);
		}
	}

	async #handleMutation(frame: MutationFrame, fromPeer: number): Promise<void> {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#socket?.send({ t: "ctrl-error", message: "read-only" }, fromPeer);
			return;
		}
		try {
			if (frame.t === "ctrl-create") {
				const { id, link } = await this.#registry.createSession();
				this.#socket?.send({ t: "ctrl-session", op: "created", id, link }, fromPeer);
			} else if (frame.t === "ctrl-resume") {
				const { id, link } = await this.#registry.resumeSession(frame.id);
				this.#socket?.send({ t: "ctrl-session", op: "resumed", id, link }, fromPeer);
			} else {
				// Drop has no link to hand back; the next ctrl-sessions
				// broadcast reflects the removal.
				await this.#registry.dropSession(frame.id);
			}
		} catch (err) {
			this.#socket?.send({ t: "ctrl-error", message: String(err) }, fromPeer);
		}
	}

	#handlePeerLeft(peer: number): void {
		this.#peers.delete(peer);
		this.#helloDone.delete(peer);
	}

	/** Timing-safe write-token check; peers without a valid token are read-only. */
	#verifyWriteToken(token: string | undefined): boolean {
		const expected = this.#writeToken;
		if (!expected || !token) return false;
		const bytes = Buffer.from(token, "base64url");
		return bytes.byteLength === expected.byteLength && timingSafeEqual(bytes, expected);
	}

	#scheduleSessionsBroadcast(): void {
		if (this.#stopped || this.#sessionsDebounce) return;
		this.#sessionsDebounce = setTimeout(() => {
			this.#sessionsDebounce = null;
			void this.#broadcastSessions();
		}, SESSIONS_DEBOUNCE_MS);
	}

	/** Build one ctrl-sessions frame per completed peer and send it targeted. */
	async #broadcastSessions(): Promise<void> {
		const socket = this.#socket;
		if (this.#stopped || !socket) return;
		let sessions: SessionSummary[];
		try {
			sessions = await this.#registry.list();
		} catch (err) {
			logger.warn("control host session list failed", { error: String(err) });
			return;
		}
		for (const peerId of this.#helloDone) {
			const peer = this.#peers.get(peerId);
			if (!peer) continue;
			socket.send({ t: "ctrl-sessions", sessions: this.#visibleSessions(sessions, peer.canWrite) }, peerId);
		}
	}

	/** Read-only peers never see session links. */
	#visibleSessions(sessions: SessionSummary[], canWrite: boolean): SessionSummary[] {
		if (canWrite) return sessions;
		// `link: undefined` never survives JSON serialization, so the wire
		// bytes carry no link for read-only peers.
		return sessions.map(s => ({ ...s, link: undefined }));
	}
}
