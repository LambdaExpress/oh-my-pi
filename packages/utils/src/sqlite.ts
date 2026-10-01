/** Shared SQLite opening, error attribution, and result-code classification for persistent stores. */
import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { getDbBusyTimeoutMs } from "./env";
import { withFileLockSync } from "./file-lock";
import { isEnoent } from "./fs-error";
import * as logger from "./logger";

const BUSY_MAX_ATTEMPTS = 4;
const BUSY_BASE_DELAY_MS = 100;
const SQLITE_STORE_SUFFIXES = ["-wal", "-shm", "-journal", ""];
const SNAPSHOT_FILE = "database";
const SNAPSHOT_MANIFEST = "snapshot.json";
const SNAPSHOT_COMPARE_CHUNK = 64 * 1024;

let snapshotCompareBuffer: Buffer | undefined;

type SqliteFileIdentity = string | null | undefined;

class SqliteAttemptFailure extends Error {
	readonly original: unknown;
	readonly identity: SqliteFileIdentity;
	readonly canRecover: boolean;
	readonly db?: Database;

	constructor(original: unknown, identity: SqliteFileIdentity, options: { canRecover?: boolean; db?: Database } = {}) {
		super(original instanceof Error ? original.message : String(original));
		this.original = original;
		this.identity = identity;
		this.canRecover = options.canRecover ?? true;
		this.db = options.db;
	}
}

function sqliteFileIdentity(dbPath: string): SqliteFileIdentity {
	try {
		const stat = fs.statSync(dbPath);
		return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
	} catch (error) {
		return isEnoent(error) ? null : undefined;
	}
}

function closeFailedDatabase(db: Database | undefined, error: unknown, identity: SqliteFileIdentity): void {
	try {
		// close(false) leaves prepare() statements and their file handles alive.
		// Failed initializers no longer own those statements.
		db?.close(true);
	} catch (closeError) {
		const original = error instanceof Error ? error : new Error(String(error));
		const detail = closeError instanceof Error ? closeError.message : String(closeError);
		original.message += `; failed to close the SQLite handle: ${detail}`;
		throw new SqliteAttemptFailure(original, identity, { canRecover: false, db });
	}
}

interface SqliteRecoveryRequest {
	failure: SqliteAttemptFailure;
	options: SqliteOpenOptions;
}

type SqliteRecoveryOutcome = { ok: true } | { ok: false; error: unknown };

interface SqliteCorruptionRecovery {
	request: SqliteRecoveryRequest;
	settled: PromiseWithResolvers<SqliteRecoveryOutcome>;
	complete: PromiseWithResolvers<SqliteRecoveryOutcome>;
	outcome?: SqliteRecoveryOutcome;
}

interface SqliteOpeningState {
	key: string;
	pending: number;
	callers: number;
	succeeded: boolean;
	successfulIdentity?: SqliteFileIdentity;
	recovery?: SqliteCorruptionRecovery;
	failures?: SqliteRecoveryRequest[];
	successfulIdentities?: Set<SqliteFileIdentity>;
	retainedFailedHandles?: boolean;
}

interface SqliteInitializingContext {
	key: string;
	parent: SqliteInitializingContext | undefined;
	active: boolean;
}

const openingStates = new Map<string, SqliteOpeningState>();
const initializingContext = new AsyncLocalStorage<SqliteInitializingContext>();

function joinOpeningState(key: string): SqliteOpeningState {
	let state = openingStates.get(key);
	if (!state) {
		state = { key, pending: 0, callers: 0, succeeded: false };
		openingStates.set(key, state);
	}
	state.pending++;
	state.callers++;
	return state;
}

function recordOpeningFailure(state: SqliteOpeningState, failure: unknown, options: SqliteOpenOptions): void {
	if (!(failure instanceof SqliteAttemptFailure)) return;
	const request = { failure, options };
	(state.failures ??= []).push(request);
	if (options.recoverCorruption && isSqliteCorruptionError(failure.original)) {
		state.recovery ??= {
			request,
			settled: Promise.withResolvers<SqliteRecoveryOutcome>(),
			complete: Promise.withResolvers<SqliteRecoveryOutcome>(),
		};
	}
}

