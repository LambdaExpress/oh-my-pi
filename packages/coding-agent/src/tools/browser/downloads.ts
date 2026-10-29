import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hasFsCode, isEnoent, toError, untilAborted } from "@oh-my-pi/pi-utils";
import type { Browser, Connection, Page } from "puppeteer-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { replaceFileAcrossDevices, replaceFileAtomically } from "../../utils/atomic-file";
import { devtoolsFrameId } from "./frames";

/** Completed download metadata returned by tab download helpers. */
export interface BrowserDownload {
	path: string;
	suggestedFilename: string;
	url: string;
	bytes: number;
}

interface DownloadStarted {
	guid: string;
	url: string;
	suggestedFilename: string;
}

interface DownloadProgress {
	guid: string;
	state: "inProgress" | "completed" | "canceled";
	receivedBytes: number;
	/** Saved location on completion, in the context's staging or user-driven browser folder. */
	filePath?: string;
}

interface PendingDownload extends DownloadStarted {
	receivedBytes: number;
}

interface DownloadWaiter {
	resolve(value: BrowserDownload): void;
	reject(error: unknown): void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

/** Chromium names an `allowAndName` download after its GUID, a lowercase UUID. */
const DOWNLOAD_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Owns tab-scoped destinations and browser-context-wide Chromium download events. */
export class DownloadManager {
	readonly #page: Page;
	readonly #defaultDirectory: string;
	readonly #perTab: boolean;
	readonly #stagingDirectory?: string;
	#directory?: string;
	#arming?: Promise<void>;
	#connection?: Connection;
	#trackingError?: ToolError;
	#inventoryError?: ToolError;
	readonly #completing = new Set<Promise<void>>();
	readonly #pending = new Map<string, PendingDownload>();
	readonly #completed: BrowserDownload[] = [];
	readonly #unclaimed: BrowserDownload[] = [];
	readonly #waiters: DownloadWaiter[] = [];
	#willBegin?: (event: DownloadStarted & { frameId: string }) => void;
	#progress?: (event: DownloadProgress) => void;

	/**
	 * `perTab` stages downloads under GUIDs outside every tab's destination and moves only each tab's completed files.
	 * Leave it off for a browser the user drives (connected, relay): there the folder also receives the user's own
	 * downloads, which would otherwise be saved under bare GUIDs nobody renames.
	 */
	constructor(browser: Browser, page: Page, tabId: string, options: { perTab: boolean }) {
		this.#page = page;
		this.#defaultDirectory = path.join(os.tmpdir(), `omp-downloads-${tabId}`);
		this.#perTab = options.perTab;
		if (this.#perTab) {
			// Workers have separate JS heaps but share Chromium's context-wide download behavior. They must all point
			// it at the same staging folder; selecting a tab's final folder also puts other tabs' live .crdownload
			// files there. Include the context identity so independent contexts do not share staging.
			const context = page.browserContext() as { id?: string };
			const key = createHash("sha256")
				.update(JSON.stringify([browser.wsEndpoint(), context.id ?? null]))
				.digest("hex");
			this.#stagingDirectory = path.join(os.tmpdir(), `omp-download-staging-${key}`);
		}
	}

	/** Arm inventory before page code can download; unsupported attached browsers remain usable for other operations. */
	async start(directory?: string): Promise<void> {
		try {
			await this.enable(directory);
		} catch (error) {
			this.#trackingError = new ToolError(
				`Download tracking is unavailable on this browser connection: ${toError(error).message}. Native downloads may still succeed, but tab.downloads() cannot inventory them.`,
			);
		}
	}

