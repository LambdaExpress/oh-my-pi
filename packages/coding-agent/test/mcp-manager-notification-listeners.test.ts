import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { CUSTOM_NOTIFICATION_METHOD, CUSTOM_NOTIFICATION_PAYLOAD } from "./fixtures/notifications-mcp";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "notifications-mcp.ts");
const BUN_EXEC = process.execPath;

type CapturedFrame = { server: string; method: string; params: unknown };

function serverConfig(): MCPServerConfig {
	return { type: "stdio", command: BUN_EXEC, args: [FIXTURE_PATH] };
}

/**
 * Bind a capturing listener that ALSO exposes a promise-based await for a
 * specific `(server, method)` pair. Lets each test wait for the exact frame it
 * cares about without polling — the frame arriving is the real signal, not a
 * timer. bun:test's per-test timeout backstops a genuine hang.
 */
function makeFrameCollector(): {
	listener: (server: string, method: string, params: unknown) => void;
	frames: CapturedFrame[];
	awaitFrame: (server: string, method: string) => Promise<CapturedFrame>;
} {
	const frames: CapturedFrame[] = [];
	const waiters = new Map<string, Array<(frame: CapturedFrame) => void>>();
	const key = (server: string, method: string) => `${server}\x00${method}`;
	return {
		frames,
		listener: (server, method, params) => {
			const frame: CapturedFrame = { server, method, params };
			frames.push(frame);
			const bucket = waiters.get(key(server, method));
			if (bucket && bucket.length > 0) {
				waiters.delete(key(server, method));
				for (const resolve of bucket) resolve(frame);
			}
		},
		awaitFrame: (server, method) => {
			const existing = frames.find(f => f.server === server && f.method === method);
			if (existing) return Promise.resolve(existing);
			const { promise, resolve } = Promise.withResolvers<CapturedFrame>();
			const bucket = waiters.get(key(server, method)) ?? [];
			bucket.push(resolve);
			waiters.set(key(server, method), bucket);
			return promise;
		},
	};
}

