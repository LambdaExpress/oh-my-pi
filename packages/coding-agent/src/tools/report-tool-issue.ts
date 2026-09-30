/**
 * report_issue — local QA capture for unexpected tool behavior.
 *
 * The write tool dispatches structured Markdown to `xd://report_issue`.
 * Reports are written synchronously to {@link REPORT_ISSUE_DIRECTORY} with
 * runtime metadata so a later maintainer can reproduce the failure.
 *
 * The SQLite grievance and remote-push exports below remain available for
 * managing legacy queued reports through the `omp grievances` CLI. New
 * `report_issue` writes never enter that queue or require sharing consent.
 *
 * The legacy queue is enabled by default (`dev.autoqa` defaults to true);
 * `PI_AUTO_QA=0` or an explicit `dev.autoqa: false` short-circuits injection
 * entirely. Shipping queued rows requires the user's persisted sharing consent
 * (`dev.autoqaConsent`, read live on every call), or `PI_AUTO_QA_PUSH=1` in
 * non-interactive environments where the consent dialog never fires. A flush
 * POSTs pending rows and marks them pushed on HTTP 2xx; rows the collector
 * permanently refuses (400/413/422) are isolated by bisecting the batch and
 * parked with the server's error, so a single bad row can't block the queue.
 * Device execution is never blocked on the network and never throws.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { $env, $flag, getAutoQaDbPath, getInstallId, logger, VERSION } from "@oh-my-pi/pi-utils";
import type { Settings } from "..";
import type { ToolSession } from "./index";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { XdevDispatch } from "./xdev";
import { REPORT_ISSUE_DEVICE_NAME, REPORT_ISSUE_DEVICE_PATH } from "@oh-my-pi/pi-tui/tools/report-tool-issue";
import { truncateHeadBytes } from "@oh-my-pi/pi-tui/tools/streaming-output";

import { cfgDevAutoqa, cfgDevAutoqaConsent, cfgDevAutoqaPushEndpoint, cfgDevAutoqaPushToken } from "./settings";

export const REPORT_ISSUE_DIRECTORY = String.raw`D:\project\oh-my-pi\issues`;

const REPORT_ISSUE_REQUIRED_SECTIONS = [
	"Summary",
	"Steps to Reproduce",
	"Expected Behavior",
	"Actual Behavior",
	"Context",
] as const;

const REPORT_ISSUE_TEMPLATE = `<tool-name>
## Summary
<concise failure description>

## Steps to Reproduce
<numbered, deterministic steps with exact tool arguments>

## Expected Behavior
<expected tool result>

## Actual Behavior
<actual result or error, verbatim when practical>

## Context
<cwd, relevant prior state, environment, frequency, and redacted evidence>`;

/** Usage text for `read xd://report_issue`. */
export function reportIssueDeviceUsage(): string {
	return `Write structured Markdown as plain text to ${REPORT_ISSUE_DEVICE_PATH}. Replace every placeholder in this template:\n${REPORT_ISSUE_TEMPLATE}`;
}

/** Whether a tool call writes to `xd://report_issue`. */
export function isReportIssueToolCall(toolCall: { name: string; arguments?: Record<string, unknown> }): boolean {
	if (toolCall.name !== "write") return false;
	const args = toolCall.arguments;
	const path =
		typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : undefined;
	return path === REPORT_ISSUE_DEVICE_PATH || path === `${REPORT_ISSUE_DEVICE_PATH}/`;
}

function reportSectionHasContent(report: string, heading: string): boolean {
	const lines = report.split(/\r?\n/);
	const start = lines.findIndex(line => line.trim() === `## ${heading}`);
	if (start < 0) return false;
	for (let index = start + 1; index < lines.length; index++) {
		const line = lines[index]!.trim();
		if (line.startsWith("## ")) break;
		if (line.length > 0) return true;
	}
	return false;
}

/**
 * Maximum `tool` length the collector accepts, in UTF-8 bytes. An oversized
 * entry makes the collector reject the *whole* batch with HTTP 400, so
 * grievances are clamped at record time and again at send time — rows recorded
 * before the clamp existed still sit in users' databases.
 */
const MAX_TOOL_BYTES = 128;

/**
 * Clamp a grievance to the collector's field limits.
 *
 * An over-long `tool` is prose the model put on line 1 instead of a tool name,
 * so the original line is kept at the head of the report and only the stored
 * name is truncated: nothing is lost and the row stops being a poison pill.
 */
