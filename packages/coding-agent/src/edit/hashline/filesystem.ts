/**
 * Coding-agent specific {@link Filesystem} adapter for the hashline patcher.
 *
 * Wires hashline's storage abstraction to the agent runtime:
 *
 * - Section paths are resolved through the plan-mode redirect so a bare
 *   `PLAN.md` lands at the canonical session artifact location.
 * - Reads go through `readEditFileText` (notebook-aware) and the
 *   auto-generated-file guard.
 * - Writes go through `serializeEditFileText` (notebook-aware) and the
 *   LSP writethrough, with FS-scan cache invalidation on success. The
 *   resulting `FileDiagnosticsResult` is captured per-path so the
 *   orchestrator can attach it to the tool result.
 *
 * Construct one per `executeHashlineSingle` call: per-section state
 * (batch request, diagnostics) lives on the instance and isn't safe to
 * share across concurrent edit tools.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Filesystem, NotFoundError, type PreflightWriteOptions, type WriteResult } from "@oh-my-pi/hashline";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { type InternalUrl, InternalUrlRouter, type ProtocolHandler, parseInternalUrl } from "../../internal-urls";
import type { FileDiagnosticsResult, WritethroughCallback, WritethroughDeferredHandle } from "../../lsp";
import { FileChangeType, notifyWorkspaceWatchedFiles } from "../../lsp/client";
import type { ToolSession } from "../../tools";
import { routeWriteThroughBridge } from "../../tools/acp-bridge";
import { assertEditableFileContent } from "../../tools/auto-generated-guard";
import { invalidateFsScanAfterWrite } from "../../tools/fs-cache-invalidation";
import { isInternalUrlPath, peelWholeFileUrlSelector } from "../../tools/path-utils";
import {
	enforcePlanModeWrite,
	resolvePlanPath,
	targetsLocalSandbox,
	unwrapHashlineHeaderPath,
} from "../../tools/plan-mode-guard";
import { canonicalSnapshotKey } from "../file-snapshot-store";
import { isNotebookPath } from "../notebook";
import { readEditFileText, serializeEditFileText } from "../read-file";
import type { LspBatchRequest } from "../renderer";

type SshEditProtocolHandler = ProtocolHandler &
	Required<Pick<ProtocolHandler, "write" | "delete" | "move" | "stat" | "canonicalKey">>;

type ResolvedEditTarget =
	| { kind: "local"; authoredPath: string; absolutePath: string; canonicalPath: string }
	| {
			kind: "ssh";
			authoredPath: string;
			parsed: InternalUrl;
			canonicalPath: string;
			handler: SshEditProtocolHandler;
	  };

function hasSshEditCapabilities(handler: ProtocolHandler | undefined): handler is SshEditProtocolHandler {
	return Boolean(handler?.write && handler.delete && handler.move && handler.stat && handler.canonicalKey);
}
export interface HashlineFilesystemOptions {
	session: ToolSession;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
	signal?: AbortSignal;
	/**
	 * Outer LSP batch request inherited from the tool-call context. The
	 * orchestrator narrows this per-section (flush only on the final write)
	 * via {@link HashlineFilesystem.setBatchRequest}.
	 */
	batchRequest?: LspBatchRequest;
}

export class HashlineFilesystem extends Filesystem {
	readonly session: ToolSession;
	readonly #writethrough: WritethroughCallback;
	readonly #beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
	readonly #signal: AbortSignal | undefined;
	#batchRequest: LspBatchRequest | undefined;
	#diagnosticsByPath = new Map<string, FileDiagnosticsResult | undefined>();

	constructor(options: HashlineFilesystemOptions) {
		super();
		this.session = options.session;
		this.#writethrough = options.writethrough;
		this.#beginDeferredDiagnosticsForPath = options.beginDeferredDiagnosticsForPath;
		this.#signal = options.signal;
		this.#batchRequest = options.batchRequest;
	}

