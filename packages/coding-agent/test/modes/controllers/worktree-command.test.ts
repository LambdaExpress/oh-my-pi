import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import * as worktreeManager from "@oh-my-pi/pi-coding-agent/worktree/manager";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { readManagedWorktreeRecord, writeManagedWorktreeRecord } from "@oh-my-pi/pi-coding-agent/worktree/metadata";
import type { ManagedWorktreeRecord } from "@oh-my-pi/pi-coding-agent/worktree/types";
import type { ManagedWorktreeResult } from "@oh-my-pi/pi-coding-agent/worktree/manager";
import { removeWithRetries, setWorktreesDir } from "@oh-my-pi/pi-utils";

interface WorktreeCommandController {
	handleWorktreeCommand(args?: string): Promise<void>;
}

const tempDirs: string[] = [];
let originalWorktreeEnv: string | undefined;

beforeEach(async () => {
	originalWorktreeEnv = process.env.OMP_WORKTREE_DIR;
	delete process.env.OMP_WORKTREE_DIR;
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Expected dark theme");
	setThemeInstance(theme);
});

afterEach(async () => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
	if (originalWorktreeEnv === undefined) delete process.env.OMP_WORKTREE_DIR;
	else process.env.OMP_WORKTREE_DIR = originalWorktreeEnv;
	for (const dir of tempDirs.splice(0)) {
		await removeWithRetries(dir);
	}
});

async function setupManagedBase(): Promise<string> {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ui-worktree-"));
	tempDirs.push(base);
	setWorktreesDir(base);
	return base;
}

async function createRecord(
	base: string,
	overrides: Partial<ManagedWorktreeRecord> & Pick<ManagedWorktreeRecord, "id" | "name">,
): Promise<ManagedWorktreeRecord> {
	const primaryRoot = path.join(base, "primary");
	const worktreeRoot = path.join(base, "worktrees", overrides.id);
	await fs.mkdir(path.join(worktreeRoot, "pkg"), { recursive: true });
	await fs.mkdir(primaryRoot, { recursive: true });
	const now = "2026-07-05T00:00:00.000Z";
	const { id, name, ...rest } = overrides;
	const record: ManagedWorktreeRecord = {
		id,
		name,
		owner: "omp",
		version: 2,
		primaryRoot,
		sourceRepoRoot: primaryRoot,
		worktreeRoot,
		relativeCwd: "pkg",
		baseRef: "HEAD",
		baseSha: "0123456789abcdef0123456789abcdef01234567",
		headSha: "0123456789abcdef0123456789abcdef01234567",
		mode: "managed",
		state: "ready",
		branch: null,
		detached: true,
		sessionFile: null,
		sessionId: null,
		title: null,
		createdAt: now,
		updatedAt: now,
		lastUsedAt: now,
		dirtyPolicy: "ignore",
		includeCopied: [],
		recurseSubmodules: false,
		submodules: [],
		snapshotPath: null,
		appliedAt: null,
		...rest,
	};
	await writeManagedWorktreeRecord(record);
	return record;
}

async function writeSessionFile(base: string, name: string, cwd: string): Promise<string> {
	const sessionFile = path.join(base, `${name}.jsonl`);
	await fs.writeFile(sessionFile, `${JSON.stringify({ cwd, sessionId: `${name}-id` })}\n`, "utf8");
	return sessionFile;
}

