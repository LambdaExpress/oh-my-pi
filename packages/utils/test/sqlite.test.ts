import { Database, type Statement } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isSqliteCorruptionError, openSqliteDatabase, openSqliteDatabaseSync } from "../src/sqlite";
import { TempDir } from "../src/temp";

async function corruptSchemaPages(dbPath: string): Promise<Buffer<ArrayBuffer>> {
	using db = new Database(dbPath);
	db.run("CREATE TABLE entries (value TEXT)");
	db.run("INSERT INTO entries VALUES ('evidence')");
	db.run("PRAGMA wal_checkpoint(TRUNCATE)");
	db.close(true);

	const damaged = await fs.promises.readFile(dbPath);
	damaged.fill(0xff, 100);
	await fs.promises.writeFile(dbPath, damaged);
	return damaged;
}

async function backupNames(dirPath: string, dbName = "store.db"): Promise<string[]> {
	return (await fs.promises.readdir(dirPath))
		.filter(name => name.startsWith(`${dbName}.corrupt-`))
		.map(name => path.join(name, "database"));
}

test("failed asynchronous initialization releases and rolls back its write transaction", async () => {
	await using dir = await TempDir.create("@omp-sqlite-init-");
	const dbPath = dir.join("store.db");
	let retainedStatement: Statement | undefined;
	try {
		await expect(
			openSqliteDatabase(dbPath, async db => {
				db.run("CREATE TABLE entries (value TEXT)");
				db.run("BEGIN IMMEDIATE");
				retainedStatement = db.prepare("INSERT INTO entries VALUES (?)");
				retainedStatement.run("uncommitted");
				await Promise.resolve();
				db.run("INSERT INTO missing_table VALUES (1)");
			}),
		).rejects.toMatchObject({ code: "SQLITE_ERROR" });

		const rows = await openSqliteDatabase(dbPath, db => {
			try {
				db.run("INSERT INTO entries VALUES ('reopened')");
				return db.query<{ value: string }, []>("SELECT value FROM entries").all();
			} finally {
				db.close(true);
			}
		});
		expect(rows).toEqual([{ value: "reopened" }]);
	} finally {
		retainedStatement?.finalize();
	}
});

test("corruption recovery is opt-in and the default preserves the active evidence", async () => {
	await using dir = await TempDir.create("@omp-sqlite-default-corrupt-");
	const dbPath = dir.join("store.db");
	const damaged = Buffer.from("not a sqlite database".repeat(64));
	await fs.promises.writeFile(dbPath, damaged);

	let failure: unknown;
	try {
		await openSqliteDatabase(dbPath, db => db.query("SELECT name FROM sqlite_master").all());
	} catch (error) {
		failure = error;
	}

	expect(isSqliteCorruptionError(failure)).toBe(true);
	expect(failure).toMatchObject({ code: "SQLITE_NOTADB" });
	expect(await fs.promises.readFile(dbPath)).toEqual(damaged);
	expect(await backupNames(dir.path())).toEqual([]);
});

test("synchronous recovery preserves malformed schema pages and yields a persistent database", async () => {
	await using dir = await TempDir.create("@omp-sqlite-sync-corrupt-");
	const dbPath = dir.join("store.db");
	const damaged = await corruptSchemaPages(dbPath);

	openSqliteDatabaseSync(
		dbPath,
		db => {
			db.run("CREATE TABLE recovered (value TEXT)");
			db.run("INSERT INTO recovered VALUES ('usable')");
			db.close(true);
		},
		{ recoverCorruption: true },
	);

	const backups = (await backupNames(dir.path())).filter(name => !/-wal$|-shm$|-journal$/.test(name));
	expect(backups).toHaveLength(1);
	const backupPath = path.join(dir.path(), backups[0]!);
	expect(await fs.promises.readFile(backupPath)).toEqual(damaged);
	if (process.platform !== "win32") {
		expect((await fs.promises.stat(backupPath)).mode & 0o777).toBe(0o600);
		expect((await fs.promises.stat(path.dirname(backupPath))).mode & 0o777).toBe(0o700);
	}

	const rows = openSqliteDatabaseSync(dbPath, db => {
		try {
			return db.query<{ value: string }, []>("SELECT value FROM recovered").all();
		} finally {
			db.close(true);
		}
	});
	expect(rows).toEqual([{ value: "usable" }]);
});

