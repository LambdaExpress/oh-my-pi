/**
 * AgentLifecycleManager - Owns the idle → parked → revived lifecycle of
 * adopted subagents.
 *
 * The task executor hands a finished agent over via {@link AgentLifecycleManager.adopt};
 * from then on the manager arms a TTL timer whenever the agent goes `idle`,
 * parks it on expiry (disposes the live session, keeps the AgentRef +
 * sessionFile), and revives it on demand through
 * {@link AgentLifecycleManager.ensureLive}. Only this manager flips
 * `parked` ↔ `idle`.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID, type RegistryEvent } from "./agent-registry";

export type AgentReviver = () => Promise<AgentSession>;

/**
 * Builds a reviver for a `parked` ref restored from disk (Agent Hub scan,
 * collab mirror, resumed process) that carries a sessionFile but no in-memory
 * adoption. Returns undefined when the ref cannot be faithfully rebuilt (no
 * persisted session contract, or its workspace is gone). Injected from the
 * top-level session so this manager stays free of sdk/SessionManager imports.
 */
export type PersistedSubagentReviverFactory = (ref: AgentRef) => Promise<AgentReviver | undefined>;

export interface AdoptOptions {
	/** TTL before an idle agent is parked. <= 0 disables parking. */
	idleTtlMs: number;
	/** Recreates a live AgentSession from the ref's sessionFile. Absent => not resumable after park (e.g. isolated runs). */
	revive?: AgentReviver;
}

interface AdoptedAgent {
	idleTtlMs: number;
	revive?: AgentReviver;
	scopeId?: string;
	timer?: NodeJS.Timeout;
}

interface ParkingAgent {
	scopeId?: string;
	promise: Promise<void>;
}

interface RevivingAgent {
	scopeId?: string;
	promise: Promise<AgentSession>;
}

export class AgentLifecycleManager {
	static #global: AgentLifecycleManager | undefined;

	static global(): AgentLifecycleManager {
		if (!AgentLifecycleManager.#global) {
			AgentLifecycleManager.#global = new AgentLifecycleManager();
		}
		return AgentLifecycleManager.#global;
	}

	/** Reset the global manager. Test-only. */
	static resetGlobalForTests(): void {
		const current = AgentLifecycleManager.#global;
		if (current) {
			current.#unsubscribe?.();
			current.#unsubscribe = undefined;
			for (const adopted of current.#adopted.values()) {
				clearTimeout(adopted.timer);
			}
			current.#adopted.clear();
			current.#revivals.clear();
			current.#parking.clear();
			current.#scopeReleases.clear();
			current.#persistedReviverFactory = undefined;
		}
		AgentLifecycleManager.#global = undefined;
	}

	readonly #registry: AgentRegistry;
	readonly #adopted = new Map<string, AdoptedAgent>();
	/** Agents whose sessions are being disposed by {@link park} right now. */
	readonly #parking = new Map<string, ParkingAgent>();
	/** In-flight revives, so concurrent {@link ensureLive} calls coalesce. */
	readonly #revivals = new Map<string, RevivingAgent>();
	/** Completed promises remain cached: releasing a scope is permanently idempotent. */
	readonly #scopeReleases = new Map<string, Promise<void>>();
	#unsubscribe: (() => void) | undefined;
	#persistedReviverFactory: PersistedSubagentReviverFactory | undefined;
	/** TTL applied when a cold-revived ref is adopted on demand. */
	#persistedReviveTtlMs = 0;

	constructor(registry: AgentRegistry = AgentRegistry.global()) {
		this.#registry = registry;
		this.#unsubscribe = registry.onChange(event => this.#onRegistryEvent(event));
	}

	/**
	 * Install the factory used to cold-revive `parked` refs restored from disk
	 * (Agent Hub scan, collab mirror, resumed process) — they carry a sessionFile
	 * but no adoption. Set by the top-level session, which owns the ambient deps
	 * (auth, models, MCP, artifacts) the factory needs at revive time.
	 */
	setPersistedSubagentReviverFactory(factory: PersistedSubagentReviverFactory, idleTtlMs: number): void {
		this.#persistedReviverFactory = factory;
		this.#persistedReviveTtlMs = idleTtlMs;
	}

	/**
	 * Take ownership of a finished subagent. Caller has already set registry
	 * status to "idle". Arms the TTL timer (idleTtlMs <= 0 adopts without one).
	 * expectedScopeId guards a delayed finalize callback from adopting a
	 * replacement ref with the same id in a newer scope.
	 */
	adopt(id: string, opts: AdoptOptions, expectedScopeId?: string): void {
		if (id === MAIN_AGENT_ID) return;
		const ref = this.#registry.get(id);
		if (!ref) {
			logger.warn("AgentLifecycleManager.adopt: unknown agent id", { id });
			return;
		}
		if (expectedScopeId !== undefined && ref.scopeId !== expectedScopeId) return;
		if (this.#registry.isScopeRetired(ref.scopeId)) {
			void this.#releaseRef(ref);
			return;
		}
		const existing = this.#adopted.get(id);
		clearTimeout(existing?.timer);
		const adopted: AdoptedAgent = { idleTtlMs: opts.idleTtlMs, revive: opts.revive, scopeId: ref.scopeId };
		this.#adopted.set(id, adopted);
		this.#armTimer(id, adopted);
	}

