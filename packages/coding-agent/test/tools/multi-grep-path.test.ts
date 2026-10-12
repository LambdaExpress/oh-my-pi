import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlFilesystem } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resolveExplicitSearchPaths } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { GrepTool, MULTI_FILE_PER_FILE_MATCHES, SINGLE_FILE_MATCHES } from "../../src/tools/grep";

const testSettings = Settings.isolated();
const isWindows = process.platform === "win32";
const filesystem = new InternalUrlFilesystem({ context: {}, tier: "read" });

function createTestSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: testSettings,
		...overrides,
	};
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

describe("search match-limit disclosure", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-search-limits-"));
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	function createTool(totalMatchLimit?: number): GrepTool {
		return new GrepTool(
			createTestSession(cwd, {
				settings: Settings.isolated({ "grep.contextBefore": 0, "grep.contextAfter": 0 }),
			}),
			{ totalMatchLimit },
		);
	}

	it("discloses omitted per-file matches and retrieves them with narrower queries", async () => {
		for (const name of ["alpha", "beta"]) {
			await Bun.write(
				path.join(cwd, `${name}.txt`),
				`${Array.from({ length: MULTI_FILE_PER_FILE_MATCHES + 5 }, (_, i) => `needle ${name} ${i + 1}`).join("\n")}\nlate-callsite ${name}\n`,
			);
		}
		const tool = createTool();
		const broad = await tool.execute("broad", {
			pattern: "needle|late-callsite",
			path: "alpha.txt;beta.txt",
		});
		const broadText = getText(broad);
		expect(broad.details?.matchCount).toBe(MULTI_FILE_PER_FILE_MATCHES * 2);
		expect(broad.details?.truncated).toBe(true);
		expect(broadText).not.toContain("late-callsite alpha");
		expect(broadText).not.toContain("late-callsite beta");
		expect(broadText).toMatch(/per-file.*limit/i);
		expect(broadText).toMatch(/alpha\.txt:\d+-/);
		expect(broad.details?.displayContent).toMatch(/per-file.*limit/i);

		const narrow = await tool.execute("narrow", { pattern: "late-callsite", path: "alpha.txt" });
		expect(getText(narrow)).toContain("late-callsite alpha");
		expect(narrow.details?.truncated).toBe(false);
		const ranged = await tool.execute("range", {
			pattern: "needle|late-callsite",
			path: `alpha.txt:${MULTI_FILE_PER_FILE_MATCHES + 1}-;beta.txt:${MULTI_FILE_PER_FILE_MATCHES + 1}-`,
		});
		expect(getText(ranged)).toContain("late-callsite alpha");
		expect(getText(ranged)).toContain("late-callsite beta");
		expect(ranged.details?.truncated).toBe(false);
	});

	it("does not report overflow at the exact per-file boundary or for absent matches", async () => {
		for (const name of ["alpha", "beta"]) {
			await Bun.write(
				path.join(cwd, `${name}.txt`),
				Array.from({ length: MULTI_FILE_PER_FILE_MATCHES }, (_, i) => `needle ${name} ${i}`).join("\n"),
			);
		}
		const tool = createTool();
		const boundary = await tool.execute("boundary", { pattern: "needle", path: "alpha.txt;beta.txt" });
		expect(boundary.details?.matchCount).toBe(MULTI_FILE_PER_FILE_MATCHES * 2);
		expect(boundary.details?.truncated).toBe(false);
		const absent = await tool.execute("absent", { pattern: "absent", path: "alpha.txt;beta.txt" });
		expect(absent.details?.matchCount).toBe(0);
		expect(absent.details?.truncated).toBe(false);
		expect(getText(absent)).not.toMatch(/limit|omitted|truncated/i);
	});

	it("discloses a caller's total match cap without treating it as a per-file cap", async () => {
		for (const name of ["alpha", "beta"]) {
			await Bun.write(path.join(cwd, `${name}.txt`), `needle ${name} first\nneedle ${name} second\n`);
		}
		const tool = createTool(2);
		const result = await tool.execute("total-cap", { pattern: "needle", path: "alpha.txt;beta.txt" });
		expect(result.details?.matchCount).toBe(2);
		expect(result.details?.truncated).toBe(true);
		expect(getText(result)).toMatch(/total.*match.*limit/i);
		expect(getText(result)).not.toMatch(/per-file.*limit/i);
		expect(result.details?.displayContent).toMatch(/total.*match.*limit/i);
	});

	it("retains retrieval instructions when the byte cap clips matches", async () => {
		await Bun.write(
			path.join(cwd, "large.txt"),
			Array.from({ length: SINGLE_FILE_MATCHES + 1 }, (_, i) => `needle ${i} ${"x".repeat(450)}`).join("\n"),
		);
		const result = await createTool().execute("byte-cap", { pattern: "needle", path: "large.txt" });
		const text = getText(result);
		expect(result.details?.truncation?.truncated).toBe(true);
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(50 * 1024);
		expect(text).toMatch(/per-file.*limit/i);
		expect(text).toMatch(/large\.txt:\d+-/);
		expect(text).toMatch(/byte.*limit/i);
	});

	it("discloses native total clipping and keeps exhausted collected pages partial", async () => {
		await Promise.all(
			Array.from({ length: 101 }, (_, fileIndex) =>
				Bun.write(
					path.join(cwd, `${String(fileIndex).padStart(3, "0")}.txt`),
					Array.from(
						{ length: MULTI_FILE_PER_FILE_MATCHES + 1 },
						(_, lineIndex) => `needle ${fileIndex} ${lineIndex}`,
					).join("\n"),
				),
			),
		);
		const tool = createTool();
		const first = await tool.execute("native-total", { pattern: "needle", path: "." });
		expect(first.details?.truncated).toBe(true);
		expect(getText(first)).toMatch(/native total.*limit/i);
		const pastCollected = await tool.execute("past-collected", { pattern: "needle", path: ".", skip: 101 });
		expect(pastCollected.details?.matchCount).toBe(0);
		expect(pastCollected.details?.truncated).toBe(true);
		expect(getText(pastCollected)).toMatch(/collected results/i);
		expect(getText(pastCollected)).toMatch(/may be omitted/i);
		const narrow = await tool.execute("native-total-narrow", { pattern: "needle", path: "100.txt" });
		expect(narrow.details?.matchCount).toBe(MULTI_FILE_PER_FILE_MATCHES + 1);
		expect(narrow.details?.truncated).toBe(false);
	});
});

