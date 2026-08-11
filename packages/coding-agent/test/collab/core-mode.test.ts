/**
 * Contract tests for the headless core-mode collab context: context usage
 * mapping from the session's own stats and no-op UI surface that must never
 * throw in a process without a terminal.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSession } from "../../src/session/agent-session";
import { createHeadlessCollabContext, materializeCollabWebFiles } from "../../src/modes/core-mode";

const cacheDirs: string[] = [];

afterEach(async () => {
	await Promise.all(cacheDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function makeSession(getContextUsage: () => unknown): AgentSession {
	return { getContextUsage } as unknown as AgentSession;
}

describe("createHeadlessCollabContext", () => {
	it("maps the session's context usage into the status-line breakdown", () => {
		const ctx = createHeadlessCollabContext(
			makeSession(() => ({ tokens: 100, contextWindow: 200, percent: 50 })),
		);
		expect(ctx.statusLine.getCachedContextBreakdown()).toEqual({ usedTokens: 100, contextWindow: 200 });
	});

	it("reports zeroes when the session has no context usage yet", () => {
		const ctx = createHeadlessCollabContext(makeSession(() => undefined));
		expect(ctx.statusLine.getCachedContextBreakdown()).toEqual({ usedTokens: 0, contextWindow: 0 });
	});

	it("keeps every UI hook a no-op that never throws", () => {
		const ctx = createHeadlessCollabContext(makeSession(() => undefined));
		expect(() => {
			ctx.statusLine.setCollabStatus({ role: "host", participantCount: 1 });
			ctx.statusLine.invalidate();
			ctx.ui.requestRender();
			ctx.updatePendingMessagesDisplay();
			ctx.showStatus("hello");
		}).not.toThrow();
	});
});

describe("materializeCollabWebFiles", () => {
	it("writes embedded files to a content-hashed cache dir and reuses it", async () => {
		const cacheRoot = path.join(os.tmpdir(), `omp-core-materialize-${Date.now()}`);
		cacheDirs.push(cacheRoot);
		const files = {
			"index.html": Buffer.from("<html>embedded</html>").toString("base64"),
			"sub/app.js": Buffer.from("console.log(1)").toString("base64"),
		};

		const dir = await materializeCollabWebFiles(cacheRoot, files, "v1");
		expect(dir).toBe(path.join(cacheRoot, "v1"));
		if (!dir) throw new Error("expected a materialized dir");
		expect(await Bun.file(path.join(dir, "index.html")).text()).toBe("<html>embedded</html>");
		expect(await Bun.file(path.join(dir, "sub/app.js")).text()).toBe("console.log(1)");

		// Idempotent: a second call returns the same dir without re-extraction.
		expect(await materializeCollabWebFiles(cacheRoot, files, "v1")).toBe(dir);
		expect(await Bun.file(path.join(dir, "index.html")).text()).toBe("<html>embedded</html>");
	});

	it("returns null for an empty file set (nothing embedded)", async () => {
		const cacheRoot = path.join(os.tmpdir(), `omp-core-materialize-${Date.now()}`);
		cacheDirs.push(cacheRoot);
		expect(await materializeCollabWebFiles(cacheRoot, {}, "v1")).toBeNull();
	});
});
