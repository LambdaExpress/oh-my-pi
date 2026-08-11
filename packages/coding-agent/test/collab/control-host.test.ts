/**
 * Contract tests for the core-mode control room and session registry
 * (multi-session core): hello/list/create/resume over the control room,
 * read-only enforcement for peers without the write token, per-session agent
 * scoping in the session rooms, and the registry's failure cleanup.
 *
 * Runs over the real local relay server (dual rooms: control + a session
 * room) with real AES-GCM sealing — only AgentSession/SessionManager are
 * fakes (model is always undefined; collab never needs an LLM). The relay
 * room the initial session and any registry-created session host is real, so
 * the created deep link is provably usable by a plain guest.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ControlHost } from "@oh-my-pi/pi-coding-agent/collab/control-host";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import type { CollabHostContext } from "@oh-my-pi/pi-coding-agent/collab/host-context";
import { type LocalServer, startLocalServer } from "@oh-my-pi/pi-coding-agent/collab/local-server";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { SessionRegistry } from "@oh-my-pi/pi-coding-agent/collab/session-registry";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { Settings } from "../../src/config/settings";
import * as sdk from "../../src/sdk";
import { EventBus } from "../../src/utils/event-bus";

const GUEST_TIMEOUT_MS = 5_000;
const INITIAL_SESSION_ID = "sess-1";
const INITIAL_SESSION_CWD = "/tmp";
/** Scope of the foreign agent registered in scenario 5 — not the initial session's. */
const OTHER_SCOPE_ID = "other-scope-1";
const OTHER_AGENT_ID = "other-session-agent";

// ── Doubles ────────────────────────────────────────────────────────────────

/**
 * Minimal AgentSession double covering exactly the surface CollabHost and the
 * registry touch (see read-only.test.ts's makeHostContext): identity, the
 * state fields #buildState reads, and no-op lifecycle hooks. `model` stays
 * undefined — collab tests never need an LLM.
 */