function clampGrievance(tool: string, report: string): { tool: string; report: string } {
	if (Buffer.byteLength(tool, "utf8") <= MAX_TOOL_BYTES) return { tool, report };
	return { tool: truncateHeadBytes(tool, MAX_TOOL_BYTES).text, report: `${tool}\n${report}` };
}

function parseReportIssueBody(text: string): { tool: string; report: string } {
	const body = text.trim();
	const firstNewline = body.indexOf("\n");
	if (firstNewline <= 0) {
		throw new ToolError(`Invalid report format. ${reportIssueDeviceUsage()}`);
	}
	const rawTool = body.slice(0, firstNewline).trim();
	const tool = rawTool.startsWith("<") && rawTool.endsWith(">") ? rawTool.slice(1, -1).trim() : rawTool;
	const report = body.slice(firstNewline + 1).trim();
	if (!/^[a-zA-Z0-9_.-]+$/.test(tool) || report.length === 0) {
		throw new ToolError(`Invalid report format. ${reportIssueDeviceUsage()}`);
	}
	const missing = REPORT_ISSUE_REQUIRED_SECTIONS.filter(section => !reportSectionHasContent(report, section));
	if (missing.length > 0) {
		throw new ToolError(
			`Incomplete report; missing non-empty sections: ${missing.join(", ")}. ${reportIssueDeviceUsage()}`,
		);
	}
	return { tool, report };
}

export interface ReportIssueDispatchOptions {
	directory?: string;
	now?: () => Date;
	createId?: () => string;
}

function filenamePart(value: string, fallback: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "") || fallback
	);
}

