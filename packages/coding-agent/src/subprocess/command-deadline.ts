/** A command's launch budget, shared by preparation and the execution backend. */
export class CommandStoppedError extends Error {
	constructor(readonly reason: "timeout" | "abort") {
		super(reason === "timeout" ? "Command deadline exceeded" : "Command cancelled");
	}
}

export class CommandDeadline {
	readonly expiresAt: number | undefined;
	readonly #controller = new AbortController();
	readonly #stopped = Promise.withResolvers<CommandStoppedError>();
	readonly #callerSignal: AbortSignal | undefined;
	readonly #onAbort = () => this.#stop("abort");
	#timer: NodeJS.Timeout | undefined;
	#error: CommandStoppedError | undefined;

	constructor(timeoutMs: number | undefined, signal?: AbortSignal, expiresAt?: number) {
		this.expiresAt = expiresAt ?? (timeoutMs === undefined ? undefined : performance.now() + timeoutMs);
		this.#callerSignal = signal;
		if (signal?.aborted) this.#stop("abort");
		else signal?.addEventListener("abort", this.#onAbort, { once: true });
		if (this.expiresAt !== undefined && !this.#error) {
			const remaining = this.expiresAt - performance.now();
			if (remaining <= 0) this.#stop("timeout");
			else this.#timer = setTimeout(() => this.#stop("timeout"), remaining);
		}
	}

	/** Cancellation for launch work; native execution receives its own remaining budget. */
	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	get remainingMs(): number | undefined {
		if (this.expiresAt === undefined) return undefined;
		return Math.max(0, this.expiresAt - performance.now());
	}

	throwIfStopped(): void {
		if (!this.#error && this.expiresAt !== undefined && performance.now() >= this.expiresAt) this.#stop("timeout");
		if (this.#error) throw this.#error;
	}

	/** Stop awaiting launch I/O even when its backend ignores cancellation. */
	async wait<T>(work: () => T | PromiseLike<T>): Promise<T> {
		this.throwIfStopped();
		const winner = await Promise.race([
			Promise.resolve(work()).then(value => ({ value })),
			this.#stopped.promise.then(error => ({ error })),
		]);
		if ("error" in winner) throw winner.error;
		this.throwIfStopped();
		return winner.value;
	}

	dispose(): void {
		clearTimeout(this.#timer);
		this.#callerSignal?.removeEventListener("abort", this.#onAbort);
	}

	#stop(reason: "timeout" | "abort"): void {
		if (this.#error) return;
		this.#error = new CommandStoppedError(reason);
		this.#controller.abort(this.#error);
		this.#stopped.resolve(this.#error);
	}
}
