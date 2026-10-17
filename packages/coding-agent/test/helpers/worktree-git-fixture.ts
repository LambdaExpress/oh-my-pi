import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ptree } from "@oh-my-pi/pi-utils";

type TestBody = () => void | Promise<void>;
type RegisterTest = (name: string, body: TestBody, timeout?: number) => void;

interface GitFixtureOptions {
	trimOutput?: "both" | "end";
	setIdentity?: boolean;
}

/**
 * Own fixture Git process trees and the test bodies that can start them.
 * Bun timeouts do not cancel an async test body, so teardown must stop its
 * children and drain the body before restoring env or deleting its checkout.
 */
export function createWorktreeGitFixture(
	registerTest: RegisterTest,
	{ trimOutput = "both", setIdentity = true }: GitFixtureOptions = {},
) {
	const children = new Map<ptree.ChildProcess, Promise<ptree.ExecResult>>();
	let activeBody: { promise: Promise<void>; settled: boolean } | undefined;
	let closing: Promise<void> | undefined;
	let closeReason: ptree.AbortError | undefined;

	function it(name: string, body: TestBody, timeout?: number): void {
		registerTest(
			name,
			() => {
				const state = { promise: Promise.resolve().then(body), settled: false };
				activeBody = state;
				void state.promise.then(
					() => {
						state.settled = true;
					},
					() => {
						state.settled = true;
					},
				);
				return state.promise.catch(error => {
					// Bun already reported a timed-out test before teardown aborts
					// its remaining Git work. Preserve every other body failure.
					if (closeReason !== undefined && error === closeReason) return;
					throw error;
				});
			},
			timeout,
		);
	}

	async function runGit(cwd: string, args: readonly string[]): Promise<string> {
		if (closeReason) throw closeReason;
		const child = ptree.spawn(["git", "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], {
			cwd,
			detached: process.platform !== "win32",
			env: {
				...process.env,
				...(setIdentity
					? {
							GIT_AUTHOR_NAME: "Test User",
							GIT_AUTHOR_EMAIL: "test@example.com",
							GIT_COMMITTER_NAME: "Test User",
							GIT_COMMITTER_EMAIL: "test@example.com",
						}
					: {}),
			},
		});
		const completion = child.wait({ allowNonZero: true });
		children.set(child, completion);
		try {
			const { stdout, stderr, exitCode } = await completion;
			if (exitCode !== 0) {
				throw new Error(
					`git ${args.join(" ")} failed: ${stderr.trim() || stdout.trim() || `exit code ${exitCode}`}`,
				);
			}
			return trimOutput === "end" ? stdout.trimEnd() : stdout.trim();
		} finally {
			children.delete(child);
		}
	}

	async function initRepo(cwd: string, branch = "main"): Promise<void> {
		await runGit(cwd, ["init", "-q", "-b", branch]);
		// These are fixture data, not config-command behavior under test. Persist
		// them together instead of spawning four more Git processes per repo.
		await fs.appendFile(
			path.join(cwd, ".git", "config"),
			"\n[core]\n\tautocrlf = false\n\teol = lf\n" +
				"[user]\n\tname = Test User\n\temail = test@example.com\n" +
				"[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n",
		);
	}

	function drain(): Promise<void> {
		if (closing) return closing;
		const body = activeBody;
		const bodyWasPending = body !== undefined && !body.settled;
		const reason = new ptree.AbortError("worktree Git fixture closed", "");
		closeReason = reason;
		closing = (async () => {
			try {
				for (const child of children.keys()) child.kill(reason, -1);
				await Promise.allSettled(children.values());
				try {
					await body?.promise;
				} catch (error) {
					// Settled failures already reached Bun through the original test
					// promise. Only our own teardown cancellation is expected while
					// draining a still-running body; genuine late failures must surface.
					if (bodyWasPending && error !== reason) throw error;
				}
			} finally {
				activeBody = undefined;
				closeReason = undefined;
				closing = undefined;
			}
		})();
		return closing;
	}

	async function close(cleanup?: TestBody): Promise<void> {
		try {
			await drain();
		} finally {
			await cleanup?.();
		}
	}

	return { it, runGit, initRepo, close };
}