function metadataValue(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function writeReportIssueFile(
	session: ToolSession,
	tool: string,
	report: string,
	options: ReportIssueDispatchOptions,
): string {
	const directory = options.directory ?? REPORT_ISSUE_DIRECTORY;
	const createdAt = options.now?.() ?? new Date();
	const canonicalTool = tool.startsWith("proxy_") ? tool.slice("proxy_".length) : tool;
	const id = options.createId?.() ?? Bun.randomUUIDv7();
	const timestamp = createdAt.toISOString().replaceAll(":", "-");
	const fileName = `${timestamp}-${filenamePart(canonicalTool, "tool")}-${filenamePart(id, "issue")}.md`;
	const issuePath = path.join(directory, fileName);
	const sessionFile = session.getSessionFile();
	const metadata = [
		`- Created: ${createdAt.toISOString()}`,
		`- OMP version: ${VERSION}`,
		`- Model: ${metadataValue(session.getActiveModelString?.() ?? "unknown")}`,
		`- Platform: ${process.platform}/${process.arch}`,
		`- Working directory: ${metadataValue(session.cwd)}`,
	];
	if (sessionFile) metadata.push(`- Session file: ${metadataValue(sessionFile)}`);
	const content = `# Tool Issue: ${canonicalTool}\n\n${metadata.join("\n")}\n\n${report}\n`;
	try {
		fs.mkdirSync(directory, { recursive: true });
		const descriptor = fs.openSync(issuePath, "wx");
		try {
			fs.writeFileSync(descriptor, content, { encoding: "utf8" });
			fs.fsyncSync(descriptor);
		} finally {
			fs.closeSync(descriptor);
		}
		return issuePath;
	} catch (error) {
		logger.error("Failed to write local tool issue", { directory, error });
		throw new ToolError(`Failed to write issue report to '${directory}': ${String(error)}`);
	}
}

/**
 * Whether local Auto-QA capture is active for this session.
 *
 * Precedence: explicit `dev.autoqa` (env `PI_AUTO_QA` or any settings layer);
 * without settings, only the env flag can enable it. Legacy remote sharing
 * consent never disables local issue files.
 */
export function isAutoQaEnabled(settings?: Settings): boolean {
	if (!settings) return cfgDevAutoqa.envValue() ?? false;
	return cfgDevAutoqa.get(settings);
}

// ───────────────────────────────────────────────────────────────────────────
// Consent gate
// ───────────────────────────────────────────────────────────────────────────

/**
 * Resolver for the user's "share grievances?" consent.
 *
 * Return values:
 *   - `true`  — user agreed; record + ship for this run and persist.
 *   - `false` — user declined; suppress for this run and persist.
 *   - `null`  — user dismissed the dialog (ESC, click-away, …) without
 *               picking an option. The decision is NOT cached or persisted,
 *               so the next `report_issue` invocation re-prompts.
 *
 * Persistence is the tool's job (so subagent invocations can persist into the
 * disk-backed `Settings` instance the host registered alongside the handler),
 * not the handler's. Implementations live in hosts that have UI affordances —
 * today only `InteractiveMode`. When no handler is registered (CLI subcommands,
 * tests, non-interactive runs) consent defaults to `false` — the explicit
 * "don't collect by default" stance.
 */
export type AutoQaConsentHandler = () => Promise<boolean | null>;

let consentHandler: AutoQaConsentHandler | null = null;
/**
 * Persistent settings instance supplied by the consent-handler registrant.
 * Subagents have in-memory `Settings` snapshots that don't write to disk;
 * we persist the decision through this disk-backed reference so a grant
 * survives across runs even when triggered from a subagent device write.
 */
let persistentConsentSettings: Settings | null = null;
/**
 * Single-flight in-flight consent request. While the dialog is open, every
 * concurrent `report_issue` call (main + every subagent) awaits this promise
 * instead of stacking duplicate popups.
 */
let consentInFlight: Promise<boolean> | null = null;

/**
 * Register the consent handler and the persistent {@link Settings} instance
 * the decision should be written to. Passing `null` clears the handler
 * (e.g. on `InteractiveMode` teardown). Re-registration is authoritative.
 */
export function setAutoQaConsentHandler(
	handler: AutoQaConsentHandler | null,
	persistentSettings: Settings | null = null,
): void {
	consentHandler = handler;
	persistentConsentSettings = persistentSettings;
}

/** Test-only: clear consent cache + handler. Never call from production code. */
export function __resetAutoQaConsentForTests(): void {
	consentHandler = null;
	persistentConsentSettings = null;
	consentInFlight = null;
}

function readPersistedConsent(settings: Settings | undefined): boolean | null {
	if (!settings) return null;
	const stored = cfgDevAutoqaConsent.get(settings);
	if (stored === "granted") return true;
	if (stored === "denied") return false;
	return null;
}

function persistConsent(localSettings: Settings | undefined, granted: boolean): void {
	const value = granted ? "granted" : "denied";
	try {
		if (localSettings) cfgDevAutoqaConsent.set(localSettings, value);
	} catch (error) {
		logger.warn("Failed to persist auto-QA consent to local settings snapshot", { error: String(error) });
	}
	if (persistentConsentSettings && persistentConsentSettings !== localSettings) {
		try {
			cfgDevAutoqaConsent.set(persistentConsentSettings, value);
		} catch (error) {
			logger.warn("Failed to persist auto-QA consent to persistent settings", { error: String(error) });
		}
	}
}

/**
 * Resolve the user's consent for Auto-QA grievances.
 *
 * Read live on every call so a `/settings` or config edit to
 * `dev.autoqaConsent` applies to the next report. Priority:
 * 1. persisted setting on the registered persistent settings instance — the
 *    user's authoritative choice, which a subagent's isolated `Settings`
 *    snapshot may predate
 * 2. persisted setting on the caller's `Settings`
 * 3. registered UI handler (single-flight)
 * 4. default `false` (no handler / non-interactive)
 */
export async function resolveAutoQaConsent(settings: Settings | undefined): Promise<boolean> {
	const globalPersisted = readPersistedConsent(persistentConsentSettings ?? undefined);
	if (globalPersisted !== null) return globalPersisted;
	const localPersisted = readPersistedConsent(settings);
	if (localPersisted !== null) return localPersisted;
	if (!consentHandler) return false;
	if (consentInFlight) return consentInFlight;
	consentInFlight = (async () => {
		try {
			const result = await consentHandler!();
			if (result === null) return false;
			persistConsent(settings, result);
			return result;
		} catch {
			// Transient failure (e.g. dialog crashed) — don't cache; allow re-prompt.
			return false;
		} finally {
			consentInFlight = null;
		}
	})();
	return consentInFlight;
}

let cachedDb: Database | null = null;

/**
 * Open (or return the cached handle for) the auto-QA SQLite database at
 * `~/.omp/autoqa.db` (XDG: `$XDG_DATA_HOME/omp/autoqa.db`), creating the
 * schema lazily. Returns `null` when the path cannot be resolved or opened.
 */
export function openAutoQaDb(): Database | null {
	if (cachedDb) return cachedDb;
	const dbPath = getAutoQaDbPath();
	if (!dbPath) return null;
	try {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath, { create: true });
		// Install the busy handler BEFORE any lock-taking statement. See #2421.
		db.run("PRAGMA busy_timeout = 5000");
		// `pushed` is tri-state: 0 = queued, 1 = accepted by the collector,
		// -1 = permanently refused (`push_error` holds the collector's reason).
		// Refused rows are parked so one bad row can't block the queue forever.
		db.exec(`
			CREATE TABLE IF NOT EXISTS grievances (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				model TEXT NOT NULL,
				version TEXT NOT NULL,
				tool TEXT NOT NULL,
				report TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				pushed INTEGER NOT NULL DEFAULT 0,
				push_error TEXT
			);
		`);
		// Legacy DBs (May 2026) predate `created_at`. ALTER TABLE only accepts
		// constant defaults, so add it empty and backfill before the index below.
		const hasCreatedAt = db.prepare("SELECT 1 FROM pragma_table_info('grievances') WHERE name = 'created_at'").get();
		if (!hasCreatedAt) {
			db.exec(`
				ALTER TABLE grievances ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
				UPDATE grievances SET created_at = CURRENT_TIMESTAMP WHERE created_at = '';
			`);
		}
		const hasPushError = db.prepare("SELECT 1 FROM pragma_table_info('grievances') WHERE name = 'push_error'").get();
		if (!hasPushError) db.exec("ALTER TABLE grievances ADD COLUMN push_error TEXT;");
		db.exec(`
			CREATE INDEX IF NOT EXISTS grievances_pushed_created_at_idx
			ON grievances (pushed, created_at, id);
		`);
		cachedDb = db;
		return db;
	} catch (error) {
		logger.warn("Failed to open auto-QA database", { error: String(error) });
		return null;
	}
}

