/**
 * Session-scoped native edit state: full-file snapshots that mint hashline
 * tags (recorded by `read`/`search`/`write`), `CUT`/`PUT` clipboard
 * registers, and the byte-identical no-op loop guard. One store per
 * {@link ToolSession}; every {@link EditSession} the edit tool opens shares it.
 */
import { EditStore } from "@oh-my-pi/pi-natives";

export type KeyedEditStore = EditStore & {
	recordSnapshotForKey(canonicalKey: string, text: string, seenLines?: number[] | null): string;
	recordSeenLinesForKey(canonicalKey: string, tag: string, lines: number[]): void;
	recordSeenLinesFromBodyForKey(canonicalKey: string, tag: string, body: string): void;
};

/** Owner of the lazily created per-session store. */
export interface EditStoreOwner {
	editStore?: EditStore;
}

/** The session's store, created on first use. */
export function getEditStore(session: EditStoreOwner): KeyedEditStore {
	session.editStore ??= new EditStore();
	return session.editStore as KeyedEditStore;
}
