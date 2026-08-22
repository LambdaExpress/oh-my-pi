/**
 * Process-wide session registry for core mode.
 *
 * Owns every concurrent {@link ManagedSession} in the process — the initial
 * session adopted at startup plus sessions created or resumed through the
 * control room — and answers list/create/resume/drop queries from a single
 * in-memory table merged with the on-disk session directory. Concurrency is
 * deliberately unbounded (provider/rate limits are the natural backpressure);
 * the registry only guarantees one live writer per JSONL file.
 */

import * as path from "node:path";
import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../async";
import { MCPManager } from "../mcp";
// Cyclic import with ../modes/core-mode (core-mode will import this registry
// to run it). Safe: the binding is only invoked at call time inside
// #provisionSession, long after both modules finished evaluating.
import { createHeadlessCollabContext } from "../modes/core-mode";
import { type CreateAgentSessionOptions, createAgentSession } from "../sdk";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { listSessions, resolveResumableSession } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";
import { FileSessionStorage } from "../session/session-storage";
import { EventBus } from "../utils/event-bus";
import { CollabHost } from "./host";
import { parseCollabLink, type SessionSummary } from "./protocol";

/** One live session tracked by the registry. */
export interface ManagedSession {
	/** SessionManager.getSessionId() — the session header id. */
	id: string;
	/** `session-${id}` — the agent-registry identity for this session. */
	agentId: string;
	/** Collab room id (parsed from the host link after start). */
	roomId: string;
	/** Registration time, ISO string; stands in for the disk `createdAt` before the first JSONL append. */
	createdAt: string;
	session: AgentSession;
	sessionManager: SessionManager;
	eventBus: EventBus;
	collabHost: CollabHost;
	/** Whether the session is currently streaming a response. */
	streaming: boolean;
	/** "dropping" marks a session mid-teardown; it rejects further operations. */
	state: "running" | "dropping";
}

export interface SessionRegistryOptions {
	relayUrl: string;
	webLinkBase: string;
	/**
	 * Options shared by every created session. The registry injects the
	 * per-session fields (sessionManager/eventBus/agentId/asyncJobManager/
	 * mcpManager) itself, so this MUST NOT carry session-bound values such as
	 * `preloadedExtensions` (Extension instances close over a parent's cwd and
	 * event bus; reusing them across sessions routes tools back to the parent).
	 */
	baseSessionOptions: CreateAgentSessionOptions;
	/** Session directory; falls back to the default for {@link cwd} when empty. */
	sessionDir: string;
	agentDir: string;
}

export class SessionRegistry {
	readonly #relayUrl: string;
	readonly #webLinkBase: string;
	readonly #baseSessionOptions: CreateAgentSessionOptions;
	readonly #sessionDir: string;
	readonly #cwd: string;
	/** Active sessions in registration order; entries stay until fully torn down. */
	readonly #active = new Map<string, ManagedSession>();
	/** Streaming subscriptions per session id, removed on drop/shutdown. */
	readonly #streamingUnsubs = new Map<string, () => void>();
	readonly #listeners = new Set<() => void>();

	constructor(options: SessionRegistryOptions) {
		this.#relayUrl = options.relayUrl;
		this.#webLinkBase = options.webLinkBase;
		this.#baseSessionOptions = options.baseSessionOptions;
		this.#cwd = options.baseSessionOptions.cwd ?? getProjectDir();
		this.#sessionDir = options.sessionDir || SessionManager.getDefaultSessionDir(this.#cwd, options.agentDir);
	}

	/**
	 * Adopt the session core mode created at startup. The caller already built
	 * the AgentSession and started its CollabHost; this installs the same
	 * streaming tracking used for registry-created sessions.
	 */
	registerInitial(managed: ManagedSession): void {
		if (this.#active.has(managed.id)) {
			throw new Error(`session already registered: ${managed.id}`);
		}
		managed.createdAt = new Date().toISOString();
		managed.streaming = managed.session.isStreaming;
		managed.state = "running";
		this.#active.set(managed.id, managed);
		this.#streamingUnsubs.set(
			managed.id,
			managed.session.subscribe(event => this.#onSessionEventFor(managed, event)),
		);
		this.#emitChange();
	}

