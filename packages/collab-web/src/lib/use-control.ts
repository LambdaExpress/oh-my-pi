/** React binding for {@link ControlClient} via `useSyncExternalStore`. */
import { useSyncExternalStore } from "react";
import type { ControlClient, ControlSnapshot } from "./control-client";

export function useControlSnapshot(client: ControlClient): ControlSnapshot {
	return useSyncExternalStore(
		listener => client.subscribe(listener),
		() => client.getSnapshot(),
		() => client.getSnapshot(),
	);
}
