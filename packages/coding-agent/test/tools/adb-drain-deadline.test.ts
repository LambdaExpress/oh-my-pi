import { expect, test } from "bun:test";
import { executeAdbBinary, type AdbSubprocess } from "../../src/adb/adb-executor";

test.each(["timeout", "abort"] as const)(
	"an exited client with stalled EOF and stream cancellation stays bounded on %s",
	async interrupt => {
		const cancel = Promise.withResolvers<void>();
		const abort = new AbortController();
		let abortTimer: ReturnType<typeof setTimeout> | undefined;
		let terminated = false;
		const stdout = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(Uint8Array.of(0x89, 0x50));
			},
			cancel: () => cancel.promise,
		});
		const child: AdbSubprocess = {
			pid: 0,
			stdout,
			stderr: null,
			exited: Promise.resolve(0),
			exitCode: 0,
			killed: false,
			kill() {
				terminated = true;
			},
		};
		try {
			if (interrupt === "abort") abortTimer = setTimeout(() => abort.abort(), 20);
			const started = performance.now();
			const result = await executeAdbBinary(["exec-out", "screencap", "-p"], {
				timeoutMs: interrupt === "timeout" ? 20 : 5_000,
				signal: abort.signal,
				dependencies: {
					resolveExecutable: () => process.execPath,
					spawn: () => child,
					terminateTree: async () => {
						terminated = true;
					},
				},
			});
			expect(result.cancelled).toBe(true);
			expect(result.timedOut).toBe(interrupt === "timeout" ? true : undefined);
			expect(result.bytes).toEqual(new Uint8Array());
			expect(terminated).toBe(false);
			expect(performance.now() - started).toBeLessThan(1_500);
		} finally {
			clearTimeout(abortTimer);
			cancel.resolve();
		}
	},
	2_000,
);