test("recovery preserves sidecars present at corruption detection under one private backup name", async () => {
	await using dir = await TempDir.create("@omp-sqlite-sidecars-");
	const dbPath = dir.join("store.db");
	const contents = new Map<string, Buffer<ArrayBuffer>>([
		["", Buffer.from("not a database")],
		["-wal", Buffer.from("damaged wal evidence")],
		["-shm", Buffer.from("damaged shm evidence")],
		["-journal", Buffer.from("damaged journal evidence")],
	]);
	for (const [suffix, bytes] of contents) await fs.promises.writeFile(`${dbPath}${suffix}`, bytes);

	await openSqliteDatabase(
		dbPath,
		async db => {
			try {
				db.run("CREATE TABLE recovered (value TEXT)");
			} catch (error) {
				// SQLite rebuilds its disposable shared-memory index while opening.
				contents.set("-shm", await fs.promises.readFile(`${dbPath}-shm`));
				// SQLite removes invalid rollback journals before reporting corruption.
				await fs.promises.writeFile(`${dbPath}-journal`, contents.get("-journal")!);
				throw error;
			}
			db.close(true);
		},
		{ recoverCorruption: true },
	);

	const mainBackups = (await backupNames(dir.path())).filter(name => !/-wal$|-shm$|-journal$/.test(name));
	expect(mainBackups).toHaveLength(1);
	const backupPath = path.join(dir.path(), mainBackups[0]!);
	for (const [suffix, bytes] of contents) {
		expect(await fs.promises.readFile(`${backupPath}${suffix}`)).toEqual(bytes);
		if (process.platform !== "win32") {
			expect((await fs.promises.stat(`${backupPath}${suffix}`)).mode & 0o777).toBe(0o600);
		}
	}
});

test("concurrent failed openers adopt one replacement without discarding each other's writes", async () => {
	await using dir = await TempDir.create("@omp-sqlite-concurrent-");
	const dbPath = dir.join("store.db");
	const damaged = await corruptSchemaPages(dbPath);
	const ready = Promise.withResolvers<void>();
	let opened = 0;
	const initialize = async (db: Database): Promise<Database> => {
		if (++opened === 2) ready.resolve();
		await ready.promise;
		db.run("PRAGMA journal_mode=WAL");
		db.run("CREATE TABLE IF NOT EXISTS recovered (value TEXT)");
		return db;
	};

	const openedHandles = await Promise.allSettled([
		openSqliteDatabase(dbPath, initialize, { recoverCorruption: true }),
		openSqliteDatabase(dbPath, initialize, { recoverCorruption: true }),
	]);
	const handles = openedHandles.flatMap(result => (result.status === "fulfilled" ? [result.value] : []));
	try {
		for (const result of openedHandles) {
			if (result.status === "rejected") throw result.reason;
		}
		handles[0]!.run("INSERT INTO recovered VALUES ('first')");
		handles[1]!.run("INSERT INTO recovered VALUES ('second')");
		expect(handles[0]!.query<{ value: string }, []>("SELECT value FROM recovered ORDER BY value").all()).toEqual([
			{ value: "first" },
			{ value: "second" },
		]);
	} finally {
		for (const db of handles) db.close(true);
	}
	const rows = openSqliteDatabaseSync(dbPath, db => {
		try {
			return db.query<{ value: string }, []>("SELECT value FROM recovered ORDER BY value").all();
		} finally {
			db.close(true);
		}
	});
	expect(rows).toEqual([{ value: "first" }, { value: "second" }]);
	const backups = (await backupNames(dir.path())).filter(name => !/-wal$|-shm$|-journal$/.test(name));
	expect(backups).toHaveLength(1);
	expect(await fs.promises.readFile(path.join(dir.path(), backups[0]!))).toEqual(damaged);
});