describe.skipIf(isWindows)("resolveExplicitSearchPaths cross-tree degeneracy", () => {
	it("returns per-path targets when commonBasePath collapses to filesystem root", async () => {
		// Two real top-level directories that exist on every Unix host. Their only
		// shared ancestor is `/`. A naive shared-base scan would walk the entire
		// filesystem; the resolver must surface explicit `targets` so callers can
		// fan out instead.
		const cwd = os.tmpdir();
		const resolved = await resolveExplicitSearchPaths(["/tmp", "/usr"], cwd, filesystem);

		expect(resolved).toBeDefined();
		if (!resolved) throw new Error("expected resolveExplicitSearchPaths to resolve");
		expect(resolved.basePath).toBe(path.parse(resolved.basePath).root);
		expect(resolved.targets).toBeDefined();
		const targetBases = (resolved.targets ?? []).map(target => target.basePath).sort();
		expect(targetBases).toEqual(["/tmp", "/usr"]);
	});
});

describe.skipIf(isWindows)("search with omitted paths", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-search-default-cwd-"));
		await Bun.write(path.join(cwd, "rooted.txt"), "default-needle here\n");
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("defaults to the workspace root when paths is omitted", async () => {
		const tool = new GrepTool(createTestSession(cwd));

		// Callers that omit `path` would otherwise be rejected at schema
		// validation with `path: Invalid input` and never run. Omission must
		// degrade to a workspace-root scan rather than fail the tool call.
		const result = await tool.execute("search-default-paths", { pattern: "default-needle" });

		const text = getText(result);
		const details = result.details as { fileCount?: number } | undefined;
		expect(text).toContain("default-needle here");
		expect(details?.fileCount).toBe(1);
	});

	it("defaults to the workspace root when path is an empty JSON array", async () => {
		const tool = new GrepTool(createTestSession(cwd));

		const result = await tool.execute("search-empty-paths", {
			pattern: "default-needle",
			path: "[]",
		});

		expect(getText(result)).toContain("default-needle here");
	});
});

