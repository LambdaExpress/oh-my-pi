import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as worktreeCli from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";
import Worktree from "@oh-my-pi/pi-coding-agent/commands/worktree";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { removeWithRetries, setProjectDir, setWorktreesDir } from "@oh-my-pi/pi-utils";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const WORKTREE_ACTIONS = [
	"list",
	"add",
	"switch",
	"merge",
	"remove",
	"prune",
	"branch",
	"path",
	"restore",
	"clear",
] as const;

let settingsState: SettingsTestState | undefined;
let tempRoot: string;
let previousExitCode: string | number | null | undefined;

beforeEach(async () => {
	settingsState = beginSettingsTest();
	previousExitCode = process.exitCode;
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worktree-command-"));
	delete process.env.OMP_WORKTREE_DIR;
	setWorktreesDir(undefined);
});

afterEach(async () => {
	process.exitCode = previousExitCode;
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	setWorktreesDir(undefined);
	await removeWithRetries(tempRoot);
});

describe("Worktree command arguments", () => {
	it("keeps the no-argument command as list and exposes every approved action", async () => {
		const descriptor = Worktree.args.action;
		expect(descriptor.default).toBe("list");
		expect(descriptor.options).toEqual([...WORKTREE_ACTIONS]);
	});

	it("parses list and clear compatibility flags without consuming action operands", async () => {
		const list = await parseWorktree(["list", "--json"]);
		expect(list.args.action).toBe("list");
		expect(list.flags.json).toBe(true);
		expect(list.argv).toEqual(["list"]);

		const clear = await parseWorktree(["clear", "--dry-run", "--all", "--json"]);
		expect(clear.args.action).toBe("clear");
		expect(clear.flags["dry-run"]).toBe(true);
		expect(clear.flags.all).toBe(true);
		expect(clear.flags.json).toBe(true);
		expect(clear.argv).toEqual(["clear"]);
	});

	it("parses add options for base ref, dirty transfer policy, and session strategy", async () => {
		const parsed = await parseWorktree([
			"add",
			"feature-review",
			"--base",
			"main",
			"--dirty-policy",
			"copy",
			"--session",
			"none",
		]);

		expect(parsed.args.action).toBe("add");
		expect(parsed.argv).toEqual(["add", "feature-review"]);
		expect(parsed.flags.base).toBe("main");
		expect(parsed.flags["dirty-policy"]).toBe("copy");
		expect(parsed.flags.session).toBe("none");
	});

	it.each([
		{ name: "switch", argv: ["switch", "alpha"] },
		{ name: "merge", argv: ["merge", "alpha"] },
		{ name: "remove", argv: ["remove", "alpha", "--force"], expectedArgv: ["remove", "alpha"] },
		{ name: "prune", argv: ["prune", "--dry-run", "--all"], expectedArgv: ["prune"] },
		{
			name: "branch",
			argv: ["branch", "alpha", "feature/alpha"],
			expectedArgv: ["branch", "alpha", "feature/alpha"],
		},
		{ name: "path", argv: ["path", "alpha", "--json"], expectedArgv: ["path", "alpha"] },
		{ name: "restore", argv: ["restore", "alpha"] },
	])("parses the $name quick action", async ({ name, argv, expectedArgv }) => {
		const parsed = await parseWorktree(argv);
		expect(parsed.args.action).toBe(name);
		expect(parsed.argv).toEqual([...(expectedArgv ?? argv)]);
	});

	it("rejects unknown actions before any scanner or manager work can run", async () => {
		await expect(parseWorktree(["archive", "alpha"])).rejects.toThrow(/Expected action|one of/i);
	});

	it.each([
		{ argv: ["switch"], message: /switch.*id|switch.*name|usage/i },
		{ argv: ["merge"], message: /merge.*id|merge.*name|usage/i },
		{ argv: ["remove"], message: /remove.*id|remove.*name|usage/i },
		{ argv: ["branch", "alpha"], message: /branch.*name|usage/i },
		{ argv: ["path"], message: /path.*id|path.*name|usage/i },
		{ argv: ["restore"], message: /restore.*id|restore.*name|usage/i },
	])("reports usage for missing operands in $argv", async ({ argv, message }) => {
		await expect(runWorktree(argv)).rejects.toThrow(message);
	});
});

