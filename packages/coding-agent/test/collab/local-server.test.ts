/**
 * Contract tests for the local single-port server: static file serving for
 * the collab web dist, plus the relay room forwarding contract (host
 * broadcast/targeted send, guest peer rewrite, peer-joined/peer-left control
 * frames, room teardown on host disconnect) over real loopback WebSockets.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { packEnvelope, unpackEnvelope } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { type LocalServer, startLocalServer } from "../../src/collab/local-server";

const WAIT_TIMEOUT_MS = 5_000;
const ROOM_ID = "a".repeat(20);

let server: LocalServer;

afterEach(() => {
	server?.stop();
	server = undefined as never;
});

async function makeDist(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-local-server-"));
	await fs.writeFile(path.join(dir, "index.html"), "<html>SENTINEL_MARKER</html>");
	await fs.writeFile(path.join(dir, "app.js"), "console.log('app');");
	return dir;
}

function connectWs(url: string): Promise<WebSocket> {
	const ws = new WebSocket(url);
	ws.binaryType = "arraybuffer";
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`websocket open timed out: ${url}`)), WAIT_TIMEOUT_MS);
		ws.onopen = () => {
			clearTimeout(timeout);
			resolve(ws);
		};
		ws.onerror = () => reject(new Error(`websocket error: ${url}`));
	});
}

/** Resolves with the next message's data (string for TEXT, ArrayBuffer for binary). */
function nextMessage(ws: WebSocket): Promise<string | ArrayBuffer> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("websocket message timed out")), WAIT_TIMEOUT_MS);
		ws.onmessage = event => {
			clearTimeout(timeout);
			resolve(event.data as string | ArrayBuffer);
		};
	});
}

function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("websocket close timed out")), WAIT_TIMEOUT_MS);
		ws.onclose = event => {
			clearTimeout(timeout);
			resolve({ code: event.code, reason: event.reason });
		};
	});
}

async function readBinary(message: string | ArrayBuffer): Promise<Uint8Array> {
	if (typeof message === "string") throw new Error(`expected binary message, got text: ${message}`);
	return new Uint8Array(message);
}

describe("local server static file serving", () => {
	it("serves index.html at / and typed assets with correct content types", async () => {
		const dist = await makeDist();
		server = startLocalServer({ webDistDir: dist });

		const index = await fetch(`${server.webLinkBase}/`);
		expect(index.status).toBe(200);
		expect(index.headers.get("content-type")).toContain("text/html");
		expect(await index.text()).toContain("SENTINEL_MARKER");

		const app = await fetch(`${server.webLinkBase}/app.js`);
		expect(app.status).toBe(200);
		expect(app.headers.get("content-type")).toContain("text/javascript");
		expect(await app.text()).toContain("console.log");
	});

	it("returns 404 for missing files and path traversal escapes", async () => {
		const dist = await makeDist();
		server = startLocalServer({ webDistDir: dist });

		const missing = await fetch(`${server.webLinkBase}/nope`);
		expect(missing.status).toBe(404);

		const traversal = await fetch(`${server.webLinkBase}/%2e%2e/package.json`);
		expect(traversal.status).toBe(404);
	});
});

describe("local server relay rooms", () => {
	it("rejects a second host for the same room with close 4009", async () => {
		const dist = await makeDist();
		server = startLocalServer({ webDistDir: dist });

		const host = await connectWs(`${server.relayUrl}/r/${ROOM_ID}?role=host`);
		const secondHost = await connectWs(`${server.relayUrl}/r/${ROOM_ID}?role=host`);
		try {
			const close = await nextClose(secondHost);
			expect(close.code).toBe(4009);
		} finally {
			host.close();
			secondHost.close();
		}
	});

	it("notifies the host of peer-joined and forwards guest envelopes with the sender peerId", async () => {
		const dist = await makeDist();
		server = startLocalServer({ webDistDir: dist });

		const host = await connectWs(`${server.relayUrl}/r/${ROOM_ID}?role=host`);
		const guest = await connectWs(`${server.relayUrl}/r/${ROOM_ID}?role=guest`);
		try {
			const joined = await nextMessage(host);
			expect(JSON.parse(joined as string)).toEqual({ t: "peer-joined", peer: 1 });

			guest.send(packEnvelope(0, new TextEncoder().encode("hi")));
			const hostBytes = await readBinary(await nextMessage(host));
			const envelope = unpackEnvelope(hostBytes);
			if (!envelope) throw new Error("expected a parseable envelope on the host");
			expect(envelope.peerId).toBe(1);
			expect(new TextDecoder().decode(envelope.payload)).toBe("hi");
		} finally {
			host.close();
			guest.close();
		}
	});

	it("broadcasts host envelopes to guests and targets single guests", async () => {
		const dist = await makeDist();
		server = startLocalServer({ webDistDir: dist });

		const host = await connectWs(`${server.relayUrl}/r/${ROOM_ID}?role=host`);
		const guest = await connectWs(`${server.relayUrl}/r/${ROOM_ID}?role=guest`);
		try {
			await nextMessage(host); // drain peer-joined

			host.send(packEnvelope(0, new TextEncoder().encode("hi")));
			const guestBytes = await readBinary(await nextMessage(guest));
			const envelope = unpackEnvelope(guestBytes);
			if (!envelope) throw new Error("expected a parseable envelope on the guest");
			expect(envelope.peerId).toBe(0);
			expect(new TextDecoder().decode(envelope.payload)).toBe("hi");

			// Directed envelope to peer 1 must reach only that guest.
			host.send(packEnvelope(1, new TextEncoder().encode("targeted")));
			const targeted = await readBinary(await nextMessage(guest));
			const targetedEnvelope = unpackEnvelope(targeted);
			if (!targetedEnvelope) throw new Error("expected a parseable envelope on the guest");
			expect(targetedEnvelope.peerId).toBe(1);
			expect(new TextDecoder().decode(targetedEnvelope.payload)).toBe("targeted");
		} finally {
			host.close();
			guest.close();
		}
	});

	it("closes guest rooms with a room-closed notice when the host disconnects", async () => {
		const dist = await makeDist();
		server = startLocalServer({ webDistDir: dist });

		const host = await connectWs(`${server.relayUrl}/r/${ROOM_ID}?role=host`);
		const guest = await connectWs(`${server.relayUrl}/r/${ROOM_ID}?role=guest`);
		await nextMessage(host); // drain peer-joined
		try {
			host.close();
			const notice = await nextMessage(guest);
			expect(JSON.parse(notice as string)).toEqual({ t: "room-closed" });
			const close = await nextClose(guest);
			expect(close.code).toBe(4001);
		} finally {
			host.close();
			guest.close();
		}
	});
});