// ───────────────────────────────────────────────────────────────────────────
// Backend push
// ───────────────────────────────────────────────────────────────────────────

export interface FlushResult {
	/** Rows the collector accepted this flush. */
	pushed: number;
	ok: boolean;
	skipped?: boolean;
	/**
	 * Rows the collector permanently refused. They are parked as `pushed = -1`
	 * and never retried; only present when non-zero.
	 */
	rejected?: number;
	/** Last collector error (`HTTP <status>: <body>`), for CLI reporting. */
	error?: string;
}

/**
 * Optional per-flush controls. Used by `omp grievances push` to surface
 * progress to a TTY and to skip the user-facing consent gate (manual
 * pushes are the user's explicit intent, not a side effect of a device write).
 */
export interface FlushOptions {
	/**
	 * Skip the `dev.autoqaConsent === "granted"` gate in
	 * {@link resolvePushConfig}. Endpoint configuration is still required.
	 * Reserved for explicit user-driven pushes (CLI `grievances push`,
	 * future debug recipes); never set from the device's auto-flush path.
	 */
	bypassConsent?: boolean;
	/**
	 * Fetch implementation for the push POST. Defaults to global fetch.
	 */
	fetch?: FetchImpl;
	/**
	 * Fires once at the start of the loop with the snapshot count of
	 * unpushed rows. Subsequent inserts won't be reflected (the count is
	 * a planning hint for progress reporters, not a live total).
	 */
	onStart?: (totalUnpushed: number) => void;
	/**
	 * Fires after every successfully shipped batch with the running pushed
	 * count. Reporters compare against the `totalUnpushed` they saw in
	 * `onStart` to advance their bar.
	 */
	onProgress?: (pushedSoFar: number) => void;
}

interface PushConfig {
	endpoint: string;
	token: string | undefined;
}

const FLUSH_TIMEOUT_MS = 5_000;
const FAILURE_COOLDOWN_MS = 30_000;
/**
 * Per-request batch size. The worker loops until no unpushed rows remain,
 * shipping `FLUSH_BATCH_SIZE` rows per POST. Tunes the trade-off between
 * request count and request size — 50 keeps each payload well under the
 * default `maxBody` limit on the autoqa collector while letting a
 * realistic backlog (a few hundred legacy rows on first flush after the
 * consent grant) drain in single-digit requests.
 */
const FLUSH_BATCH_SIZE = 50;

let inFlightFlush: Promise<FlushResult> | null = null;
let lastFailureAt = 0;

/** Test-only: clear single-flight + cooldown state. Never call from production code. */
export function __resetAutoQaFlushStateForTests(): void {
	inFlightFlush = null;
	lastFailureAt = 0;
}

