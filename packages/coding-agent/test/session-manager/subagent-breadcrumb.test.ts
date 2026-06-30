import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { readTerminalBreadcrumbEntry } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { getTerminalId } from "@oh-my-pi/pi-tui";
import { getConfigRootDir, getTerminalSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";

import { makeAssistantMessage } from "./helpers";

const JSONL_SUFFIX = ".jsonl";

const TERMINAL_ENV_KEYS = [
	"ZELLIJ_PANE_ID",
	"ZELLIJ_SESSION_NAME",
	"TMUX_PANE",
	"CMUX_SURFACE_ID",
	"KITTY_WINDOW_ID",
	"WEZTERM_PANE",
	"TERM_SESSION_ID",
	"WT_SESSION",
] as const;
type TerminalEnvKey = (typeof TERMINAL_ENV_KEYS)[number];

/** Synchronously seed the per-terminal breadcrumb (write is otherwise fire-and-forget). */
function writeBreadcrumb(cwd: string, sessionFile: string): void {
	const terminalId = getTerminalId();
	if (!terminalId) throw new Error("Expected a terminal id for breadcrumb test");
	const dir = getTerminalSessionsDir();
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, terminalId), `${cwd}\n${sessionFile}\n`);
}

/** Materialize a subagent session file under the parent's artifacts dir (`<parent>/<id>.jsonl`). */
async function writeSubagentSession(parentFile: string, agentId: string, userText: string): Promise<string> {
	const artifactsDir = parentFile.slice(0, -JSONL_SUFFIX.length);
	fs.mkdirSync(artifactsDir, { recursive: true });
	const subFile = path.join(artifactsDir, `${agentId}.jsonl`);
	// Subagents open in the parent's TTY; suppression is what keeps them off the breadcrumb.
	const sub = await SessionManager.open(subFile, undefined, undefined, {
		initialCwd: path.dirname(parentFile),
		suppressBreadcrumb: true,
	});
	sub.appendMessage({ role: "user", content: userText, timestamp: 2 });
	sub.appendMessage(makeAssistantMessage());
	await sub.flush();
	await sub.close();
	return subFile;
}

describe("SessionManager subagent breadcrumb isolation", () => {
	let testAgentDir: string;
	let cwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	let terminalEnvBefore: Partial<Record<TerminalEnvKey, string | undefined>> = {};
	let stdinIsTTYBefore: PropertyDescriptor | undefined;
	let stdinIsTTYOverridden = false;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(async () => {
		// Deterministic terminal id so breadcrumb read/write is stable even when
		// the aggregate suite runs under a real TTY or inherited terminal env.
		terminalEnvBefore = {};
		for (const key of TERMINAL_ENV_KEYS) {
			terminalEnvBefore[key] = process.env[key];
			delete process.env[key];
		}
		process.env.TMUX_PANE = "%subagent-breadcrumb-test";
		stdinIsTTYBefore = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		stdinIsTTYOverridden = false;
		try {
			Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
			stdinIsTTYOverridden = true;
		} catch {}
		testAgentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-subagent-crumb-"));
		setAgentDir(testAgentDir);
		cwd = path.join(testAgentDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
	});

	afterEach(async () => {
		for (const key of TERMINAL_ENV_KEYS) {
			const previous = terminalEnvBefore[key];
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
		}
		if (stdinIsTTYOverridden) {
			if (stdinIsTTYBefore) {
				Object.defineProperty(process.stdin, "isTTY", stdinIsTTYBefore);
			} else {
				Reflect.deleteProperty(process.stdin, "isTTY");
			}
		}
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fsp.rm(testAgentDir, { recursive: true, force: true });
	});

	async function createParentSession(): Promise<string> {
		const mainFile = SessionManager.createEmptySessionFile(cwd);
		const main = await SessionManager.open(mainFile, undefined, undefined, { suppressBreadcrumb: true });
		main.appendMessage({ role: "user", content: "main work", timestamp: 1 });
		main.appendMessage(makeAssistantMessage());
		await main.flush();
		await main.close();
		return mainFile;
	}

	it("keeps --continue on the parent when a subagent opens in the same terminal", async () => {
		const mainFile = await createParentSession();
		writeBreadcrumb(cwd, mainFile);

		// A subagent opening its own session must not clobber the terminal breadcrumb.
		await writeSubagentSession(mainFile, "Worker", "subagent work");

		const crumb = await readTerminalBreadcrumbEntry();
		expect(crumb?.sessionFile).toBe(mainFile);

		const resumed = await SessionManager.continueRecent(cwd);
		try {
			expect(resumed.getSessionFile()).toBe(path.resolve(mainFile));
			const dump = JSON.stringify(resumed.getEntries());
			expect(dump).toContain("main work");
			expect(dump).not.toContain("subagent work");
		} finally {
			await resumed.close();
		}
	});

	it("recovers a stale breadcrumb that points inside a subagent artifacts dir", async () => {
		const mainFile = await createParentSession();
		const subFile = await writeSubagentSession(mainFile, "Worker", "subagent work");

		// Simulate a pre-fix poisoned breadcrumb pointing at the subagent transcript.
		writeBreadcrumb(cwd, subFile);

		const resumed = await SessionManager.continueRecent(cwd);
		try {
			// Redirected up to the interactive root rather than resuming the subagent.
			expect(resumed.getSessionFile()).toBe(path.resolve(mainFile));
			const dump = JSON.stringify(resumed.getEntries());
			expect(dump).toContain("main work");
			expect(dump).not.toContain("subagent work");
		} finally {
			await resumed.close();
		}
	});
});
