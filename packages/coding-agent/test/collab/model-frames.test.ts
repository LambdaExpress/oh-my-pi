/**
 * End-to-end contract for the session-room model and thinking controls (proto v4): guests
 * request the available models with `model-list` (targeted reply after
 * background discovery settles) and switch the session model with
 * `model-change` (write-gated; unknown models and setModel failures surface
 * as targeted `error` frames; success flows through the existing state
 * broadcast). Runs over the same in-process relay + fake WebSocket transport
 * as the other collab host suites.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

interface ModelHarness {
	models: { id: string; name: string; provider: string; contextWindow: number | null }[];
	/** Number of times the host awaited background discovery. */
	refreshCount: number;
	/** Models the stub session accepted via setModel, in call order. */
	switched: { provider: string; id: string }[];
	/** Thinking selectors the stub session accepted, in call order. */
	thinkingChanges: string[];
	configuredThinkingLevel: string;
	setModelError?: Error;
	ctx: InteractiveModeContext;
}

function makeHostContext(): ModelHarness {
	const models: ModelHarness["models"] = [];
	const harness: ModelHarness = {
		models,
		refreshCount: 0,
		switched: [],
		thinkingChanges: [],
		configuredThinkingLevel: "medium",
		ctx: undefined as unknown as InteractiveModeContext,
	};
	const ctx = {
		settings: { get: () => "" },
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
			queuedMessageCount: 0,
			sessionName: "models",
			model: {
				id: "opus",
				name: "Opus",
				provider: "anthropic",
				contextWindow: 200_000,
				reasoning: true,
			},
			thinkingLevel: "medium",
			configuredThinkingLevel: () => harness.configuredThinkingLevel,
			getAvailableThinkingLevels: () => ["low", "medium", "high"],
			setThinkingLevel: (level: string) => {
				harness.configuredThinkingLevel = level;
				harness.thinkingChanges.push(level);
			},
			getAgentScopeId: () => "sess-models",
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
			modelRegistry: {
				awaitBackgroundRefresh: async () => {
					harness.refreshCount++;
				},
			},
			getAvailableModels: () => harness.models,
			setModel: async (model: { provider: string; id: string }) => {
				if (harness.setModelError) throw harness.setModelError;
				harness.switched.push({ provider: model.provider, id: model.id });
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
	nextFrame(): Promise<CollabFrame>;
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
	const waiters: ((frame: CollabFrame) => void)[] = [];
	socket.onFrame = frame => {
		if (FILTERED_FRAME_TYPES[frame.t] && !(includeState && frame.t === "state")) return;
		const waiter = waiters.shift();
		if (waiter) waiter(frame);
		else queue.push(frame);
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name, writeToken });
	socket.connect();
	const nextFrame = (): Promise<CollabFrame> => {
		const queued = queue.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<CollabFrame>();
		waiters.push(resolve);
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
		{ id: "flash-lite", name: "Flash Lite", provider: "google", contextWindow: 1_000_000 },
		{ id: "opus", name: "Opus", provider: "anthropic", contextWindow: 200_000 },
	);
	host = new CollabHost(harness.ctx);
	await host.start("ws://localhost:8787");
});

afterEach(() => {
	for (const cleanup of guestCleanups.splice(0)) cleanup();
});

describe("collab session-room model frames", () => {
	it("advertises the current configured thinking selector and model-supported choices", async () => {
		const guest = await joinAsGuest(host.link, "thinking-browser");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		expect(welcome.state.thinkingLevel).toBe("medium");
		expect(welcome.state.configuredThinkingLevel).toBe("medium");
		expect(welcome.state.availableThinkingLevels).toEqual(["off", "auto", "low", "medium", "high"]);
	});

	it("replies to model-list with the available models mapped to wire shape after discovery", async () => {
		const guest = await joinAsGuest(host.link, "model-browser");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		guest.socket.send({ t: "model-list" });
		const reply = await guest.nextFrame();
		expect(reply.t).toBe("model-list");
		// CollabFrame unions the guest `model-list` and host `model-list`
		// variants under the same discriminant; the reply is the host variant.
		if (!("models" in reply)) throw new Error("expected host model-list frame with models");
		// Background discovery settles before the list is served (cold-start providers).
		expect(harness.refreshCount).toBe(1);
		expect(reply.models).toEqual([
			{ id: "flash-lite", name: "Flash Lite", provider: "google", contextWindow: 1_000_000 },
			{ id: "opus", name: "Opus", provider: "anthropic", contextWindow: 200_000 },
		]);
	});

	it("switches the session model for a writable guest and never answers with an error", async () => {
		const guest = await joinAsGuest(host.link, "model-switcher");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		guest.socket.send({ t: "model-change", provider: "google", id: "flash-lite" });
		// Success has no dedicated reply frame; the state broadcast carries the
		// new model. Let the debounced broadcast + any (unexpected) error land.
		await Bun.sleep(200);
		expect(harness.switched).toEqual([{ provider: "google", id: "flash-lite" }]);
	});

	it("refreshes discovery once before declaring an unknown model missing", async () => {
		const guest = await joinAsGuest(host.link, "model-miss");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		guest.socket.send({ t: "model-change", provider: "openai", id: "ghost" });
		const reply = await guest.nextFrame();
		expect(reply).toEqual({ t: "error", message: "Model not found: openai/ghost" });
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
		expect(reply).toEqual({ t: "error", message: "changing the model is disabled on a read-only link" });
		expect(harness.switched).toEqual([]);
		expect(harness.refreshCount).toBe(0);
	});

	it("surfaces a setModel failure as a targeted error frame", async () => {
		harness.setModelError = new Error("provider session reset failed");
		const guest = await joinAsGuest(host.link, "model-fail");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		guest.socket.send({ t: "model-change", provider: "anthropic", id: "opus" });
		const reply = await guest.nextFrame();
		expect(reply).toEqual({ t: "error", message: "Error: provider session reset failed" });
		expect(harness.switched).toEqual([]);
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
		expect(harness.thinkingChanges).toEqual(["high"]);

		guest.socket.send({ t: "thinking-change", level: "max" });
		const reply = await guest.nextFrame();
		expect(reply).toEqual({ t: "error", message: "Thinking level not supported by the current model: max" });
		expect(harness.thinkingChanges).toEqual(["high"]);
	});

	it("rejects thinking changes from a read-only guest", async () => {
		const guest = await joinAsGuest(host.viewLink, "thinking-viewer");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		guest.socket.send({ t: "thinking-change", level: "low" });
		const reply = await guest.nextFrame();
		expect(reply).toEqual({ t: "error", message: "changing thinking is disabled on a read-only link" });
		expect(harness.thinkingChanges).toEqual([]);
	});
});