test("a successful concurrent initializer keeps its committed writes and live handle", async () => {
	await using dir = await TempDir.create("@omp-sqlite-live-peer-");
	const dbPath = dir.join("store.db");
	using seed = new Database(dbPath);
	seed.run("CREATE TABLE entries (value TEXT)");
	seed.close(true);
	const ready = Promise.withResolvers<void>();
	const committed = Promise.withResolvers<void>();
	let opened = 0;
	let retainedStatement: Statement | undefined;
	const arrive = async () => {
		if (++opened === 2) ready.resolve();
		await ready.promise;
	};

	const [writer, failed] = await Promise.allSettled([
		openSqliteDatabase(
			dbPath,
			async db => {
				await arrive();
				db.run("INSERT INTO entries VALUES ('committed')");
				committed.resolve();
				return db;
			},
			{ recoverCorruption: true },
		),
		openSqliteDatabase(
			dbPath,
			async db => {
				retainedStatement = db.prepare("SELECT value FROM entries");
				await arrive();
				await committed.promise;
				throw Object.assign(new Error("a different page was corrupt"), { code: "SQLITE_CORRUPT", errno: 11 });
			},
			{ recoverCorruption: true },
		),
	]);
	try {
		if (writer.status === "rejected") throw writer.reason;
		expect(failed).toMatchObject({ status: "rejected", reason: { code: "SQLITE_CORRUPT" } });
		writer.value.run("INSERT INTO entries VALUES ('still-open')");
		expect(writer.value.query<{ value: string }, []>("SELECT value FROM entries ORDER BY value").all()).toEqual([
			{ value: "committed" },
			{ value: "still-open" },
		]);
		const backups = (await backupNames(dir.path())).filter(name => !/-wal$|-shm$|-journal$/.test(name));
		expect(backups).toHaveLength(1);
		using backup = new Database(path.join(dir.path(), backups[0]!), { readonly: true });
		expect(backup.query<{ value: string }, []>("SELECT value FROM entries").all()).toEqual([{ value: "committed" }]);
	} finally {
		if (writer.status === "fulfilled") writer.value.close(true);
		retainedStatement?.finalize();
	}
});

for (const uncertainIdentity of [false, true]) {
	test(
		uncertainIdentity
			? "a successful opener with an inaccessible identity keeps its committed writes"
			: "a successful fresh-path opener keeps its committed writes after closing its handle",
		async () => {
			await using dir = await TempDir.create("@omp-sqlite-unknown-success-");
			const dbPath = dir.join("store.db");
			if (uncertainIdentity) {
				using seed = new Database(dbPath);
				seed.run("CREATE TABLE entries (value TEXT)");
				seed.close(true);
			}
			const writerReady = Promise.withResolvers<void>();
			const releaseWriter = Promise.withResolvers<void>();
			const releaseFailure = Promise.withResolvers<void>();
			const stat = uncertainIdentity
				? spyOn(fs, "statSync").mockImplementationOnce(() => {
						throw Object.assign(new Error("file identity is inaccessible"), { code: "EACCES" });
					})
				: undefined;
			const writer = openSqliteDatabase(
				dbPath,
				async db => {
					db.run("CREATE TABLE IF NOT EXISTS entries (value TEXT)");
					db.run("INSERT INTO entries VALUES ('committed')");
					writerReady.resolve();
					await releaseWriter.promise;
					db.close(true);
				},
				{ recoverCorruption: true },
			);
			stat?.mockRestore();
			await writerReady.promise;
			let attempts = 0;
			const failed = openSqliteDatabase(
				dbPath,
				async db => {
					if (attempts++ === 0) {
						await releaseFailure.promise;
						throw Object.assign(new Error("a different page was corrupt"), { code: "SQLITE_CORRUPT", errno: 11 });
					}
					db.run("CREATE TABLE IF NOT EXISTS entries (value TEXT)");
					return db;
				},
				{ recoverCorruption: true },
			);
			releaseWriter.resolve();
			await writer;
			releaseFailure.resolve();
			const [result] = await Promise.allSettled([failed]);
			try {
				expect(result).toMatchObject({ status: "rejected", reason: { code: "SQLITE_CORRUPT" } });
				using observer = new Database(dbPath, { readonly: true });
				expect(observer.query<{ value: string }, []>("SELECT value FROM entries").all()).toEqual([
					{ value: "committed" },
				]);
			} finally {
				if (result.status === "fulfilled") result.value.close(true);
			}
		},
	);
}