describe("MCPManager notification listeners", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-notif-"));
	});

	afterEach(() => {
		removeSyncWithRetries(workDir);
	});

	it("delivers known and server-custom notifications to a registered listener", async () => {
		const manager = new MCPManager(workDir);
		const collector = makeFrameCollector();
		const unsubscribe = manager.addNotificationListener(collector.listener);
		expect(typeof unsubscribe).toBe("function");

		try {
			await manager.connectServers({ alpha: serverConfig() }, {});

			// Await both the known list_changed and the server-custom frame
			// independently. Arrival order across the two isn't guaranteed
			// because list_changed triggers an internal `tools/list` refresh
			// that MCPManager awaits before fanout (so listeners see fresh
			// `getTools()`), which lets a non-refresh frame like the custom
			// one overtake in the same batch. Both MUST still be delivered;
			// that's the actual contract this test exercises.
			const [listChanged, custom] = await Promise.all([
				collector.awaitFrame("alpha", "notifications/tools/list_changed"),
				collector.awaitFrame("alpha", CUSTOM_NOTIFICATION_METHOD),
			]);
			expect(custom.params).toEqual(CUSTOM_NOTIFICATION_PAYLOAD);
			expect(listChanged.method).toBe("notifications/tools/list_changed");
		} finally {
			await manager.disconnectAll();
		}
	});

	it("dispatches to every listener and isolates handler errors", async () => {
		const manager = new MCPManager(workDir);
		const collectorA = makeFrameCollector();
		const collectorC = makeFrameCollector();

		manager.addNotificationListener(collectorA.listener);
		manager.addNotificationListener(() => {
			// Middle listener throws synchronously. Must NOT prevent the third
			// listener from being invoked for the same frame.
			throw new Error("listener-B intentionally throws");
		});
		manager.addNotificationListener(collectorC.listener);

		try {
			await manager.connectServers({ alpha: serverConfig() }, {});
			const [frameA, frameC] = await Promise.all([
				collectorA.awaitFrame("alpha", CUSTOM_NOTIFICATION_METHOD),
				collectorC.awaitFrame("alpha", CUSTOM_NOTIFICATION_METHOD),
			]);
			expect(frameA.params).toEqual(CUSTOM_NOTIFICATION_PAYLOAD);
			expect(frameC.params).toEqual(CUSTOM_NOTIFICATION_PAYLOAD);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("unsubscribe stops delivery to that listener without affecting others", async () => {
		const manager = new MCPManager(workDir);
		const early = makeFrameCollector();
		const late = makeFrameCollector();

		const unsubscribeEarly = manager.addNotificationListener(early.listener);

		try {
			await manager.connectServers({ alpha: serverConfig() }, {});
			await early.awaitFrame("alpha", CUSTOM_NOTIFICATION_METHOD);
			const earlyCountBeforeUnsub = early.frames.length;

			unsubscribeEarly();

			// Add a fresh listener AFTER unsub, then connect a second server so
			// the fixture emits a new batch. The unsubscribed listener must not
			// grow; the fresh listener must observe the fresh batch. Dispatch
			// per frame is synchronous over the listener set, so once `late`
			// resolves for a `beta` frame, any concurrent delivery to `early`
			// would have already happened had the unsubscribe not landed.
			manager.addNotificationListener(late.listener);
			await manager.connectServers({ beta: serverConfig() }, {});
			await late.awaitFrame("beta", CUSTOM_NOTIFICATION_METHOD);

			expect(early.frames.length).toBe(earlyCountBeforeUnsub);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("buffers notifications received before any listener attaches, drains into first subscriber", async () => {
		const manager = new MCPManager(workDir);

		try {
			// Connect FIRST, before any listener is registered. The fixture
			// emits `notifications/tools/list_changed` plus a server-custom
			// notification during its `notifications/initialized` handshake,
			// so the startup barrier ensures its notification frames have
			// already been received by the manager with no consumer.
			await manager.connectServers({ alpha: serverConfig() }, {});
			await manager.waitForStartup(0);

			// Attach the FIRST listener AFTER frames were already dispatched.
			// Drain-on-first-subscribe must deliver the buffered frames now.
			const collector = makeFrameCollector();
			manager.addNotificationListener(collector.listener);
			// Both the known list_changed and the server-custom frame must
			// have been buffered and drained on attach. Await each
			// independently — arrival order between refresh-triggering and
			// non-refresh frames is not guaranteed (see the delivery test
			// for rationale), but both are always delivered.
			const [listChanged, custom] = await Promise.all([
				collector.awaitFrame("alpha", "notifications/tools/list_changed"),
				collector.awaitFrame("alpha", CUSTOM_NOTIFICATION_METHOD),
			]);
			expect(custom.params).toEqual(CUSTOM_NOTIFICATION_PAYLOAD);
			expect(listChanged.method).toBe("notifications/tools/list_changed");
		} finally {
			await manager.disconnectAll();
		}
	});

	it("runs a refresh queued during a failed tools refresh instead of dropping it", async () => {
		const manager = new MCPManager(workDir);
		const collector = makeFrameCollector();
		manager.addNotificationListener(collector.listener);

		try {
			await manager.connectServers({ alpha: serverConfig() }, {});
			await manager.waitForStartup(0);
			// The handshake's list_changed refresh fans out only after it settles.
			await collector.awaitFrame("alpha", "notifications/tools/list_changed");

			let calls = 0;
			manager.setOnToolsChanged(async () => {
				calls++;
				if (calls === 1) {
					// A tools/list_changed arriving mid-flight marks the refresh dirty…
					void manager.refreshServerTools("alpha");
					// …and then the in-flight pass fails.
					throw new Error("in-flight refresh failed");
				}
			});

			await manager.refreshServerTools("alpha");
			expect(calls).toBe(2);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("coalesces a burst of tool refreshes into one trailing pass that every caller waits for", async () => {
		const manager = new MCPManager(workDir);
		const collector = makeFrameCollector();
		manager.addNotificationListener(collector.listener);

		try {
			await manager.connectServers({ alpha: serverConfig() }, {});
			await manager.waitForStartup(0);
			await collector.awaitFrame("alpha", "notifications/tools/list_changed");

			const firstEntered = Promise.withResolvers<void>();
			const releaseFirst = Promise.withResolvers<void>();
			let calls = 0;
			manager.setOnToolsChanged(async () => {
				calls++;
				if (calls === 1) {
					firstEntered.resolve();
					await releaseFirst.promise;
				}
			});

			const first = manager.refreshServerTools("alpha");
			await firstEntered.promise;
			const burst = [1, 2, 3, 4].map(() => manager.refreshServerTools("alpha"));
			let burstSettled = false;
			void Promise.all(burst).then(() => {
				burstSettled = true;
			});
			releaseFirst.resolve();
			await Promise.all([first, ...burst]);

			expect(burstSettled).toBe(true);
			// The held pass plus exactly one trailing pass for the whole burst.
			expect(calls).toBe(2);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("refreshServerTools awaits an async setOnToolsChanged handler before resolving", async () => {
		const manager = new MCPManager(workDir);
		const collector = makeFrameCollector();
		manager.addNotificationListener(collector.listener);
		const events: string[] = [];
		const entered = Promise.withResolvers<void>();
		const { promise: hold, resolve: release } = Promise.withResolvers<void>();

		try {
			await manager.connectServers({ alpha: serverConfig() }, {});
			await manager.waitForStartup(0);
			await collector.awaitFrame("alpha", "notifications/tools/list_changed");

			// Install the held handler only after startup and its notifications settle.
			manager.setOnToolsChanged(async () => {
				events.push("cb:start");
				entered.resolve();
				await hold;
				events.push("cb:end");
			});
			const refreshDone = manager.refreshServerTools("alpha").then(() => {
				events.push("refresh:end");
			});
			await entered.promise;
			// Drain runnable continuations without releasing the callback.
			const nextTurn = Promise.withResolvers<void>();
			setImmediate(nextTurn.resolve);
			await nextTurn.promise;
			expect(events).toEqual(["cb:start"]);

			release();
			await refreshDone;
			expect(events).toEqual(["cb:start", "cb:end", "refresh:end"]);
		} finally {
			release();
			await manager.disconnectAll();
		}
	});

	it("mcp_notification listener for tools/list_changed fires only AFTER setOnToolsChanged callback resolves", async () => {
		const manager = new MCPManager(workDir);
		const collector = makeFrameCollector();
		manager.addNotificationListener(collector.listener);
		const events: string[] = [];
		const entered = Promise.withResolvers<void>();
		const delivered = Promise.withResolvers<void>();
		const { promise: gate, resolve: releaseGate } = Promise.withResolvers<void>();

		try {
			await manager.connectServers({ alpha: serverConfig() }, {});
			await manager.waitForStartup(0);
			await collector.awaitFrame("alpha", "notifications/tools/list_changed");

			manager.setOnToolsChanged(async () => {
				events.push("cb:start");
				entered.resolve();
				await gate;
				events.push("cb:end");
			});
			manager.addNotificationListener((_server, method) => {
				if (method === "notifications/tools/list_changed") {
					events.push("listener:fire");
					delivered.resolve();
				}
			});

			// Simulate a post-connect `notifications/tools/list_changed` frame
			// by driving the transport's onNotification hook directly — that's
			// exactly what the transport does when a server pushes a
			// notification after startup. Bypasses the fixture's initial
			// handshake burst so we exercise the connectionKnown=true path
			// (where refresh actually runs and the callback is awaited).
			const conn = manager.getConnection("alpha");
			if (!conn?.transport.onNotification) throw new Error("expected transport onNotification to be wired");
			void conn.transport.onNotification("notifications/tools/list_changed", {});

			await entered.promise;
			const nextTurn = Promise.withResolvers<void>();
			setImmediate(nextTurn.resolve);
			await nextTurn.promise;
			expect(events).toEqual(["cb:start"]);

			// Release the gate. Now the callback resolves, refresh completes,
			// and the listener fires — in that order.
			releaseGate();
			await delivered.promise;
			expect(events).toEqual(["cb:start", "cb:end", "listener:fire"]);
		} finally {
			// Ensure gate is released even on early failure so no promise leaks.
			releaseGate();
			await manager.disconnectAll();
		}
	}, 15_000);
});