function recordOpeningSuccess(state: SqliteOpeningState, identity: SqliteFileIdentity): void {
	if (state.succeeded && state.successfulIdentity !== identity) {
		(state.successfulIdentities ??= new Set([state.successfulIdentity])).add(identity);
	}
	state.successfulIdentity = identity;
	state.succeeded = true;
}

function hasInitializingParent(key: string, parent: SqliteInitializingContext | undefined): boolean {
	for (let context = parent; context; context = context.parent) {
		if (context.key === key && context.active) return true;
	}
	return false;
}

function finishOpeningState(state: SqliteOpeningState): void {
	if (--state.pending !== 0) return;
	const recovery = state.recovery;
	if (!recovery) return;
	const { request } = recovery;
	let outcome: SqliteRecoveryOutcome;
	try {
		const backupPath = recoverCorruptDatabase(
			state.key,
			request.failure,
			request.options,
			state,
			state.failures?.map(({ failure }) => failure),
		);
		outcome = { ok: true };
		// Descendant/synchronous opens may adopt the preserved replacement.
		// Unrelated arrivals remain queued until all original openers finish.
		recovery.outcome = outcome;
		if (backupPath !== null) request.options.onCorruptionPreserved?.(backupPath, request.failure.original);
	} catch (error) {
		outcome = { ok: false, error };
	}
	recovery.outcome = outcome;
	recovery.settled.resolve(outcome);
}

function releaseOpeningState(state: SqliteOpeningState): void {
	if (--state.callers !== 0) return;
	// A failed pre-close snapshot keeps its cohort rooted until process exit.
	// Releasing the last connection, even through GC, can destroy uncopied evidence.
	if (!state.retainedFailedHandles) openingStates.delete(state.key);
	const recovery = state.recovery;
	if (recovery?.outcome) recovery.complete.resolve(recovery.outcome);
}

function replacementFailure(state: SqliteOpeningState, failure: unknown, dbPath: string): Error {
	const error = annotateSqliteError(failure instanceof SqliteAttemptFailure ? failure.original : failure, dbPath);
	if (state.recovery) state.recovery.outcome = { ok: false, error };
	return error;
}

/** Controls opt-in replacement of an unrecoverably corrupt SQLite store. */
export interface SqliteOpenOptions {
	/**
	 * Preserve a corrupt store and its sidecars, recreate it, and run the
	 * initializer once more. Disabled by default.
	 */
	recoverCorruption?: boolean;
	/** Receives the preserved database file in its private snapshot directory before replacement initialization. */
	onCorruptionPreserved?: (backupPath: string, error: unknown) => void;
}

/**
 * Bun's multi-statement `db.run()` reports only the final statement's step
 * error (oven-sh/bun#37415), so a corrupt page hit mid-script can resurface as
 * an unrelated failure such as "no such table". When an initializer fails for
 * any other reason, a `quick_check` on the still-open handle decides whether
 * the store itself is damaged. Runs only on the failure path.
 */
function revealHiddenCorruption(db: Database | undefined, error: unknown): unknown {
	if (!db || isSqliteCorruptionError(error) || isSqliteBusyError(error)) return error;
	let detail: string;
	let code: unknown = "SQLITE_CORRUPT";
	let errno: unknown = 11;
	try {
		const rows = db.query<{ quick_check: string }, []>("PRAGMA quick_check(1)").all();
		if (rows[0]?.quick_check === "ok") return error;
		detail = `database disk image is malformed (${rows[0]?.quick_check})`;
	} catch (probeError) {
		if (!isSqliteCorruptionError(probeError)) return error;
		detail = probeError instanceof Error ? probeError.message : String(probeError);
		({ code, errno } = probeError as { code: unknown; errno?: unknown });
	}
	const original = error instanceof Error ? error.message : String(error);
	return Object.assign(new Error(`${detail}; initialization failed: ${original}`, { cause: error }), { code, errno });
}