for (const journalMode of ["WAL", "DELETE"] as const) {
	test(`a failed ${journalMode} snapshot retains uncopied evidence and the failed connection`, async () => {
		await using dir = await TempDir.create("@omp-sqlite-incomplete-snapshot-");
		const dbPath = dir.join("store.db");
		using seed = new Database(dbPath);
		seed.run("CREATE TABLE entries (value TEXT)");
		seed.run("INSERT INTO entries VALUES ('seed')");
		seed.close(true);
		const suffix = journalMode === "WAL" ? "-wal" : "-journal";
		const sidecarPath = `${dbPath}${suffix}`;
		const savedPath = dir.join("saved.db");
		let failedHandle: Database | undefined;
		let retainedStatement: Statement | undefined;
		let sidecarEvidence: Buffer<ArrayBuffer> | undefined;
		let partialPath: fs.PathLike | undefined;
		const copyFile = fs.copyFileSync;
		const copy = spyOn(fs, "copyFileSync").mockImplementation((source, destination, flags) => {
			if (source === sidecarPath) {
				partialPath = destination;
				fs.writeFileSync(destination, fs.readFileSync(source).subarray(0, 32), { mode: 0o600 });
				throw Object.assign(new Error("not enough space to preserve the sidecar"), { code: "ENOSPC" });
			}
			copyFile(source, destination, flags);
		});
		try {
			await expect(
				openSqliteDatabase(
					dbPath,
					db => {
						failedHandle = db;
						db.run(`PRAGMA journal_mode = ${journalMode}`);
						if (journalMode === "WAL") db.run("PRAGMA wal_autocheckpoint = 0");
						else db.run("BEGIN IMMEDIATE");
						retainedStatement = db.prepare("INSERT INTO entries VALUES (?)");
						retainedStatement.run(journalMode === "WAL" ? "committed-wal" : "uncommitted");
						sidecarEvidence = fs.readFileSync(sidecarPath);
						throw Object.assign(new Error("a different page was corrupt"), { code: "SQLITE_CORRUPT", errno: 11 });
					},
					{ recoverCorruption: true },
				),
			).rejects.toMatchObject({ code: "SQLITE_CORRUPT" });
			if (!sidecarEvidence) throw new Error("The failed initializer did not capture sidecar evidence");
			expect(fs.readFileSync(sidecarPath)).toEqual(sidecarEvidence);
			copy.mockRestore();
			await expect(
				openSqliteDatabase(
					dbPath,
					db => {
						try {
							db.run("INSERT INTO entries VALUES ('arrival')");
						} finally {
							db.close(true);
						}
					},
					{ recoverCorruption: true },
				),
			).rejects.toMatchObject({ code: "SQLITE_CORRUPT" });
			expect(failedHandle?.query<{ value: string }, []>("SELECT value FROM entries ORDER BY value").all()).toEqual(
				journalMode === "WAL"
					? [{ value: "committed-wal" }, { value: "seed" }]
					: [{ value: "seed" }, { value: "uncommitted" }],
			);
			expect(await backupNames(dir.path())).toEqual([]);
			if (!partialPath) throw new Error("the failed copy did not leave partial evidence");
			expect(fs.readFileSync(partialPath)).toEqual(sidecarEvidence.subarray(0, 32));
			// The caller preserves the full live evidence before explicitly releasing its retained handle.
			copyFile(dbPath, savedPath, fs.constants.COPYFILE_EXCL);
			copyFile(sidecarPath, `${savedPath}${suffix}`, fs.constants.COPYFILE_EXCL);
		} finally {
			copy.mockRestore();
			failedHandle?.close(true);
			retainedStatement?.finalize();
		}
		if (journalMode === "WAL") {
			using saved = new Database(savedPath, { readonly: true });
			expect(saved.query<{ value: string }, []>("SELECT value FROM entries ORDER BY value").all()).toEqual([
				{ value: "committed-wal" },
				{ value: "seed" },
			]);
		} else {
			expect(fs.readFileSync(`${savedPath}${suffix}`)).toEqual(sidecarEvidence);
			using reopened = new Database(dbPath, { readonly: true });
			expect(reopened.query<{ value: string }, []>("SELECT value FROM entries").all()).toEqual([{ value: "seed" }]);
		}
	});
}

