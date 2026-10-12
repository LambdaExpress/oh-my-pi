import { AsyncLocalStorage } from "node:async_hooks";

import type { EvalShadowCellSession } from "./cell-session";

export type EvalKernelContextRunner = <T>(action: () => T) => T;

const activeCell = new AsyncLocalStorage<EvalShadowCellSession>();
const activeKernelLeases = new AsyncLocalStorage<readonly { key: string; active: boolean }[]>();
const emptyKernelLeases: readonly { key: string; active: boolean }[] = [];

export function runWithEvalShadowCell<T>(cell: EvalShadowCellSession | undefined, action: () => T): T {
	return cell ? activeCell.run(cell, action) : action();
}

export function getActiveEvalShadowCell(): EvalShadowCellSession | undefined {
	return activeCell.getStore();
}

export function runWithEvalKernelLease<T>(lease: { key: string; active: boolean }, action: () => T): T {
	return activeKernelLeases.run([...(activeKernelLeases.getStore() ?? emptyKernelLeases), lease], action);
}

export function isEvalKernelLeasedByCaller(key: string, ownLease?: { key: string; active: boolean }): boolean {
	return (
		activeKernelLeases.getStore()?.some(lease => lease !== ownLease && lease.active && lease.key === key) ?? false
	);
}

/** Restore the originating cell's lease ancestry when a transport delivers a host callback. */
export function captureEvalKernelContext(): EvalKernelContextRunner {
	const leases = activeKernelLeases.getStore() ?? emptyKernelLeases;
	return action => activeKernelLeases.run(leases, action);
}