describe("Worktree command settings bootstrap", () => {
	it.each([
		{ action: "list", argv: ["list", "--json"], expected: { json: true } },
		{
			action: "clear",
			argv: ["clear", "--dry-run", "--all", "--json"],
			expected: { all: true, dryRun: true, json: true },
		},
		{
			action: "add",
			argv: [
				"add",
				"feature-review",
				"--base",
				"main",
				"--dirty-policy",
				"copy",
				"--session",
				"none",
				"--recurse-submodules",
				"--json",
			],
			expected: {
				name: "feature-review",
				baseRef: "main",
				dirtyPolicy: "copy",
				sessionStrategy: "none",
				recurseSubmodules: true,
				json: true,
			},
		},
		{ action: "switch", argv: ["switch", "alpha", "--json"], expected: { idOrName: "alpha", json: true } },
		{ action: "merge", argv: ["merge", "alpha", "--json"], expected: { idOrName: "alpha", json: true } },
		{
			action: "remove",
			argv: ["remove", "alpha", "--force", "--json"],
			expected: { idOrName: "alpha", force: true, json: true },
		},
		{
			action: "prune",
			argv: ["prune", "--dry-run", "--all", "--json"],
			expected: { all: true, dryRun: true, json: true },
		},
		{
			action: "branch",
			argv: ["branch", "alpha", "feature/alpha", "--json"],
			expected: { idOrName: "alpha", branch: "feature/alpha", json: true },
		},
		{ action: "path", argv: ["path", "alpha", "--json"], expected: { idOrName: "alpha", json: true } },
		{ action: "restore", argv: ["restore", "alpha", "--json"], expected: { idOrName: "alpha", json: true } },
	])("initializes settings before dispatching $action", async ({ action, argv, expected }) => {
		const projectDir = path.join(tempRoot, "project");
		const configuredBase = path.join(tempRoot, "configured-worktrees");
		const events: string[] = [];
		const seen: Record<string, unknown> = {};
		vi.spyOn(Settings, "init").mockImplementation(async options => {
			events.push(`init:${options?.cwd}`);
			setWorktreesDir(configuredBase);
			return Settings.isolated({});
		});
		installActionSpies(events, seen);

		await runWorktree(argv);

		expect(events).toEqual([`init:${projectDir}`, action]);
		expect(seen[action]).toMatchObject(expected);
	});
});

async function parseWorktree(argv: readonly string[]) {
	const command = new Worktree([...argv], testConfig());
	return command.parse(Worktree);
}

async function runWorktree(argv: readonly string[]): Promise<void> {
	const projectDir = path.join(tempRoot, "project");
	await fs.mkdir(projectDir, { recursive: true });
	setProjectDir(projectDir);
	const command = new Worktree([...argv], testConfig());
	await command.run();
}

function testConfig(): CliConfig {
	return { bin: "omp", version: "0.0.0-test", commands: new Map() };
}

function installActionSpies(events: string[], seen: Record<string, unknown>): void {
	vi.spyOn(worktreeCli, "listWorktrees").mockImplementation(async options => {
		events.push("list");
		seen.list = options;
	});
	vi.spyOn(worktreeCli, "clearWorktrees").mockImplementation(async options => {
		events.push("clear");
		seen.clear = options;
	});
	vi.spyOn(worktreeCli, "addWorktree").mockImplementation(async options => {
		events.push("add");
		seen.add = options;
	});
	vi.spyOn(worktreeCli, "switchWorktree").mockImplementation(async options => {
		events.push("switch");
		seen.switch = options;
	});
	vi.spyOn(worktreeCli, "mergeWorktree").mockImplementation(async options => {
		events.push("merge");
		seen.merge = options;
	});
	vi.spyOn(worktreeCli, "removeWorktree").mockImplementation(async options => {
		events.push("remove");
		seen.remove = options;
	});
	vi.spyOn(worktreeCli, "pruneWorktrees").mockImplementation(async options => {
		events.push("prune");
		seen.prune = options;
	});
	vi.spyOn(worktreeCli, "branchWorktree").mockImplementation(async options => {
		events.push("branch");
		seen.branch = options;
	});
	vi.spyOn(worktreeCli, "pathWorktree").mockImplementation(async options => {
		events.push("path");
		seen.path = options;
	});
	vi.spyOn(worktreeCli, "restoreWorktree").mockImplementation(async options => {
		events.push("restore");
		seen.restore = options;
	});
}