test.skipIf(process.platform !== "win32")(
	"a foreign live handle prevents replacement without losing corrupt evidence",
	async () => {
		await using dir = await TempDir.create("@omp-sqlite-foreign-handle-");
		const dbPath = dir.join("store.db");
		const damaged = await corruptSchemaPages(dbPath);
		// This handle deliberately bypasses the helper, like a foreign process.
		using foreign = new Database(dbPath);
		foreign.run("PRAGMA busy_timeout = 0");
		await expect(
			openSqliteDatabase(dbPath, db => db.run("CREATE TABLE recovered (value TEXT)"), { recoverCorruption: true }),
		).rejects.toMatchObject({ code: "SQLITE_CORRUPT" });
		expect(await fs.promises.readFile(dbPath)).toEqual(damaged);
		const backups = (await backupNames(dir.path())).filter(name => !/-wal$|-shm$|-journal$/.test(name));
		expect(backups).toHaveLength(1);
		expect(await fs.promises.readFile(path.join(dir.path(), backups[0]!))).toEqual(damaged);
	},
);

test("nested asynchronous corruption propagates to its parent instead of waiting on it", async () => {
	await using dir = await TempDir.create("@omp-sqlite-nested-async-");
	const dbPath = dir.join("store.db");
	const damaged = await corruptSchemaPages(dbPath);
	const db = await openSqliteDatabase(
		dbPath,
		async outer => {
			const inner = await openSqliteDatabase(
				dbPath,
				handle => {
					handle.run("CREATE TABLE IF NOT EXISTS recovered (value TEXT)");
					return handle;
				},
				{ recoverCorruption: true },
			);
			inner.close(true);
			outer.run("INSERT INTO recovered VALUES ('nested-async')");
			return outer;
		},
		{ recoverCorruption: true },
	);
	try {
		expect(db.query<{ value: string }, []>("SELECT value FROM recovered").all()).toEqual([{ value: "nested-async" }]);
	} finally {
		db.close(true);
	}
	const backups = (await backupNames(dir.path())).filter(name => !/-wal$|-shm$|-journal$/.test(name));
	expect(backups).toHaveLength(1);
	expect(await fs.promises.readFile(path.join(dir.path(), backups[0]!))).toEqual(damaged);
});

test("a detached corruption opener recovers after its parent's initializer has settled", async () => {
	await using dir = await TempDir.create("@omp-sqlite-detached-async-");
	const dbPath = dir.join("store.db");
	const damaged = await corruptSchemaPages(dbPath);
	const releaseChild = Promise.withResolvers<void>();
	let child: Promise<Database> | undefined;
	const owner = openSqliteDatabase(
		dbPath,
		db => {
			child ??= openSqliteDatabase(
				dbPath,
				async handle => {
					await releaseChild.promise;
					handle.run("CREATE TABLE IF NOT EXISTS recovered (value TEXT)");
					handle.run("INSERT INTO recovered VALUES ('detached')");
					return handle;
				},
				{ recoverCorruption: true },
			);
			// This synchronous failure deactivates the parent's context before the child is released.
			db.run("CREATE TABLE IF NOT EXISTS recovered (value TEXT)");
			db.run("INSERT INTO recovered VALUES ('parent')");
			return db;
		},
		{ recoverCorruption: true },
	);
	releaseChild.resolve();
	if (!child) throw new Error("the parent did not start its detached opener");
	const results = await Promise.allSettled([owner, child]);
	const handles = results.flatMap(result => (result.status === "fulfilled" ? [result.value] : []));
	try {
		for (const result of results) {
			if (result.status === "rejected") throw result.reason;
		}
		expect(handles[0]!.query<{ value: string }, []>("SELECT value FROM recovered ORDER BY value").all()).toEqual([
			{ value: "detached" },
			{ value: "parent" },
		]);
	} finally {
		for (const db of handles) db.close(true);
	}
	const backups = await backupNames(dir.path());
	expect(backups).toHaveLength(1);
	expect(await fs.promises.readFile(path.join(dir.path(), backups[0]!))).toEqual(damaged);
});