async function openWithBusyRetries<T>(
	dbPath: string,
	initialize: (db: Database) => T | Promise<T>,
	options: SqliteOpenOptions,
	key: string,
	onInitialized?: (identity: SqliteFileIdentity) => void,
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		let db: Database | undefined;
		const identity = sqliteFileIdentity(dbPath);
		try {
			db = new Database(dbPath);
			// WAL recovery can bypass the busy handler; both it and retries are needed (#2421).
			db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
			const context: SqliteInitializingContext = { key, parent: initializingContext.getStore(), active: true };
			try {
				const result = await initializingContext.run(context, initialize, db);
				onInitialized?.(identity);
				return result;
			} finally {
				context.active = false;
			}
		} catch (caught) {
			const error = options.recoverCorruption ? revealHiddenCorruption(db, caught) : caught;
			if (options.recoverCorruption && isSqliteCorruptionError(error)) {
				throw new SqliteAttemptFailure(error, identity, { db });
			}
			closeFailedDatabase(db, error, identity);
			if (!isSqliteBusyError(error) || attempt + 1 >= BUSY_MAX_ATTEMPTS) {
				throw new SqliteAttemptFailure(error, identity);
			}
			await Bun.sleep(BUSY_BASE_DELAY_MS * 2 ** attempt);
		}
	}
}

function openOnce<T>(
	dbPath: string,
	initialize: (db: Database) => T,
	options: SqliteOpenOptions,
	key: string,
	onInitialized?: (identity: SqliteFileIdentity) => void,
): T {
	let db: Database | undefined;
	const identity = sqliteFileIdentity(dbPath);
	try {
		db = new Database(dbPath);
		db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
		const context: SqliteInitializingContext = { key, parent: initializingContext.getStore(), active: true };
		try {
			const result = initializingContext.run(context, initialize, db);
			onInitialized?.(identity);
			return result;
		} finally {
			context.active = false;
		}
	} catch (caught) {
		const error = options.recoverCorruption ? revealHiddenCorruption(db, caught) : caught;
		if (options.recoverCorruption && isSqliteCorruptionError(error)) {
			throw new SqliteAttemptFailure(error, identity, { db });
		}
		closeFailedDatabase(db, error, identity);
		throw new SqliteAttemptFailure(error, identity);
	}
}

interface PreservedSqliteStore {
	backupPath: string;
	suffixes: string[];
}

interface StagedSqliteStore extends PreservedSqliteStore {
	directory: string;
	complete: boolean;
}

interface SqliteRecoveryEvidence {
	staged: StagedSqliteStore | null;
	preserved: PreservedSqliteStore | null;
}

function createSqliteSnapshot(dbPath: string): StagedSqliteStore {
	const directory = `${dbPath}.recovery-${crypto.randomUUID()}`;
	fs.mkdirSync(directory, { mode: 0o700 });
	return { directory, backupPath: path.join(directory, SNAPSHOT_FILE), suffixes: [], complete: false };
}

function captureSqliteSnapshot(dbPath: string, snapshot: StagedSqliteStore): void {
	// A private, unpublished copy survives WAL truncation during strict close.
	for (const suffix of SQLITE_STORE_SUFFIXES) {
		try {
			fs.copyFileSync(`${dbPath}${suffix}`, `${snapshot.backupPath}${suffix}`, fs.constants.COPYFILE_EXCL);
			fs.chmodSync(`${snapshot.backupPath}${suffix}`, 0o600);
			snapshot.suffixes.push(suffix);
		} catch (error) {
			if (isEnoent(error) && suffix !== "") continue;
			throw error;
		}
	}
	fs.writeFileSync(path.join(snapshot.directory, SNAPSHOT_MANIFEST), JSON.stringify(snapshot.suffixes), {
		flag: "wx",
		mode: 0o600,
	});
	snapshot.complete = true;
}

