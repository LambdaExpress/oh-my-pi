import { describe, expect, test } from "bun:test";
import { RelayBridge, type RelaySocket } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/bridge";
import type { RelayToExtMessage } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";

interface CdpMessage {
	id?: number;
	method?: string;
	sessionId?: string;
	result?: Record<string, unknown>;
	error?: { message: string };
}

type Rpc = Extract<RelayToExtMessage, { t: "rpc" }>;

/** Actual bridge with only its two transport boundaries replaced; commands and events traverse normal dispatch. */
function relayFixture() {
	const bridge = new RelayBridge();
	const commands: Rpc[] = [];
	const messages: CdpMessage[] = [];
	const pending = new Map<number, { resolve(value: CdpMessage): void }>();
	const extension: RelaySocket = {
		send(text) {
			const message = JSON.parse(text) as RelayToExtMessage;
			if (message.t !== "rpc") return;
			commands.push(message);
			if (message.op === "send" && message.method === "Browser.setDownloadBehavior") return;
			queueMicrotask(() =>
				bridge.extMessage(extension, JSON.stringify({ t: "rpcResult", id: message.id, ok: true, result: {} })),
			);
		},
		close() {},
	};
	const downstream: RelaySocket = {
		send(text) {
			const message = JSON.parse(text) as CdpMessage;
			messages.push(message);
			if (message.id !== undefined) {
				pending.get(message.id)?.resolve(message);
				pending.delete(message.id);
			}
		},
		close() {},
	};
	bridge.extConnected(extension);
	bridge.extMessage(
		extension,
		JSON.stringify({
			t: "hello",
			userAgent: "fixture",
			browserVersion: "Chrome/155.0.0.0",
			discardedTabsProtocol: 1,
			tabs: [1, 2].map(tabId => ({
				tabId,
				url: `https://example.test/${tabId}`,
				title: "fixture",
				active: tabId === 1,
				discarded: false,
				windowId: 1,
				pinned: false,
				groupId: -1,
			})),
			attachedTabIds: [1, 2],
		}),
	);
	const connection = bridge.cdpConnected(downstream);
	let sequence = 0;
	return {
		bridge,
		commands,
		messages,
		async command(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<CdpMessage> {
			const id = ++sequence;
			const result = Promise.withResolvers<CdpMessage>();
			pending.set(id, result);
			bridge.cdpMessage(connection, JSON.stringify({ id, method, params, sessionId }));
			return await result.promise;
		},
		reply(id: number, error?: string) {
			bridge.extMessage(
				extension,
				JSON.stringify({ t: "rpcResult", id, ok: error === undefined, result: {}, error }),
			);
		},
		event(tabId: number, method: string, params: Record<string, unknown>) {
			bridge.extMessage(extension, JSON.stringify({ t: "cdpEvent", tabId, method, params }));
		},
		close() {
			bridge.cdpClosed(connection);
			bridge.extClosed(extension);
		},
	};
}

describe("relay native download capability", () => {
	test("forwards Browser.setDownloadBehavior for a claimed tab and waits for the real browser reply", async () => {
		const fixture = relayFixture();
		try {
			const targetId = fixture.bridge.listTargets()[0]!.id;
			const attached = await fixture.command("Target.attachToTarget", { targetId, flatten: true });
			const sessionId = attached.result?.sessionId;
			if (typeof sessionId !== "string") throw new Error("Relay did not attach the page session");
			await fixture.command("OMP.claimTarget", {}, sessionId);
			let replied = false;
			const behavior = fixture.command("Browser.setDownloadBehavior", { behavior: "default", eventsEnabled: true });
			void behavior.then(() => {
				replied = true;
			});
			const forwarded = fixture.commands.find(
				message => message.op === "send" && message.method === "Browser.setDownloadBehavior",
			);
			if (!forwarded || forwarded.op !== "send") throw new Error("Browser command was not forwarded");
			expect(forwarded.tabId).toBe(1);
			expect(forwarded.params).toEqual({ behavior: "default", eventsEnabled: true });
			expect(replied).toBe(false);
			fixture.reply(forwarded.id);
			expect((await behavior).error).toBeUndefined();
			fixture.event(1, "Browser.downloadWillBegin", {
				guid: "native",
				frameId: "frame",
				url: "blob:https://example.test/native",
				suggestedFilename: "native.toml",
			});
			fixture.event(1, "Browser.downloadProgress", {
				guid: "native",
				state: "completed",
				receivedBytes: 15,
				filePath: "/fixture/native.toml",
			});
			const events = fixture.messages.filter(
				message => message.method?.startsWith("Browser.download") && message.sessionId === undefined,
			);
			expect(events.map(message => message.method)).toEqual([
				"Browser.downloadWillBegin",
				"Browser.downloadProgress",
			]);
			fixture.event(2, "Browser.downloadWillBegin", { guid: "unrelated", frameId: "other-frame" });
			expect(
				fixture.messages.filter(
					message => message.method?.startsWith("Browser.download") && message.sessionId === undefined,
				),
			).toHaveLength(2);
		} finally {
			fixture.close();
		}
	});

	test("returns the debugger capability failure instead of acknowledging unsupported downloads", async () => {
		const fixture = relayFixture();
		try {
			const attached = await fixture.command("Target.attachToTarget", {
				targetId: fixture.bridge.listTargets()[0]!.id,
				flatten: true,
			});
			const sessionId = attached.result?.sessionId;
			if (typeof sessionId !== "string") throw new Error("Relay did not attach the page session");
			const behavior = fixture.command(
				"Browser.setDownloadBehavior",
				{ behavior: "default", eventsEnabled: true },
				sessionId,
			);
			const forwarded = fixture.commands.find(
				message => message.op === "send" && message.method === "Browser.setDownloadBehavior",
			);
			if (!forwarded) throw new Error("Browser command was not forwarded");
			fixture.reply(forwarded.id, "Not allowed by chrome.debugger");
			expect((await behavior).error?.message).toContain("Download tracking is not supported");
		} finally {
			fixture.close();
		}
	});

	test("does not select unrelated user tabs to arm browser-wide tracking", async () => {
		const fixture = relayFixture();
		try {
			const result = await fixture.command("Browser.setDownloadBehavior", {
				behavior: "default",
				eventsEnabled: true,
			});
			expect(result.error?.message).toContain("requires one adopted relay tab");
			expect(fixture.commands).toEqual([]);
		} finally {
			fixture.close();
		}
	});
});