	/** Create a brand-new persisted session and start its collab host. */
	async createSession(): Promise<{ id: string; link: string }> {
		const sessionManager = SessionManager.create(this.#cwd, this.#sessionDir);
		return await this.#provisionSession(sessionManager);
	}

	/**
	 * Resume a persisted session by id, filename prefix, or JSONL path.
	 *
	 * Refuses to load a JSONL an active session already owns (a second writer
	 * would race the live one); a matching active session returns its live
	 * link instead.
	 */
	async resumeSession(idOrPath: string): Promise<{ id: string; link: string }> {
		let resolvedPath: string;
		if (idOrPath.includes("/") || idOrPath.includes("\\") || idOrPath.endsWith(".jsonl")) {
			// Direct path argument (mirrors main.ts resume handling).
			resolvedPath = path.resolve(idOrPath);
		} else {
			const match = await resolveResumableSession(idOrPath, this.#cwd, this.#sessionDir);
			if (!match) throw new Error("no such session");
			resolvedPath = path.resolve(match.session.path);
		}

		// File equality is the dedupe key: it also covers id-style arguments,
		// since resolveResumableSession maps ids onto paths above.
		for (const entry of this.#active.values()) {
			const file = entry.sessionManager.getSessionFile();
			if (!file || path.resolve(file) !== resolvedPath) continue;
			if (entry.state === "dropping") throw new Error("no such session");
			return { id: entry.id, link: entry.collabHost.webLink };
		}

		const sessionManager = await SessionManager.open(resolvedPath, this.#sessionDir);
		return await this.#provisionSession(sessionManager);
	}

	/**
	 * Drop a live session: tear down its collab host and dispose the session.
	 *
	 * The entry flips to "dropping" first so it leaves list() broadcasts
	 * immediately and concurrent create/resume/drop for the same id throw
	 * until the teardown finishes.
	 */
	async dropSession(id: string): Promise<void> {
		const entry = this.#active.get(id);
		if (!entry || entry.state === "dropping") throw new Error("no such session");
		entry.state = "dropping";
		try {
			await entry.collabHost.stop("session dropped");
		} catch (err) {
			logger.warn("failed to stop collab host while dropping session", { id, error: String(err) });
		}
		try {
			await entry.session.dispose();
		} catch (err) {
			logger.warn("failed to dispose session while dropping", { id, error: String(err) });
		}
		this.#streamingUnsubs.get(id)?.();
		this.#streamingUnsubs.delete(id);
		this.#active.delete(id);
		this.#emitChange();
	}

	/** List all sessions (disk + live), newest first by modification time. */
	async list(): Promise<SessionSummary[]> {
		const infos = await listSessions(this.#sessionDir, new FileSessionStorage());
		const summaries: SessionSummary[] = [];
		for (const info of infos) {
			const active = this.#active.get(info.id);
			// Dropping sessions are invisible until the drop completes.
			if (active && active.state === "dropping") continue;
			const summary: SessionSummary = {
				id: info.id,
				title: info.title,
				cwd: info.cwd,
				createdAt: info.created.toISOString(),
				modifiedAt: info.modified.toISOString(),
				messageCount: info.messageCount,
				status: info.status,
				running: active !== undefined && active.state === "running",
				streaming: active?.streaming ?? false,
			};
			// The link is only exposed for live sessions; disk-only sessions
			// must be resumed through the control room first.
			if (active) summary.link = active.collabHost.webLink;
			summaries.push(summary);
		}
		summaries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
		return summaries;
	}

	/** Tear down every session in reverse registration order. Never throws. */
	async stopAll(): Promise<void> {
		const entries = [...this.#active.values()].reverse();
		for (const entry of entries) {
			try {
				await entry.collabHost.stop("core shutdown");
			} catch (err) {
				logger.warn("failed to stop collab host during shutdown", { id: entry.id, error: String(err) });
			}
			try {
				await entry.session.dispose();
			} catch (err) {
				logger.warn("failed to dispose session during shutdown", { id: entry.id, error: String(err) });
			}
		}
		for (const unsubscribe of this.#streamingUnsubs.values()) {
			try {
				unsubscribe();
			} catch (err) {
				logger.warn("failed to remove streaming listener during shutdown", { error: String(err) });
			}
		}
		this.#streamingUnsubs.clear();
		this.#active.clear();
	}

	/** Subscribe to list changes and streaming flips. Returns an unsubscribe. */
	onSessionEvent(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/**
	 * Create the AgentSession + CollabHost for a (fresh or reopened) session
	 * manager, start the host, and register the entry.
	 */
	async #provisionSession(sessionManager: SessionManager): Promise<{ id: string; link: string }> {
		const id = sessionManager.getSessionId();
		const agentId = `session-${id}`;
		const eventBus = new EventBus();
		let host: CollabHost | undefined;
		let session: AgentSession | undefined;
		try {
			const result = await createAgentSession({
				...this.#baseSessionOptions,
				sessionManager,
				eventBus,
				agentId,
				// Shared process singletons: every core session talks to the same
				// async-job manager and MCP manager. When the MCP instance is
				// undefined the sdk's setInstance gate guarantees only the first
				// top-level session becomes the global instance.
				asyncJobManager: AsyncJobManager.instance(),
				mcpManager: MCPManager.instance() ?? undefined,
			});
			session = result.session;
			host = new CollabHost(createHeadlessCollabContext(session, eventBus));
			await host.start(this.#relayUrl, this.#webLinkBase);
		} catch (err) {
			await this.#cleanupFailedProvision(host, session);
			throw err;
		}

		const parsed = parseCollabLink(host.link);
		if ("error" in parsed) {
			// Unreachable in practice: host.start() already parsed the same link.
			await this.#cleanupFailedProvision(host, session);
			throw new Error(parsed.error);
		}

		const entry: ManagedSession = {
			id,
			agentId,
			roomId: parsed.roomId,
			createdAt: new Date().toISOString(),
			session,
			sessionManager,
			eventBus,
			collabHost: host,
			streaming: session.isStreaming,
			state: "running",
		};
		this.#active.set(id, entry);
		this.#streamingUnsubs.set(
			id,
			session.subscribe(event => this.#onSessionEventFor(entry, event)),
		);
		this.#emitChange();
		return { id, link: host.webLink };
	}

	/** Idempotent best-effort teardown after a failed provision; never throws. */
	async #cleanupFailedProvision(host: CollabHost | undefined, session: AgentSession | undefined): Promise<void> {
		try {
			await host?.stop("create failed");
		} catch (err) {
			logger.warn("failed to stop collab host after session creation error", { error: String(err) });
		}
		try {
			await session?.dispose();
		} catch (err) {
			logger.warn("failed to dispose session after creation error", { error: String(err) });
		}
	}

	/** Flip an entry's streaming flag on agent_start/agent_end and notify. */
	#onSessionEventFor(entry: ManagedSession, event: AgentSessionEvent): void {
		if (event.type !== "agent_start" && event.type !== "agent_end") return;
		const streaming = event.type === "agent_start";
		if (entry.streaming === streaming) return;
		entry.streaming = streaming;
		this.#emitChange();
	}

	#emitChange(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch (err) {
				logger.warn("session registry change listener error", { error: String(err) });
			}
		}
	}
}