test("nested synchronous corruption leaves recovery to the pending asynchronous parent", async () => {
	await using dir = await TempDir.create("@omp-sqlite-nested-sync-");
	const dbPath = dir.join("store.db");
	const damaged = await corruptSchemaPages(dbPath);
	const db = await openSqliteDatabase(
		dbPath,
		outer => {
			const inner = openSqliteDatabaseSync(
				dbPath,
				handle => {
					handle.run("CREATE TABLE IF NOT EXISTS recovered (value TEXT)");
					return handle;
				},
				{ recoverCorruption: true },
			);
			inner.close(true);
			outer.run("INSERT INTO recovered VALUES ('nested-sync')");
			return outer;
		},
		{ recoverCorruption: true },
	);
	try {
		expect(db.query<{ value: string }, []>("SELECT value FROM recovered").all()).toEqual([{ value: "nested-sync" }]);
	} finally {
		db.close(true);
	}
	const backups = (await backupNames(dir.path())).filter(name => !/-wal$|-shm$|-journal$/.test(name));
	expect(backups).toHaveLength(1);
	expect(await fs.promises.readFile(path.join(dir.path(), backups[0]!))).toEqual(damaged);
});

test("arriving startup writes wait for the recovered generation's initializer to finish", async () => {
	await using dir = await TempDir.create("@omp-sqlite-recovery-arrival-");
	const dbPath = dir.join("store.db");
	const damaged = await corruptSchemaPages(dbPath);
	const adoptionStarted = Promise.withResolvers<void>();
	const releaseAdoption = Promise.withResolvers<void>();
	const owner = openSqliteDatabase(
		dbPath,
		async db => {
			db.run("CREATE TABLE IF NOT EXISTS recovered (value TEXT)");
			adoptionStarted.resolve();
			await releaseAdoption.promise;
			db.run("INSERT INTO recovered VALUES ('owner')");
			return db;
		},
		{ recoverCorruption: true },
	);
	await adoptionStarted.promise;
	const arrival = openSqliteDatabase(
		dbPath,
		db => {
			db.run("CREATE TABLE IF NOT EXISTS recovered (value TEXT)");
			db.run("INSERT INTO recovered VALUES ('arrival')");
			return db;
		},
		{ recoverCorruption: true },
	);
	try {
		using observer = new Database(dbPath, { readonly: true });
		expect(observer.query<{ value: string }, []>("SELECT value FROM recovered").all()).toEqual([]);
		observer.close(true);
		releaseAdoption.resolve();
		const [openedOwner, openedArrival] = await Promise.allSettled([owner, arrival]);
		if (openedOwner.status === "rejected") throw openedOwner.reason;
		if (openedArrival.status === "rejected") throw openedArrival.reason;
		expect(
			openedOwner.value.query<{ value: string }, []>("SELECT value FROM recovered ORDER BY value").all(),
		).toEqual([{ value: "arrival" }, { value: "owner" }]);
	} finally {
		releaseAdoption.resolve();
		for (const result of await Promise.allSettled([owner, arrival])) {
			if (result.status === "fulfilled") result.value.close(true);
		}
	}
	const backups = (await backupNames(dir.path())).filter(name => !/-wal$|-shm$|-journal$/.test(name));
	expect(backups).toHaveLength(1);
	expect(await fs.promises.readFile(path.join(dir.path(), backups[0]!))).toEqual(damaged);
});

