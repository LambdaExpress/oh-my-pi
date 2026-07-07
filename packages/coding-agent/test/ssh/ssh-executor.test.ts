import { afterEach, describe, expect, it, vi } from "bun:test";
import * as connectionManager from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import { executeSSH } from "@oh-my-pi/pi-coding-agent/ssh/ssh-executor";
import * as sshfsMount from "@oh-my-pi/pi-coding-agent/ssh/sshfs-mount";
import { type ChildProcess, ptree } from "@oh-my-pi/pi-utils";

type TestStdin = "pipe" | "ignore" | Buffer | Uint8Array | null;

function createNeverClosingStream(): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("started\n"));
		},
	});
}

function createClosedStream(text = ""): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			if (text.length > 0) {
				controller.enqueue(new TextEncoder().encode(text));
			}
			controller.close();
		},
	});
}

function createBlockedChild<In extends TestStdin>(exited?: Promise<number>): ChildProcess<In> {
	const { promise } = Promise.withResolvers<number>();

	return {
		stdout: createNeverClosingStream(),
		stderr: undefined,
		exited: exited ?? promise,
		[Symbol.dispose]() {},
	} as unknown as ChildProcess<In>;
}

function createExitedChild<In extends TestStdin>(
	exited: Promise<number> = Promise.resolve(0),
	stdout = "",
	stderr?: string,
): ChildProcess<In> {
	return {
		stdout: createClosedStream(stdout),
		stderr: stderr === undefined ? undefined : createClosedStream(stderr),
		exited,
		[Symbol.dispose]() {},
	} as unknown as ChildProcess<In>;
}

async function flushMicrotasks(count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		await Promise.resolve();
	}
}

describe("executeSSH", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function mockOpenStreamChild(exited?: Promise<number>) {
		const cleanup = vi.fn(async () => {});
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue();
		vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockResolvedValue({
			args: ["remote", "sleep 60"],
			cleanup,
		});
		vi.spyOn(sshfsMount, "hasSshfs").mockReturnValue(false);
		vi.spyOn(ptree, "spawn").mockImplementation(<In extends TestStdin>() => createBlockedChild<In>(exited));
		return { cleanup };
	}

	function startOpenStreamCommand(controller: AbortController) {
		const chunked = Promise.withResolvers<void>();
		const resultPromise = executeSSH({ name: "remote", host: "remote" }, "sleep 60", {
			signal: controller.signal,
			onChunk: () => chunked.resolve(),
		});
		return { resultPromise, chunked: chunked.promise };
	}

	it("returns promptly when an abort races a ControlMaster stream that stays open", async () => {
		const { cleanup } = mockOpenStreamChild();

		const controller = new AbortController();
		const { resultPromise, chunked } = startOpenStreamCommand(controller);
		await chunked;

		let result: Awaited<typeof resultPromise> | undefined;
		resultPromise.then(value => {
			result = value;
		});
		controller.abort("user interrupt");
		await flushMicrotasks(20);
		expect(result).toBeDefined();
		if (!result) return;
		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
		expect(result.output).toContain("Command aborted");
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	it("reports cancellation when abort unblocks streams after the ssh process exits", async () => {
		const { cleanup } = mockOpenStreamChild(Promise.resolve(0));

		const controller = new AbortController();
		const { resultPromise, chunked } = startOpenStreamCommand(controller);
		await chunked;
		await flushMicrotasks(20);

		let result: Awaited<typeof resultPromise> | undefined;
		resultPromise.then(value => {
			result = value;
		});
		controller.abort("user interrupt");
		await flushMicrotasks(20);
		expect(result).toBeDefined();
		if (!result) return;
		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
		expect(result.output).toContain("Command aborted");
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	it("passes invocation env to ssh spawn, cleans up on success, and keeps password out of argv", async () => {
		const env = { OMP_SSH_PASSWORD: "s3cr3t-value", SSH_ASKPASS_REQUIRE: "force" };
		const cleanup = vi.fn(async () => {});
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue();
		vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockResolvedValue({
			args: ["remote", "true"],
			env,
			cleanup,
		});
		vi.spyOn(sshfsMount, "hasSshfs").mockReturnValue(false);
		const spawn = vi
			.spyOn(ptree, "spawn")
			.mockImplementation(<In extends TestStdin>() => createExitedChild<In>(Promise.resolve(0), "ok\n"));

		const result = await executeSSH({ name: "pw", host: "remote", password: "s3cr3t-value" }, "true");

		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);
		expect(result.output).toBe("ok\n");
		expect(spawn).toHaveBeenCalledTimes(1);
		const call = spawn.mock.calls[0];
		expect(call).toBeDefined();
		if (!call) return;
		const [argv, options] = call;
		expect(argv).toEqual(["ssh", "remote", "true"]);
		expect(argv.join("\0")).not.toContain("s3cr3t-value");
		if (options === undefined) throw new Error("spawn options missing");
		expect(options.env).toBe(env);
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	it("cleans up invocation askpass state when ssh times out", async () => {
		const cleanup = vi.fn(async () => {});
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue();
		vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockResolvedValue({
			args: ["remote", "slow"],
			env: { OMP_SSH_PASSWORD: "s3cr3t-value" },
			cleanup,
		});
		vi.spyOn(sshfsMount, "hasSshfs").mockReturnValue(false);
		vi.spyOn(ptree, "spawn").mockImplementation(<In extends TestStdin>() =>
			createExitedChild<In>(Promise.reject(new ptree.TimeoutError(10_000, "timed out")), "partial\n"),
		);

		const result = await executeSSH({ name: "pw", host: "remote", password: "s3cr3t-value" }, "slow", {
			timeout: 10_000,
		});

		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
		expect(result.output).toContain("partial\n");
		expect(result.output).toContain("SSH: Operation cancelled: Timed out after 10s");
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	it("skips sshfs mounting for password hosts even when sshfs is available", async () => {
		const cleanup = vi.fn(async () => {});
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue();
		vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockResolvedValue({
			args: ["remote", "true"],
			env: { OMP_SSH_PASSWORD: "s3cr3t-value" },
			cleanup,
		});
		vi.spyOn(sshfsMount, "hasSshfs").mockReturnValue(true);
		const mountRemote = vi.spyOn(sshfsMount, "mountRemote").mockResolvedValue("/mnt/remote");
		const spawn = vi.spyOn(ptree, "spawn").mockImplementation(<In extends TestStdin>() => createExitedChild<In>());

		await executeSSH({ name: "pw", host: "remote", password: "s3cr3t-value" }, "true", { remotePath: "/srv" });

		expect(mountRemote).not.toHaveBeenCalled();
		expect(spawn).toHaveBeenCalledTimes(1);
		const call = spawn.mock.calls[0];
		expect(call).toBeDefined();
		if (!call) return;
		expect(call[0].join("\0")).not.toContain("s3cr3t-value");
		expect(cleanup).toHaveBeenCalledTimes(1);
	});
});