function makeSessionDouble(scopeId: string, sessionManager: SessionManager): AgentSession {
	return {
		sessionManager,
		settings: { get: () => "" } as unknown as Settings,
		isStreaming: false,
		isAborting: false,
		queuedMessageCount: 0,
		sessionName: undefined,
		model: undefined,
		thinkingLevel: undefined,
		getAgentScopeId: () => scopeId,
		getContextUsage: () => undefined,
		subscribe: () => () => {},
		emitNotice: () => {},
		promptCustomMessage: async () => {},
		abort: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
}

/**
 * Minimal SessionManager double: identity + the replication surface the
 * CollabHost hello path reads (snapshotForReplication), plus the file
 * accessors the registry's resume/list paths use. `onEntryAppended` must be
 * writable — CollabHost.start installs its entry broadcast there.
 */
function makeSessionManagerDouble(id: string, sessionFile: string, cwd: string): SessionManager {
	return {
		getSessionId: () => id,
		getCwd: () => cwd,
		getSessionDir: () => path.dirname(sessionFile),
		getSessionFile: () => sessionFile,
		snapshotForReplication: () => ({
			header: { type: "session", id, timestamp: new Date().toISOString(), cwd },
			entries: [],
		}),
		onEntryAppended: undefined,
	} as unknown as SessionManager;
}

/** Minimal CollabHostContext double (mirrors read-only.test.ts's makeHostContext). */
function makeHostContext(session: AgentSession, sessionManager: SessionManager, eventBus: EventBus): CollabHostContext {
	return {
		settings: { get: () => "" } as unknown as Settings,
		sessionManager,
		session,
		eventBus,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		updatePendingMessagesDisplay: () => {},
		collabHost: undefined,
	} as unknown as CollabHostContext;
}

// ── Raw guest over the wire protocol (control or session room) ─────────────

interface TestGuest {
	socket: CollabSocket;
	/**
	 * Resolve with the next frame satisfying `predicate` (skipping unrelated
	 * interleaved broadcast frames), or reject on timeout. Frames are never
	 * dropped: non-matching ones stay queued for later predicates.
	 */
	nextFrame(predicate?: (frame: CollabFrame) => boolean, timeoutMs?: number): Promise<CollabFrame>;
	close(): void;
}

interface JoinRoomOptions {
	/** Send the control-room hello (ctrl-hello) instead of the session hello. */
	ctrl?: boolean;
	/**
	 * Write token for hello. undefined → derive from the link; null → omit
	 * (a read-only peer); a string → use verbatim.
	 */
	writeToken?: string | null;
}

async function joinRoom(link: string, name: string, options: JoinRoomOptions = {}): Promise<TestGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken =
		options.writeToken === null
			? undefined
			: (options.writeToken ??
				(parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined));
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const queue: CollabFrame[] = [];
	const waiters: {
		predicate: (frame: CollabFrame) => boolean;
		resolve: (frame: CollabFrame) => void;
		timer: Timer;
	}[] = [];
	socket.onFrame = frame => {
		for (let i = 0; i < waiters.length; i++) {
			const waiter = waiters[i];
			if (waiter?.predicate(frame)) {
				waiters.splice(i, 1);
				clearTimeout(waiter.timer);
				waiter.resolve(frame);
				return;
			}
		}
		queue.push(frame);
	};
	socket.onOpen = () => {
		if (options.ctrl) {
			socket.send({ t: "ctrl-hello", proto: COLLAB_PROTO, name, writeToken });
		} else {
			socket.send({ t: "hello", proto: COLLAB_PROTO, name, writeToken });
		}
	};
	socket.connect();
	const nextFrame = (
		predicate: (frame: CollabFrame) => boolean = () => true,
		timeoutMs = GUEST_TIMEOUT_MS,
	): Promise<CollabFrame> => {
		const queuedIndex = queue.findIndex(predicate);
		if (queuedIndex >= 0) {
			const [frame] = queue.splice(queuedIndex, 1);
			return Promise.resolve(frame!);
		}
		const { promise, resolve, reject } = Promise.withResolvers<CollabFrame>();
		// Hang guard only: it fires on a missing frame (a test failure) and
		// never asserts on elapsed time, so real wall-clock timing is the
		// right tool here — fake timers cannot make a live websocket deliver.
		const timer = setTimeout(() => {
			const index = waiters.findIndex(waiter => waiter.resolve === resolve);
			if (index >= 0) waiters.splice(index, 1);
			reject(new Error(`timed out after ${timeoutMs}ms waiting for a collab frame`));
		}, timeoutMs);
		waiters.push({ predicate, resolve, timer });
		return promise;
	};
	return { socket, nextFrame, close: () => socket.close() };
}

// ── Harness: registry + initial session host + control host ────────────────

interface Harness {
	registry: SessionRegistry;
	initialHost: CollabHost;
	controlHost: ControlHost;
	sessionDir: string;
}

let server: LocalServer;
let harness: Harness | undefined;
const guestCleanups: (() => void)[] = [];