test("a second corruption failure surfaces without rotating the first backup again", async () => {
	await using dir = await TempDir.create("@omp-sqlite-repeat-corrupt-");
	const dbPath = dir.join("store.db");
	const damaged = await corruptSchemaPages(dbPath);
	await expect(
		openSqliteDatabase(dbPath, db => db.run("CREATE TABLE recovered (value TEXT)"), {
			recoverCorruption: true,
			onCorruptionPreserved: backupPath => fs.copyFileSync(backupPath, dbPath),
		}),
	).rejects.toMatchObject({ code: "SQLITE_CORRUPT" });
	const backups = await backupNames(dir.path());
	expect(backups).toHaveLength(1);
	expect(await fs.promises.readFile(path.join(dir.path(), backups[0]!))).toEqual(damaged);
});

test("opt-in recovery never rotates a non-corruption SQLite failure", async () => {
	await using dir = await TempDir.create("@omp-sqlite-error-");
	const dbPath = dir.join("store.db");

	let failure: unknown;
	try {
		openSqliteDatabaseSync(dbPath, db => db.run("INSERT INTO missing_table VALUES (1)"), { recoverCorruption: true });
	} catch (error) {
		failure = error;
	}

	expect(isSqliteCorruptionError(failure)).toBe(false);
	expect(failure).toMatchObject({ code: "SQLITE_ERROR" });
	expect(await backupNames(dir.path())).toEqual([]);
});

/** Point the freelist trunk at a page past EOF: reads still work, but the next page allocation fails. */
async function corruptFreelist(dbPath: string) {
	using seed = new Database(dbPath);
	seed.run("CREATE TABLE existing (value TEXT)");
	seed.close(true);
	const damaged = await fs.promises.readFile(dbPath);
	damaged.writeUInt32BE(0x0d000000, 32);
	damaged.writeUInt32BE(1, 36);
	await fs.promises.writeFile(dbPath, damaged);
	return damaged;
}

test("recovery still fires when a multi-statement script hides the corruption behind a later error", async () => {
	await using dir = await TempDir.create("@omp-sqlite-hidden-corrupt-");
	const dbPath = dir.join("store.db");
	const damaged = await corruptFreelist(dbPath);

	const initialize = (db: Database) => {
		// Bun reports only the final statement's step error, so the failed CREATE is dropped here...
		db.run("CREATE TABLE IF NOT EXISTS added (value TEXT); CREATE TABLE IF NOT EXISTS existing (value TEXT);");
		// ...and resurfaces as SQLITE_ERROR, which on its own would not trigger recovery.
		db.prepare("SELECT value FROM added").finalize();
		return db;
	};

	const db = await openSqliteDatabase(dbPath, initialize, { recoverCorruption: true });
	try {
		expect(db.query("SELECT value FROM added").all()).toEqual([]);
	} finally {
		db.close(true);
	}
	const backups = (await backupNames(dir.path())).filter(name => !/-wal$|-shm$|-journal$/.test(name));
	expect(backups).toHaveLength(1);
	expect(await fs.promises.readFile(path.join(dir.path(), backups[0]!))).toEqual(damaged);
});

test("a non-corruption init failure on a store that fails quick_check is preserved as corruption", async () => {
	await using dir = await TempDir.create("@omp-sqlite-init-fails-on-corrupt-");
	const dbPath = dir.join("store.db");
	const damaged = await corruptFreelist(dbPath);
	const initFailure = new Error("init failed");
	let attempts = 0;
	let preserved: unknown;

	const db = await openSqliteDatabase(
		dbPath,
		handle => {
			if (attempts++ === 0) throw initFailure;
			return handle;
		},
		{ recoverCorruption: true, onCorruptionPreserved: (_backupPath, error) => (preserved = error) },
	);
	db.close(true);

	expect(attempts).toBe(2);
	expect(isSqliteCorruptionError(preserved)).toBe(true);
	expect((preserved as Error | undefined)?.cause).toBe(initFailure);
	const backups = (await backupNames(dir.path())).filter(name => !/-wal$|-shm$|-journal$/.test(name));
	expect(backups).toHaveLength(1);
	expect(await fs.promises.readFile(path.join(dir.path(), backups[0]!))).toEqual(damaged);
});
