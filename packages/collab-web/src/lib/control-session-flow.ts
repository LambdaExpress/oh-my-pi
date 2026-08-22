import type { ControlClient, ControlSessionInfo } from "./control-client";

type PendingSessionOp =
	| { op: "created"; client: ControlClient; initialPrompt?: string }
	| { op: "resumed"; id: string; client: ControlClient };

export interface AcceptedControlSession extends ControlSessionInfo {
	initialPrompt?: string;
}

/**
 * Coordinates directed create/resume replies with the currently active
 * control-room client. Admission is synchronous so rapid UI actions cannot
 * replace an in-flight operation before React renders the pending state.
 */
export class ControlSessionFlow {
	#activeClient: ControlClient | null = null;
	#pending: PendingSessionOp | null = null;

	get activeClient(): ControlClient | null {
		return this.#activeClient;
	}

	get pending(): boolean {
		return this.#pending !== null;
	}

	/** Make a control client authoritative and invalidate any earlier request. */
	activate(client: ControlClient): ControlClient | null {
		const previous = this.#activeClient;
		this.#activeClient = client;
		this.#pending = null;
		return previous;
	}

	/** Leave control mode and invalidate replies from the former client. */
	deactivate(): ControlClient | null {
		const previous = this.#activeClient;
		this.#activeClient = null;
		this.#pending = null;
		return previous;
	}

	/** Return to the sessions home without leaving the active control room. */
	cancelPending(): void {
		this.#pending = null;
	}

	startCreate(client: ControlClient, initialPrompt?: string): boolean {
		if (this.#activeClient !== client || this.#pending !== null) return false;
		this.#pending = { op: "created", client, initialPrompt };
		client.sendCreate();
		return true;
	}

	startResume(client: ControlClient, id: string): boolean {
		if (this.#activeClient !== client || this.#pending !== null) return false;
		this.#pending = { op: "resumed", id, client };
		client.sendResume(id);
		return true;
	}

	/** A control error only ends the request owned by its source client. */
	fail(client: ControlClient): boolean {
		if (this.#pending?.client !== client) return false;
		this.#pending = null;
		return true;
	}

	/** Consume only the directed reply for the active client's pending request. */
	accept(client: ControlClient, info: ControlSessionInfo): AcceptedControlSession | null {
		const pending = this.#pending;
		if (this.#activeClient !== client || pending?.client !== client || pending.op !== info.op) return null;
		if (pending.op === "resumed" && pending.id !== info.id) return null;
		this.#pending = null;
		return pending.op === "created" ? { ...info, initialPrompt: pending.initialPrompt } : info;
	}
}
