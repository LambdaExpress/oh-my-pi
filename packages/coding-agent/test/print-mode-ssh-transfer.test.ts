import { describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { type PrintSshTransferSession, waitForPrintSshTransfers } from "@oh-my-pi/pi-coding-agent/modes/print-mode";

function printSession(manager: AsyncJobManager, waitForIdle = vi.fn(async () => {})): PrintSshTransferSession {
	return {
		asyncJobManager: manager,
		isStreaming: false,
		getAgentId: () => "Main",
		getAgentScopeId: () => "scope-1",
		waitForIdle,
	};
}

describe("print-mode SSH transfer fixed point", () => {
	it("waits for a completion follow-up that starts another scoped transfer", async () => {
		const first = Promise.withResolvers<string>();
		const second = Promise.withResolvers<string>();
		const deliveries: string[] = [];
		let secondRegistered = false;
		const secondStarted = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				deliveries.push(`${jobId}:${text}`);
				if (!secondRegistered) {
					secondRegistered = true;
					secondStarted.resolve();
					manager.register("ssh_transfer", "second", async () => second.promise, {
						ownerId: "Main",
						scopeId: "scope-1",
					});
				}
			},
		});
		manager.register("ssh_transfer", "first", async () => first.promise, {
			ownerId: "Main",
			scopeId: "scope-1",
		});
		const waitForIdle = vi.fn(async () => {});
		let settled = false;
		const waiting = waitForPrintSshTransfers(printSession(manager, waitForIdle)).then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		first.resolve("first done");
		await secondStarted.promise;
		expect(secondRegistered).toBe(true);
		expect(settled).toBe(false);

		second.resolve("second done");
		await waiting;
		expect(deliveries).toHaveLength(2);
		expect(waitForIdle).toHaveBeenCalledTimes(2);
	});

	it("does not wait for Bash jobs or SSH transfers in another scope", async () => {
		const bash = Promise.withResolvers<string>();
		const otherScope = Promise.withResolvers<string>();
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		manager.register("bash", "bash", async () => bash.promise, { ownerId: "Main", scopeId: "scope-1" });
		manager.register("ssh_transfer", "other", async () => otherScope.promise, {
			ownerId: "Main",
			scopeId: "scope-2",
		});

		await waitForPrintSshTransfers(printSession(manager));
		expect(manager.getAllJobs().filter(job => job.status === "running")).toHaveLength(2);

		bash.resolve("bash done");
		otherScope.resolve("other done");
		await manager.waitForAll();
		await manager.drainDeliveries();
	});
});
