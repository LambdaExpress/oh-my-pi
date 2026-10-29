import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { RelayBridge, type RelaySocket } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/bridge";
import type { RelayToExtMessage, TabSnapshot } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";

class ExtensionSocket implements RelaySocket {
	readonly messages: RelayToExtMessage[] = [];
	send(text: string): void {
		this.messages.push(JSON.parse(text));
	}
	close(): void {}
}

class CdpSocket implements RelaySocket {
	readonly messages: Array<{ id?: number; result?: { sessionId?: string }; error?: { message: string } }> = [];
	send(text: string): void {
		this.messages.push(JSON.parse(text));
	}
	close(): void {}
}

function connect(bridge: RelayBridge, socket: ExtensionSocket, instanceId: string): string {
	const tab: TabSnapshot = {
		tabId: 7,
		windowId: 1,
		url: "https://example.com/",
		title: instanceId,
		active: false,
		discarded: false,
		pinned: false,
		groupId: -1,
	};
	bridge.extConnected(socket);
	bridge.extMessage(
		socket,
		JSON.stringify({
			t: "hello",
			instanceId,
			userAgent: "test",
			browserVersion: "Chrome/151.0.0.0",
			discardedTabsProtocol: 1,
			tabs: [tab],
			attachedTabIds: [7],
		}),
	);
	const code = createHash("sha256").update(instanceId).digest("base64url").slice(0, 8);
	return `PAGE${code}.7`;
}

async function settle(): Promise<void> {
	for (let index = 0; index < 12; index++) await Promise.resolve();
}

async function setup() {
	const bridge = new RelayBridge();
	const owned = new ExtensionSocket();
	const targetId = connect(bridge, owned, "pointer-browser");
	const other = new ExtensionSocket();
	connect(bridge, other, "other-browser");
	const cdp = new CdpSocket();
	const connectionId = bridge.cdpConnected(cdp);
	bridge.cdpMessage(
		connectionId,
		JSON.stringify({ id: 1, method: "Target.attachToTarget", params: { targetId, flatten: true } }),
	);
	await settle();
	const sessionId = cdp.messages.find(message => message.id === 1)?.result?.sessionId;
	if (!sessionId) throw new Error("Relay did not attach the owned tab");
	return { bridge, owned, other, cdp, connectionId, sessionId };
}

describe("relay native pointer activation", () => {
	test("bringToFront activates the owning Chrome window/tab and waits for its acknowledgement", async () => {
		const { bridge, owned, other, cdp, connectionId, sessionId } = await setup();
		bridge.cdpMessage(connectionId, JSON.stringify({ id: 2, sessionId, method: "Page.bringToFront" }));
		await settle();
		const activation = owned.messages.find(message => message.t === "rpc" && message.op === "activateTab");
		if (!activation || activation.t !== "rpc" || activation.op !== "activateTab") {
			throw new Error("Page.bringToFront did not request native Chrome activation");
		}
		expect(activation.tabId).toBe(7);
		expect(owned.messages.filter(message => message.t === "rpc" && message.op === "send")).toEqual([]);
		expect(other.messages.filter(message => message.t === "rpc")).toEqual([]);
		expect(cdp.messages.find(message => message.id === 2)).toBeUndefined();
		bridge.extMessage(owned, JSON.stringify({ t: "rpcResult", id: activation.id, ok: true, result: {} }));
		await settle();
		expect(cdp.messages.find(message => message.id === 2)).toMatchObject({ id: 2, result: {} });
		bridge.cdpClosed(connectionId);
		bridge.extClosed(owned);
		bridge.extClosed(other);
	});

	test("does not acknowledge failed activation or replace it with synthetic input", async () => {
		const { bridge, owned, other, cdp, connectionId, sessionId } = await setup();
		bridge.cdpMessage(connectionId, JSON.stringify({ id: 2, sessionId, method: "Page.bringToFront" }));
		await settle();
		const activation = owned.messages.find(message => message.t === "rpc" && message.op === "activateTab");
		if (!activation || activation.t !== "rpc" || activation.op !== "activateTab") {
			throw new Error("Page.bringToFront did not request native Chrome activation");
		}
		bridge.extMessage(
			owned,
			JSON.stringify({ t: "rpcResult", id: activation.id, ok: false, error: "Window activation denied" }),
		);
		await settle();
		expect(cdp.messages.find(message => message.id === 2)).toMatchObject({
			id: 2,
			error: { message: "Window activation denied" },
		});
		expect(owned.messages.filter(message => message.t === "rpc" && message.op === "send")).toEqual([]);
		bridge.cdpClosed(connectionId);
		bridge.extClosed(owned);
		bridge.extClosed(other);
	});
});
