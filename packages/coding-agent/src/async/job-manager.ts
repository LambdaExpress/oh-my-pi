import { logger } from "@oh-my-pi/pi-utils";

const DELIVERY_RETRY_BASE_MS = 500;
const DELIVERY_RETRY_MAX_MS = 30_000;
const DELIVERY_RETRY_JITTER_MS = 200;
const DEFAULT_RETENTION_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RUNNING_JOBS = 15;
/** Abort reason used only when the owning session shuts down the entire manager. */
export const ASYNC_JOB_MANAGER_SHUTDOWN_REASON = Symbol("AsyncJobManager shutdown");

/**
 * Adaptive ("smart") `hub` poll-wait ladder (ms). A tight poll loop climbs
 * these rungs so each immediate re-poll backs off and stops spending turns on
 * "still running" frames; the floor (first rung) is the shortest wait and the
 * top rung is the longest a smart poll will ever block. Only used when
 * `async.pollWaitDuration` is set to `smart`; fixed durations wait verbatim.
 */
const POLL_WAIT_LADDER_MS = [5_000, 10_000, 30_000, 60_000, 300_000] as const;
/**
 * Going at least this long between poll calls means the agent stepped out of
 * the poll loop to do real work — the next poll drops back to the ladder floor.
 */
const POLL_ESCALATION_RESET_MS = 60_000;

interface PollEscalationState {
	/** Index into POLL_WAIT_LADDER_MS used for the most recent poll wait. */
	level: number;
	/** Timestamp (ms) when the most recent poll wait returned. */
	lastPollEndAt: number;
	/** Session scope whose poll ladder this state belongs to. */
	scopeId?: string;
}

export interface AsyncJobProgress {
	text: string;
	details?: Record<string, unknown>;
	updatedAt: number;
}

/** Kind of work a managed job runs; drives job-row badges and delivery labels. */
export type AsyncJobType = "bash" | "task" | "ssh_transfer" | "eval";

export interface AsyncJob {
	id: string;
	type: AsyncJobType;
	status: "running" | "completed" | "failed" | "cancelled";
	startTime: number;
	/** Absolute command deadline; absent when the job has no deadline. */
	deadlineAt?: number;
	label: string;
	abortController: AbortController;
	promise: Promise<void>;
	resultText?: string;
	errorText?: string;
	toolCallId?: string;
	progress?: AsyncJobProgress;
	settledAt?: number;
	/** Latest tool-render details reported by the running job. */
	latestDetails?: Record<string, unknown>;
	/**
	 * Registry id of the agent that registered the job (e.g. "Main",
	 * "AuthLoader"). Used by scoped cancel/list APIs so a subagent's teardown
	 * does not cancel its parent's jobs. Undefined for callers that don't
	 * supply an id (e.g. legacy tests, SDK consumers without an agent context).
	 */
	ownerId?: string;
	/** Top-level Main session UUID inherited unchanged by child agents. */
	scopeId?: string;
	/**
	 * Registry id of the subagent this job runs (task/tan/vibe jobs). Lets
	 * job-view code link a job row to its AgentRegistry ref even when the job
	 * id differs from the agent id (vibe turn jobs, tan clones).
	 */
	agentId?: string;
	/**
	 * Job is registered but parked behind a caller-managed gate (e.g. a task
	 * batch semaphore). Queued jobs do not count toward the running-job limit
	 * until the caller invokes `markRunning()` from the run context.
	 */
	queued?: boolean;
}

/** Delivery callback for a settled job's result text. */
export type AsyncJobDeliverySink = (jobId: string, text: string, job?: AsyncJob) => void | Promise<void>;

export interface AsyncJobManagerOptions {
	/**
	 * Delivery sink for UNOWNED completions (jobs registered without an
	 * `ownerId`). Owned deliveries route exclusively through
	 * {@link AsyncJobManager.registerDeliverySink}; when the owner has no live
	 * sink they are dead-lettered (dropped with a warning; the job row keeps
	 * the result text until retention eviction) — never routed here, which
	 * would leak one agent's result into another session.
	 */
	onJobComplete?: AsyncJobDeliverySink;
	maxRunningJobs?: number;
	retentionMs?: number;
}

interface AsyncJobDelivery {
	jobId: string;
	text: string;
	type: AsyncJobType;
	attempt: number;
	nextAttemptAt: number;
	lastError?: string;
	ownerId?: string;
	scopeId?: string;
	promise?: Promise<void>;
}

export interface AsyncJobDeliveryState {
	queued: number;
	delivering: boolean;
	nextRetryAt?: number;
	pendingJobIds: string[];
}

export interface AsyncJobReapResult {
	settled: boolean;
	pendingJobIds: string[];
	completion: Promise<void>;
}

export interface AsyncJobRegisterOptions {
	id?: string;
	toolCallId?: string;
	/** Job deadline relative to registration; zero or undefined means no deadline. */
	timeoutMs?: number;
	/** Registry id of the agent that owns this job; used to scope cancelAll. */
	ownerId?: string;
	/** Top-level Main session UUID inherited unchanged by child agents. */
	scopeId?: string;
	/** Registry id of the subagent this job runs; see {@link AsyncJob.agentId}. */
	agentId?: string;
	onProgress?: (text: string, details?: Record<string, unknown>) => void | Promise<void>;
	/** Register the job in queued state; see {@link AsyncJob.queued}. */
	queued?: boolean;
}

/**
 * Filter applied to job query/cancel/delivery APIs. Every provided field must
 * match, so owner and session scope constraints compose conjunctively. A
 * `scopeId` of `null` matches jobs registered WITHOUT a scope (legacy/SDK
 * registrations); an omitted `scopeId` leaves the scope unconstrained.
 */
export interface AsyncJobFilter {
	ownerId?: string;
	scopeId?: string | null;
	type?: AsyncJobType;
}

