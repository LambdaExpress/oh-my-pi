import { afterEach, describe, expect, it, vi } from "bun:test";
import * as connectionManager from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import { executeSSH } from "@oh-my-pi/pi-coding-agent/ssh/ssh-executor";
import * as sshfsMount from "@oh-my-pi/pi-coding-agent/ssh/sshfs-mount";
import { type ChildProcess, ptree } from "@oh-my-pi/pi-utils";

type TestStdin = "pipe" | "ignore" | Buffer | Uint8Array | null;

function createChild<In extends TestStdin>(
	stdout: ReadableStream<Uint8Array>,
	exited = Promise.resolve(0),
): ChildProcess<In> {
	return {
		stdout,
		stderr: undefined,
		exited,
		[Symbol.dispose]() {},
	} as unknown as ChildProcess<In>;
}

function closedStream(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

function openStream(onChunk: () => void): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("started\n"));
			onChunk();
		},
	});
}

describe("executeSSH", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("passes OMP password authentication only through the child environment and cleans it up", async () => {
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		vi.spyOn(sshfsMount, "hasSshfs").mockReturnValue(false);
		const password = "ssh-password-sentinel";
		const target = { name: "prod", host: "192.0.2.10", username: "root", password };
		const cleanup = vi.fn(async () => {});
		const build = vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockResolvedValue({
			args: ["-n", "root@192.0.2.10", "printf ok"],
			env: { OMP_SSH_PASSWORD: password, SSH_ASKPASS_REQUIRE: "force" },
			cleanup,
		});
		const spawn = vi
			.spyOn(ptree, "spawn")
			.mockImplementation(<In extends TestStdin>() => createChild<In>(closedStream("ok")));

		const result = await executeSSH(target, "printf ok");

		expect(result).toMatchObject({ output: "ok", exitCode: 0, cancelled: false });
		expect(build).toHaveBeenCalledWith(target, "printf ok");
		expect(spawn.mock.calls[0]?.[0]).not.toContain(password);
		expect(spawn.mock.calls[0]?.[1]?.env).toMatchObject({ OMP_SSH_PASSWORD: password });
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	it("settles promptly when abort races an SSH stream that remains open", async () => {
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		vi.spyOn(sshfsMount, "hasSshfs").mockReturnValue(false);
		vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockResolvedValue({ args: ["remote", "sleep 60"] });
		const streamed = Promise.withResolvers<void>();
		vi.spyOn(ptree, "spawn").mockImplementation(<In extends TestStdin>() => {
			const neverExits = Promise.withResolvers<number>();
			return createChild<In>(
				openStream(() => streamed.resolve()),
				neverExits.promise,
			);
		});
		const controller = new AbortController();
		const resultPromise = executeSSH({ name: "remote", host: "remote" }, "sleep 60", {
			signal: controller.signal,
		});
		await streamed.promise;

		controller.abort("user interrupt");
		const result = await resultPromise;
		expect(result).toMatchObject({ cancelled: true, exitCode: undefined });
		expect(result.output).toContain("Command aborted");
	});

	it("reports cancellation when abort releases streams after the process exits", async () => {
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		vi.spyOn(sshfsMount, "hasSshfs").mockReturnValue(false);
		vi.spyOn(connectionManager, "buildRemoteCommandInvocation").mockResolvedValue({ args: ["remote", "true"] });
		const streamed = Promise.withResolvers<void>();
		vi.spyOn(ptree, "spawn").mockImplementation(<In extends TestStdin>() =>
			createChild<In>(openStream(() => streamed.resolve())),
		);
		const controller = new AbortController();
		const resultPromise = executeSSH({ name: "remote", host: "remote" }, "true", {
			signal: controller.signal,
		});
		await streamed.promise;

		controller.abort("user interrupt");
		const result = await resultPromise;
		expect(result).toMatchObject({ cancelled: true, exitCode: undefined });
		expect(result.output).toContain("Command aborted");
	});
});
