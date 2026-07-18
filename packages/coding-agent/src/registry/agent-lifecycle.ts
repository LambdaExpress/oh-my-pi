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
 *
 * Park/dispose is gated against concurrent ensureLive/hub-send:
 * - A disposing session is never handed out.
 * - ensureLive during an in-flight park either cancels the park (session still
 *   live) or waits for detach+park and then revives.
 * - Concurrent ensureLive/park operations coalesce per id.
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

interface ParkInFlight {
	scopeId?: string;
	/** Resolves when the park attempt finishes (success, cancel, or dispose error). */
	promise: Promise<void>;
	/** Cancel before the session is detached. Returns true if cancel took effect. */
	cancel: () => boolean;
	/** True once cancel() succeeded (ensureLive kept the live session). */
	cancelled: boolean;
	/** True once the live session has been detached and status is parked. */
	detached: boolean;
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
			current.#parks.clear();
			current.#scopeReleases.clear();
			current.#persistedReviverFactory = undefined;
		}
		AgentLifecycleManager.#global = undefined;
	}

	readonly #registry: AgentRegistry;
	readonly #adopted = new Map<string, AdoptedAgent>();
	/**
	 * In-flight park attempts. A park is cancelable until the live session is
	 * detached; after detach, ensureLive waits for the park and revives.
	 */
	readonly #parks = new Map<string, ParkInFlight>();
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

	/**
	 * True when this manager owns `registry` — i.e. its adopt/park/revive state
	 * describes that registry's refs. Lets a caller holding a specific registry
	 * (e.g. a custom-registry {@link IrcBus} that fell back to the global
	 * manager) skip lifecycle gating that would consult unrelated park state.
	 */
	manages(registry: AgentRegistry): boolean {
		return this.#registry === registry;
	}

	/**
	 * True while {@link park} is disposing this agent's session (lets dispose
	 * hooks distinguish park from teardown). False once the park is cancelled
	 * by ensureLive or after detach+dispose completes.
	 */
	isParking(id: string): boolean {
		const park = this.#parks.get(id);
		return Boolean(park && !park.cancelled);
	}

	/**
	 * Dispose the live session, detach it from the registry, and mark the
	 * agent `parked`. No-op unless the id is adopted and live.
	 *
	 * The session is detached (and status flipped to `parked`) *before*
	 * `session.dispose()` so concurrent {@link ensureLive}/hub-send never
	 * observe or inject into a disposing session. A concurrent ensureLive that
	 * arrives before detach cancels the park and keeps the live session.
	 */
	async park(id: string): Promise<void> {
		const existing = this.#parks.get(id);
		if (existing) return existing.promise;
		const adopted = this.#adopted.get(id);
		const ref = this.#registry.get(id);
		if (!adopted || !ref?.session) return;
		if (adopted.scopeId !== ref.scopeId) {
			if (this.#adopted.get(id) === adopted) this.#adopted.delete(id);
			return;
		}
		if (this.#registry.isScopeRetired(ref.scopeId)) return this.#releaseRef(ref);
		const session = ref.session;
		if (adopted.timer) {
			clearTimeout(adopted.timer);
			adopted.timer = undefined;
		}

		let cancelled = false;
		const park: ParkInFlight = {
			scopeId: ref.scopeId,
			promise: undefined as unknown as Promise<void>,
			cancel: () => {
				// Cancel only before detach — once detached the old session is already
				// leaving the registry and must finish disposing.
				if (park.detached || cancelled) return cancelled;
				cancelled = true;
				park.cancelled = true;
				return true;
			},
			cancelled: false,
			detached: false,
		};

		park.promise = (async () => {
			try {
				// Yield so a same-tick ensureLive/hub-send can cancel before we
				// commit to dispose. Deterministic with Promise microtasks; no timers.
				await Promise.resolve();
				if (cancelled) return;

				// Re-check liveness: release/unregister or scope replacement may have raced us.
				const live = this.#registry.get(id);
				if (!live?.session || live.session !== session || live.scopeId !== ref.scopeId) return;
				if (this.#adopted.get(id) !== adopted) return;

				// Commit: detach + parked *before* dispose so callers never see a
				// dying session via ref.session / idle status.
				park.detached = true;
				this.#registry.detachSession(id, ref.scopeId);
				this.#registry.setStatus(id, "parked", ref.scopeId);

				try {
					await session.dispose();
				} catch (error) {
					logger.warn("AgentLifecycleManager.park: session dispose failed", { id, error: String(error) });
				}
			} finally {
				// Only clear if we are still the in-flight entry (a later park would
				// have replaced us only after we resolved).
				if (this.#parks.get(id) === park) this.#parks.delete(id);
			}
		})();

		this.#parks.set(id, park);
		return park.promise;
	}

	/**
	 * Return the live session, reviving from the sessionFile if parked.
	 * Throws a plain Error if the id is unknown or parked without a reviver.
	 * Concurrent calls in the same scope share one in-flight revive.
	 *
	 * Never returns a session that is mid-dispose: an in-flight park is either
	 * cancelled (session still live) or awaited to completion before revive.
	 */
	async ensureLive(id: string): Promise<AgentSession> {
		const park = this.#parks.get(id);
		const parkRef = this.#registry.get(id);
		if (park && park.scopeId === parkRef?.scopeId) {
			const ref = this.#registry.get(id);
			// Cancel if the live session is still attached — keep it instead of
			// thrashing dispose + revive.
			if (ref?.session && !park.detached && park.cancel()) {
				await park.promise;
				const kept = this.#registry.get(id)?.session;
				if (kept) {
					// Park cleared the idle timer; re-arm so TTL park still works.
					const adopted = this.#adopted.get(id);
					if (adopted && ref.status === "idle") this.#armTimer(id, adopted);
					return kept;
				}
			} else {
				// Already committed to detach (or no live session): wait for park,
				// then fall through to the revive path.
				await park.promise;
			}
		}

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
		const adopted = this.#adopted.get(id);
		clearTimeout(adopted?.timer);
		this.#adopted.delete(id);

		const park = this.#parks.get(id);
		if (park) {
			// Prefer cancel when the session is still live so release owns dispose.
			if (!park.detached) park.cancel();
			await park.promise;
		}
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
		const ids = [...new Set([...this.#adopted.keys(), ...this.#parks.keys()])];
		await Promise.all(ids.map(id => this.release(id)));
		this.#revivals.clear();
		this.#parks.clear();
		this.#scopeReleases.clear();
		this.#persistedReviverFactory = undefined;
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

		const park = this.#parks.get(ref.id);
		if (park && park.scopeId === ref.scopeId) {
			if (!park.detached) park.cancel();
			await park.promise;
		}

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
			// Don't re-arm while a park is in flight — the park owns the transition.
			if (this.#parks.has(event.ref.id)) return;
			this.#armTimer(event.ref.id, adopted);
		}
	}
}
