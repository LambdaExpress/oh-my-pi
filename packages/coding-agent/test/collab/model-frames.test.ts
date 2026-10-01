/**
 * End-to-end contract for the session-room model and thinking controls: guests
 * request the available models with `model-list` (targeted reply after
 * background discovery settles) and switch the session model with
 * `model-change` (write-gated; unknown models and setModel failures surface
 * as targeted `error` frames; success flows through the existing state
 * broadcast). Runs over the same in-process relay + fake WebSocket transport
 * as the other collab host suites.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "../../src/session/agent-session-events";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

interface ModelHarness {
	models: Model[];
	/** Number of times the host awaited background discovery. */
	refreshCount: number;
	/** Models the stub session accepted via setModel, in call order. */
	switched: { provider: string; id: string }[];
	configuredThinkingLevel: string;
	setModelError?: Error;
	ctx: InteractiveModeContext;
}

function makeHostContext(): ModelHarness {
	const models: ModelHarness["models"] = [];
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	let currentThinkingLevel = "medium";
	let currentModel: Model = createMockModel({
		id: "opus",
		provider: "anthropic",
		contextWindow: 200_000,
		reasoning: true,
	});
	const harness: ModelHarness = {
		models,
		refreshCount: 0,
		switched: [],
		configuredThinkingLevel: "medium",
		ctx: undefined as unknown as InteractiveModeContext,
	};
	const ctx = {
		settings: Settings.isolated(),
		sessionManager: {
			getSessionId: () => "sess-models",
			getCwd: () => "/tmp",
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-models", timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			isAborting: false,
			isSessionTransitioning: false,
			waitForSessionTransition: async () => {},
			queuedMessageCount: 0,
			sessionName: "models",
			get model() {
				return currentModel;
			},
			get thinkingLevel() {
				return currentThinkingLevel;
			},
			configuredThinkingLevel: () => harness.configuredThinkingLevel,
			getAvailableThinkingLevels: () => ["low", "medium", "high"],
			setThinkingLevel: (level: string) => {
				harness.configuredThinkingLevel = level;
				if (level !== "auto") currentThinkingLevel = level;
			},
			getAgentScopeId: () => "sess-models",
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			subscribeCommandMetadataChanged: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(true),
			abort: () => Promise.resolve(),
			modelRegistry: {
				awaitBackgroundRefresh: async () => {
					harness.refreshCount++;
				},
			},
			getAvailableModels: () => harness.models,
			setModel: async (model: Model) => {
				if (harness.setModelError) throw harness.setModelError;
				harness.switched.push({ provider: model.provider, id: model.id });
				currentModel = model;
				for (const listener of listeners) listener({ type: "model_changed" });
				return { switched: true };
			},
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
	harness.ctx = ctx;
	return harness;
}

interface TestGuest {
	socket: CollabSocket;
	nextFrame(predicate?: (frame: CollabFrame) => boolean): Promise<CollabFrame>;
}

const FILTERED_FRAME_TYPES: Record<string, true> = {
	state: true,
	agents: true,
	entry: true,
	event: true,
	bus: true,
	"snapshot-chunk": true,
};

async function joinAsGuest(link: string, name: string, includeState = false): Promise<TestGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const queue: CollabFrame[] = [];
	const waiters: { predicate: (frame: CollabFrame) => boolean; resolve: (frame: CollabFrame) => void }[] = [];
	socket.onFrame = frame => {
		if (FILTERED_FRAME_TYPES[frame.t] && !(includeState && frame.t === "state")) return;
		const index = waiters.findIndex(waiter => waiter.predicate(frame));
		const waiter = index >= 0 ? waiters.splice(index, 1)[0] : undefined;
		if (waiter) waiter.resolve(frame);
		else queue.push(frame);
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name, writeToken });
	socket.connect();
	const nextFrame = (predicate: (frame: CollabFrame) => boolean = () => true): Promise<CollabFrame> => {
		const index = queue.findIndex(predicate);
		if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]!);
		const { promise, resolve } = Promise.withResolvers<CollabFrame>();
		waiters.push({ predicate, resolve });
		return promise;
	};
	return { socket, nextFrame };
}

let host: CollabHost;
let harness: ModelHarness;
const guestCleanups: (() => void)[] = [];

beforeAll(async () => {
	installInMemoryRelay();
});

afterAll(async () => {
	for (const cleanup of guestCleanups.splice(0)) cleanup();
	await host.stop("test over");
	uninstallInMemoryRelay();
});

beforeEach(async () => {
	if (host) await host.stop("resetting between tests");
	harness = makeHostContext();
	harness.models.push(
		createMockModel({ id: "flash-lite", provider: "google", contextWindow: 1_000_000 }),
		createMockModel({ id: "opus", provider: "anthropic", contextWindow: 200_000, reasoning: true }),
	);
	host = new CollabHost(harness.ctx);
	await host.start("ws://localhost:8787");
});

afterEach(() => {
	for (const cleanup of guestCleanups.splice(0)) cleanup();
});

