/**
 * Local single-port server for headless core mode: a collab relay room
 * multiplexer (host/guest forwarding contract of the public relay) plus a
 * static file server for the collab web dist.
 *
 * Ports the relay semantics of `packages/collab-web/scripts/local-relay.ts`
 * and merges them with static hosting so `CollabHost.start(relayUrl,
 * webLinkBase)` can serve both the deep link and the browser UI from one
 * loopback port.
 */

import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { rewriteEnvelopePeer, unpackEnvelope } from "./protocol";

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;

interface SocketData {
	roomId: string;
	role: "host" | "guest";
	/** Assigned on open for guests; the host stays 0. */
	peerId: number;
}

type RelaySocket = Bun.ServerWebSocket<SocketData>;

interface Room {
	host: RelaySocket;
	guests: Map<number, RelaySocket>;
	nextPeerId: number;
}

export interface LocalServer {
	/** ws://127.0.0.1:<port> — pass as the first argument of CollabHost.start. */
	relayUrl: string;
	/** http://127.0.0.1:<port> — pass as the second argument of CollabHost.start. */
	webLinkBase: string;
	port: number;
	/** Closes every room and stops the server. Idempotent. */
	stop(): void;
}

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
};

export function startLocalServer(options: { webDistDir: string }): LocalServer {
	const { webDistDir } = options;
	const rooms = new Map<string, Room>();
	let stopped = false;

	const server = Bun.serve({
		port: 0,
		fetch(req, srv): Response | Promise<Response> | undefined {
			const url = new URL(req.url);
			const match = ROOM_PATH_RE.exec(url.pathname);
			const role = url.searchParams.get("role");
			if (match && (role === "host" || role === "guest")) {
				const data: SocketData = { roomId: match[1]!, role, peerId: 0 };
				if (srv.upgrade(req, { data })) return undefined;
				return new Response("websocket upgrade required", { status: 426 });
			}
			return serveStatic(url);
		},
		websocket: {
			open(ws: RelaySocket): void {
				const { roomId, role } = ws.data;
				if (role === "host") {
					if (rooms.has(roomId)) {
						ws.close(4009, "a host is already connected for this room");
						return;
					}
					rooms.set(roomId, { host: ws, guests: new Map(), nextPeerId: 1 });
					return;
				}
				const room = rooms.get(roomId);
				if (!room) {
					ws.close(4004, "no such room");
					return;
				}
				const peerId = room.nextPeerId++;
				ws.data.peerId = peerId;
				room.guests.set(peerId, ws);
				room.host.send(JSON.stringify({ t: "peer-joined", peer: peerId }));
			},
			message(ws: RelaySocket, message: string | Buffer): void {
				if (typeof message === "string") return; // clients never send TEXT
				const room = rooms.get(ws.data.roomId);
				if (!room) return;
				if (ws.data.role === "host") {
					const envelope = unpackEnvelope(message);
					if (!envelope) return;
					if (envelope.peerId === 0) {
						for (const guest of room.guests.values()) guest.send(message);
					} else {
						room.guests.get(envelope.peerId)?.send(message);
					}
					return;
				}
				if (message.byteLength < 4) return;
				rewriteEnvelopePeer(message, ws.data.peerId);
				room.host.send(message);
			},
			close(ws: RelaySocket): void {
				const { roomId, role, peerId } = ws.data;
				const room = rooms.get(roomId);
				if (!room) return;
				if (role === "host") {
					// Rejected second host: the live room is not ours to tear down.
					if (room.host !== ws) return;
					rooms.delete(roomId);
					const closure = JSON.stringify({ t: "room-closed" });
					for (const guest of room.guests.values()) {
						guest.send(closure);
						guest.close(4001, "room closed");
					}
					room.guests.clear();
					return;
				}
				if (room.guests.delete(peerId)) {
					room.host.send(JSON.stringify({ t: "peer-left", peer: peerId }));
				}
			},
		},
	});

	async function serveStatic(url: URL): Promise<Response> {
		const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
		const rel = path.normalize(pathname.replace(/^[/\\]+/, ""));
		// Normalize collapses `..` segments; reject anything that escapes the dist root.
		const resolved = path.join(webDistDir, rel);
		if (resolved !== webDistDir && !resolved.startsWith(webDistDir + path.sep)) {
			return new Response("not found", { status: 404 });
		}
		try {
			const file = Bun.file(resolved);
			if (!(await file.exists())) return new Response("not found", { status: 404 });
			const contentType = CONTENT_TYPES[path.extname(resolved).toLowerCase()];
			return new Response(file, {
				status: 200,
				headers: contentType ? { "content-type": contentType } : undefined,
			});
		} catch (err) {
			// Windows Bun can surface a missing file as an ENOENT rejection
			// instead of a clean `exists() === false`.
			if (isEnoent(err)) return new Response("not found", { status: 404 });
			throw err;
		}
	}

	return {
		relayUrl: `ws://127.0.0.1:${server.port}`,
		webLinkBase: `http://127.0.0.1:${server.port}`,
		// Bun.serve types `port` as possibly-undefined, but `port: 0` always
		// makes the OS assign a concrete free port before serve resolves.
		port: server.port!,
		stop(): void {
			if (stopped) return;
			stopped = true;
			for (const room of rooms.values()) {
				const closure = JSON.stringify({ t: "room-closed" });
				for (const guest of room.guests.values()) {
					guest.send(closure);
					guest.close(4001, "room closed");
				}
				room.host.close(1001, "relay shutting down");
			}
			rooms.clear();
			server.stop(true);
		},
	};
}