function envOverrideString(name: string): string | undefined {
	const value = $env[name];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function resolvePushConfig(settings: Settings | undefined, bypassConsent: boolean): PushConfig | null {
	if (!isAutoQaEnabled(settings)) return null;

	// Consent IS the push opt-in for the auto-flush path. `bypassConsent`
	// covers explicit user-driven pushes (`omp grievances push`) where the
	// user clearly intends to ship regardless of dialog state. The
	// `PI_AUTO_QA_PUSH` env flag stays as a CI/headless override too.
	if (!bypassConsent) {
		const consented = (settings ? cfgDevAutoqaConsent.get(settings) : undefined) === "granted";
		if (!consented && !$flag("PI_AUTO_QA_PUSH")) return null;
	}

	const endpoint =
		envOverrideString("PI_AUTO_QA_PUSH_URL") ?? (settings ? cfgDevAutoqaPushEndpoint.get(settings) : undefined);
	if (!endpoint || endpoint.trim().length === 0) return null;

	const token =
		envOverrideString("PI_AUTO_QA_PUSH_TOKEN") ?? (settings ? cfgDevAutoqaPushToken.get(settings) : undefined);
	return { endpoint: endpoint.trim(), token: token && token.length > 0 ? token : undefined };
}

interface GrievanceRow {
	id: number;
	model: string;
	version: string;
	tool: string;
	report: string;
}

/** Cap on collector error text kept for logs, `FlushResult`, and `push_error`. */
const MAX_PUSH_ERROR_CHARS = 300;

async function describeErrorResponse(response: Response): Promise<string> {
	let detail = "";
	try {
		detail = (await response.text()).trim();
	} catch {
		/* body already consumed or not readable — status alone is the error */
	}
	if (detail.length > MAX_PUSH_ERROR_CHARS) detail = `${detail.slice(0, MAX_PUSH_ERROR_CHARS)}…`;
	return detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`;
}

type BatchOutcome =
	/** Collector accepted every entry. */
	| { kind: "sent" }
	/** Collector refused the payload; retrying the same bytes is pointless. */
	| { kind: "rejected"; error: string }
	/** Transient failure (network, 5xx, rate limit, auth) — try again later. */
	| { kind: "retry"; error: string };

async function performFlush(db: Database, config: PushConfig, options: FlushOptions = {}): Promise<FlushResult> {
	const selectStmt = db.prepare(
		"SELECT id, model, version, tool, report FROM grievances WHERE pushed = 0 ORDER BY id ASC LIMIT ?",
	);
	// Planning snapshot — fires once so progress reporters can size their bar.
	// Mid-flight inserts are NOT folded in (the worker drains them too, but
	// the progress bar treats the initial backlog as the denominator).
	if (options.onStart) {
		const totalRow = db.prepare("SELECT COUNT(*) AS n FROM grievances WHERE pushed = 0").get() as { n: number };
		options.onStart(totalRow.n);
	}
	const fetchImpl = options.fetch ?? fetch;
	let totalPushed = 0;
	let totalRejected = 0;
	let lastError: string | undefined;

	const postBatch = async (batch: GrievanceRow[]): Promise<BatchOutcome> => {
		const body = JSON.stringify({
			agent: { name: "omp", version: VERSION },
			installId: getInstallId(),
			// Coarse host fingerprint for triage — `darwin`/`linux`/`win32` +
			// `arm64`/`x64`. Useful for "is this bug arch-specific?" without
			// leaking the user's machine name.
			platform: process.platform,
			arch: process.arch,
			// Clamped on the way out so rows recorded before the record-time
			// clamp existed still ship instead of poisoning every batch.
			entries: batch.map(row => ({ ...row, ...clampGrievance(row.tool, row.report) })),
		});
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (config.token) headers.authorization = `Bearer ${config.token}`;

		let response: Response;
		try {
			response = await fetchImpl(config.endpoint, {
				method: "POST",
				headers,
				body,
				signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
			});
		} catch (error) {
			return { kind: "retry", error: String(error) };
		}
		if (response.ok) return { kind: "sent" };
		const error = await describeErrorResponse(response);
		// 400/413/422 mean the payload itself is unacceptable — retrying the same
		// bytes can only fail again. 5xx, 408, 429 and auth failures (401/403) say
		// nothing about the rows, so they stay retryable.
		const status = response.status;
		const permanent = status === 400 || status === 413 || status === 422;
		return permanent ? { kind: "rejected", error } : { kind: "retry", error };
	};

	/**
	 * Ship one batch, bisecting on payload rejections until the offending rows
	 * are isolated and parked. `false` means a transient failure — the caller
	 * stops the flush and leaves everything queued for the next attempt.
	 */
	const shipBatch = async (batch: GrievanceRow[]): Promise<boolean> => {
		const outcome = await postBatch(batch);
		if (outcome.kind === "sent") {
			const ids = batch.map(r => r.id);
			const placeholders = ids.map(() => "?").join(",");
			db.prepare(`UPDATE grievances SET pushed = 1 WHERE id IN (${placeholders})`).run(...ids);
			totalPushed += batch.length;
			options.onProgress?.(totalPushed);
			return true;
		}
		lastError = outcome.error;
		if (outcome.kind === "retry") return false;
		if (batch.length === 1) {
			const row = batch[0];
			if (!row) return true;
			db.prepare("UPDATE grievances SET pushed = -1, push_error = ? WHERE id = ?").run(outcome.error, row.id);
			totalRejected += 1;
			logger.warn("autoqa grievance rejected", {
				endpoint: config.endpoint,
				id: row.id,
				tool: row.tool,
				error: outcome.error,
			});
			return true;
		}
		const mid = Math.floor(batch.length / 2);
		return (await shipBatch(batch.slice(0, mid))) && (await shipBatch(batch.slice(mid)));
	};

	let ok = true;
	for (;;) {
		const rows = selectStmt.all(FLUSH_BATCH_SIZE) as GrievanceRow[];
		if (rows.length === 0) break;
		if (!(await shipBatch(rows))) {
			lastFailureAt = Date.now();
			logger.warn("autoqa push failed", {
				endpoint: config.endpoint,
				error: lastError,
				batchSize: rows.length,
				pushedSoFar: totalPushed,
			});
			ok = false;
			break;
		}
	}
	return {
		pushed: totalPushed,
		ok,
		...(totalRejected > 0 ? { rejected: totalRejected } : {}),
		...(lastError ? { error: lastError } : {}),
	};
}

/**
 * Flush queued grievances to the configured backend.
 */
export async function flushGrievances(
	db?: Database,
	settings?: Settings,
	options: FlushOptions = {},
): Promise<FlushResult> {
	const config = resolvePushConfig(settings, options.bypassConsent === true);
	if (!config) return { pushed: 0, ok: false, skipped: true };

	const bypass = options.bypassConsent === true;
	if (!bypass && inFlightFlush) return inFlightFlush;

	if (!bypass && lastFailureAt > 0 && Date.now() - lastFailureAt < FAILURE_COOLDOWN_MS) {
		return { pushed: 0, ok: false, skipped: true };
	}

	const handle = db ?? openAutoQaDb();
	if (!handle) return { pushed: 0, ok: false, skipped: true };

	const promise = (async () => {
		try {
			return await performFlush(handle, config, options);
		} catch (error) {
			lastFailureAt = Date.now();
			logger.warn("autoqa push failed", { endpoint: config.endpoint, error: String(error) });
			return { pushed: 0, ok: false };
		}
	})();

	if (!bypass) inFlightFlush = promise;
	try {
		return await promise;
	} finally {
		if (!bypass) inFlightFlush = null;
	}
}

/**
 * Execute `write xd://report_issue`.
 *
 * The first line names the tool. The remaining Markdown MUST contain every
 * section in {@link REPORT_ISSUE_REQUIRED_SECTIONS}.
 */
export async function dispatchReportIssueDevice(
	session: ToolSession,
	text: string,
	options: ReportIssueDispatchOptions = {},
): Promise<{ result: AgentToolResult<unknown>; xdev: XdevDispatch }> {
	const trimmed = text.trim();
	if (!isAutoQaEnabled(session.settings)) {
		return {
			result: { content: [{ type: "text", text: "Issue reporting is disabled." }] },
			xdev: { tool: REPORT_ISSUE_DEVICE_NAME, mode: "execute", args: { report: trimmed } },
		};
	}
	const { tool, report } = parseReportIssueBody(trimmed);
	const issuePath = writeReportIssueFile(session, tool, report, options);
	return {
		result: { content: [{ type: "text", text: `Saved issue report to ${issuePath}` }] },
		xdev: { tool: REPORT_ISSUE_DEVICE_NAME, mode: "execute", args: { report: trimmed, path: issuePath } },
	};
}