	/** True if the id is adopted (parked or live). */
	has(id: string): boolean {
		return this.#adopted.has(id);
	}

	/** True while {@link park} is disposing this agent's session (lets dispose hooks distinguish park from teardown). */
	isParking(id: string): boolean {
		return this.#parking.has(id);
	}

	/**
	 * Dispose the live session, detach it from the registry, and mark the
	 * agent `parked`. No-op unless the id is adopted and live.
	 */
	park(id: string): Promise<void> {
		const adopted = this.#adopted.get(id);
		const ref = this.#registry.get(id);
		if (!adopted || !ref?.session) return Promise.resolve();
		if (adopted.scopeId !== ref.scopeId) {
			if (this.#adopted.get(id) === adopted) this.#adopted.delete(id);
			return Promise.resolve();
		}
		const existing = this.#parking.get(id);
		if (existing && existing.scopeId === ref.scopeId) return existing.promise;
		if (this.#registry.isScopeRetired(ref.scopeId)) return this.#releaseRef(ref);
		if (adopted.timer) {
			clearTimeout(adopted.timer);
			adopted.timer = undefined;
		}
		const parking: ParkingAgent = {
			scopeId: ref.scopeId,
			promise: this.#parkSession(id, ref, adopted),
		};
		this.#parking.set(id, parking);
		void parking.promise.finally(() => {
			if (this.#parking.get(id) === parking) this.#parking.delete(id);
		});
		return parking.promise;
	}

	/**
	 * Return the live session, reviving from the sessionFile if parked.
	 * Throws a plain Error if the id is unknown or parked without a reviver.
	 * Concurrent calls in the same scope share one in-flight revive.
	 */
	async ensureLive(id: string): Promise<AgentSession> {
		const ref = this.#registry.get(id);
		if (!ref) {
			throw new Error(
				`Unknown agent "${id}" — it was never registered or has been released. If a transcript exists, read history://${id}.`,
			);
		}
		if (this.#registry.isScopeRetired(ref.scopeId)) {
			void this.#releaseRef(ref);
			throw new Error(`Agent "${id}" belongs to retired scope "${ref.scopeId}" and cannot be revived.`);
		}
		if (ref.session) return ref.session;
		const inflight = this.#revivals.get(id);
		if (inflight && inflight.scopeId === ref.scopeId) return inflight.promise;
		const revival: RevivingAgent = {
			scopeId: ref.scopeId,
			promise: this.#resolveAndRevive(id, ref),
		};
		this.#revivals.set(id, revival);
		try {
			return await revival.promise;
		} finally {
			if (this.#revivals.get(id) === revival) this.#revivals.delete(id);
		}
	}

	/**
	 * Resolve a reviver and bring the agent back to a live session. A ref
	 * restored from disk is `parked` with a sessionFile but no in-memory
	 * adoption; build a reviver via the injected persisted-subagent factory and
	 * adopt it so the agent rejoins the normal idle↔parked lifecycle.
	 */
	async #resolveAndRevive(id: string, ref: AgentRef): Promise<AgentSession> {
		let adopted = this.#adopted.get(id);
		if (adopted?.scopeId !== ref.scopeId) adopted = undefined;
		let revive = adopted?.revive;
		let coldAdopted: AdoptedAgent | undefined;
		if (!revive && ref.status === "parked" && ref.sessionFile && this.#persistedReviverFactory) {
			revive = await this.#persistedReviverFactory(ref);
			if (this.#registry.get(id) !== ref || this.#registry.isScopeRetired(ref.scopeId)) {
				throw new Error(`Agent "${id}" was released while its reviver was being prepared.`);
			}
			if (revive) {
				coldAdopted = { idleTtlMs: this.#persistedReviveTtlMs, revive, scopeId: ref.scopeId };
				this.#adopted.set(id, coldAdopted);
			}
		}
		if (ref.status !== "parked" || !revive) {
			throw new Error(
				`Agent "${id}" is ${ref.status} and cannot be revived${revive ? "" : " (no reviver registered)"}. Its transcript remains readable at history://${id}.`,
			);
		}
		try {
			return await this.#revive(id, ref, revive);
		} catch (error) {
			// A failed cold revive must rebuild from fresh persisted context next time.
			if (coldAdopted && this.#adopted.get(id) === coldAdopted) this.#adopted.delete(id);
			throw error;
		}
	}

	/** Hard removal: dispose if live, unregister from registry, drop timers. */
	async release(id: string): Promise<void> {
		const ref = this.#registry.get(id);
		if (!ref) return;
		await this.#releaseRef(ref);
	}

	/**
	 * Permanently fence and release every non-main agent in a top-level scope.
	 * Fencing is synchronous; cleanup is idempotent and waits for in-flight
	 * park/revive work so no session can attach after the promise resolves.
	 */
	releaseScope(scopeId: string): Promise<void> {
		this.#registry.retireScope(scopeId);
		const existing = this.#scopeReleases.get(scopeId);
		if (existing) return existing;

		const revivals = new Map<string, RevivingAgent>();
		for (const [id, revival] of this.#revivals) {
			if (revival.scopeId !== scopeId) continue;
			revivals.set(id, revival);
			this.#revivals.delete(id);
		}
		for (const [id, adopted] of this.#adopted) {
			if (adopted.scopeId !== scopeId) continue;
			clearTimeout(adopted.timer);
			this.#adopted.delete(id);
		}
		const refs = this.#registry.list().filter(ref => ref.kind !== "main" && ref.scopeId === scopeId);
		const release = Promise.all(refs.map(ref => this.#releaseRef(ref, revivals.get(ref.id)))).then(() => undefined);
		this.#scopeReleases.set(scopeId, release);
		return release;
	}

	/** Teardown everything (process exit / main session dispose). */
	async dispose(): Promise<void> {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		const ids = [...this.#adopted.keys()];
		await Promise.all(ids.map(id => this.release(id)));
		this.#revivals.clear();
		this.#parking.clear();
		this.#scopeReleases.clear();
		this.#persistedReviverFactory = undefined;
	}

	async #parkSession(id: string, ref: AgentRef, adopted: AdoptedAgent): Promise<void> {
		try {
			await ref.session?.dispose();
		} catch (error) {
			logger.warn("AgentLifecycleManager.park: session dispose failed", { id, error: String(error) });
		}
		if (
			this.#registry.get(id) !== ref ||
			this.#registry.isScopeRetired(ref.scopeId) ||
			this.#adopted.get(id) !== adopted
		) {
			if (this.#registry.get(id) === ref) this.#registry.unregister(id, ref.scopeId);
			return;
		}
		this.#registry.detachSession(id, ref.scopeId);
		this.#registry.setStatus(id, "parked", ref.scopeId);
	}

	async #revive(id: string, ref: AgentRef, revive: AgentReviver): Promise<AgentSession> {
		const session = await revive();
		if (this.#registry.get(id) !== ref || this.#registry.isScopeRetired(ref.scopeId)) {
			try {
				await session.dispose();
			} catch (error) {
				logger.warn("AgentLifecycleManager.revive: stale session dispose failed", { id, error: String(error) });
			}
			throw new Error(`Agent "${id}" was released while it was being revived.`);
		}
		this.#registry.attachSession(id, session, ref.sessionFile, ref.scopeId);
		// Emits status_changed → "idle", which re-arms the TTL timer below.
		this.#registry.setStatus(id, "idle", ref.scopeId);
		return session;
	}

	async #releaseRef(ref: AgentRef, inFlightRevival?: RevivingAgent): Promise<void> {
		const adopted = this.#adopted.get(ref.id);
		if (adopted && adopted.scopeId === ref.scopeId) {
			clearTimeout(adopted.timer);
			this.#adopted.delete(ref.id);
		}

		const parking = this.#parking.get(ref.id);
		if (parking && parking.scopeId === ref.scopeId) await parking.promise;

		const revival = inFlightRevival ?? this.#revivals.get(ref.id);
		if (revival && revival.scopeId === ref.scopeId) {
			if (this.#revivals.get(ref.id) === revival) this.#revivals.delete(ref.id);
			try {
				await revival.promise;
			} catch {
				// The revive path disposes any session created after release.
			}
		}

		if (this.#registry.get(ref.id) !== ref) return;
		if (ref.session) {
			try {
				await ref.session.dispose();
			} catch (error) {
				logger.warn("AgentLifecycleManager.release: session dispose failed", { id: ref.id, error: String(error) });
			}
		}
		if (this.#registry.get(ref.id) === ref) this.#registry.unregister(ref.id, ref.scopeId);
	}

	#armTimer(id: string, adopted: AdoptedAgent): void {
		if (adopted.idleTtlMs <= 0 || this.#registry.isScopeRetired(adopted.scopeId)) return;
		clearTimeout(adopted.timer);
		const timer = setTimeout(() => {
			adopted.timer = undefined;
			if (this.#adopted.get(id) === adopted) void this.park(id);
		}, adopted.idleTtlMs);
		timer.unref?.();
		adopted.timer = timer;
	}

	#onRegistryEvent(event: RegistryEvent): void {
		const adopted = this.#adopted.get(event.ref.id);
		if (!adopted || adopted.scopeId !== event.ref.scopeId) return;
		if (event.type === "removed") {
			clearTimeout(adopted.timer);
			this.#adopted.delete(event.ref.id);
			return;
		}
		if (event.type !== "status_changed") return;
		if (event.ref.status === "running") {
			if (adopted.timer) {
				clearTimeout(adopted.timer);
				adopted.timer = undefined;
			}
		} else if (event.ref.status === "idle") {
			this.#armTimer(event.ref.id, adopted);
		}
	}
}
