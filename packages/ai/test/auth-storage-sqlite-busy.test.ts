/**
 * Regression coverage for issue #2421.
 *
 * Concurrent omp startups can race against WAL recovery so the auth-store init
 * sees `SQLITE_BUSY` / `SQLITE_BUSY_RECOVERY` before its multi-statement run
 * installs the busy handler. The fix hoists `PRAGMA busy_timeout` to a separate
 * statement that runs first and wraps `open()` in a bounded retry loop on the
 * BUSY family.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { isSqliteBusyError, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { TempDir } from "../../utils/src/temp";

interface SqliteBusyShape extends Error {
	code: string;
	errno: number;
}

function makeBusyError(code: string, errno: number): SqliteBusyShape {
	const err = new Error("database is locked") as SqliteBusyShape;
	err.code = code;
	err.errno = errno;
	return err;
}

describe("isSqliteBusyError", () => {
	test("recognizes every documented BUSY family code", () => {
		expect(isSqliteBusyError(makeBusyError("SQLITE_BUSY", 5))).toBe(true);
		expect(isSqliteBusyError(makeBusyError("SQLITE_BUSY_RECOVERY", 261))).toBe(true);
		expect(isSqliteBusyError(makeBusyError("SQLITE_BUSY_SNAPSHOT", 517))).toBe(true);
		expect(isSqliteBusyError(makeBusyError("SQLITE_BUSY_TIMEOUT", 773))).toBe(true);
	});

	test("rejects non-BUSY codes and non-error values", () => {
		expect(isSqliteBusyError(makeBusyError("SQLITE_LOCKED", 6))).toBe(false);
		expect(isSqliteBusyError(makeBusyError("SQLITE_CORRUPT", 11))).toBe(false);
		expect(isSqliteBusyError(new Error("plain"))).toBe(false);
		expect(isSqliteBusyError(null)).toBe(false);
		expect(isSqliteBusyError(undefined)).toBe(false);
		expect(isSqliteBusyError("SQLITE_BUSY")).toBe(false);
	});
});

describe("SqliteAuthCredentialStore.open SQLITE_BUSY handling", () => {
	test("open() survives a writer holding the lock past the retry budget (#7298)", async () => {
		await using tempDir = await TempDir.create("@pi-ai-sqlite-busy-");
		const dbPath = tempDir.join("ordering.db");
		const sentinel = tempDir.join("locked.sentinel");
		// The child holds an EXCLUSIVE lock longer than the retry budget but
		// shorter than busy_timeout. Only a busy handler installed before DDL
		// lets the first attempt wait out the writer. Readiness is signaled
		// after BEGIN EXCLUSIVE so scheduling cannot weaken the contention.
		const locker = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
using db = new Database(process.argv[1]);
db.run("BEGIN EXCLUSIVE");
writeFileSync(process.argv[2], "locked");
await Bun.sleep(750);
db.run("COMMIT");`,
				dbPath,
				sentinel,
			],
			{ env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" }, stdout: "ignore", stderr: "pipe" },
		);
		try {
			// Fake timers cannot advance the child process's real lock duration
			// or filesystem readiness, so this platform integration uses real time.
			const deadline = Date.now() + 5000;
			let locked = false;
			while (Date.now() < deadline) {
				locked = await fs.access(sentinel).then(
					() => true,
					() => false,
				);
				if (locked || locker.exitCode !== null) break;
				await Bun.sleep(10);
			}
			if (!locked) {
				throw new Error(`locker never signaled readiness: ${await new Response(locker.stderr).text()}`);
			}

			const store = await SqliteAuthCredentialStore.open(dbPath);
			try {
				await store.saveApiKey("locked-provider", "committed-after-lock");
				expect(store.getApiKey("locked-provider")).toBe("committed-after-lock");
			} finally {
				store.close();
			}
			const [exitCode, stderr] = await Promise.all([locker.exited, new Response(locker.stderr).text()]);
			expect(exitCode, stderr).toBe(0);
		} finally {
			if (locker.exitCode === null) locker.kill();
			await locker.exited;
		}
	});

	test("retries through a transient SQLITE_BUSY_RECOVERY and eventually succeeds", async () => {
		await using tempDir = await TempDir.create("@pi-ai-sqlite-busy-");
		const dbPath = tempDir.join("retry.db");
		let throws = 2;
		// Only this test's connections see the synthetic WAL-recovery race.
		const realRun = Database.prototype.run;
		const spy = vi.spyOn(Database.prototype, "run").mockImplementation(function (
			this: Database,
			...args: Parameters<typeof realRun>
		) {
			if (this.filename === dbPath && throws > 0) {
				throws--;
				throw makeBusyError("SQLITE_BUSY_RECOVERY", 261);
			}
			return realRun.apply(this, args);
		});

		try {
			const store = await SqliteAuthCredentialStore.open(dbPath);
			try {
				await store.saveApiKey("retried-provider", "committed-after-retries");
			} finally {
				store.close();
			}
			const reopened = await SqliteAuthCredentialStore.open(dbPath);
			try {
				expect(reopened.getApiKey("retried-provider")).toBe("committed-after-retries");
			} finally {
				reopened.close();
			}
		} finally {
			spy.mockRestore();
		}
	});

	test("non-BUSY errors short-circuit retries", async () => {
		await using tempDir = await TempDir.create("@pi-ai-sqlite-busy-");
		const dbPath = tempDir.join("fatal.db");
		const realRun = Database.prototype.run;
		let runCalls = 0;
		// SQLITE_IOERR is neither BUSY (retried) nor CORRUPT (quarantined).
		const spy = vi.spyOn(Database.prototype, "run").mockImplementation(function (
			this: Database,
			...args: Parameters<typeof realRun>
		) {
			if (this.filename !== dbPath) return realRun.apply(this, args);
			runCalls++;
			if (runCalls === 1) {
				throw makeBusyError("SQLITE_IOERR", 10);
			}
			return realRun.apply(this, args);
		});

		try {
			await expect(SqliteAuthCredentialStore.open(dbPath)).rejects.toMatchObject({
				code: "SQLITE_IOERR",
				errno: 10,
			});
			expect(runCalls).toBe(1);
		} finally {
			spy.mockRestore();
		}
	});

	test("exhausts its bounded retry budget and retains the extended SQLite result code", async () => {
		await using tempDir = await TempDir.create("@pi-ai-sqlite-busy-");
		const dbPath = tempDir.join("stuck.db");
		const realRun = Database.prototype.run;
		let attempts = 0;
		const spy = vi.spyOn(Database.prototype, "run").mockImplementation(function (
			this: Database,
			...args: Parameters<typeof realRun>
		) {
			if (this.filename !== dbPath) return realRun.apply(this, args);
			attempts++;
			throw makeBusyError("SQLITE_BUSY_RECOVERY", 261);
		});

		try {
			await expect(SqliteAuthCredentialStore.open(dbPath)).rejects.toMatchObject({
				code: "SQLITE_BUSY_RECOVERY",
				errno: 261,
			});
			expect(attempts).toBe(4);
		} finally {
			spy.mockRestore();
		}
	});
});
