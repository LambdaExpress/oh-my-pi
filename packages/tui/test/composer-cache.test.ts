import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Database, Statement } from "bun:sqlite";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { COMPOSER_DEFAULTS, type ComposerStatusCache } from "@oh-my-pi/pi-tui/prompt/composer";
import { ComposerCache } from "@oh-my-pi/pi-tui/prompt/composer-cache";

function statusFor(thinkingLevel: ThinkingLevel): ComposerStatusCache {
	return {
		borderColor: { prefix: "\x1b[36m", suffix: "\x1b[39m" },
		statusLine: {
			settings: { leftSegments: ["model", "path", "git"], contextLine: "embedded" },
			gitEnabled: true,
			thinkingLevel,
			autoThinking: false,
			fastMode: false,
			usingSubscription: true,
			autoCompactEnabled: true,
			compactionBoundaries: { thresholdPercent: 80, speculationPercent: null },
		},
	};
}

describe("composer startup cache", () => {
	let root: string;
	let dbPath: string;
	const openCaches = new Set<ComposerCache>();

	function openCache(): ComposerCache {
		const cache = ComposerCache.open(dbPath);
		openCaches.add(cache);
		return cache;
	}

	function closeCache(cache: ComposerCache): void {
		cache.close();
		openCaches.delete(cache);
	}

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-composer-cache-"));
		dbPath = path.join(root, "cache", "composer.db");
	});

	afterEach(async () => {
		for (const cache of openCaches) closeCache(cache);
		await fs.rm(root, { recursive: true, force: true });
	});

	it("round-trips per-project speculation and serves settings-derived rows to projects without their own", () => {
		const project = path.join(root, "project");
		const other = path.join(root, "other");
		const preferences = { ...COMPOSER_DEFAULTS, composerShape: "rail", autocompleteMaxVisible: 7 };
		const theme = { symbolPreset: "ascii" as const, colorBlindMode: true, darkTheme: "dark", lightTheme: "light" };
		const status = statusFor(ThinkingLevel.High);

		const writer = openCache();
		writer.writeUi(project, preferences, theme);
		writer.writeStatus(project, status);
		closeCache(writer);

		// A separate connection sees everything: the next launch reads what this one wrote.
		const reader = openCache();
		expect(reader.read(project)).toEqual({ preferences, theme, status });
		// Theme and status follow the user.
		expect(reader.read(other)).toEqual({ preferences, theme, status });
		closeCache(reader);
	});

	it("prefers a project's own status over the last status written elsewhere", () => {
		const cache = openCache();
		cache.writeStatus(path.join(root, "a"), statusFor(ThinkingLevel.Low));
		cache.writeStatus(path.join(root, "b"), statusFor(ThinkingLevel.High));

		expect(cache.read(path.join(root, "a")).status?.statusLine.thinkingLevel).toBe(ThinkingLevel.Low);
		expect(cache.read(path.join(root, "fresh")).status?.statusLine.thinkingLevel).toBe(ThinkingLevel.High);
		closeCache(cache);
	});

	it("skips write transactions for identical payloads", () => {
		const project = path.join(root, "project");
		const cache = openCache();
		const observer = new Database(dbPath, { readonly: true });
		// data_version moves only when another connection commits a change.
		const dataVersion = () => observer.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version;
		const statementRuns = vi.spyOn(Statement.prototype, "run");
		const transactions = vi.spyOn(Database.prototype, "transaction");
		try {
			cache.writeStatus(project, statusFor(ThinkingLevel.High));
			const written = dataVersion();
			statementRuns.mockClear();
			transactions.mockClear();

			// Same connection: nothing reaches SQLite.
			cache.writeStatus(project, statusFor(ThinkingLevel.High));
			// Next launch: values learned by read() are not written back either.
			const next = openCache();
			next.read(project);
			next.writeStatus(project, statusFor(ThinkingLevel.High));
			expect(statementRuns).not.toHaveBeenCalled();
			expect(transactions).not.toHaveBeenCalled();

			// Without a prior read, the upsert guard still leaves identical rows untouched.
			const blind = openCache();
			blind.writeStatus(project, statusFor(ThinkingLevel.High));
			expect(dataVersion()).toBe(written);

			next.writeStatus(project, statusFor(ThinkingLevel.Low));
			expect(dataVersion()).not.toBe(written);
			expect(cache.read(path.join(root, "fresh")).status?.statusLine.thinkingLevel).toBe(ThinkingLevel.Low);
			closeCache(next);
			closeCache(blind);
		} finally {
			statementRuns.mockRestore();
			transactions.mockRestore();
			observer.close();
			closeCache(cache);
		}
	});

	it("drops a store written in an older payload format", async () => {
		const project = path.join(root, "project");
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const legacy = new Database(dbPath);
		try {
			legacy.run(
				"CREATE TABLE entries (project TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (project, kind)) WITHOUT ROWID",
			);
			legacy.run("INSERT INTO entries VALUES (?, ?, ?)", [
				project,
				"status",
				JSON.stringify(statusFor(ThinkingLevel.High)),
			]);
		} finally {
			legacy.close();
		}

		const cache = openCache();
		expect(cache.read(project).status).toBeUndefined();
		closeCache(cache);
	});

	it("loads XDG_CACHE_HOME from the home .env before the first cache access", async () => {
		if (process.platform === "win32") return;

		const home = path.join(root, "home");
		const xdgCache = path.join(root, "xdg-cache");
		const project = path.join(root, "project");
		await Promise.all([
			fs.mkdir(home, { recursive: true }),
			fs.mkdir(path.join(xdgCache, "omp"), { recursive: true }),
		]);
		await Bun.write(path.join(home, ".env"), `XDG_CACHE_HOME=${xdgCache}\n`);

		const composerCacheModule = Bun.resolveSync("@oh-my-pi/pi-tui/prompt/composer-cache", import.meta.dir);
		const script = [
			'import * as path from "node:path";',
			`import { ComposerCache } from ${JSON.stringify(composerCacheModule)};`,
			"const cache = ComposerCache.open();",
			`cache.writeUi(${JSON.stringify(project)}, {}, {});`,
			"cache.close();",
			`const expected = path.join(${JSON.stringify(xdgCache)}, "omp", "cache", "composer.db");`,
			"process.stdout.write(String(await Bun.file(expected).exists()));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "--eval", script], {
			cwd: root,
			env: {
				...process.env,
				HOME: home,
				XDG_CACHE_HOME: undefined,
				PI_CODING_AGENT_DIR: undefined,
				OMP_PROFILE: undefined,
				PI_PROFILE: undefined,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode, stderr).toBe(0);
		expect(stdout).toBe("true");
	});
});
