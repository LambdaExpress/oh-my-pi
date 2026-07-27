import { logger, ptree } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { OutputSink } from "../session/streaming-output";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../tools/output-meta";
import {
	buildRemoteCommandInvocation,
	ensureConnection,
	ensureHostInfo,
	type SSHConnectionTarget,
} from "./connection-manager";
import { hasSshfs, mountRemote } from "./sshfs-mount";
import { wrapInPosixShell } from "./utils";

export interface SSHExecutorOptions {
	timeout?: number;
	onChunk?: (chunk: string) => void;
	signal?: AbortSignal;
	remotePath?: string;
	compatEnabled?: boolean;
	artifactPath?: string;
	artifactId?: string;
}

export interface SSHResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	timedOut?: boolean;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	artifactId?: string;
}

type SSHExitEvent = { kind: "exit"; exitCode: number } | { kind: "error"; error: unknown };

function createAbortWaiter(
	signal: AbortSignal | undefined,
	streamAbort: AbortController,
): { promise: Promise<ptree.AbortError> | undefined; cleanup: () => void } {
	if (!signal) return { promise: undefined, cleanup: () => {} };

	const { promise, resolve } = Promise.withResolvers<ptree.AbortError>();
	const onAbort = () => {
		const error = new ptree.AbortError(signal.reason, "<cancelled>");
		if (!streamAbort.signal.aborted) streamAbort.abort(error);
		resolve(error);
	};
	if (signal.aborted) {
		onAbort();
		return { promise, cleanup: () => {} };
	}
	signal.addEventListener("abort", onAbort, { once: true });
	return { promise, cleanup: () => signal.removeEventListener("abort", onAbort) };
}

export async function executeSSH(
	host: SSHConnectionTarget,
	command: string,
	options?: SSHExecutorOptions,
): Promise<SSHResult> {
	await ensureConnection(host);
	if (hasSshfs()) {
		try {
			await mountRemote(host, options?.remotePath ?? "/");
		} catch (error) {
			logger.warn("SSHFS mount failed", { host: host.name, error: String(error) });
		}
	}

	let resolvedCommand = command;
	if (options?.compatEnabled) {
		const info = await ensureHostInfo(host);
		if (info.compatShell) {
			resolvedCommand = wrapInPosixShell(info.compatShell, command);
		} else {
			logger.warn("SSH compat enabled without detected compat shell", { host: host.name });
		}
	}

	const invocation = await buildRemoteCommandInvocation(host, resolvedCommand);
	try {
		using child = ptree.spawn(["ssh", ...invocation.args], {
			signal: options?.signal,
			timeout: options?.timeout,
			stdin: "pipe",
			stderr: "full",
			env: invocation.env,
		});

		const settings = await Settings.init();
		const sink = new OutputSink({
			onChunk: options?.onChunk,
			artifactPath: options?.artifactPath,
			artifactId: options?.artifactId,
			headBytes: resolveOutputSinkHeadBytes(settings),
			maxColumns: resolveOutputMaxColumns(settings),
		});
		const streamAbort = new AbortController();
		const abortWaiter = createAbortWaiter(options?.signal, streamAbort);
		const streamOptions = { signal: streamAbort.signal };
		const streams = [child.stdout.pipeTo(sink.createInput(), streamOptions)];
		if (child.stderr) streams.push(child.stderr.pipeTo(sink.createInput(), streamOptions));
		const streamsSettled = Promise.allSettled(streams).then(() => {});

		try {
			const exitEvent = child.exited.then(
				(exitCode): SSHExitEvent => ({ kind: "exit", exitCode }),
				(error): SSHExitEvent => ({ kind: "error", error }),
			);
			const abortEvent = abortWaiter.promise?.then((error): SSHExitEvent => ({ kind: "error", error }));
			const event = await (abortEvent ? Promise.race([exitEvent, abortEvent]) : exitEvent);
			if (event.kind === "error") throw event.error;

			const streamEvent = await (abortEvent ? Promise.race([streamsSettled, abortEvent]) : streamsSettled);
			if (streamEvent?.kind === "error") throw streamEvent.error;
			return { exitCode: event.exitCode, cancelled: false, ...(await sink.dump()) };
		} catch (error) {
			if (!streamAbort.signal.aborted) streamAbort.abort(error);
			void streamsSettled;
			if (error instanceof ptree.Exception) {
				if (error instanceof ptree.TimeoutError) {
					return {
						exitCode: undefined,
						cancelled: true,
						timedOut: true,
						...(await sink.dump(`SSH: ${error.message}`)),
					};
				}
				if (error.aborted) {
					return {
						exitCode: undefined,
						cancelled: true,
						...(await sink.dump(`Command aborted: ${error.message}`)),
					};
				}
				return {
					exitCode: error.exitCode,
					cancelled: false,
					...(await sink.dump(`Unexpected error: ${error.message}`)),
				};
			}
			throw error;
		} finally {
			abortWaiter.cleanup();
		}
	} finally {
		await invocation.cleanup?.();
	}
}