function createWorktreeContext(sourceDir: string) {
	const order: string[] = [];
	const state = { cwd: sourceDir };
	const createdSessionFile = path.join(sourceDir, "created-session.jsonl");
	const session = {
		isStreaming: false,
		sessionFile: undefined as string | undefined,
		sessionId: "current-session-id",
		sessionName: "Current Session",
		newSession: vi.fn(async () => {
			order.push("newSession");
			session.sessionFile = createdSessionFile;
			session.sessionId = "created-session-id";
			return true;
		}),
		switchSession: vi.fn(async (sessionFile: string) => {
			order.push("switchSession");
			session.sessionFile = path.resolve(sessionFile);
			const headerLine = (await fs.readFile(session.sessionFile, "utf8")).split("\n", 1)[0] ?? "{}";
			const header = JSON.parse(headerLine) as { cwd?: string; sessionId?: string };
			if (header.cwd) state.cwd = path.resolve(header.cwd);
			if (header.sessionId) session.sessionId = header.sessionId;
			return true;
		}),
	};
	const ctx = {
		session,
		sessionManager: {
			getCwd: () => state.cwd,
			getSessionFile: () => session.sessionFile,
			getSessionId: () => session.sessionId,
			getSessionName: () => session.sessionName,
			moveTo: vi.fn(async (cwd: string) => {
				order.push("moveTo");
				state.cwd = path.resolve(cwd);
			}),
		},
		showError: vi.fn(),
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		showHookCustom: vi.fn(async () => undefined),
		showHookInput: vi.fn(async () => undefined),
		present: vi.fn(),
		clearTransientSessionUi: vi.fn(() => order.push("clearTransientSessionUi")),
		resetObserverRegistry: vi.fn(() => order.push("resetObserverRegistry")),
		applyCwdChange: vi.fn(async (cwd: string) => {
			order.push("applyCwdChange");
			expect(state.cwd).toBe(path.resolve(cwd));
		}),
		updateEditorBorderColor: vi.fn(() => order.push("updateEditorBorderColor")),
		reloadTodos: vi.fn(async () => {
			order.push("reloadTodos");
		}),
		renderInitialMessages: vi.fn(() => order.push("renderInitialMessages")),
		ui: { requestRender: vi.fn(() => order.push("requestRender")) },
		statusLine: { invalidate: vi.fn(), resetActiveTime: vi.fn() },
		chatContainer: { clear: vi.fn(() => order.push("chatContainer.clear")) },
		editor: { addToHistory: vi.fn(), setText: vi.fn() },
	} as unknown as InteractiveModeContext;
	return { ctx, order, session, state };
}