export class AsyncJobManager {
	static #instance: AsyncJobManager | undefined;

	/** Process-global instance shared by internal URL protocol handlers and tools. */
	static instance(): AsyncJobManager | undefined {
		return AsyncJobManager.#instance;
	}

	/** Install or clear the process-global instance. */
	static setInstance(value: AsyncJobManager | undefined): void {
		AsyncJobManager.#instance = value;
	}

	/** Reset the process-global instance. Test-only. */
	static resetForTests(): void {
		AsyncJobManager.#instance = undefined;
	}

	readonly #jobs = new Map<string, AsyncJob>();
	readonly #deliveries: AsyncJobDelivery[] = [];
	readonly #inFlightDeliveries: AsyncJobDelivery[] = [];
	readonly #suppressedDeliveries = new Set<string>();
	readonly #watchedJobs = new Set<string>();
	readonly #evictionTimers = new Map<string, NodeJS.Timeout>();
	readonly #pollEscalation = new Map<string | undefined, PollEscalationState>();
	readonly #retiredScopes = new Set<string>();
	readonly #scopeRetirements = new Map<string, Promise<void>>();
	readonly #jobChangeListeners = new Set<(job: Readonly<AsyncJob>) => void>();
	readonly #deliverySinks = new Map<string, AsyncJobDeliverySink>();
	readonly #onJobComplete: AsyncJobManagerOptions["onJobComplete"];
	readonly #maxRunningJobs: number;
	readonly #retentionMs: number;
	#deliveryLoop: Promise<void> | undefined;
	#deliveryQueueChanged = Promise.withResolvers<void>();
	#disposed = false;