describe("collab session-room model frames", () => {
	it("preserves the configured auto selector independently of the effective thinking effort", async () => {
		harness.configuredThinkingLevel = "auto";
		const guest = await joinAsGuest(host.link, "thinking-browser");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		expect(welcome.state.thinkingLevel).toBe("medium");
		expect(welcome.state.configuredThinkingLevel).toBe("auto");
	});

	it("serves a discovered catalog whose selection updates the guest's active model", async () => {
		const guest = await joinAsGuest(host.link, "model-browser", true);
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		guest.socket.send({ t: "model-list" });
		const reply = await guest.nextFrame(frame => frame.t === "model-list" || frame.t === "error");
		expect(reply.t).toBe("model-list");
		// CollabFrame unions the guest `model-list` and host `model-list`
		// variants under the same discriminant; the reply is the host variant.
		if (!("models" in reply)) throw new Error("expected host model-list frame with models");
		// Background discovery settles before the list is served (cold-start providers).
		expect(harness.refreshCount).toBe(1);
		const selected = reply.models.find(model => model.provider === "google" && model.id === "flash-lite");
		if (!selected) throw new Error("expected discovered Google model");
		guest.socket.send({ t: "model-change", provider: selected.provider, id: selected.id });
		const update = await guest.nextFrame(
			frame => frame.t === "error" || (frame.t === "state" && frame.state.model?.id === selected.id),
		);
		if (update.t !== "state") throw new Error(`expected model update, got ${update.t}`);
		expect(update.state.model?.provider).toBe(selected.provider);
		expect(update.state.model?.contextWindow).toBe(1_000_000);
	});

	it("broadcasts a writable guest's model switch to another guest", async () => {
		const guest = await joinAsGuest(host.link, "model-switcher", true);
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);
		const observer = await joinAsGuest(host.viewLink, "model-observer", true);
		guestCleanups.push(() => observer.socket.close());
		const observerWelcome = await observer.nextFrame();
		if (observerWelcome.t !== "welcome") throw new Error(`expected welcome, got ${observerWelcome.t}`);

		guest.socket.send({ t: "model-change", provider: "google", id: "flash-lite" });
		// Consume the observable update, not a wall-clock delay or a mock call.
		const update = await guest.nextFrame(
			frame => frame.t === "error" || (frame.t === "state" && frame.state.model?.id === "flash-lite"),
		);
		if (update.t !== "state") throw new Error(`expected model update, got ${update.t}`);
		expect(update.state.model?.provider).toBe("google");
		const observed = await observer.nextFrame(
			frame => frame.t === "error" || (frame.t === "state" && frame.state.model?.id === "flash-lite"),
		);
		if (observed.t !== "state") throw new Error(`expected observer model update, got ${observed.t}`);
		expect(observed.state.model?.provider).toBe("google");
	});

	it("refreshes discovery once before declaring an unknown model missing", async () => {
		const guest = await joinAsGuest(host.link, "model-miss");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		guest.socket.send({ t: "model-change", provider: "openai", id: "ghost" });
		const reply = await guest.nextFrame();
		expect(reply.t).toBe("error");
		expect(harness.refreshCount).toBe(1);
		expect(harness.switched).toEqual([]);
	});

	it("rejects model-change from a read-only guest without touching the session", async () => {
		const guest = await joinAsGuest(host.viewLink, "model-viewer");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);
		expect(welcome.readOnly).toBe(true);

		guest.socket.send({ t: "model-change", provider: "google", id: "flash-lite" });
		const reply = await guest.nextFrame();
		expect(reply.t).toBe("error");
		expect(harness.switched).toEqual([]);
		expect(harness.refreshCount).toBe(0);
	});

	it("surfaces a setModel failure as a targeted error frame", async () => {
		harness.setModelError = new Error("provider session reset failed");
		const observer = await joinAsGuest(host.link, "model-observer");
		guestCleanups.push(() => observer.socket.close());
		const observerWelcome = await observer.nextFrame();
		if (observerWelcome.t !== "welcome") throw new Error(`expected welcome, got ${observerWelcome.t}`);
		const guest = await joinAsGuest(host.link, "model-fail");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		guest.socket.send({ t: "model-change", provider: "anthropic", id: "opus" });
		const reply = await guest.nextFrame();
		if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);
		expect(reply.message).toContain(harness.setModelError.message);
		expect(harness.switched).toEqual([]);
		observer.socket.send({ t: "model-list" });
		const observerReply = await observer.nextFrame();
		expect(observerReply.t).toBe("model-list");
	});

	it("changes thinking for a writable guest and rejects unsupported selectors", async () => {
		const guest = await joinAsGuest(host.link, "thinking-switcher", true);
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		guest.socket.send({ t: "thinking-change", level: "high" });
		let update = await guest.nextFrame();
		while (update.t === "state" && update.state.configuredThinkingLevel !== "high") {
			update = await guest.nextFrame();
		}
		if (update.t !== "state") throw new Error(`expected state, got ${update.t}`);
		expect(update.state.configuredThinkingLevel).toBe("high");
		expect(update.state.thinkingLevel).toBe("high");

		guest.socket.send({ t: "thinking-change", level: "max" });
		const reply = await guest.nextFrame();
		expect(reply.t).toBe("error");
		const observer = await joinAsGuest(host.link, "thinking-after-rejection");
		guestCleanups.push(() => observer.socket.close());
		const observed = await observer.nextFrame();
		if (observed.t !== "welcome") throw new Error(`expected welcome, got ${observed.t}`);
		expect(observed.state.configuredThinkingLevel).toBe("high");
		expect(observed.state.thinkingLevel).toBe("high");
	});

	it("rejects thinking changes from a read-only guest", async () => {
		const guest = await joinAsGuest(host.viewLink, "thinking-viewer");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		guest.socket.send({ t: "thinking-change", level: "low" });
		const reply = await guest.nextFrame();
		expect(reply.t).toBe("error");
		const observer = await joinAsGuest(host.link, "thinking-after-read-only");
		guestCleanups.push(() => observer.socket.close());
		const observed = await observer.nextFrame();
		if (observed.t !== "welcome") throw new Error(`expected welcome, got ${observed.t}`);
		expect(observed.state.configuredThinkingLevel).toBe(welcome.state.configuredThinkingLevel);
		expect(observed.state.thinkingLevel).toBe(welcome.state.thinkingLevel);
	});
});