async function setupHarness(): Promise<Harness> {
	const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-core-ctrl-"));
	// The initial session must be discoverable on disk so registry.list()
	// reports it (header-only → status "unknown") and resume-by-id resolves.
	const initialSessionFile = path.join(sessionDir, "initial.jsonl");
	const header = {
		type: "session",
		id: INITIAL_SESSION_ID,
		timestamp: new Date().toISOString(),
		cwd: INITIAL_SESSION_CWD,
	};
	await fs.writeFile(initialSessionFile, `${JSON.stringify(header)}\n`);

	const registry = new SessionRegistry({
		relayUrl: server.relayUrl,
		webLinkBase: server.webLinkBase,
		baseSessionOptions: {},
		sessionDir,
		agentDir: path.join(sessionDir, "agent"),
	});

	const initialManager = makeSessionManagerDouble(INITIAL_SESSION_ID, initialSessionFile, INITIAL_SESSION_CWD);
	const initialSession = makeSessionDouble(INITIAL_SESSION_ID, initialManager);
	const initialBus = new EventBus();
	const initialHost = new CollabHost(makeHostContext(initialSession, initialManager, initialBus));
	await initialHost.start(server.relayUrl, server.webLinkBase);
	const parsed = parseCollabLink(initialHost.link);
	if ("error" in parsed) throw new Error(parsed.error);
	registry.registerInitial({
		id: INITIAL_SESSION_ID,
		agentId: `session-${INITIAL_SESSION_ID}`,
		roomId: parsed.roomId,
		createdAt: new Date().toISOString(),
		session: initialSession,
		sessionManager: initialManager,
		eventBus: initialBus,
		collabHost: initialHost,
		streaming: false,
		state: "running",
	});

	const controlHost = new ControlHost(registry);
	await controlHost.start(server.relayUrl, server.webLinkBase);
	return { registry, initialHost, controlHost, sessionDir };
}

async function teardownHarness(target: Harness | undefined): Promise<void> {
	if (!target) return;
	try {
		await target.controlHost.stop("test done");
	} catch {
		// Best-effort teardown; never mask the test result.
	}
	try {
		await target.registry.stopAll();
	} catch {
		// Best-effort teardown; never mask the test result.
	}
	await fs.rm(target.sessionDir, { recursive: true, force: true });
}

/**
 * Replace createAgentSession with a double returning the shape the registry
 * consumes: a fake session whose sessionManager and agent scope come from the
 * options the registry injected (mirroring the sdk's `scopeId = agentScopeId
 * ?? sessionManager.getSessionId()`), so the provisioned CollabHost and the
 * registry's entry agree on the session id and agent scope. The registry
 * imports createAgentSession as a named export, and Bun's ESM namespace is
 * live, so spying on the module namespace intercepts the registry's calls.
 */
function spyOnCreateAgentSession(): { created: Array<{ id: string; session: AgentSession }> } {
	const created: Array<{ id: string; session: AgentSession }> = [];
	vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
		if (!options) throw new Error("test spy: expected registry-injected options");
		const manager = options.sessionManager;
		if (!manager) throw new Error("test spy: expected a registry-injected sessionManager");
		const session = makeSessionDouble(manager.getSessionId(), manager);
		created.push({ id: manager.getSessionId(), session });
		return {
			session,
			eventBus: new EventBus(),
			setToolUIContext: () => {},
			extensionsResult: {} as unknown as sdk.CreateAgentSessionResult["extensionsResult"],
			mcpManager: undefined,
		};
	});
	return { created };
}

// ── Suite ──────────────────────────────────────────────────────────────────