	#matchesFilter(
		value: { ownerId?: string; scopeId?: string; type?: AsyncJobType },
		filter?: AsyncJobFilter,
	): boolean {
		if (filter?.ownerId !== undefined && value.ownerId !== filter.ownerId) return false;
		if (filter?.scopeId !== undefined) {
			if (filter.scopeId === null) {
				if (value.scopeId !== undefined) return false;
			} else if (value.scopeId !== filter.scopeId) {
				return false;
			}
		}
		if (filter?.type !== undefined && value.type !== filter.type) return false;
		return true;
	}

	#filterJobs(jobs: Iterable<AsyncJob>, filter?: AsyncJobFilter): AsyncJob[] {
		const out: AsyncJob[] = [];
		for (const job of jobs) {
			if (this.#matchesFilter(job, filter)) out.push(job);
		}
		return out;
	}

	constructor(options: AsyncJobManagerOptions) {
		this.#onJobComplete = options.onJobComplete;
		this.#maxRunningJobs = Math.max(1, Math.floor(options.maxRunningJobs ?? DEFAULT_MAX_RUNNING_JOBS));
		this.#retentionMs = Math.max(0, Math.floor(options.retentionMs ?? DEFAULT_RETENTION_MS));
	}

	onJobChange(listener: (job: Readonly<AsyncJob>) => void): () => void {
		this.#jobChangeListeners.add(listener);
		return () => {
			this.#jobChangeListeners.delete(listener);
		};
	}

	#notifyJobChange(job: AsyncJob): void {
		for (const listener of this.#jobChangeListeners) {
			try {
				listener(job);
			} catch (error) {
				logger.warn("Async job change listener failed", {
					jobId: job.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	/** True when the running-job count has reached the configured cap. */
	get atCapacity(): boolean {
		if (this.#disposed) return true;
		// Mirror register(): queued jobs hold no execution slot.
		let activeCount = 0;
		for (const job of this.#jobs.values()) {
			if ((job.status === "running" || (job.status === "cancelled" && job.settledAt === undefined)) && !job.queued) {
				activeCount++;
			}
		}
		return activeCount >= this.#maxRunningJobs;
	}

	register(
		type: AsyncJobType,
		label: string,
		run: (ctx: {
			jobId: string;
			signal: AbortSignal;
			reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
			/** Clear the queued flag once the job actually starts executing. */
			markRunning: () => void;
		}) => Promise<string>,
		options?: AsyncJobRegisterOptions,
	): string {
		if (this.#disposed) {
			throw new Error("Async job manager is disposed");
		}
		if (options?.scopeId !== undefined && this.#retiredScopes.has(options.scopeId)) {
			throw new Error(`Async job scope is retired: ${options.scopeId}`);
		}
		let activeCount = 0;
		for (const existing of this.#jobs.values()) {
			if (
				(existing.status === "running" || (existing.status === "cancelled" && existing.settledAt === undefined)) &&
				!existing.queued
			) {
				activeCount++;
			}
		}
		if (activeCount >= this.#maxRunningJobs) {
			throw new Error(
				`Background job limit reached (${this.#maxRunningJobs}). Wait for running jobs to finish or cancel one.`,
			);
		}

		const id = this.#resolveJobId(options?.id);
		this.#suppressedDeliveries.delete(id);
		const abortController = new AbortController();
		const startTime = Date.now();
		const timeoutMs = options?.timeoutMs;
		const job: AsyncJob = {
			id,
			type,
			status: "running",
			startTime,
			...(timeoutMs !== undefined && timeoutMs > 0 ? { deadlineAt: startTime + timeoutMs } : {}),
			label,
			abortController,
			promise: Promise.resolve(),
			toolCallId: options?.toolCallId,
			ownerId: options?.ownerId,
			scopeId: options?.scopeId,
			agentId: options?.agentId,
			queued: options?.queued === true,
		};
		this.#jobs.set(id, job);
		this.#notifyJobChange(job);

		const reportProgress = async (text: string, details?: Record<string, unknown>): Promise<void> => {
			if (job.scopeId !== undefined && this.#retiredScopes.has(job.scopeId)) return;
			job.progress = { text, details, updatedAt: Date.now() };
			if (details) job.latestDetails = details;
			this.#notifyJobChange(job);
			if (!options?.onProgress) return;
			try {
				await options.onProgress(text, details);
			} catch (error) {
				logger.warn("Async job progress callback failed", {
					jobId: id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		};
		job.promise = (async () => {
			try {
				const text = await run({
					jobId: id,
					signal: abortController.signal,
					reportProgress,
					markRunning: () => {
						if (job.status === "running") {
							job.queued = false;
							this.#notifyJobChange(job);
						}
					},
				});
				job.resultText = text;
				if (job.status !== "cancelled") job.status = "completed";
				job.settledAt = Date.now();
				this.#notifyJobChange(job);
				if (job.status !== "cancelled" || job.type === "ssh_transfer") this.#enqueueDelivery(id, text);
				this.#scheduleEviction(id);
			} catch (error) {
				const errorText = error instanceof Error ? error.message : String(error);
				job.errorText = errorText;
				if (job.status !== "cancelled") job.status = "failed";
				job.settledAt = Date.now();
				this.#notifyJobChange(job);
				if (job.status !== "cancelled" || job.type === "ssh_transfer") this.#enqueueDelivery(id, errorText);
				this.#scheduleEviction(id);
			}
		})();

		return id;
	}

	/**
	 * Cancel a single job by id. When a provided filter field does not match,
	 * the call is treated as not-found so cross-owner and cross-scope
	 * cancellation is rejected at the manager boundary.
	 */
	cancel(id: string, filter?: AsyncJobFilter): boolean {
		const job = this.#jobs.get(id);
		if (!job) return false;
		if (!this.#matchesFilter(job, filter)) return false;
		if (job.status !== "running") return false;
		job.status = "cancelled";
		job.abortController.abort();
		this.#notifyJobChange(job);
		return true;
	}

	getJob(id: string): AsyncJob | undefined {
		return this.#jobs.get(id);
	}

	getRunningJobs(filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter).filter(job => job.status === "running");
	}

	getRecentJobs(limit = 10, filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter)
			.filter(job => job.status !== "running" && !(job.status === "cancelled" && job.settledAt === undefined))
			.sort((a, b) => b.startTime - a.startTime)
			.slice(0, limit);
	}

	getAllJobs(filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter);
	}

	/**
	 * The session-owned job view: jobs of the session scope plus unscoped jobs
	 * of the owning agent. A job registered without an explicit scopeId belongs
	 * to its owner's top-level session, so it must stay visible there even
	 * though the conjunctive {@link AsyncJobFilter} cannot express that union.
	 */
	getSessionJobs(ownerId: string | undefined, scopeId: string): AsyncJob[] {
		const ownerFilter = ownerId !== undefined ? { ownerId } : undefined;
		const scoped = this.#filterJobs(this.#jobs.values(), { ...(ownerFilter ?? {}), scopeId });
		if (ownerFilter === undefined) return scoped;
		const unscopedOwner = this.#filterJobs(this.#jobs.values(), ownerFilter).filter(job => job.scopeId === undefined);
		return [...scoped, ...unscopedOwner];
	}

	/** Session-owned settled jobs, most recent first. See {@link getSessionJobs}. */
	getSessionRecentJobs(ownerId: string | undefined, scopeId: string, limit: number): AsyncJob[] {
		return this.getSessionJobs(ownerId, scopeId)
			.filter(job => job.status !== "running" && !(job.status === "cancelled" && job.settledAt === undefined))
			.sort((a, b) => b.startTime - a.startTime)
			.slice(0, limit);
	}

	/** Session-owned delivery state. See {@link getSessionJobs}. */
	getSessionDeliveryState(ownerId: string | undefined, scopeId: string): AsyncJobDeliveryState {
		const ownerFilter = ownerId !== undefined ? { ownerId } : undefined;
		const scopedFilter = { ...(ownerFilter ?? {}), scopeId };
		const deliveries = [
			...this.#filterDeliveries(scopedFilter),
			...(ownerFilter !== undefined
				? this.#filterDeliveries(ownerFilter).filter(delivery => delivery.scopeId === undefined)
				: []),
		];
		const inFlightDeliveries = [
			...this.#filterInFlightDeliveries(scopedFilter),
			...(ownerFilter !== undefined
				? this.#filterInFlightDeliveries(ownerFilter).filter(delivery => delivery.scopeId === undefined)
				: []),
		];
		const nextRetryAt = deliveries.reduce<number | undefined>((next, delivery) => {
			if (next === undefined) return delivery.nextAttemptAt;
			return Math.min(next, delivery.nextAttemptAt);
		}, undefined);

		return {
			queued: deliveries.length + inFlightDeliveries.length,
			delivering: inFlightDeliveries.length > 0 || (this.#deliveryLoop !== undefined && deliveries.length > 0),
			nextRetryAt,
			pendingJobIds: deliveries.concat(inFlightDeliveries).map(delivery => delivery.jobId),
		};
	}

	getDeliveryState(filter?: AsyncJobFilter): AsyncJobDeliveryState {
		const deliveries = this.#filterDeliveries(filter);
		const inFlightDeliveries = this.#filterInFlightDeliveries(filter);
		const nextRetryAt = deliveries.reduce<number | undefined>((next, delivery) => {
			if (next === undefined) return delivery.nextAttemptAt;
			return Math.min(next, delivery.nextAttemptAt);
		}, undefined);

		return {
			queued: deliveries.length + inFlightDeliveries.length,
			delivering: inFlightDeliveries.length > 0 || (this.#deliveryLoop !== undefined && deliveries.length > 0),
			nextRetryAt,
			pendingJobIds: deliveries.concat(inFlightDeliveries).map(delivery => delivery.jobId),
		};
	}

	hasPendingDeliveries(filter?: AsyncJobFilter): boolean {
		return this.getDeliveryState(filter).queued > 0;
	}

	watchJobs(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		for (const jobId of uniqueJobIds) {
			this.#watchedJobs.add(jobId);
		}
		this.#notifyDeliveryQueueChanged();
		return uniqueJobIds.length;
	}

	unwatchJobs(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		let removed = 0;
		for (const jobId of uniqueJobIds) {
			if (this.#watchedJobs.delete(jobId)) {
				removed += 1;
			}
		}
		return removed;
	}

	/**
	 * Compute the next adaptive ("smart") wait (ms) for a blocking `hub` wait by
	 * the given owner/session-scope pair. Consecutive polls — those starting
	 * within POLL_ESCALATION_RESET_MS of the previous poll returning — climb
	 * POLL_WAIT_LADDER_MS so a tight wait loop backs off; a longer gap means the
	 * agent left to do real work, so the wait resets to the floor. Pair each call
	 * with `recordPollWaitEnd()` using the same scope once the wait returns.
	 */
	nextPollWaitMs(ownerId: string | undefined, now: number = Date.now(), scopeId?: string): number {
		const key = JSON.stringify([ownerId, scopeId]);
		const prev = this.#pollEscalation.get(key);
		const reset = !prev || now - prev.lastPollEndAt >= POLL_ESCALATION_RESET_MS;
		const level = reset ? 0 : Math.min(prev.level + 1, POLL_WAIT_LADDER_MS.length - 1);
		this.#pollEscalation.set(key, { level, lastPollEndAt: prev?.lastPollEndAt ?? now, scopeId });
		return POLL_WAIT_LADDER_MS[level];
	}

	/**
	 * Mark a blocking poll wait as finished so the idle-reset window is measured
	 * from now. Polling again before POLL_ESCALATION_RESET_MS elapses keeps
	 * climbing the ladder; waiting longer resets it to the floor.
	 */
	recordPollWaitEnd(ownerId: string | undefined, now: number = Date.now(), scopeId?: string): void {
		const key = JSON.stringify([ownerId, scopeId]);
		const prev = this.#pollEscalation.get(key);
		this.#pollEscalation.set(key, { level: prev?.level ?? 0, lastPollEndAt: now, scopeId });
	}

	acknowledgeDeliveries(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0))).filter(
			jobId => {
				const job = this.#jobs.get(jobId);
				if (!job) return true;
				return job.status !== "cancelled" || job.settledAt !== undefined;
			},
		);
		if (uniqueJobIds.length === 0) return 0;

		for (const jobId of uniqueJobIds) {
			this.#suppressedDeliveries.add(jobId);
		}

		const before = this.#deliveries.length;
		this.#deliveries.splice(
			0,
			this.#deliveries.length,
			...this.#deliveries.filter(delivery => !this.isDeliverySuppressed(delivery.jobId)),
		);
		this.#notifyDeliveryQueueChanged();
		return before - this.#deliveries.length;
	}

	/**
	 * Lift a foreground-wait suppression set via `acknowledgeDeliveries`. If the
	 * job already finished while suppressed (its delivery enqueue was skipped),
	 * re-enqueue the completion so the result is still delivered exactly once.
	 */
	resumeDeliveries(jobIds: string[]): void {
		for (const rawId of jobIds) {
			const jobId = rawId.trim();
			if (!jobId) continue;
			if (!this.#suppressedDeliveries.delete(jobId)) continue;
			const job = this.#jobs.get(jobId);
			if (!job || job.settledAt === undefined) continue;
			const queued =
				this.#deliveries.some(delivery => delivery.jobId === jobId) ||
				this.#inFlightDeliveries.some(delivery => delivery.jobId === jobId);
			if (queued) continue;
			this.#enqueueDelivery(jobId, job.resultText ?? job.errorText ?? job.progress?.text ?? "");
		}
	}

	/**
	 * Cancel running jobs. With `filter.ownerId` set, cancels only jobs the
	 * matching agent registered; with no filter, cancels every running job
	 * (used by `dispose()` to nuke the manager's state).
	 *
	 * `reason` is forwarded to each job's `AbortController.abort`, so a session
	 * teardown can tag its owned jobs with {@link ASYNC_JOB_MANAGER_SHUTDOWN_REASON}
	 * before `dispose()` runs — the task executor reads it to park (not
	 * tombstone) a subagent interrupted purely by process shutdown.
	 */
	cancelAll(filter?: AsyncJobFilter, reason?: unknown): void {
		this.#cancelJobs(filter, reason);
	}

	#cancelJobs(filter?: AsyncJobFilter, reason?: unknown): void {
		for (const job of this.getRunningJobs(filter)) {
			if (job.status !== "running") continue;
			job.status = "cancelled";
			job.abortController.abort(reason);
			this.#scheduleEviction(job.id);
		}
	}

	async cancelAndWait(filter: AsyncJobFilter & { type: AsyncJobType }): Promise<void> {
		const jobs = this.#filterJobs(this.#jobs.values(), filter).filter(
			job => job.status === "running" || (job.status === "cancelled" && job.settledAt === undefined),
		);
		for (const job of jobs) {
			if (job.status !== "running") continue;
			job.status = "cancelled";
			job.abortController.abort();
			this.#notifyJobChange(job);
		}
		await Promise.allSettled(jobs.map(job => job.promise));
	}

	/**
	 * Permanently fence and remove one session scope. The fence, delivery
	 * suppression, and cancellation all happen before the returned promise can
	 * yield so late work cannot enter the retired scope during teardown.
	 */
	retireScope(scopeId: string): Promise<void> {
		const existing = this.#scopeRetirements.get(scopeId);
		if (existing) return existing;

		this.#retiredScopes.add(scopeId);
		const jobs = this.#filterJobs(this.#jobs.values(), { scopeId });
		const jobIds = new Set(jobs.map(job => job.id));
		const inFlightDeliveries = this.#inFlightDeliveries.filter(delivery => delivery.scopeId === scopeId);
		for (const delivery of this.#deliveries) {
			if (delivery.scopeId === scopeId) jobIds.add(delivery.jobId);
		}
		for (const delivery of inFlightDeliveries) {
			jobIds.add(delivery.jobId);
		}
		for (const jobId of jobIds) {
			this.#suppressedDeliveries.add(jobId);
			const timer = this.#evictionTimers.get(jobId);
			if (timer) {
				clearTimeout(timer);
				this.#evictionTimers.delete(jobId);
			}
		}
		this.#deliveries.splice(
			0,
			this.#deliveries.length,
			...this.#deliveries.filter(delivery => delivery.scopeId !== scopeId),
		);
		this.#notifyDeliveryQueueChanged();
		for (const job of jobs) {
			if (job.status !== "running") continue;
			job.status = "cancelled";
			job.abortController.abort();
			this.#notifyJobChange(job);
		}

		const deliveryPromises = inFlightDeliveries
			.map(delivery => delivery.promise)
			.filter((promise): promise is Promise<void> => promise !== undefined);
		const retirement = this.#finishScopeRetirement(
			scopeId,
			jobIds,
			jobs.map(job => job.promise),
			deliveryPromises,
		);
		this.#scopeRetirements.set(scopeId, retirement);
		return retirement;
	}

	async #finishScopeRetirement(
		scopeId: string,
		jobIds: Set<string>,
		jobPromises: Promise<void>[],
		deliveryPromises: Promise<void>[],
	): Promise<void> {
		await Promise.allSettled([...jobPromises, ...deliveryPromises]);

		for (const job of this.#jobs.values()) {
			if (job.scopeId === scopeId) jobIds.add(job.id);
		}
		for (const delivery of this.#deliveries) {
			if (delivery.scopeId === scopeId) jobIds.add(delivery.jobId);
		}
		for (const delivery of this.#inFlightDeliveries) {
			if (delivery.scopeId === scopeId) jobIds.add(delivery.jobId);
		}
		this.#deliveries.splice(
			0,
			this.#deliveries.length,
			...this.#deliveries.filter(delivery => delivery.scopeId !== scopeId),
		);
		this.#notifyDeliveryQueueChanged();
		this.#inFlightDeliveries.splice(
			0,
			this.#inFlightDeliveries.length,
			...this.#inFlightDeliveries.filter(delivery => delivery.scopeId !== scopeId),
		);
		for (const [jobId, job] of this.#jobs) {
			if (job.scopeId === scopeId) this.#jobs.delete(jobId);
		}
		for (const jobId of jobIds) {
			const timer = this.#evictionTimers.get(jobId);
			clearTimeout(timer);
			this.#evictionTimers.delete(jobId);
			this.#suppressedDeliveries.delete(jobId);
			this.#watchedJobs.delete(jobId);
		}
		for (const [key, state] of this.#pollEscalation) {
			if (state.scopeId === scopeId) this.#pollEscalation.delete(key);
		}
	}

	/**
	 * Session-owned teardown complement of {@link getSessionJobs}: cancel, drop
	 * deliveries for, and evict the unscoped jobs of `ownerId`. A job registered
	 * without an explicit scopeId belongs to its owner's top-level session, so a
	 * session transition must retire those rows exactly like {@link retireScope}
	 * retires the scoped half — the conjunctive {@link AsyncJobFilter} cannot
	 * express "unscoped only", so the rows are resolved explicitly. Awaits the
	 * in-flight settlement of affected jobs and deliveries. Returns the number
	 * of jobs retired.
	 */
	async retireUnscopedOwnerJobs(ownerId: string): Promise<number> {
		const unscoped = this.#filterJobs(this.#jobs.values(), { ownerId }).filter(job => job.scopeId === undefined);
		if (unscoped.length === 0) return 0;
		const jobIds = new Set(unscoped.map(job => job.id));
		const inFlightDeliveries = this.#inFlightDeliveries.filter(
			delivery => delivery.ownerId === ownerId && delivery.scopeId === undefined,
		);
		for (const delivery of this.#deliveries) {
			if (delivery.ownerId === ownerId && delivery.scopeId === undefined) jobIds.add(delivery.jobId);
		}
		for (const delivery of inFlightDeliveries) {
			jobIds.add(delivery.jobId);
		}
		for (const jobId of jobIds) {
			this.#suppressedDeliveries.add(jobId);
			const timer = this.#evictionTimers.get(jobId);
			if (timer) {
				clearTimeout(timer);
				this.#evictionTimers.delete(jobId);
			}
		}
		this.#deliveries.splice(
			0,
			this.#deliveries.length,
			...this.#deliveries.filter(delivery => !(delivery.ownerId === ownerId && delivery.scopeId === undefined)),
		);
		this.#notifyDeliveryQueueChanged();
		for (const job of unscoped) {
			if (job.status !== "running") continue;
			job.status = "cancelled";
			job.abortController.abort();
			this.#notifyJobChange(job);
		}

		const deliveryPromises = inFlightDeliveries
			.map(delivery => delivery.promise)
			.filter((promise): promise is Promise<void> => promise !== undefined);
		await Promise.allSettled([...unscoped.map(job => job.promise), ...deliveryPromises]);

		this.#inFlightDeliveries.splice(
			0,
			this.#inFlightDeliveries.length,
			...this.#inFlightDeliveries.filter(
				delivery => !(delivery.ownerId === ownerId && delivery.scopeId === undefined),
			),
		);
		for (const job of unscoped) {
			this.#jobs.delete(job.id);
		}
		for (const jobId of jobIds) {
			const timer = this.#evictionTimers.get(jobId);
			clearTimeout(timer);
			this.#evictionTimers.delete(jobId);
			this.#suppressedDeliveries.delete(jobId);
			this.#watchedJobs.delete(jobId);
		}
		return unscoped.length;
	}

	/**
	 * Immediately evict completed and failed jobs matching the filter instead of
	 * waiting for retention expiry, dropping every queued delivery so a prior
	 * session's result can never be injected into a later transcript. Returns the
	 * number of jobs evicted.
	 *
	 * A delivery whose sink call is already in flight (or drained onto a caller's
	 * yield queue) is guarded by the owner's delivery generation, not the per-id
	 * suppression marker — that marker is cleared when the id is reused.
	 */
	evictCompletedJobs(filter?: AsyncJobFilter): number {
		let evicted = 0;
		for (const job of this.#filterJobs(this.#jobs.values(), filter)) {
			if (job.status !== "completed" && job.status !== "failed") continue;
			this.acknowledgeDeliveries([job.id]);
			if (this.#evictJob(job.id)) evicted += 1;
		}
		return evicted;
	}

	async waitForAll(): Promise<void> {
		await Promise.all(Array.from(this.#jobs.values()).map(job => job.promise));
	}

	/**
	 * Route completions for jobs owned by `ownerId` to `sink`. Sessions register
	 * their own sink at construction and unregister on dispose. Owned deliveries
	 * with no live sink are dead-lettered — `onJobComplete` serves only unowned
	 * deliveries.
	 *
	 * Last registration wins for an owner id; the returned unregister clears the
	 * mapping only while it still points at `sink`, so a revived session's fresh
	 * registration survives its parked predecessor's late cleanup.
	 */
	registerDeliverySink(ownerId: string, sink: AsyncJobDeliverySink): () => void {
		this.#deliverySinks.set(ownerId, sink);
		return () => {
			if (this.#deliverySinks.get(ownerId) === sink) this.#deliverySinks.delete(ownerId);
		};
	}

	/**
	 * Wait until every job owned by `ownerId` has settled — its run promise
	 * resolved, which for cancelled jobs means the underlying process actually
	 * exited. Jobs registered while waiting (e.g. by a follow-up turn) are
	 * awaited too. Returns false when `timeoutMs` elapses first.
	 *
	 * `excludeSuppressed` skips jobs whose delivery is suppressed (acknowledged
	 * or `hub`-watched): those can never re-wake a run, so quiescence barriers
	 * pass it to share one contract with the pending-async-wake predicate.
	 * Teardown reaps omit it — worktree safety concerns every owner process.
	 */
	async waitForOwnerJobs(
		ownerId: string,
		options?: { timeoutMs?: number; excludeSuppressed?: boolean },
	): Promise<boolean> {
		const deadline =
			options?.timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + Math.max(0, options.timeoutMs);
		const awaited = new Set<string>();
		for (;;) {
			const pending = this.#filterJobs(this.#jobs.values(), { ownerId }).filter(
				job => !awaited.has(job.id) && (options?.excludeSuppressed !== true || !this.isDeliverySuppressed(job.id)),
			);
			if (pending.length === 0) return true;
			for (const job of pending) awaited.add(job.id);
			const settled = await this.#waitForDeliveryPromise(
				Promise.all(pending.map(job => job.promise)).then(() => {}),
				deadline,
			);
			if (!settled) return false;
		}
	}

	/**
	 * Cancel every job owned by `ownerId`, then wait only until `deadlineAt`.
	 * The returned completion keeps waiting for actual process settlement when
	 * the deadline expires, so callers can move that cleanup out of the
	 * user-visible Task wait without losing ownership of the live work.
	 */
	async cancelAndReapOwnerJobs(ownerId: string, deadlineAt: number): Promise<AsyncJobReapResult> {
		this.cancelAll({ ownerId });
		const timeoutMs = Math.max(0, deadlineAt - Date.now());
		const settled = await this.waitForOwnerJobs(ownerId, { timeoutMs });
		if (settled) {
			return { settled: true, pendingJobIds: [], completion: Promise.resolve() };
		}
		const pendingJobIds = this.getAllJobs({ ownerId })
			.filter(job => job.status === "running" || job.status === "cancelled")
			.map(job => job.id);
		const completion = this.waitForOwnerJobs(ownerId).then(() => {});
		return { settled: false, pendingJobIds, completion };
	}

	async #waitForAllUntil(deadline: number): Promise<boolean> {
		const promises = Array.from(this.#jobs.values()).map(job => job.promise);
		if (promises.length === 0) return true;
		if (deadline === Number.POSITIVE_INFINITY) {
			await Promise.all(promises);
			return true;
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return false;

		const timeout = Promise.withResolvers<"timeout">();
		const timer = setTimeout(() => timeout.resolve("timeout"), remainingMs);
		timer.unref();
		try {
			const result = await Promise.race([Promise.all(promises).then(() => "settled" as const), timeout.promise]);
			return result === "settled";
		} finally {
			clearTimeout(timer);
		}
	}

	async drainDeliveries(options?: { timeoutMs?: number; filter?: AsyncJobFilter }): Promise<boolean> {
		const timeoutMs = options?.timeoutMs;
		const filter = options?.filter;
		const hasDeadline = timeoutMs !== undefined;
		const deadline = hasDeadline ? Date.now() + Math.max(timeoutMs, 0) : Number.POSITIVE_INFINITY;

		while (this.hasPendingDeliveries(filter)) {
			if (filter?.ownerId !== undefined || filter?.scopeId !== undefined) {
				const delivered = await this.#deliverNextFiltered(filter, deadline);
				if (delivered) continue;
				return false;
			}
			const inFlightDeliveries = this.#filterInFlightDeliveries();
			if (inFlightDeliveries.length > 0 && this.#filterDeliveries().length === 0) {
				const delivered = await this.#waitForDeliveryPromise(inFlightDeliveries[0]?.promise, deadline);
				if (delivered) continue;
				return false;
			}

			this.#ensureDeliveryLoop();
			const loop = this.#deliveryLoop;
			if (!loop) {
				continue;
			}

			if (!hasDeadline) {
				await loop;
				continue;
			}

			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				return false;
			}

			await Promise.race([loop, Bun.sleep(remainingMs)]);
			if (Date.now() >= deadline && this.hasPendingDeliveries(filter)) {
				return false;
			}
		}

		return true;
	}

	async dispose(options?: { timeoutMs?: number }): Promise<boolean> {
		this.#disposed = true;
		this.#clearEvictionTimers();
		this.#cancelJobs(undefined, ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
		const timeoutMs = Math.max(options?.timeoutMs ?? 3_000, 0);
		const deadline = Date.now() + timeoutMs;
		const jobsSettled = await this.#waitForAllUntil(deadline);
		const drained = await this.drainDeliveries({ timeoutMs: Math.max(deadline - Date.now(), 0) });
		this.#clearEvictionTimers();
		this.#jobs.clear();
		this.#deliveries.length = 0;
		this.#notifyDeliveryQueueChanged();
		this.#inFlightDeliveries.length = 0;
		this.#suppressedDeliveries.clear();
		this.#watchedJobs.clear();
		this.#pollEscalation.clear();
		this.#jobChangeListeners.clear();
		this.#deliverySinks.clear();
		return jobsSettled && drained;
	}

	#resolveJobId(preferredId?: string): string {
		preferredId = preferredId?.trim();
		if (!preferredId) {
			let candidate = 1;
			while (true) {
				const id = `bg_${candidate}`;
				if (!this.#jobs.has(id)) {
					return id;
				}
				candidate += 1;
			}
		}

		const base = preferredId.trim();
		if (!this.#jobs.has(base)) return base;

		let suffix = 2;
		let candidate = `${base}-${suffix}`;
		while (this.#jobs.has(candidate)) {
			suffix += 1;
			candidate = `${base}-${suffix}`;
		}
		return candidate;
	}

	#evictJob(jobId: string): boolean {
		clearTimeout(this.#evictionTimers.get(jobId));
		this.#evictionTimers.delete(jobId);
		this.#suppressedDeliveries.delete(jobId);
		this.#watchedJobs.delete(jobId);
		return this.#jobs.delete(jobId);
	}

	#scheduleEviction(jobId: string): void {
		if (this.#disposed) return;
		const job = this.#jobs.get(jobId);
		if (!job || job.settledAt === undefined) return;
		if (job.scopeId !== undefined && this.#retiredScopes.has(job.scopeId)) return;
		if (this.#retentionMs <= 0) {
			this.#evictJob(jobId);
			return;
		}
		const existing = this.#evictionTimers.get(jobId);
		if (existing) {
			clearTimeout(existing);
		}
		const timer = setTimeout(() => {
			this.#evictJob(jobId);
		}, this.#retentionMs);
		timer.unref();
		this.#evictionTimers.set(jobId, timer);
	}

	#clearEvictionTimers(): void {
		for (const timer of this.#evictionTimers.values()) {
			clearTimeout(timer);
		}
		this.#evictionTimers.clear();
	}

	#filterDeliveries(filter?: AsyncJobFilter): AsyncJobDelivery[] {
		return this.#deliveries.filter(
			delivery => this.#matchesFilter(delivery, filter) && !this.#isDeliverySuppressed(delivery),
		);
	}

	#filterInFlightDeliveries(filter?: AsyncJobFilter): AsyncJobDelivery[] {
		return this.#inFlightDeliveries.filter(
			delivery => this.#matchesFilter(delivery, filter) && !this.#isDeliverySuppressed(delivery),
		);
	}

	async #deliverNextFiltered(filter: AsyncJobFilter, deadline: number): Promise<boolean> {
		while (true) {
			let selected: AsyncJobDelivery | undefined;
			for (const delivery of this.#deliveries) {
				if (!this.#matchesFilter(delivery, filter)) continue;
				if (this.#isDeliverySuppressed(delivery)) continue;
				if (!selected || delivery.nextAttemptAt < selected.nextAttemptAt) {
					selected = delivery;
				}
			}

			if (!selected) {
				const inFlight = this.#filterInFlightDeliveries(filter);
				if (inFlight.length === 0) return true;
				return this.#waitForDeliveryPromise(inFlight[0]?.promise, deadline);
			}

			const now = Date.now();
			if (selected.nextAttemptAt > now) {
				if (selected.nextAttemptAt > deadline) return false;
				await this.#waitForDeliveryQueueChange(selected.nextAttemptAt - now);
				continue;
			}

			const index = this.#deliveries.indexOf(selected);
			if (index === -1) continue;
			this.#deliveries.splice(index, 1);
			this.#notifyDeliveryQueueChanged();
			if (this.#isDeliverySuppressed(selected)) continue;

			return this.#waitForDeliveryPromise(this.#deliverDelivery(selected), deadline);
		}
	}

	isDeliverySuppressed(jobId: string): boolean {
		const job = this.#jobs.get(jobId);
		return (
			this.#suppressedDeliveries.has(jobId) ||
			this.#watchedJobs.has(jobId) ||
			(job?.scopeId !== undefined && this.#retiredScopes.has(job.scopeId))
		);
	}

	#isDeliverySuppressed(delivery: AsyncJobDelivery): boolean {
		return (
			this.#suppressedDeliveries.has(delivery.jobId) ||
			this.#watchedJobs.has(delivery.jobId) ||
			(delivery.scopeId !== undefined && this.#retiredScopes.has(delivery.scopeId))
		);
	}

	#enqueueDelivery(jobId: string, text: string): void {
		// Skip delivery if already acknowledged.
		if (this.isDeliverySuppressed(jobId)) {
			return;
		}
		const job = this.#jobs.get(jobId);
		if (!job) return;
		this.#queueDelivery({
			jobId,
			text,
			type: job.type,
			attempt: 0,
			nextAttemptAt: Date.now(),
			ownerId: job.ownerId,
			scopeId: job.scopeId,
		});
		this.#ensureDeliveryLoop();
	}

	#ensureDeliveryLoop(): void {
		if (this.#deliveryLoop) {
			return;
		}

		this.#deliveryLoop = this.#runDeliveryLoop()
			.catch(error => {
				logger.error("Async job delivery loop crashed", { error: String(error) });
			})
			.finally(() => {
				this.#deliveryLoop = undefined;
				if (this.#deliveries.length > 0) {
					this.#ensureDeliveryLoop();
				}
			});
	}

	async #runDeliveryLoop(): Promise<void> {
		while (this.#deliveries.length > 0) {
			const delivery = this.#deliveries[0];
			if (this.#isDeliverySuppressed(delivery)) {
				this.#deliveries.shift();
				this.#notifyDeliveryQueueChanged();
				continue;
			}
			const waitMs = delivery.nextAttemptAt - Date.now();
			if (waitMs > 0) {
				await this.#waitForDeliveryQueueChange(waitMs);
				continue;
			}
			if (this.#deliveries[0] !== delivery) {
				continue;
			}
			if (this.#isDeliverySuppressed(delivery)) {
				this.#deliveries.shift();
				this.#notifyDeliveryQueueChanged();
				continue;
			}

			this.#deliveries.shift();
			this.#notifyDeliveryQueueChanged();
			await this.#deliverDelivery(delivery);
		}
	}

	/**
	 * Resolve the sink for one delivery attempt: owned deliveries route ONLY to
	 * their owner's registered sink (a missing sink dead-letters — never the
	 * default, which would misroute a dead owner's result into another
	 * session); unowned deliveries use the constructor default. Resolved per
	 * attempt so a sink registered between retries (e.g. a revived session)
	 * picks up the retry.
	 */
	#resolveDeliverySink(ownerId: string | undefined): AsyncJobDeliverySink | undefined {
		if (ownerId !== undefined) return this.#deliverySinks.get(ownerId);
		return this.#onJobComplete;
	}

	#deliverDelivery(delivery: AsyncJobDelivery): Promise<void> {
		const sink = this.#resolveDeliverySink(delivery.ownerId);
		if (!sink) {
			// Dead-letter: owned delivery with no live sink (session disposed or
			// parked), or unowned delivery with no default sink. Drop it — the
			// job row keeps its result/error text until retention eviction, so
			// the outcome stays inspectable via job queries and agent:// reads.
			logger.warn("Async job delivery dead-lettered: no delivery sink", {
				jobId: delivery.jobId,
				ownerId: delivery.ownerId,
			});
			delivery.promise = Promise.resolve();
			return delivery.promise;
		}
		const promise = (async () => {
			this.#inFlightDeliveries.push(delivery);
			// Publish delivery.promise before invoking user code so retirement
			// can always await every entry visible in #inFlightDeliveries.
			await Promise.resolve();
			try {
				if (this.#isDeliverySuppressed(delivery)) return;
				await sink(delivery.jobId, delivery.text, this.#jobs.get(delivery.jobId));
			} catch (error) {
				delivery.attempt += 1;
				delivery.lastError = error instanceof Error ? error.message : String(error);
				delivery.nextAttemptAt = Date.now() + this.#getRetryDelay(delivery.attempt);
				if (!this.#isDeliverySuppressed(delivery)) {
					this.#queueDelivery(delivery);
				}
				logger.warn("Async job completion delivery failed", {
					jobId: delivery.jobId,
					attempt: delivery.attempt,
					nextRetryAt: delivery.nextAttemptAt,
					error: delivery.lastError,
				});
			} finally {
				const index = this.#inFlightDeliveries.indexOf(delivery);
				if (index !== -1) this.#inFlightDeliveries.splice(index, 1);
				if (this.#deliveries.length > 0) this.#ensureDeliveryLoop();
			}
		})();
		delivery.promise = promise;
		return promise;
	}

	#queueDelivery(delivery: AsyncJobDelivery): void {
		const index = this.#deliveries.findIndex(candidate => candidate.nextAttemptAt > delivery.nextAttemptAt);
		if (index === -1) this.#deliveries.push(delivery);
		else this.#deliveries.splice(index, 0, delivery);
		this.#notifyDeliveryQueueChanged();
	}

	async #waitForDeliveryQueueChange(delayMs: number): Promise<void> {
		const timerElapsed = Promise.withResolvers<void>();
		const timer = setTimeout(timerElapsed.resolve, delayMs);
		timer.unref();
		try {
			await Promise.race([timerElapsed.promise, this.#deliveryQueueChanged.promise]);
		} finally {
			clearTimeout(timer);
		}
	}

	#notifyDeliveryQueueChanged(): void {
		this.#deliveryQueueChanged.resolve();
		this.#deliveryQueueChanged = Promise.withResolvers<void>();
	}

	async #waitForDeliveryPromise(promise: Promise<void> | undefined, deadline: number): Promise<boolean> {
		if (!promise) return true;
		if (deadline === Number.POSITIVE_INFINITY) {
			await promise;
			return true;
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return false;
		let timedOut = false;
		await Promise.race([
			promise,
			Bun.sleep(remainingMs).then(() => {
				timedOut = true;
			}),
		]);
		return !timedOut;
	}

	#getRetryDelay(attempt: number): number {
		const exp = Math.min(Math.max(attempt - 1, 0), 8);
		const backoffMs = DELIVERY_RETRY_BASE_MS * 2 ** exp;
		const jitterMs = Math.floor(Math.random() * DELIVERY_RETRY_JITTER_MS);
		return Math.min(DELIVERY_RETRY_MAX_MS, backoffMs + jitterMs);
	}
}
