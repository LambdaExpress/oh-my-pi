import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as worktreeCli from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";
import { removeWithRetries, setWorktreesDir } from "@oh-my-pi/pi-utils";

interface FixturePaths {
	base: string;
	empty: string;
	managed: string;
	metadata: string;
	pr: string;
	raw: string;
	snapshotted: string;
	stray: string;
	task: string;
}

type JsonObject = Record<string, unknown>;

type RemoveWorktree = (options: worktreeCli.RemoveWorktreeCliOptions) => Promise<unknown>;

let tempRoot: string;
let previousWorktreeEnv: string | undefined;
let previousExitCode: string | number | null | undefined;

beforeEach(async () => {
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worktree-cli-"));
	previousWorktreeEnv = process.env.OMP_WORKTREE_DIR;
	previousExitCode = process.exitCode;
	delete process.env.OMP_WORKTREE_DIR;
	setWorktreesDir(path.join(tempRoot, "wt"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
	if (previousWorktreeEnv === undefined) delete process.env.OMP_WORKTREE_DIR;
	else process.env.OMP_WORKTREE_DIR = previousWorktreeEnv;
	process.exitCode = previousExitCode;
	await removeWithRetries(tempRoot);
});

describe("worktree CLI scanner", () => {
	it("renders an empty worktree base as an empty list instead of touching the host profile", async () => {
		const output = await captureConsole(async () => {
			await worktreeCli.listWorktrees({ json: false });
		});

		expect(output).toContain("No agent-managed worktrees found under");
		expect(output).toContain(path.join(tempRoot, "wt"));
	});

	it("classifies managed, snapshotted, PR checkout, task leftover, raw git, empty, and stray entries", async () => {
		const fixture = await createScannerFixture();

		const output = await captureConsole(async () => {
			await worktreeCli.listWorktrees({ json: true });
		});
		const entries = parseJsonArray(output);

		expect(entries.map(entry => stringField(entry, "kind")).sort()).toEqual([
			"empty",
			"managed",
			"pr-checkout",
			"raw-git-worktree",
			"snapshotted",
			"stray",
			"task-isolation",
		]);

		const managed = metadataFor(findEntry(entries, "managed"));
		expect(managed).toMatchObject({
			id: "managed-alpha",
			name: "Alpha background",
			owner: "omp",
			state: "ready",
			worktreeRoot: fixture.managed,
		});

		const snapshotted = metadataFor(findEntry(entries, "snapshotted"));
		expect(snapshotted).toMatchObject({
			id: "snap-beta",
			name: "Beta snapshot",
			owner: "omp",
			state: "snapshotted",
			snapshotPath: fixture.snapshotted,
		});

		expect(findEntry(entries, "pr-checkout")).toMatchObject({
			path: fixture.pr,
			branch: "pr-42",
		});
		expect(findEntry(entries, "raw-git-worktree")).toMatchObject({
			path: fixture.raw,
			branch: "feature/raw-worktree",
		});
		expect(findEntry(entries, "task-isolation")).toMatchObject({ path: fixture.task });
		expect(findEntry(entries, "empty")).toMatchObject({ path: fixture.empty });
		expect(findEntry(entries, "stray")).toMatchObject({ path: fixture.stray });
		expect(entries.every(entry => path.basename(stringField(entry, "path")) !== "metadata")).toBe(true);
	});

	it("clear removes only orphan-style compatibility leftovers by default", async () => {
		const fixture = await createScannerFixture();

		const output = await captureConsole(async () => {
			await worktreeCli.clearWorktrees({ all: false, dryRun: false, json: true });
		});
		const result = parseJsonObject(output);

		expect(numberField(result, "removed")).toBe(3);
		await expectPathMissing(fixture.task);
		await expectPathMissing(fixture.empty);
		await expectPathMissing(fixture.stray);
		await expectPathPresent(fixture.managed);
		await expectPathPresent(fixture.metadata);
		await expectPathPresent(fixture.pr);
		await expectPathPresent(fixture.raw);
	});

	it("clear --all can remove live PR checkouts without deleting managed or raw worktrees", async () => {
		const fixture = await createScannerFixture();

		const output = await captureConsole(async () => {
			await worktreeCli.clearWorktrees({ all: true, dryRun: false, json: true });
		});
		const result = parseJsonObject(output);

		expect(numberField(result, "removed")).toBe(4);
		await expectPathMissing(fixture.pr);
		await expectPathMissing(fixture.task);
		await expectPathMissing(fixture.empty);
		await expectPathMissing(fixture.stray);
		await expectPathPresent(fixture.managed);
		await expectPathPresent(fixture.metadata);
		await expectPathPresent(fixture.raw);
	});

	it("remove rejects a raw git worktree instead of deleting a worktree it does not own", async () => {
		const fixture = await createScannerFixture();
		const removeWorktree = getRemoveWorktree(worktreeCli);
		expect(removeWorktree).toBeDefined();
		if (!removeWorktree) return;

		await expect(
			removeWorktree({ cwd: tempRoot, idOrName: path.basename(fixture.raw), force: false, json: false }),
		).rejects.toThrow(/managed|owner|raw|not.*Oh My Pi/i);
		await expectPathPresent(fixture.raw);
	});
});

async function createScannerFixture(): Promise<FixturePaths> {
	const base = path.join(tempRoot, "wt");
	const project = path.join(base, "project-aaaaaaa");
	const metadataDir = path.join(base, "metadata");
	const snapshotDir = path.join(base, "snapshots", "project-aaaaaaa", "snap-beta-20260705T000000Z");
	const managed = path.join(project, "alpha-managed-a1b2c3d4");
	const pr = path.join(base, "42-abcdef0");
	const raw = path.join(base, "external-raw-worktree");
	const task = path.join(base, "task-leftover");
	const empty = path.join(base, "empty-shell");
	const stray = path.join(base, "stray-shell");
	const parentRepo = path.join(tempRoot, "parent-repo");
	const rawRepo = path.join(tempRoot, "raw-parent-repo");

	await Promise.all([
		fs.mkdir(managed, { recursive: true }),
		fs.mkdir(metadataDir, { recursive: true }),
		fs.mkdir(snapshotDir, { recursive: true }),
		fs.mkdir(path.join(task, "m"), { recursive: true }),
		fs.mkdir(empty, { recursive: true }),
		fs.mkdir(stray, { recursive: true }),
		fs.mkdir(path.join(parentRepo, ".git", "worktrees", "pr-42"), { recursive: true }),
		fs.mkdir(path.join(rawRepo, ".git", "worktrees", "external-raw-worktree"), { recursive: true }),
		fs.mkdir(pr, { recursive: true }),
		fs.mkdir(raw, { recursive: true }),
	]);

	await Promise.all([
		fs.writeFile(path.join(stray, "payload.txt"), "not a worktree\n"),
		fs.writeFile(path.join(parentRepo, ".git", "worktrees", "pr-42", "HEAD"), "ref: refs/heads/pr-42\n"),
		fs.writeFile(
			path.join(rawRepo, ".git", "worktrees", "external-raw-worktree", "HEAD"),
			"ref: refs/heads/feature/raw-worktree\n",
		),
		fs.writeFile(path.join(pr, ".git"), `gitdir: ${path.join(parentRepo, ".git", "worktrees", "pr-42")}\n`),
		fs.writeFile(
			path.join(raw, ".git"),
			`gitdir: ${path.join(rawRepo, ".git", "worktrees", "external-raw-worktree")}\n`,
		),
	]);

	const managedRecord = managedRecordJson({
		id: "managed-alpha",
		name: "Alpha background",
		primaryRoot: parentRepo,
		sourceRepoRoot: parentRepo,
		worktreeRoot: managed,
		state: "ready",
		snapshotPath: null,
	});
	const snapshottedRecord = managedRecordJson({
		id: "snap-beta",
		name: "Beta snapshot",
		primaryRoot: parentRepo,
		sourceRepoRoot: parentRepo,
		worktreeRoot: path.join(project, "beta-removed-bb22cc33"),
		state: "snapshotted",
		snapshotPath: snapshotDir,
	});
	await Promise.all([
		fs.writeFile(path.join(metadataDir, "managed-alpha.json"), `${JSON.stringify(managedRecord, null, 2)}\n`),
		fs.writeFile(path.join(metadataDir, "snap-beta.json"), `${JSON.stringify(snapshottedRecord, null, 2)}\n`),
	]);

	return {
		base,
		empty,
		managed,
		metadata: path.join(metadataDir, "managed-alpha.json"),
		pr,
		raw,
		snapshotted: snapshotDir,
		stray,
		task,
	};
}

function managedRecordJson(options: {
	id: string;
	name: string;
	primaryRoot: string;
	sourceRepoRoot: string;
	worktreeRoot: string;
	state: "ready" | "snapshotted";
	snapshotPath: string | null;
}): JsonObject {
	const timestamp = "2026-07-05T00:00:00.000Z";
	return {
		id: options.id,
		name: options.name,
		owner: "omp",
		version: 2,
		primaryRoot: options.primaryRoot,
		sourceRepoRoot: options.sourceRepoRoot,
		worktreeRoot: options.worktreeRoot,
		relativeCwd: "",
		baseRef: "HEAD",
		baseSha: "0123456789abcdef0123456789abcdef01234567",
		headSha: "0123456789abcdef0123456789abcdef01234567",
		mode: "managed",
		state: options.state,
		branch: null,
		detached: true,
		sessionFile: null,
		sessionId: null,
		title: null,
		createdAt: timestamp,
		updatedAt: timestamp,
		lastUsedAt: timestamp,
		dirtyPolicy: "ignore",
		includeCopied: [],
		recurseSubmodules: false,
		submodules: [],
		snapshotPath: options.snapshotPath,
		appliedAt: null,
	};
}

async function captureConsole(run: () => Promise<void>): Promise<string> {
	const lines: string[] = [];
	const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	});
	try {
		await run();
	} finally {
		spy.mockRestore();
	}
	return lines.join("\n");
}