function readPublishedSnapshot(directory: string): PreservedSqliteStore | null {
	try {
		if (!fs.lstatSync(directory).isDirectory()) throw new Error("SQLite recovery snapshot is not a directory");
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
	const manifestPath = path.join(directory, SNAPSHOT_MANIFEST);
	if (!fs.lstatSync(manifestPath).isFile()) throw new Error("SQLite recovery snapshot has no owned manifest");
	const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	if (!Array.isArray(manifest)) throw new Error("SQLite recovery snapshot has an invalid manifest");
	const suffixes: string[] = [];
	const backupPath = path.join(directory, SNAPSHOT_FILE);
	for (const suffix of manifest) {
		if (typeof suffix !== "string" || !SQLITE_STORE_SUFFIXES.includes(suffix) || suffixes.includes(suffix)) {
			throw new Error("SQLite recovery snapshot has an invalid suffix set");
		}
		if (!fs.lstatSync(`${backupPath}${suffix}`).isFile()) {
			throw new Error("SQLite recovery snapshot is incomplete");
		}
		suffixes.push(suffix);
	}
	if (!suffixes.includes("")) throw new Error("SQLite recovery snapshot has no main database");
	return { backupPath, suffixes };
}

function snapshotFilesEqual(leftPath: string, rightPath: string): boolean {
	const left = fs.openSync(leftPath, "r");
	try {
		const right = fs.openSync(rightPath, "r");
		try {
			const size = fs.fstatSync(left).size;
			if (size !== fs.fstatSync(right).size) return false;
			const buffer = (snapshotCompareBuffer ??= Buffer.allocUnsafe(SNAPSHOT_COMPARE_CHUNK * 2));
			for (let position = 0; position < size;) {
				const length = Math.min(SNAPSHOT_COMPARE_CHUNK, size - position);
				const bytes = fs.readSync(left, buffer, 0, length, position);
				if (bytes === 0 || fs.readSync(right, buffer, SNAPSHOT_COMPARE_CHUNK, bytes, position) !== bytes)
					return false;
				if (buffer.compare(buffer, SNAPSHOT_COMPARE_CHUNK, SNAPSHOT_COMPARE_CHUNK + bytes, 0, bytes) !== 0)
					return false;
				position += bytes;
			}
			return true;
		} finally {
			fs.closeSync(right);
		}
	} finally {
		fs.closeSync(left);
	}
}

function discardRedundantSnapshot(snapshot: StagedSqliteStore, published: PreservedSqliteStore): boolean {
	if (!snapshot.complete || snapshot.suffixes.length !== published.suffixes.length) return false;
	for (const suffix of snapshot.suffixes) {
		if (
			!published.suffixes.includes(suffix) ||
			!snapshotFilesEqual(`${snapshot.backupPath}${suffix}`, `${published.backupPath}${suffix}`)
		) {
			return false;
		}
	}
	for (const suffix of snapshot.suffixes) fs.unlinkSync(`${snapshot.backupPath}${suffix}`);
	fs.unlinkSync(path.join(snapshot.directory, SNAPSHOT_MANIFEST));
	fs.rmdirSync(snapshot.directory);
	return true;
}

function removeCorruptSqliteStore(dbPath: string, { backupPath, suffixes }: PreservedSqliteStore): void {
	const removed: string[] = [];
	try {
		// Remove the main file last so a failed sidecar removal cannot leave
		// a path at which another startup creates an empty database.
		for (const suffix of suffixes) {
			try {
				fs.unlinkSync(`${dbPath}${suffix}`);
				removed.push(suffix);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
	} catch (error) {
		for (const suffix of removed) {
			try {
				fs.copyFileSync(`${backupPath}${suffix}`, `${dbPath}${suffix}`, fs.constants.COPYFILE_EXCL);
			} catch (rollbackError) {
				logger.error("SQLite quarantine rollback failed; original preserved at backup path", {
					path: `${dbPath}${suffix}`,
					backupPath: `${backupPath}${suffix}`,
					error: String(rollbackError),
				});
			}
		}
		throw error;
	}
}

function corruptionPreservationError(corruption: unknown, dbPath: string, preservationError: unknown): Error {
	const annotated = annotateSqliteError(corruption, dbPath);
	const detail = preservationError instanceof Error ? preservationError.message : String(preservationError);
	annotated.message += `; failed to preserve the corrupt database: ${detail}`;
	return annotated;
}

function closeFailedDatabases(failures: SqliteAttemptFailure[]): void {
	let closeFailure: unknown;
	for (const failure of failures) {
		// A previous strict close failure makes replacement unsafe; do not
		// reinterpret it as a reason to retry or remove a still-open file.
		if (!failure.canRecover) continue;
		try {
			closeFailedDatabase(failure.db, failure.original, failure.identity);
		} catch (error) {
			closeFailure ??= error;
		}
	}
	if (closeFailure !== undefined) throw closeFailure;
}

function recoverCorruptDatabase(
	dbPath: string,
	error: unknown,
	options: SqliteOpenOptions,
	state: SqliteOpeningState,
	failures?: SqliteAttemptFailure[],
): string | null {
	if (!(error instanceof SqliteAttemptFailure)) throw annotateSqliteError(error, dbPath);
	const failure = error;
	const failedAttempts = failures ?? [failure];
	if (!options.recoverCorruption || !failure.canRecover || !isSqliteCorruptionError(failure.original)) {
		closeFailedDatabases(failedAttempts);
		throw annotateSqliteError(failure.original, dbPath);
	}

	const evidence: SqliteRecoveryEvidence = { staged: null, preserved: null };
	let captureFailure: unknown;
	let preservationVerified = false;
	let replaced = false;
	const backupDirectory = `${dbPath}.corrupt-${encodeURIComponent(String(failure.identity))}`;
	try {
		try {
			const currentIdentity = sqliteFileIdentity(dbPath);
			if (failure.identity === undefined || currentIdentity === undefined) {
				throw new Error("could not verify the corrupt database file identity");
			}
			if (currentIdentity === failure.identity) {
				evidence.staged = createSqliteSnapshot(dbPath);
				captureSqliteSnapshot(dbPath, evidence.staged);
			}
		} catch (error) {
			captureFailure = error;
		}
		if (!evidence.staged?.complete) {
			const currentIdentity = sqliteFileIdentity(dbPath);
			if (
				failure.identity !== null &&
				failure.identity !== undefined &&
				currentIdentity !== undefined &&
				currentIdentity !== failure.identity
			) {
				// A peer may have rotated the old generation while our copy failed.
				// Its atomic, complete publication must be verified before strict close.
				evidence.preserved = readPublishedSnapshot(backupDirectory);
			}
		}
		preservationVerified = evidence.staged?.complete === true || evidence.preserved !== null;
		if (!preservationVerified)
			throw captureFailure ?? new Error("could not verify a complete pre-close SQLite recovery snapshot");
		// Close before contending for the lease; otherwise failed processes
		// can pin each other's main/WAL files on Windows.
		closeFailedDatabases(failedAttempts);
		replaced = withFileLockSync(`${dbPath}.recovery`, () => {
			const currentIdentity = sqliteFileIdentity(dbPath);
			if (failure.identity === undefined || currentIdentity === undefined) {
				throw new Error("could not verify the corrupt database file identity");
			}
			evidence.preserved = readPublishedSnapshot(backupDirectory);
			if (currentIdentity !== failure.identity) {
				// A complete, owned peer snapshot proves preservation even when
				// our pre-close copy failed because the old generation vanished.
				if (!evidence.preserved) throw new Error("could not verify the replacement owner's preserved snapshot");
				if (evidence.staged && discardRedundantSnapshot(evidence.staged, evidence.preserved))
					evidence.staged = null;
				return false;
			}
			if (captureFailure !== undefined) throw captureFailure;
			if (!evidence.staged?.complete) throw new Error("could not capture a complete SQLite recovery snapshot");
			if (!evidence.preserved) {
				// Rename the whole complete directory under the lease. Neither
				// a partial sidecar publication nor a losing opener is a backup.
				fs.renameSync(evidence.staged.directory, backupDirectory);
				evidence.preserved = {
					backupPath: path.join(backupDirectory, SNAPSHOT_FILE),
					suffixes: evidence.staged.suffixes,
				};
				evidence.staged = null;
			} else if (discardRedundantSnapshot(evidence.staged, evidence.preserved)) {
				evidence.staged = null;
			}
			if (failedAttempts.some(attempt => !attempt.canRecover)) {
				throw new Error("another failed initializer could not release its SQLite handle");
			}
			if (
				state.succeeded &&
				(state.successfulIdentity === null ||
					state.successfulIdentity === undefined ||
					state.successfulIdentities?.has(null) ||
					state.successfulIdentities?.has(undefined) ||
					state.successfulIdentity === failure.identity ||
					state.successfulIdentities?.has(failure.identity))
			) {
				throw new Error("another initializer successfully opened this database; refusing to discard its writes");
			}
			// A distinct staged image can contain later committed WAL bytes.
			// Preserve it and use it for rollback rather than overwrite evidence.
			removeCorruptSqliteStore(dbPath, evidence.staged ?? evidence.preserved);
			return true;
		});
	} catch (preservationError) {
		if (!preservationVerified && failedAttempts.some(attempt => attempt.db !== undefined)) {
			state.retainedFailedHandles = true;
		}
		const annotated = corruptionPreservationError(failure.original, dbPath, preservationError);
		if (evidence.preserved)
			annotated.message += `; preserved evidence: ${JSON.stringify(evidence.preserved.backupPath)}`;
		if (evidence.staged) annotated.message += `; staged evidence: ${JSON.stringify(evidence.staged.directory)}`;
		if (state.retainedFailedHandles) {
			annotated.message +=
				"; failed SQLite handles retained and further opens blocked until process exit to protect uncopied evidence";
		}
		throw annotated;
	}

	if (!evidence.preserved) return null;
	const { backupPath } = evidence.preserved;
	if (!replaced) {
		if (evidence.staged) {
			logger.warn("SQLite peer recovery adopted; additional damaged-store evidence retained", {
				path: dbPath,
				backupPath,
				additionalEvidencePath: evidence.staged.directory,
			});
		}
		return null;
	}
	logger.warn("SQLite database corrupt; preserved damaged store before recreating it", {
		path: dbPath,
		backupPath,
		additionalEvidencePath: evidence.staged?.directory,
		warning: "Stored credentials from this database may require re-login.",
	});
	return backupPath;
}

/**
 * Opens and initializes a store, retrying BUSY failures up to four total attempts.
 * Installs the busy handler before initialization and closes failed connections.
 * The initializer may run again on a fresh connection; on success it owns the handle.
 *
 * Healthy initializers remain parallel and acquire no recovery lock. Only
 * corruption recovery waits for concurrent local attempts to settle, copies
 * evidence, and closes their failed handles before replacing files under the
 * cross-process recovery lock. Complete snapshots are published atomically;
 * unequal/partial peer evidence remains in its private staging directory.
 * Incomplete pre-close preservation retains failed handles and blocks further
 * same-path opens until process exit rather than checkpointing uncopied evidence.
 * File identities protect a peer's replacement,
 * and successful concurrent local initializers are never discarded. A foreign
 * live Windows handle can prevent replacement; its preservation error surfaces
 * with the backup intact rather than adding another retry policy.
 * Final failures retain their SQLite codes and include the database path.
 */
export async function openSqliteDatabase<T>(
	dbPath: string,
	initialize: (db: Database) => T | Promise<T>,
	options: SqliteOpenOptions = {},
): Promise<T> {
	const key = path.resolve(dbPath);
	const parent = initializingContext.getStore();
	const nested = hasInitializingParent(key, parent);
	const existing = openingStates.get(key);
	const recovering = existing?.recovery;
	if (existing && recovering) {
		if (existing.retainedFailedHandles && recovering.outcome && !recovering.outcome.ok) {
			throw recovering.outcome.error;
		}
		// Seal the damaged generation against continuous arrivals. A descendant
		// cannot wait for its parent; after preservation it may only adopt the
		// replacement, never start another corruption rotation.
		if (nested) {
			const outcome = recovering.outcome;
			if (!outcome) throw annotateSqliteError(recovering.request.failure.original, dbPath);
			if (!outcome.ok) throw outcome.error;
			existing.callers++;
			try {
				return await openWithBusyRetries(dbPath, initialize, {}, key);
			} catch (error) {
				throw replacementFailure(existing, error, dbPath);
			} finally {
				releaseOpeningState(existing);
			}
		}
		const outcome = await recovering.complete.promise;
		if (!outcome.ok) throw outcome.error;
	}
	const state = joinOpeningState(key);
	try {
		let failure: unknown;
		try {
			return await openWithBusyRetries(dbPath, initialize, options, key, identity =>
				recordOpeningSuccess(state, identity),
			);
		} catch (error) {
			failure = error;
			recordOpeningFailure(state, error, options);
		} finally {
			finishOpeningState(state);
		}

		if (
			!(failure instanceof SqliteAttemptFailure) ||
			!options.recoverCorruption ||
			!isSqliteCorruptionError(failure.original) ||
			!state.recovery ||
			hasInitializingParent(key, parent)
		) {
			// The parent owns quiescence and any retained failed descendant handle.
			throw annotateSqliteError(failure instanceof SqliteAttemptFailure ? failure.original : failure, dbPath);
		}
		const outcome = await state.recovery.settled.promise;
		if (!outcome.ok) throw outcome.error;
		try {
			return await openWithBusyRetries(dbPath, initialize, {}, key);
		} catch (error) {
			throw replacementFailure(state, error, dbPath);
		}
	} finally {
		releaseOpeningState(state);
	}
}

/**
 * Synchronous counterpart to {@link openSqliteDatabase}. It performs no BUSY
 * retry loop; corruption recovery, when enabled, is bounded to one replacement.
 */
export function openSqliteDatabaseSync<T>(
	dbPath: string,
	initialize: (db: Database) => T,
	options: SqliteOpenOptions = {},
): T {
	const key = path.resolve(dbPath);
	const existing = openingStates.get(key);
	const recovering = existing?.recovery;
	if (existing && recovering) {
		const outcome = recovering.outcome;
		if (!outcome) throw annotateSqliteError(recovering.request.failure.original, dbPath);
		if (!outcome.ok) throw outcome.error;
		existing.callers++;
		try {
			return openOnce(dbPath, initialize, {}, key);
		} catch (error) {
			throw replacementFailure(existing, error, dbPath);
		} finally {
			releaseOpeningState(existing);
		}
	}
	const state = joinOpeningState(key);
	try {
		let failure: unknown;
		try {
			return openOnce(dbPath, initialize, options, key, identity => recordOpeningSuccess(state, identity));
		} catch (error) {
			failure = error;
			recordOpeningFailure(state, error, options);
		} finally {
			finishOpeningState(state);
		}

		const outcome = state.recovery?.outcome;
		if (!outcome) {
			// Never block the event loop waiting for an enclosing/async initializer.
			throw annotateSqliteError(failure instanceof SqliteAttemptFailure ? failure.original : failure, dbPath);
		}
		if (!outcome.ok) throw outcome.error;
		try {
			return openOnce(dbPath, initialize, {}, key);
		} catch (error) {
			throw replacementFailure(state, error, dbPath);
		}
	} finally {
		releaseOpeningState(state);
	}
}

/** Adds the failing store's path to an error without losing SQLite result codes or its original stack. */
export function annotateSqliteError(error: unknown, dbPath: string): Error {
	const annotated = error instanceof Error ? error : new Error(String(error));
	annotated.message = `Database ${JSON.stringify(dbPath)}: ${annotated.message}`;
	return annotated;
}

/** Checkpoints committed WAL frames without waiting for concurrent readers. */
export function checkpointWal(db: Database): void {
	db.run("PRAGMA wal_checkpoint(PASSIVE)");
}

/**
 * SQLite's busy result-code family — base `SQLITE_BUSY` plus the extended
 * variants `SQLITE_BUSY_RECOVERY` (concurrent WAL recovery), `SQLITE_BUSY_SNAPSHOT`,
 * and `SQLITE_BUSY_TIMEOUT`. All warrant the same backoff-and-retry treatment.
 */
export function isSqliteBusyError(err: unknown): boolean {
	if (err === null || typeof err !== "object" || !("code" in err)) return false;
	const code = err.code;
	return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

/**
 * SQLite's unrecoverable-corruption result codes — the `SQLITE_CORRUPT` family
 * (base plus extended variants like `SQLITE_CORRUPT_VTAB` / `SQLITE_CORRUPT_INDEX`)
 * and `SQLITE_NOTADB` (the file header is not a database). Unlike
 * {@link isSqliteBusyError}, these never clear by retrying: the store must be
 * repaired or replaced, so callers latch, quarantine, or recreate the file.
 */
export function isSqliteCorruptionError(err: unknown): boolean {
	if (err === null || typeof err !== "object" || !("code" in err)) return false;
	const code = err.code;
	return typeof code === "string" && (code.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB");
}