describe("CommandController /worktree", () => {
	it("parses recurse flag for add commands", async () => {
		const base = await setupManagedBase();
		const primaryRoot = path.join(base, "primary");
		const record = await createRecord(base, {
			id: "recursive-add",
			name: "Recursive Add",
			primaryRoot,
			sourceRepoRoot: primaryRoot,
			recurseSubmodules: true,
		});
		const result: ManagedWorktreeResult = {
			record,
			worktreeRoot: record.worktreeRoot,
			targetCwd: path.join(record.worktreeRoot, record.relativeCwd),
			warnings: [],
		};
		vi.spyOn(worktreeManager, "addManagedWorktree").mockResolvedValue(result);
		const { ctx } = createWorktreeContext(primaryRoot);

		await (new CommandController(ctx) as unknown as WorktreeCommandController).handleWorktreeCommand(
			"add Recursive Add --recurse-submodules",
		);

		expect(worktreeManager.addManagedWorktree).toHaveBeenCalledWith({
			cwd: primaryRoot,
			name: "Recursive Add",
			dirtyPolicy: "ignore",
			recurseSubmodules: true,
		});
		expect(ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining("Created managed worktree Recursive Add"));
	});

	it("switch adopts the resumed session cwd before re-scoping TUI state", async () => {
		const base = await setupManagedBase();
		const record = await createRecord(base, { id: "alpha", name: "Alpha" });
		const targetCwd = path.join(record.worktreeRoot, record.relativeCwd);
		const sessionFile = await writeSessionFile(base, "alpha-session", targetCwd);
		await writeManagedWorktreeRecord({ ...record, sessionFile, sessionId: "alpha-session-id" });
		const { ctx, order, session } = createWorktreeContext(record.primaryRoot);

		await (new CommandController(ctx) as unknown as WorktreeCommandController).handleWorktreeCommand("switch alpha");

		expect(session.switchSession).toHaveBeenCalledWith(sessionFile);
		expect(ctx.sessionManager.moveTo).not.toHaveBeenCalled();
		expect(ctx.applyCwdChange).toHaveBeenCalledWith(targetCwd);
		expect(order.indexOf("switchSession")).toBeLessThan(order.indexOf("applyCwdChange"));
		expect(order.indexOf("applyCwdChange")).toBeLessThan(order.indexOf("updateEditorBorderColor"));
		expect(order.indexOf("updateEditorBorderColor")).toBeLessThan(order.indexOf("reloadTodos"));
		expect(order.indexOf("reloadTodos")).toBeLessThan(order.indexOf("requestRender"));
		expect(ctx.showError).not.toHaveBeenCalled();
		expect(ctx.showWarning).not.toHaveBeenCalled();
	});

	it("refuses to switch worktrees while the session is streaming", async () => {
		const base = await setupManagedBase();
		const record = await createRecord(base, { id: "busy", name: "Busy" });
		const sessionFile = await writeSessionFile(base, "busy-session", record.worktreeRoot);
		await writeManagedWorktreeRecord({ ...record, sessionFile, sessionId: "busy-session-id" });
		const { ctx, session } = createWorktreeContext(record.primaryRoot);
		session.isStreaming = true;

		await (new CommandController(ctx) as unknown as WorktreeCommandController).handleWorktreeCommand("switch busy");

		expect(session.switchSession).not.toHaveBeenCalled();
		expect(ctx.sessionManager.moveTo).not.toHaveBeenCalled();
		expect(ctx.applyCwdChange).not.toHaveBeenCalled();
		expect(ctx.showWarning).toHaveBeenCalledWith(expect.stringContaining("current response"));
	});

	it("creates a session for an unassociated worktree and persists the metadata binding", async () => {
		const base = await setupManagedBase();
		const record = await createRecord(base, { id: "fresh", name: "Fresh" });
		const targetCwd = path.join(record.worktreeRoot, record.relativeCwd);
		const { ctx, order, session } = createWorktreeContext(record.primaryRoot);

		await (new CommandController(ctx) as unknown as WorktreeCommandController).handleWorktreeCommand("switch fresh");

		expect(session.newSession).toHaveBeenCalledTimes(1);
		expect(ctx.sessionManager.moveTo).toHaveBeenCalledWith(targetCwd);
		expect(ctx.applyCwdChange).toHaveBeenCalledWith(targetCwd);
		expect(order.indexOf("newSession")).toBeLessThan(order.indexOf("moveTo"));
		expect(order.indexOf("moveTo")).toBeLessThan(order.indexOf("applyCwdChange"));
		const updated = await readManagedWorktreeRecord("fresh");
		expect(updated?.sessionFile).toBe(path.resolve(path.join(record.primaryRoot, "created-session.jsonl")));
		expect(updated?.sessionId).toBe("created-session-id");
	});

	it("moves the current session into a worktree without switching to another session file", async () => {
		const base = await setupManagedBase();
		const record = await createRecord(base, { id: "move-me", name: "Move Me" });
		const targetCwd = path.join(record.worktreeRoot, record.relativeCwd);
		const sessionFile = await writeSessionFile(base, "move-me-session", targetCwd);
		await writeManagedWorktreeRecord({ ...record, sessionFile, sessionId: "existing-session-id" });
		const { ctx, session } = createWorktreeContext(record.primaryRoot);
		ctx.showHookCustom = vi.fn(async () => ({
			action: "move-current" as const,
			id: "move-me",
		})) as unknown as InteractiveModeContext["showHookCustom"];

		await (new CommandController(ctx) as unknown as WorktreeCommandController).handleWorktreeCommand();

		expect(ctx.sessionManager.moveTo).toHaveBeenCalledWith(targetCwd);
		expect(session.switchSession).not.toHaveBeenCalled();
		expect(ctx.applyCwdChange).toHaveBeenCalledWith(targetCwd);
	});
});