describe.skipIf(isWindows)("search across unrelated filesystem trees", () => {
	let dirA: string;
	let dirB: string;
	let cwd: string;

	beforeEach(async () => {
		// Place fixtures in two unrelated top-level subtrees so their only shared
		// ancestor is the filesystem root. Without the multi-target fanout, the
		// search tool would scan from `/` and walk the entire filesystem.
		dirA = await fs.mkdtemp(path.join("/tmp", "pi-search-multi-A-"));
		dirB = await fs.mkdtemp(path.join("/var/tmp", "pi-search-multi-B-"));
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-search-multi-cwd-"));
		await Bun.write(path.join(dirA, "alpha.txt"), "shared-needle alpha\n");
		await Bun.write(path.join(dirB, "beta.txt"), "shared-needle beta\n");
	});

	afterEach(async () => {
		await Promise.all([removeWithRetries(dirA), removeWithRetries(dirB), removeWithRetries(cwd)]);
	});

	it("returns matches from both trees without rooting the scan at /", async () => {
		const tool = new GrepTool(createTestSession(cwd));

		const start = performance.now();
		const result = await tool.execute("search-cross-tree", {
			pattern: "shared-needle",
			path: `${dirA}; ${dirB}`,
		});
		const durationMs = performance.now() - start;

		const text = getText(result);
		const details = result.details as { fileCount?: number; matchCount?: number } | undefined;

		expect(text).toContain("shared-needle alpha");
		expect(text).toContain("shared-needle beta");
		expect(details?.fileCount).toBe(2);
		expect(details?.matchCount).toBe(2);
		// Defense-in-depth: a regression that re-roots the scan at `/` typically
		// takes seconds. Two-fixture targeted scans complete in well under a
		// second on every supported platform.
		expect(durationMs).toBeLessThan(5000);
	});
});

describe.skipIf(isWindows)("resolveExplicitSearchPaths shared non-root ancestor", () => {
	let parent: string;
	let repo: string;
	let cousinFile: string;

	beforeEach(async () => {
		parent = await fs.mkdtemp(path.join(os.tmpdir(), "pi-search-ancestor-"));
		repo = path.join(parent, "repo");
		await fs.mkdir(path.join(repo, "src"), { recursive: true });
		await Bun.write(path.join(repo, "src", "a.ts"), "alpha\n");
		cousinFile = path.join(parent, "homeish", ".gitconfig");
		await Bun.write(cousinFile, "[push]\n\tfollowTags = true\n");
	});

	afterEach(async () => {
		await removeWithRetries(parent);
	});

	it("fans out per-path targets instead of walking the unrequested ancestor", async () => {
		// `.` (the repo) and a file in a cousin tree only share `parent`, which the
		// caller never asked to search. Collapsing to a single walk rooted there
		// scans every unrelated sibling (the real-world case: `.` + `~/.gitconfig`
		// walks all of `$HOME` until the grep timeout). The resolver must surface
		// per-path targets so each scan stays bounded to a requested path.
		const resolved = await resolveExplicitSearchPaths([".", cousinFile], repo, filesystem);
		expect(resolved).toBeDefined();
		if (!resolved) throw new Error("expected resolveExplicitSearchPaths to resolve");
		const targetBases = (resolved.targets ?? []).map(target => target.basePath).sort();
		expect(targetBases).toEqual([repo, cousinFile].sort());
	});

	it("keeps a single collapsed walk when the common ancestor is a requested scope", async () => {
		// `ast_edit` consumes the same targets and applies rewrites once per
		// target; a dir + nested-file input must stay a single walk by default or
		// overlapping targets would double-apply rewrites to the nested file.
		const resolved = await resolveExplicitSearchPaths([".", "src/a.ts"], repo, filesystem);
		expect(resolved).toBeDefined();
		if (!resolved) throw new Error("expected resolveExplicitSearchPaths to resolve");
		expect(resolved.targets).toBeUndefined();
		expect(resolved.basePath).toBe(repo);
	});

	it("collapses the walk when the requested ancestor is a non-canonical absolute path", async () => {
		// Regression for #11584: resolveToCwd returned absolute inputs verbatim
		// while findCommonBasePath canonicalizes via path.resolve, so the
		// commonIsRequestedScope identity check never held for an absolute
		// ancestor — on Windows for every absolute spelling (`/` vs `\`), on
		// POSIX for a non-canonical one (trailing separator or embedded `..`).
		// The false fan-out made ast_edit double-apply the rewrite to the nested
		// file. A trailing separator and an embedded `..` are distinct shapes a
		// partial fix could normalize inconsistently, so both must collapse.
		for (const ancestor of [`${repo}${path.sep}`, `${repo}${path.sep}src${path.sep}..`]) {
			const resolved = await resolveExplicitSearchPaths([ancestor, "src/a.ts"], repo, filesystem);
			expect(resolved).toBeDefined();
			if (!resolved) throw new Error("expected resolveExplicitSearchPaths to resolve");
			expect(resolved.targets).toBeUndefined();
			expect(resolved.basePath).toBe(repo);
		}
	});

	it("fans out nested plain files when the caller opts in via fanOutFileItems", async () => {
		const resolved = await resolveExplicitSearchPaths([".", "src/a.ts"], repo, filesystem, undefined, true);
		expect(resolved).toBeDefined();
		if (!resolved) throw new Error("expected resolveExplicitSearchPaths to resolve");
		const targetBases = (resolved.targets ?? []).map(target => target.basePath).sort();
		expect(targetBases).toEqual([repo, path.join(repo, "src", "a.ts")].sort());
	});
});