describe("control room + session registry (multi-session core)", () => {
	beforeAll(async () => {
		const distDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-core-ctrl-web-"));
		await fs.writeFile(path.join(distDir, "index.html"), "<html>core control test</html>");
		server = startLocalServer({ webDistDir: distDir });
	});

	afterEach(async () => {
		for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
		await teardownHarness(harness);
		harness = undefined;
		vi.restoreAllMocks();
		// The global registry is process-wide; every host subscribed to it
		// during start and unsubscribed during teardown above, so resetting
		// here leaves no listener dangling for the next test.
		AgentRegistry.resetGlobalForTests();
	});

	afterAll(() => {
		server.stop();
	});

	it("welcomes a full-control guest and lists the initial session with its link", async () => {
		harness = await setupHarness();
		const guest = await joinRoom(harness.controlHost.webLink, "writer", { ctrl: true });
		guestCleanups.push(() => guest.close());

		const welcome = await guest.nextFrame(f => f.t === "ctrl-welcome");
		if (welcome.t !== "ctrl-welcome") throw new Error(`expected ctrl-welcome, got ${welcome.t}`);
		expect(welcome.readOnly).toBeUndefined();

		guest.socket.send({ t: "ctrl-list" });
		const sessionsFrame = await guest.nextFrame(f => f.t === "ctrl-sessions");
		if (sessionsFrame.t !== "ctrl-sessions") throw new Error(`expected ctrl-sessions, got ${sessionsFrame.t}`);
		expect(sessionsFrame.sessions).toHaveLength(1);
		const initial = sessionsFrame.sessions[0]!;
		expect(initial.id).toBe(INITIAL_SESSION_ID);
		expect(initial.running).toBe(true);
		expect(initial.streaming).toBe(false);
		// Full-control peers see the live deep link of the initial session.
		expect(initial.link).toBe(harness.initialHost.webLink);
	});

	it("creates a session through the control room and its link serves a live session room", async () => {
		harness = await setupHarness();
		const { created } = spyOnCreateAgentSession();

		const guest = await joinRoom(harness.controlHost.webLink, "creator", { ctrl: true });
		guestCleanups.push(() => guest.close());
		await guest.nextFrame(f => f.t === "ctrl-welcome");

		guest.socket.send({ t: "ctrl-create" });
		const createdFrame = await guest.nextFrame(f => f.t === "ctrl-session");
		if (createdFrame.t !== "ctrl-session") throw new Error(`expected ctrl-session, got ${createdFrame.t}`);
		expect(createdFrame.op).toBe("created");
		expect(created).toHaveLength(1);
		expect(createdFrame.id).toBe(created[0]!.id);
		expect(createdFrame.link).toContain("ws://");

		// The created link must hand a plain guest a real session room.
		const sessionGuest = await joinRoom(createdFrame.link, "joiner");
		guestCleanups.push(() => sessionGuest.close());
		const sessionWelcome = await sessionGuest.nextFrame(f => f.t === "welcome");
		if (sessionWelcome.t !== "welcome") throw new Error(`expected welcome, got ${sessionWelcome.t}`);
		expect(sessionWelcome.readOnly).toBeUndefined();
	});

	it("resumes an active session with its live link and errors for unknown ids", async () => {
		harness = await setupHarness();
		const guest = await joinRoom(harness.controlHost.webLink, "resumer", { ctrl: true });
		guestCleanups.push(() => guest.close());
		await guest.nextFrame(f => f.t === "ctrl-welcome");

		// Active session: resume must hand back the live link, not reload the JSONL.
		guest.socket.send({ t: "ctrl-resume", id: INITIAL_SESSION_ID });
		const resumed = await guest.nextFrame(f => f.t === "ctrl-session");
		if (resumed.t !== "ctrl-session") throw new Error(`expected ctrl-session, got ${resumed.t}`);
		expect(resumed.op).toBe("resumed");
		expect(resumed.id).toBe(INITIAL_SESSION_ID);
		expect(resumed.link).toBe(harness.initialHost.webLink);

		guest.socket.send({ t: "ctrl-resume", id: "no-such-session" });
		const err = await guest.nextFrame(f => f.t === "ctrl-error");
		if (err.t !== "ctrl-error") throw new Error(`expected ctrl-error, got ${err.t}`);
		expect(err.message).toContain("no such session");
	});

	it("treats guests without the write token as read-only and strips session links", async () => {
		harness = await setupHarness();
		const guest = await joinRoom(harness.controlHost.webLink, "viewer", { ctrl: true, writeToken: null });
		guestCleanups.push(() => guest.close());

		const welcome = await guest.nextFrame(f => f.t === "ctrl-welcome");
		if (welcome.t !== "ctrl-welcome") throw new Error(`expected ctrl-welcome, got ${welcome.t}`);
		expect(welcome.readOnly).toBe(true);

		guest.socket.send({ t: "ctrl-create" });
		const err = await guest.nextFrame(f => f.t === "ctrl-error");
		if (err.t !== "ctrl-error") throw new Error(`expected ctrl-error, got ${err.t}`);
		expect(err.message).toBe("read-only");

		guest.socket.send({ t: "ctrl-list" });
		const sessionsFrame = await guest.nextFrame(f => f.t === "ctrl-sessions");
		if (sessionsFrame.t !== "ctrl-sessions") throw new Error(`expected ctrl-sessions, got ${sessionsFrame.t}`);
		expect(sessionsFrame.sessions).toHaveLength(1);
		// `link` never survives JSON serialization for read-only peers.
		expect(sessionsFrame.sessions[0]!.link).toBeUndefined();
	});

	it("does not expose or accept control over other sessions' agents", async () => {
		harness = await setupHarness();
		const guest = await joinRoom(harness.initialHost.link, "observer");
		guestCleanups.push(() => guest.close());
		const welcome = await guest.nextFrame(f => f.t === "welcome");
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		// An agent registered under a different session scope (multi-session
		// core registers every session in the shared process-wide registry).
		const foreignSession = { abort: async () => {}, dispose: async () => {} } as unknown as AgentSession;
		const ref = AgentRegistry.global().register({
			id: OTHER_AGENT_ID,
			displayName: "other session agent",
			kind: "sub",
			scopeId: OTHER_SCOPE_ID,
			session: foreignSession,
			sessionFile: null,
			status: "idle",
		});
		try {
			guest.socket.send({ t: "agent-cmd", cmd: "chat", agentId: OTHER_AGENT_ID, text: "hi" });
			const cmdReply = await guest.nextFrame(f => f.t === "error");
			if (cmdReply.t !== "error") throw new Error(`expected error, got ${cmdReply.t}`);
			expect(cmdReply.message).toBe("agent not in this session");

			guest.socket.send({ t: "fetch-transcript", reqId: 7, agentId: OTHER_AGENT_ID, fromByte: 0 });
			const transcript = await guest.nextFrame(f => f.t === "transcript");
			if (transcript.t !== "transcript") throw new Error(`expected transcript, got ${transcript.t}`);
			expect(transcript.reqId).toBe(7);
			expect(transcript.text).toBe("");
			expect(transcript.newSize).toBe(0);
			expect(transcript.error).toBe("no transcript available");

			// The debounced agents broadcast never mirrors the foreign ref.
			const agents = await guest.nextFrame(f => f.t === "agents");
			if (agents.t !== "agents") throw new Error(`expected agents, got ${agents.t}`);
			expect(agents.agents.map(agent => agent.id)).not.toContain(OTHER_AGENT_ID);
		} finally {
			AgentRegistry.global().unregister(OTHER_AGENT_ID, ref);
		}
	});

	it("reports ctrl-error when session creation fails and leaks no entry", async () => {
		harness = await setupHarness();
		const failedIds: string[] = [];
		vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("test spy: expected registry-injected options");
			const manager = options.sessionManager;
			if (!manager) throw new Error("test spy: expected a registry-injected sessionManager");
			failedIds.push(manager.getSessionId());
			throw new Error("provider unavailable");
		});

		const guest = await joinRoom(harness.controlHost.webLink, "creator", { ctrl: true });
		guestCleanups.push(() => guest.close());
		await guest.nextFrame(f => f.t === "ctrl-welcome");

		guest.socket.send({ t: "ctrl-create" });
		const err = await guest.nextFrame(f => f.t === "ctrl-error");
		if (err.t !== "ctrl-error") throw new Error(`expected ctrl-error, got ${err.t}`);
		expect(err.message).toContain("provider unavailable");
		expect(failedIds).toHaveLength(1);

		// No leaked entry: the failed session never registers and lazy
		// persistence means no JSONL was materialized for it either — the
		// list still shows only the initial session.
		const sessions = await harness.registry.list();
		expect(sessions.map(s => s.id)).toEqual([INITIAL_SESSION_ID]);
	});
});