function parseJsonArray(output: string): JsonObject[] {
	const parsed = JSON.parse(output) as unknown;
	if (!Array.isArray(parsed)) throw new Error("Expected JSON array output");
	return parsed.map((entry, index) => objectValue(entry, `entry ${index}`));
}

function parseJsonObject(output: string): JsonObject {
	return objectValue(JSON.parse(output) as unknown, "JSON output");
}

function objectValue(value: unknown, label: string): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not an object`);
	return value as JsonObject;
}

function stringField(object: JsonObject, key: string): string {
	const value = object[key];
	if (typeof value !== "string") throw new Error(`Expected ${key} to be a string`);
	return value;
}

function numberField(object: JsonObject, key: string): number {
	const value = object[key];
	if (typeof value !== "number") throw new Error(`Expected ${key} to be a number`);
	return value;
}

function metadataFor(entry: JsonObject): JsonObject {
	const record = entry.record;
	if (record && typeof record === "object" && !Array.isArray(record)) return objectValue(record, "record");
	const metadata = entry.metadata;
	if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) return objectValue(metadata, "metadata");
	return entry;
}

function findEntry(entries: JsonObject[], kind: string): JsonObject {
	const entry = entries.find(candidate => candidate.kind === kind);
	if (!entry) throw new Error(`Missing ${kind} entry`);
	return entry;
}

async function expectPathPresent(target: string): Promise<void> {
	expect(
		await fs.stat(target).then(
			() => true,
			() => false,
		),
	).toBe(true);
}

async function expectPathMissing(target: string): Promise<void> {
	expect(
		await fs.stat(target).then(
			() => true,
			() => false,
		),
	).toBe(false);
}

function getRemoveWorktree(module: typeof worktreeCli): RemoveWorktree | undefined {
	if (!("removeWorktree" in module)) return undefined;
	const candidate = module.removeWorktree;
	return typeof candidate === "function" ? candidate : undefined;
}