	/**
	 * Owned tabs share a private GUID staging folder. User-driven tabs without an explicit destination keep
	 * Chrome's native download behavior and directory; subscribing must not redirect the user's downloads.
	 */
	async enable(directory?: string): Promise<void> {
		if (this.#trackingError) throw this.#trackingError;
		const resolved =
			directory === undefined && !this.#perTab ? undefined : path.resolve(directory ?? this.#defaultDirectory);
		const staging = this.#stagingDirectory ?? resolved;
		if (resolved) await fs.mkdir(resolved, { recursive: true });
		if (staging && staging !== resolved) await fs.mkdir(staging, { recursive: true });
		const connection = this.#connection ?? (await this.#attach());
		const context = this.#page.browserContext() as { id?: string };
		await connection.send("Browser.setDownloadBehavior", {
			behavior: this.#perTab ? "allowAndName" : resolved ? "allow" : "default",
			...(staging ? { downloadPath: staging } : {}),
			eventsEnabled: true,
			...(context.id ? { browserContextId: context.id } : {}),
		});
		this.#directory = resolved;
	}

	/** Enabling started by a `wait()` that has not yet applied; settles once downloads are tracked. */
	get arming(): Promise<void> | undefined {
		return this.#arming;
	}

	/** Wait for the next unclaimed completed download. */
	async wait(signal?: AbortSignal): Promise<BrowserDownload> {
		if (signal?.aborted) throw signal.reason;
		if (this.#trackingError) throw this.#trackingError;
		if (this.#inventoryError) throw this.#inventoryError;
		if (this.#unclaimed.length === 0) {
			// A rejected `arming` nobody awaits would surface as an unhandled rejection.
			if (signal?.aborted) throw signal.reason;
			// Closing the last behavior override resets Chromium's folder, so re-enable tracking before each new wait.
			const arming = (this.#arming ??= this.enable(this.#directory).finally(() => {
				this.#arming = undefined;
			}));
			try {
				await untilAborted(signal, arming);
			} catch (error) {
				// Abort with the caller's reason, as the waits below do.
				if (signal?.aborted) throw signal.reason;
				throw error;
			}
		}
		const ready = this.#unclaimed.shift();
		if (ready) return { ...ready };
		if (signal?.aborted) throw signal.reason;
		return await new Promise<BrowserDownload>((resolve, reject) => {
			const waiter: DownloadWaiter = { resolve, reject, signal };
			if (signal) {
				waiter.onAbort = () => {
					this.#removeWaiter(waiter);
					reject(signal.reason);
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			this.#waiters.push(waiter);
		});
	}

	/** Return every completed download for this tab. */
	async list(): Promise<BrowserDownload[]> {
		if (this.#trackingError) throw this.#trackingError;
		await Promise.all(this.#completing);
		if (this.#inventoryError) throw this.#inventoryError;
		return this.#completed.map(download => ({ ...download }));
	}

	/** Detach event listeners and reject outstanding waits. */
	async close(): Promise<void> {
		const connection = this.#connection;
		if (!connection) return;
		if (this.#willBegin) connection.off("Browser.downloadWillBegin", this.#willBegin);
		if (this.#progress) connection.off("Browser.downloadProgress", this.#progress);
		for (const waiter of this.#waiters.splice(0)) {
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.reject(new ToolError("Tab closed while waiting for a download"));
		}
		this.#connection = undefined;
	}

	async #attach(): Promise<Connection> {
		// Browser.download* events have no sessionId: Puppeteer dispatches them on Connection, not on a
		// Target.attachToTarget(browser) child CDPSession. Match BrowserContext.setDownloadBehavior's root
		// command path and subscribe there too. A temporary page session exposes the same worker connection
		// on both native CDP and relay transports; it owns neither the root connection nor its download events.
		const session = await this.#page.createCDPSession();
		let connection: Connection | undefined;
		try {
			connection = session.connection();
		} finally {
			await session.detach().catch(() => undefined);
		}
		if (!connection) throw new ToolError("The browser page has no root CDP connection for download tracking");
		this.#willBegin = event => {
			// Every session hears every download in the browser; keep the ones this tab's frames started.
			if (!this.#page.frames().some(frame => devtoolsFrameId(frame) === event.frameId)) return;
			this.#pending.set(event.guid, { ...event, receivedBytes: 0 });
		};
		this.#progress = event => {
			const pending = this.#pending.get(event.guid);
			if (!pending) return;
			pending.receivedBytes = event.receivedBytes;
			if (event.state === "inProgress") return;
			this.#pending.delete(event.guid);
			if (event.state === "canceled") {
				this.#rejectNext(new ToolError(`Download canceled: ${pending.url}`));
				return;
			}
			const completing = this.#complete(pending, event.filePath)
				.catch(error => {
					this.#inventoryError = new ToolError(`Download failed: ${pending.url}: ${toError(error).message}`);
					this.#rejectNext(this.#inventoryError);
				})
				.finally(() => this.#completing.delete(completing));
			this.#completing.add(completing);
		};
		connection.on("Browser.downloadWillBegin", this.#willBegin);
		connection.on("Browser.downloadProgress", this.#progress);
		this.#connection = connection;
		return connection;
	}

	async #complete(pending: PendingDownload, filePath: string | undefined): Promise<void> {
		if (!filePath && !this.#perTab) {
			throw new ToolError(
				"The browser completed a native download without exposing its saved path; download inventory is unsupported on this connection. Its path cannot be identified safely without inspecting the user's download directory.",
			);
		}
		const directory = this.#directory ?? this.#defaultDirectory;
		const source =
			filePath ??
			path.join(this.#stagingDirectory ?? directory, this.#perTab ? pending.guid : pending.suggestedFilename);
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				await fs.stat(source);
				break;
			} catch {
				await Bun.sleep(10);
			}
		}
		await fs.stat(source);
		const name = typeof pending.suggestedFilename === "string" ? path.basename(pending.suggestedFilename) : "";
		const target = path.join(directory, name);
		// Only the last segment of the suggested name is used; anything else, or a download that cannot be moved, is
		// reported where Chromium saved it.
		const movable =
			this.#perTab &&
			name !== "" &&
			name !== "." &&
			name !== ".." &&
			(await canMoveDownload(source, pending.guid, target));
		const downloadPath = movable
			? await moveDownload(source, target).then(
					() => target,
					() => source,
				)
			: source;
		const download: BrowserDownload = {
			path: downloadPath,
			suggestedFilename: pending.suggestedFilename,
			url: pending.url,
			bytes: pending.receivedBytes,
		};
		this.#completed.push(download);
		const waiter = this.#waiters.shift();
		if (!waiter) {
			this.#unclaimed.push(download);
			return;
		}
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
		waiter.resolve({ ...download });
	}

	#rejectNext(error: ToolError): void {
		const waiter = this.#waiters.shift();
		if (!waiter) return;
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
		waiter.reject(error);
	}

	#removeWaiter(waiter: DownloadWaiter): void {
		const index = this.#waiters.indexOf(waiter);
		if (index >= 0) this.#waiters.splice(index, 1);
	}
}

/**
 * Whether `source` is a regular file saved under a UUID-shaped download GUID, and `target` is free or a file it may
 * replace. The peer names the GUID, the saved path and the suggested name, so a symlink or directory stays where it is.
 */
async function canMoveDownload(source: string, guid: string, target: string): Promise<boolean> {
	if (!DOWNLOAD_GUID.test(guid) || path.basename(source) !== guid) return false;
	return (await entryKind(source)) === "file" && (await entryKind(target)) !== "other";
}

/** What a path names, without following a symlink there. */
async function entryKind(file: string): Promise<"file" | "missing" | "other"> {
	try {
		return (await fs.lstat(file)).isFile() ? "file" : "other";
	} catch (error) {
		return isEnoent(error) ? "missing" : "other";
	}
}

/** Move a completed download into a tab's folder, replacing a same-named file as Chromium's own saves do. */
async function moveDownload(source: string, target: string): Promise<void> {
	await fs.mkdir(path.dirname(target), { recursive: true });
	try {
		await replaceFileAtomically(source, target);
	} catch (error) {
		if (!hasFsCode(error, "EXDEV")) throw error;
		await replaceFileAcrossDevices(source, target);
	}
}