	async #sshContext() {
		return {
			cwd: this.session.cwd,
			signal: this.#signal,
			sshHosts: await this.session.getSessionSshHosts?.(),
		};
	}

	/**
	 * Set the LSP batch request used for the next {@link writeText} call.
	 * Multi-section orchestrators flip the `flush` flag to true before the
	 * final section so LSP diagnostics flush in one round-trip.
	 */
	setBatchRequest(batchRequest: LspBatchRequest | undefined): void {
		this.#batchRequest = batchRequest;
	}

	/**
	 * Look up (and clear) the diagnostics captured by the most-recent
	 * {@link writeText} call for `path`. Returns `undefined` if no write
	 * has happened or the writethrough returned no diagnostics.
	 */
	consumeDiagnostics(path: string): FileDiagnosticsResult | undefined {
		const value = this.#diagnosticsByPath.get(path);
		this.#diagnosticsByPath.delete(path);
		return value;
	}

	#resolveEditTarget(authoredPath: string): ResolvedEditTarget {
		const unwrappedPath = unwrapHashlineHeaderPath(authoredPath);
		if (!/^ssh:\/\//i.test(unwrappedPath.trim())) {
			const absolutePath = resolvePlanPath(this.session, authoredPath);
			return {
				kind: "local",
				authoredPath,
				absolutePath,
				canonicalPath: canonicalSnapshotKey(absolutePath),
			};
		}

		const wholeFilePath = peelWholeFileUrlSelector(unwrappedPath, "edit");
		const parsed = parseInternalUrl(wholeFilePath);
		const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
		if (scheme !== "ssh") {
			throw new Error(`Cannot edit non-SSH internal URL through SSH path resolver: ${authoredPath}`);
		}
		const handler = InternalUrlRouter.instance().getHandler("ssh");
		if (!hasSshEditCapabilities(handler)) {
			throw new Error(
				"ssh:// edit requires a protocol handler with resolve, write, delete, move, stat, and canonicalKey",
			);
		}
		return {
			kind: "ssh",
			authoredPath: wholeFilePath,
			parsed,
			canonicalPath: handler.canonicalKey(parsed),
			handler,
		};
	}

	resolveAbsolute(relativePath: string): string {
		const target = this.#resolveEditTarget(relativePath);
		return target.kind === "ssh" ? target.canonicalPath : target.absolutePath;
	}

	override canonicalPath(relativePath: string): string {
		return this.#resolveEditTarget(relativePath).canonicalPath;
	}

	override allowTagPathRecovery(authoredPath: string, resolvedPath: string): boolean {
		const unwrappedAuthoredPath = unwrapHashlineHeaderPath(authoredPath);
		const authoredTargetsSsh = /^ssh:\/\//i.test(unwrappedAuthoredPath.trim());
		const resolvedTargetsSsh = /^ssh:\/\//i.test(resolvedPath.trim());
		if (authoredTargetsSsh || resolvedTargetsSsh) {
			if (!authoredTargetsSsh || !resolvedTargetsSsh) return false;
			try {
				const authoredTarget = this.#resolveEditTarget(authoredPath);
				const resolvedTarget = this.#resolveEditTarget(resolvedPath);
				if (authoredTarget.kind !== "ssh" || resolvedTarget.kind !== "ssh") return false;
				const authoredAuthority = /^ssh:\/\/([^/?#]*)/i.exec(authoredTarget.canonicalPath)?.[1];
				const resolvedAuthority = /^ssh:\/\/([^/?#]*)/i.exec(resolvedTarget.canonicalPath)?.[1];
				return authoredAuthority !== undefined && authoredAuthority === resolvedAuthority;
			} catch {
				return false;
			}
		}
		// Internal-URL authored targets (`local://`, `vault://`, …) are approved
		// at the lower "read" privilege; never let one redirect onto a "write".
		if (isInternalUrlPath(unwrappedAuthoredPath)) return false;
		// Recovery rebinds a bare/mis-typed authored path onto the file its
		// snapshot tag uniquely names. Confine the redirect to locations a plain
		// "write" may legitimately target:
		//  1. the working tree (the model dropped the directory), or
		//  2. the session `local://` sandbox where plan/scratch artifacts live —
		//     the snapshot tag proves the model wrote/read that exact file this
		//     session, so a bare `plan.md#tag` should land on `local://plan.md`.
		// The secret vault and any other out-of-tree path stay refused.
		const root = canonicalSnapshotKey(this.session.cwd);
		if (resolvedPath === root || resolvedPath.startsWith(`${root}${path.sep}`)) return true;
		return targetsLocalSandbox(this.session, resolvedPath);
	}

	async readText(relativePath: string): Promise<string> {
		const target = this.#resolveEditTarget(relativePath);
		if (target.kind === "ssh") {
			const context = await this.#sshContext();
			const kind = await target.handler.stat(target.parsed, context);
			if (kind === "missing") throw new NotFoundError(relativePath);
			if (kind === "directory") throw new Error(`Cannot edit remote directory: ${relativePath}`);
			if (kind === "other") throw new Error(`Cannot edit remote special file: ${relativePath}`);
			const resource = await target.handler.resolve(target.parsed, context);
			if (resource.isDirectory) throw new Error(`Cannot edit remote directory: ${relativePath}`);
			if (resource.immutable) throw new Error(`Cannot edit immutable remote resource: ${relativePath}`);
			assertEditableFileContent(resource.content, relativePath);
			return resource.content;
		}

		let content: string;
		try {
			content = await readEditFileText(target.absolutePath, relativePath);
		} catch (error) {
			if (isEnoent(error)) throw new NotFoundError(relativePath, error);
			if (error instanceof Error && error.message === `File not found: ${relativePath}`) {
				throw new NotFoundError(relativePath, error);
			}
			throw error;
		}
		// Refuse edits against generated files (lockfiles, models.json, …).
		assertEditableFileContent(content, relativePath, this.session.settings);
		return content;
	}

	override async readBinary(relativePath: string): Promise<Uint8Array | undefined> {
		const target = this.#resolveEditTarget(relativePath);
		if (target.kind === "ssh") return undefined;
		if (isNotebookPath(target.absolutePath)) return undefined;
		try {
			return await fs.readFile(target.absolutePath);
		} catch (error) {
			if (isEnoent(error)) throw new NotFoundError(relativePath, error);
			throw error;
		}
	}

	override async preflightWrite(relativePath: string, options?: PreflightWriteOptions): Promise<void> {
		const fileOp = options?.fileOp;
		if (fileOp?.kind === "rem") {
			enforcePlanModeWrite(this.session, relativePath, { op: "delete" });
			return;
		}
		if (fileOp?.kind === "move") {
			enforcePlanModeWrite(this.session, relativePath, { op: "update", move: fileOp.dest });
			return;
		}
		enforcePlanModeWrite(this.session, relativePath, { op: "update" });
	}

	override async delete(relativePath: string): Promise<void> {
		const target = this.#resolveEditTarget(relativePath);
		if (target.kind === "ssh") {
			enforcePlanModeWrite(this.session, relativePath, { op: "delete" });
			await target.handler.delete(target.parsed, await this.#sshContext());
			return;
		}
		enforcePlanModeWrite(this.session, relativePath, { op: "delete" });
		try {
			await fs.rm(target.absolutePath);
		} catch (error) {
			if (isEnoent(error)) throw new NotFoundError(relativePath, error);
			throw error;
		}
		if (this.session.enableLsp ?? true) {
			await notifyWorkspaceWatchedFiles(
				this.session.cwd,
				[{ filePath: target.absolutePath, type: FileChangeType.Deleted }],
				this.#signal,
			);
		}
		invalidateFsScanAfterWrite(target.absolutePath);
	}

	override async move(fromRelative: string, toRelative: string, content?: string): Promise<void> {
		const fromTarget = this.#resolveEditTarget(fromRelative);
		const toTarget = this.#resolveEditTarget(toRelative);
		if (fromTarget.kind === "ssh" || toTarget.kind === "ssh") {
			if (fromTarget.kind !== "ssh" || toTarget.kind !== "ssh") {
				throw new Error("Remote MV destination must be a full ssh://same-authority/<absolute-path> URL");
			}
			enforcePlanModeWrite(this.session, fromRelative, { op: "update", move: toRelative });
			await fromTarget.handler.move(fromTarget.parsed, toTarget.parsed, content, await this.#sshContext());
			this.#diagnosticsByPath.set(fromRelative, undefined);
			return;
		}
		enforcePlanModeWrite(this.session, fromRelative, { op: "update", move: toRelative });
		if (content !== undefined) {
			await Bun.write(toTarget.absolutePath, content);
			await fs.rm(fromTarget.absolutePath);
		} else {
			await fs.rename(fromTarget.absolutePath, toTarget.absolutePath);
		}
		if (this.session.enableLsp ?? true) {
			await notifyWorkspaceWatchedFiles(
				this.session.cwd,
				[
					{ filePath: fromTarget.absolutePath, type: FileChangeType.Deleted },
					{ filePath: toTarget.absolutePath, type: FileChangeType.Created },
				],
				this.#signal,
			);
		}
		invalidateFsScanAfterWrite(fromTarget.absolutePath);
		invalidateFsScanAfterWrite(toTarget.absolutePath);
	}

	async writeText(relativePath: string, content: string): Promise<WriteResult> {
		const target = this.#resolveEditTarget(relativePath);
		if (target.kind === "ssh") {
			enforcePlanModeWrite(this.session, relativePath, { op: "update" });
			await target.handler.write(target.parsed, content, await this.#sshContext());
			this.#diagnosticsByPath.set(relativePath, undefined);
			return { text: content };
		}

		await this.preflightWrite(relativePath);
		const finalContent = await serializeEditFileText(target.absolutePath, relativePath, content);

		// Route through ACP bridge when available; skips internal artifacts.
		// `finalContent` is storage-space (e.g. a notebook's full JSON); the
		// bridge may also report content that diverges from it (e.g. the
		// client reformatted on save). `WriteResult.text` must stay in
		// view-space — the same space `readText` returns — so a follow-up
		// `readText` sees exactly what this write reports.
		const bridgeResult = await routeWriteThroughBridge(
			this.session,
			relativePath,
			target.absolutePath,
			finalContent,
			this.#signal,
		);
		if (bridgeResult) {
			this.#diagnosticsByPath.set(relativePath, undefined);
			if (!bridgeResult.driftedFromRequest) {
				// No client-side transform: the view we sent is what's on disk.
				return { text: content };
			}
			// Drifted (e.g. format-on-save): re-derive the view from what
			// actually landed on disk instead of assuming `content` still
			// matches. Falls back to `content` if the drifted file can't be
			// re-read as a valid view (e.g. a formatter broke notebook JSON).
			try {
				return { text: await readEditFileText(target.absolutePath, relativePath) };
			} catch {
				return { text: content };
			}
		}

		const diagnostics = await this.#writethrough(
			target.absolutePath,
			finalContent,
			this.#signal,
			Bun.file(target.absolutePath),
			this.#batchRequest,
			dst => (dst === target.absolutePath ? this.#beginDeferredDiagnosticsForPath(target.absolutePath) : undefined),
		);
		invalidateFsScanAfterWrite(target.absolutePath);
		this.#diagnosticsByPath.set(relativePath, diagnostics);
		return { text: content };
	}

	override async exists(relativePath: string): Promise<boolean> {
		const target = this.#resolveEditTarget(relativePath);
		if (target.kind === "ssh") {
			const kind = await target.handler.stat(target.parsed, await this.#sshContext());
			return kind !== "missing";
		}
		return Bun.file(target.absolutePath).exists();
	}
}