describe.skipIf(!isWindows)("resolveExplicitSearchPaths Windows casing", () => {
	it("collapses overlapping scopes whose drive letters differ in case", async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "pi-search-case-"));
		try {
			await fs.mkdir(path.join(repo, "src"), { recursive: true });
			await Bun.write(path.join(repo, "src", "a.ts"), "alpha\n");
			const driveLetter = repo[0]!;
			const differentlyCasedDrive =
				driveLetter === driveLetter.toLowerCase() ? driveLetter.toUpperCase() : driveLetter.toLowerCase();
			const absoluteAncestor = `${differentlyCasedDrive}${repo.slice(1)}`;

			const resolved = await resolveExplicitSearchPaths([absoluteAncestor, "src/a.ts"], repo, filesystem);
			expect(resolved).toBeDefined();
			if (!resolved) throw new Error("expected resolveExplicitSearchPaths to resolve");
			expect(resolved.targets).toBeUndefined();
			expect(resolved.basePath.toLowerCase()).toBe(repo.toLowerCase());
		} finally {
			await removeWithRetries(repo);
		}
	});
});

describe.skipIf(isWindows)("search with explicit walker-pruned file targets", () => {
	let repo: string;

	beforeEach(async () => {
		repo = await fs.mkdtemp(path.join(os.tmpdir(), "pi-search-pruned-"));
		await fs.mkdir(path.join(repo, ".git"), { recursive: true });
		await Bun.write(path.join(repo, ".git", "config"), "[push]\n\tfollowTags = true\n");
		await Bun.write(path.join(repo, "readme.txt"), "no needle here\n");
	});

	afterEach(async () => {
		await removeWithRetries(repo);
	});

	it("matches inside an explicit .git/config target alongside a directory scope", async () => {
		// The directory walker prunes `.git` unconditionally, so folding the
		// explicit file into the walk's glob union silently returned 0 matches.
		// The file must be read directly as its own target.
		const tool = new GrepTool(createTestSession(repo));

		const result = await tool.execute("search-git-config", {
			pattern: "followTags",
			path: ".; .git/config",
		});
		const details = result.details as { matchCount?: number; files?: string[] } | undefined;
		expect(getText(result)).toContain("followTags = true");
		expect(details?.matchCount).toBe(1);
		expect(details?.files).toEqual([".git/config"]);
	});

	it("dedupes matches when a file target overlaps a directory target", async () => {
		await fs.mkdir(path.join(repo, "src"), { recursive: true });
		await Bun.write(path.join(repo, "src", "a.ts"), "needle-dup\n");
		const tool = new GrepTool(createTestSession(repo));

		const result = await tool.execute("search-overlap", {
			pattern: "needle-dup",
			path: ".; src/a.ts",
		});
		const details = result.details as { matchCount?: number } | undefined;
		expect(details?.matchCount).toBe(1);
	});
});
