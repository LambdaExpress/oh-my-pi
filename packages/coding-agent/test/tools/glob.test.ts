import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { FileType } from "@oh-my-pi/pi-natives";
import type { GlobToolDetails } from "@oh-my-pi/pi-tui/tools/glob";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { GlobTool } from "../../src/tools/glob";
import { findUniqueWorkspaceSuffixWithGlobForTest } from "../../src/tools/path-utils";
import { ToolAbortError } from "../../src/tools/tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { formatOutputNotice } from "@oh-my-pi/pi-tui/tools/output-meta";

function createSession(cwd = process.cwd()): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

const ROOT_SEARCH_ERROR = "Searching from root directory '/' is not allowed";

async function expectRootSearchRejected(searchPath: string): Promise<void> {
	const tool = new GlobTool(createSession());
	let thrown: unknown;
	try {
		await tool.execute("glob-root-regression", { path: searchPath });
	} catch (error) {
		thrown = error;
	}

	if (!(thrown instanceof Error)) {
		throw new Error(`Expected glob path ${JSON.stringify(searchPath)} to reject`);
	}

	expect(thrown).toBeInstanceOf(ToolError);
	expect(thrown.message).toBe(ROOT_SEARCH_ERROR);
}

describe("GlobTool.execute", () => {
	test.each(["/", "//"])("rejects bare root search path %s", async searchPath => {
		await expectRootSearchRejected(searchPath);
	});

	test("matches a linked-worktree .git file while pruning repository .git directories", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "glob-git-file-"));
		try {
			const worktree = path.join(root, "linked-worktree");
			const repository = path.join(root, "repository");
			await fs.mkdir(worktree);
			await fs.mkdir(path.join(repository, ".git"), { recursive: true });
			await fs.writeFile(path.join(worktree, ".git"), "gitdir: ../repository/.git/worktrees/linked-worktree\n");
			await fs.writeFile(path.join(worktree, ".hidden"), "ordinary hidden file\n");
			await fs.writeFile(path.join(repository, ".git", "config"), "[core]\n");

			const tool = new GlobTool(createSession(root));
			const result = await tool.execute("glob-linked-worktree-git-file", {
				path: path.join(root, "*", ".git"),
				hidden: true,
				gitignore: false,
			});

			expect(result.details?.files).toEqual(["linked-worktree/.git"]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("rejects a caller abort during preparation without launching a native scan", async () => {
		const controller = new AbortController();
		const statStarted = Promise.withResolvers<void>();
		const releaseStat = Promise.withResolvers<void>();
		const statSettled = Promise.withResolvers<void>();
		let nativeStarted = false;
		const tool = new GlobTool(createSession(), {
			stat: async () => {
				statStarted.resolve();
				try {
					await releaseStat.promise;
					throw new Error("Released blocked stat");
				} finally {
					statSettled.resolve();
				}
			},
			nativeGlob: async () => {
				nativeStarted = true;
				return { matches: [], totalMatches: 0 };
			},
		});
		const execution = tool.execute("glob-preparation-abort", { path: "." }, controller.signal);

		await statStarted.promise;
		try {
			controller.abort();
			await expect(execution).rejects.toThrow("Aborted");
			expect(nativeStarted).toBe(false);
		} finally {
			releaseStat.resolve();
			await statSettled.promise;
		}
		expect(nativeStarted).toBe(false);
	});

	test("does not finish a timeout until the native scan has stopped", async () => {
		const started = Promise.withResolvers<void>();
		const timeoutObserved = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let nativeSettled = false;
		const tool = new GlobTool(createSession(), {
			timeoutMs: 100,
			nativeGlob: async options => {
				if (!(options.signal instanceof AbortSignal)) {
					started.resolve();
					timeoutObserved.resolve();
					throw new Error("Missing native cancellation signal");
				}
				const nativeSignal = options.signal;
				nativeSignal.addEventListener("abort", () => timeoutObserved.resolve(), { once: true });
				started.resolve();
				await timeoutObserved.promise;
				await release.promise;
				nativeSettled = true;
				throw new Error("GenericFailure, Aborted: Timeout");
			},
		});

		const execution = tool.execute("glob-timeout-cleanup", { path: "." });
		let executionSettled = false;
		void execution.then(
			() => {
				executionSettled = true;
			},
			() => {
				executionSettled = true;
			},
		);
		await started.promise;
		await timeoutObserved.promise;
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(executionSettled).toBe(false);

		release.resolve();
		const result = await execution;

		expect(nativeSettled).toBe(true);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Glob timed out after 0.1s");
	});

	test("waits for every native scan to settle before rejecting an abort", async () => {
		const controller = new AbortController();
		const allStarted = Promise.withResolvers<void>();
		const allAborted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let startedCount = 0;
		let abortedCount = 0;
		let settledCount = 0;
		const tool = new GlobTool(createSession(), {
			timeoutMs: 5000,
			nativeGlob: async options => {
				if (!(options.signal instanceof AbortSignal)) throw new Error("Missing native cancellation signal");
				const nativeSignal = options.signal;
				const abortObserved = Promise.withResolvers<void>();
				nativeSignal.addEventListener(
					"abort",
					() => {
						abortedCount += 1;
						if (abortedCount === 2) allAborted.resolve();
						abortObserved.resolve();
					},
					{ once: true },
				);
				startedCount += 1;
				if (startedCount === 2) allStarted.resolve();
				await abortObserved.promise;
				await release.promise;
				settledCount += 1;
				throw new Error("GenericFailure, Aborted: Signal");
			},
		});
		const execution = tool.execute(
			"glob-abort-cleanup",
			{ path: `.; ${path.dirname(process.cwd())}` },
			controller.signal,
		);
		let executionSettled = false;
		void execution.then(
			() => {
				executionSettled = true;
			},
			() => {
				executionSettled = true;
			},
		);

		await allStarted.promise;
		controller.abort();
		await allAborted.promise;
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(executionSettled).toBe(false);

		release.resolve();
		await expect(execution).rejects.toBeInstanceOf(ToolAbortError);
		expect(settledCount).toBe(2);
	});
	test("suffix recovery rejects a caller abort after native completion", async () => {
		const controller = new AbortController();
		const nativeCompleted = Promise.withResolvers<void>();
		const releaseResult = Promise.withResolvers<void>();
		const execution = findUniqueWorkspaceSuffixWithGlobForTest(
			"target.ts",
			"/workspace",
			controller.signal,
			async () => {
				nativeCompleted.resolve();
				await releaseResult.promise;
				return {
					matches: [{ path: "nested/target.ts", fileType: FileType.File }],
					totalMatches: 1,
				};
			},
		);

		await nativeCompleted.promise;
		controller.abort();
		releaseResult.resolve();
		await expect(execution).rejects.toBeInstanceOf(ToolAbortError);
	});
});

describe("GlobTool hard-cap limit notice", () => {
	const files5001 = Array.from({ length: 5001 }, (_, i) => `f${String(i).padStart(4, "0")}`);

	function globToolWith(files: string[]): GlobTool {
		return new GlobTool(createSession(), {
			nativeGlob: async () => ({
				matches: files.map(file => ({ path: file, mtime: 0, fileType: FileType.File })),
				totalMatches: files.length,
			}),
		});
	}

	function textOf(result: AgentToolResult<GlobToolDetails>): string {
		const first = result.content[0];
		return first?.type === "text" && first.text !== undefined ? first.text : "";
	}

	function limitNotice(result: AgentToolResult<GlobToolDetails>): string {
		return formatOutputNotice(result.details?.meta);
	}

	test("discloses a clamped request and never advises a value that clamps back", async () => {
		const result = await globToolWith(files5001).execute("glob-clamp-notice", {
			path: ".",
			limit: 6000,
			gitignore: false,
		});

		expect(result.details?.fileCount).toBe(5000);
		expect(result.details?.files).toEqual(files5001.slice(0, 5000));
		expect(textOf(result)).toContain("Requested limit 6000 clamped to the max of 5000");
		expect(limitNotice(result)).toContain("5000 results limit reached");
		expect(limitNotice(result)).not.toContain("Use limit=");
	});

	test("an explicit hard-cap request keeps the reached notice without doomed advice", async () => {
		const result = await globToolWith(files5001).execute("glob-cap-explicit", {
			path: ".",
			limit: 5000,
			gitignore: false,
		});

		expect(result.details?.fileCount).toBe(5000);
		expect(textOf(result)).not.toContain("clamped");
		expect(limitNotice(result)).toContain("5000 results limit reached");
		expect(limitNotice(result)).not.toContain("Use limit=");
	});

	test("below the cap the doubled suggestion is capped at the hard limit and stays usable", async () => {
		const tool = globToolWith(files5001);
		const result = await tool.execute("glob-below-cap", { path: ".", limit: 3000, gitignore: false });

		expect(result.details?.fileCount).toBe(3000);
		expect(limitNotice(result)).toContain("[3000 results limit reached. Use limit=5000 for more]");
		const expanded = await tool.execute("glob-bounded-suggestion", { path: ".", limit: 5000, gitignore: false });
		expect(expanded.details?.files).toEqual(files5001.slice(0, 5000));
		expect(textOf(expanded)).not.toContain("clamped");
	});

	test("the default 200 limit suggests a usable increase below the hard cap", async () => {
		const files430 = files5001.slice(0, 430);
		const tool = globToolWith(files430);
		const result = await tool.execute("glob-default", { path: ".", gitignore: false });

		expect(result.details?.files).toEqual(files430.slice(0, 200));
		expect(textOf(result)).not.toContain("clamped");
		expect(limitNotice(result)).toContain("[200 results limit reached. Use limit=400 for more]");
		const expanded = await tool.execute("glob-default-suggestion", { path: ".", limit: 400, gitignore: false });
		expect(expanded.details?.files).toEqual(files430.slice(0, 400));
		expect(textOf(expanded)).not.toContain("clamped");
	});
});
