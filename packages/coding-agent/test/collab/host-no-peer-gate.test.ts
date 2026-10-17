/**
 * Contract: an auto-started collab host mirrors nothing while no guest is
 * joined (events, entries and state refreshes are all skipped), the first
 * frame after a guest's welcome reaches it, and the state dedupe baseline
 * restarts from the welcome so a change made while the room was empty is not
 * mistaken for one guests already have.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

interface Fixture {
	ctx: InteractiveModeContext;
	isStreaming: boolean;
	emit: (event: { type: string; [key: string]: unknown }) => void;
	append: (entry: SessionEntry) => void;
	onParticipantCount?: (count: number) => void;
}

function makeFixture(): Fixture {
	const sessionId = `sess-${crypto.randomUUID()}`;
	const fixture = {
		isStreaming: false,
		emit: () => {},
		append: () => {},
	} as unknown as Fixture;
	const sessionManager: { onEntryAppended?: (entry: SessionEntry) => void; [key: string]: unknown } = {
		getSessionId: () => sessionId,
		getCwd: () => "/tmp/collab-no-peer-test",
		snapshotForReplication: () => ({
			header: { type: "session", id: sessionId, timestamp: "2026-07-20T00:00:00Z", cwd: "/tmp/collab-no-peer-test" },
			entries: [],
		}),
		onEntryAppended: undefined,
	};
	fixture.append = entry => sessionManager.onEntryAppended?.(entry);
	fixture.ctx = {
		settings: Settings.isolated(),
		sessionManager,
		session: {
			isSessionTransitioning: false,
			get isStreaming() {
				return fixture.isStreaming;
			},
			queuedMessageCount: 0,
			sessionName: "no-peer-test",
			model: undefined,
			thinkingLevel: undefined,
			configuredThinkingLevel: () => undefined,
			getAvailableThinkingLevels: () => [],
			getAgentScopeId: () => sessionId,
			subscribe: (cb: Fixture["emit"]) => {
				fixture.emit = cb;
				return () => {};
			},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: (status: { participantCount: number } | null) => {
				if (status) fixture.onParticipantCount?.(status.participantCount);
			},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
	return fixture;
}

const textEntry = (id: string): SessionEntry =>
	({
		type: "custom_message",
		id,
		parentId: null,
		timestamp: "2026-07-20T00:00:00Z",
		customType: "note",
		content: id,
		display: true,
	}) as unknown as SessionEntry;

let host: CollabHost | undefined;
const guests: CollabSocket[] = [];
const restoreSpies: Array<() => void> = [];

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	installInMemoryRelay();
	host = undefined;
});

afterEach(async () => {
	vi.useRealTimers();
	try {
		for (const guest of guests.splice(0)) guest.close();
		await host?.stop("test cleanup");
	} finally {
		for (const restore of restoreSpies.splice(0).reverse()) restore();
		uninstallInMemoryRelay();
		AgentRegistry.resetGlobalForTests();
	}
});

async function startHost(fixture: Fixture): Promise<CollabSocket> {
	const originalConnect = CollabSocket.prototype.connect;
	let transport: CollabSocket | undefined;
	const capture = spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
		transport = this;
		return originalConnect.call(this);
	});
	host = new CollabHost(fixture.ctx);
	try {
		await host.start("ws://localhost:8788");
	} finally {
		capture.mockRestore();
	}
	if (!transport) throw new Error("host transport missing");
	return transport;
}

function frameType(frame: CollabFrame | string): string | undefined {
	// Pre-serialized broadcasts lead with their frame tag.
	return typeof frame === "string" ? /^\{"t":"([a-z-]+)"/.exec(frame)?.[1] : frame.t;
}

async function observeParticipantCount(fixture: Fixture, count: number, action: () => void): Promise<void> {
	const observed = Promise.withResolvers<void>();
	fixture.onParticipantCount = current => {
		if (current === count) observed.resolve();
	};
	try {
		action();
		await observed.promise;
	} finally {
		fixture.onParticipantCount = undefined;
	}
}

async function joinGuest(fixture: Fixture, name: string) {
	if (!host) throw new Error("host missing");
	const parsed = parseCollabLink(host.viewLink);
	if ("error" in parsed) throw new Error(parsed.error);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
	guests.push(socket);
	const frames: CollabFrame[] = [];
	const waiters = new Set<(frame: CollabFrame) => void>();
	socket.onFrame = frame => {
		frames.push(frame);
		for (const waiter of waiters) waiter(frame);
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name });
	// The host updates its participant count after queuing the welcome and
	// snapshot. Wait for that admission point, not an event-loop delay.
	await observeParticipantCount(fixture, 2, () => socket.connect());
	return {
		socket,
		frames,
		waitForFrame: (predicate: (frame: CollabFrame) => boolean): Promise<CollabFrame> => {
			const existing = frames.find(predicate);
			if (existing) return Promise.resolve(existing);
			const received = Promise.withResolvers<CollabFrame>();
			const waiter = (frame: CollabFrame): void => {
				if (!predicate(frame)) return;
				waiters.delete(waiter);
				received.resolve(frame);
			};
			waiters.add(waiter);
			return received.promise;
		},
	};
}

describe("collab host with no joined guest", () => {
	it("mirrors no events or entries until a guest joins, then delivers the first frame after its welcome", async () => {
		const fixture = makeFixture();
		const transport = await startHost(fixture);
		const send = spyOn(transport, "send");
		const sendBatch = spyOn(transport, "sendBatch");
		restoreSpies.push(
			() => send.mockRestore(),
			() => sendBatch.mockRestore(),
		);

		fixture.emit({ type: "agent_start" });
		fixture.append(textEntry("before-join"));
		expect(send.mock.calls).toEqual([]);
		expect(sendBatch.mock.calls).toEqual([]);

		const guest = await joinGuest(fixture, "guest");
		fixture.emit({ type: "agent_start" });
		fixture.append(textEntry("after-join"));
		await guest.waitForFrame(frame => frame.t === "entry" && frame.entry.id === "after-join");

		const types = guest.frames.map(frame => frame.t);
		expect(types[0]).toBe("welcome");
		expect(types).toContain("event");
		expect(types).toContain("entry");
	});

	it("re-sends a state that matches the last one sent before the room emptied", async () => {
		const fixture = makeFixture();
		const transport = await startHost(fixture);
		const send = spyOn(transport, "send");
		restoreSpies.push(() => send.mockRestore());
		vi.useFakeTimers();
		const stateFrames = () => send.mock.calls.filter(([frame]) => frameType(frame) === "state");

		const first = await joinGuest(fixture, "first");
		fixture.isStreaming = true;
		fixture.emit({ type: "agent_start" });
		vi.advanceTimersByTime(500);
		expect(stateFrames()).toHaveLength(1);
		const firstBusyState = await first.waitForFrame(frame => frame.t === "state" && frame.state.isStreaming);

		// The room empties and the session goes idle while nobody is watching.
		await observeParticipantCount(fixture, 1, () => first.socket.close());
		fixture.isStreaming = false;
		fixture.emit({ type: "agent_end" });
		vi.advanceTimersByTime(500);
		expect(stateFrames()).toHaveLength(1);

		// The same guest rejoins; its welcome carries the idle state, and going busy
		// again before the join's state refresh fires must still reach it.
		const rejoined = await joinGuest(fixture, "first");
		fixture.isStreaming = true;
		fixture.emit({ type: "agent_start" });
		vi.advanceTimersByTime(500);
		expect(stateFrames()).toHaveLength(2);
		const welcome = await rejoined.waitForFrame(frame => frame.t === "welcome");
		if (welcome.t !== "welcome") throw new Error("expected welcome");
		expect(welcome.state.isStreaming).toBe(false);
		const nextBusyState = await rejoined.waitForFrame(frame => frame.t === "state" && frame.state.isStreaming);
		expect(nextBusyState).toEqual(firstBusyState);
	});
});
