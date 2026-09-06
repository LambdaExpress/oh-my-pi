import { isEnoent } from "@oh-my-pi/pi-utils";
import {
	type InternalUrl,
	InternalUrlRouter,
	type LocalProtocolOptions,
	type ProtocolHandler,
	parseInternalUrl,
	type ResolveContext,
	type WriteContext,
} from "../internal-urls";
import type { ToolSession } from "../tools";
import { assertEditableFile } from "../tools/auto-generated-guard";
import { isInternalUrlPath, peelWholeFileUrlSelector, resolveToCwd } from "../tools/path-utils";
import { enforcePlanModeWrite, resolvePlanPath, unwrapHashlineHeaderPath } from "../tools/plan-mode-guard";

export type EditTargetOperation = "create" | "delete" | "update";

export type EditTarget =
	| {
			kind: "local";
			requestedPath: string;
			absolutePath: string;
			displayPath: string;
			canonicalPath: string;
	  }
	| {
			kind: "internal";
			scheme: string;
			requestedPath: string;
			url: InternalUrl;
			handler: MutableEditProtocolHandler;
			canonicalPath: string;
			displayPath: string;
			observedKind?: "file" | "missing";
	  };

type InternalEditTarget = Extract<EditTarget, { kind: "internal" }>;

export interface EditTargetContext {
	cwd: string;
	signal?: AbortSignal;
	localProtocolOptions?: LocalProtocolOptions;
	sshHosts?: WriteContext["sshHosts"];
}

export interface ResolveEditTargetOptions {
	op?: EditTargetOperation;
	move?: string;
	signal?: AbortSignal;
	assertLocalEditable?: boolean;
	enforcePlanMode?: boolean;
	allowMissing?: boolean;
	context?: EditTargetContext;
}

export interface PreviewEditTargetOptions {
	op?: EditTargetOperation;
	move?: boolean;
	signal?: AbortSignal;
}

export interface EditTargetFileSystem {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	readBinary?: (path: string) => Promise<Uint8Array>;
	write(path: string, content: string): Promise<void>;
	delete(path: string): Promise<void>;
	mkdir(path: string): Promise<void>;
	move?: (fromPath: string, toPath: string, content: string | undefined) => Promise<void>;
}

export type MutableEditProtocolHandler = ProtocolHandler &
	Required<Pick<ProtocolHandler, "canonicalKey" | "stat">> & {
		write?: NonNullable<ProtocolHandler["write"]>;
		delete?: NonNullable<ProtocolHandler["delete"]>;
		move?: NonNullable<ProtocolHandler["move"]>;
	};

export interface EditVirtualResourceInput {
	canonicalUrl: string;
	displayUrl: string;
	content?: string;
}

export interface ResolvedEditVirtualResource {
	target: InternalEditTarget;
	resource: EditVirtualResourceInput;
}

export interface InternalEditWriteRequest {
	op: string;
	content?: string;
	moveTo?: string;
}

const LOCAL_BACKED_INTERNAL_SCHEMES = new Set(["local", "vault"]);
const encoder = new TextEncoder();

export function isHostBackedEditTargetPath(requestedPath: string): boolean {
	const unwrappedPath = unwrapHashlineHeaderPath(requestedPath);
	if (!isInternalUrlPath(unwrappedPath)) return false;
	const url = parseInternalUrl(peelWholeFileUrlSelector(unwrappedPath, "edit"));
	return !LOCAL_BACKED_INTERNAL_SCHEMES.has(normalizeScheme(url));
}

async function contextFromSession(session: ToolSession, signal?: AbortSignal): Promise<EditTargetContext> {
	return {
		cwd: session.cwd,
		signal,
		localProtocolOptions: session.localProtocolOptions,
		sshHosts: await session.getSessionSshHosts?.(),
	};
}

function resolveContext(context: EditTargetContext): ResolveContext {
	return {
		cwd: context.cwd,
		signal: context.signal,
		localProtocolOptions: context.localProtocolOptions,
		sshHosts: context.sshHosts,
	};
}

function writeContext(context: EditTargetContext): WriteContext {
	return {
		cwd: context.cwd,
		signal: context.signal,
		localProtocolOptions: context.localProtocolOptions,
		sshHosts: context.sshHosts,
	};
}

function normalizeScheme(url: InternalUrl): string {
	return url.protocol.replace(/:$/, "").toLowerCase();
}

function handlerSupportsOperation(
	handler: ProtocolHandler | undefined,
	op: EditTargetOperation,
	move: boolean,
): handler is MutableEditProtocolHandler {
	if (!handler?.canonicalKey || !handler.stat) return false;
	if (move) return Boolean(handler.move);
	if (op === "delete") return Boolean(handler.delete);
	return Boolean(handler.write);
}

function operationName(op: EditTargetOperation, move: boolean): string {
	if (move) return "move";
	return op === "create" ? "create" : op === "delete" ? "delete" : "update";
}

function mutableHandlerForTarget(
	scheme: string,
	op: EditTargetOperation,
	move: boolean,
	displayPath: string,
): MutableEditProtocolHandler {
	const handler = InternalUrlRouter.instance().getHandler(scheme);
	if (!handlerSupportsOperation(handler, op, move)) {
		throw new Error(
			`${scheme}:// edit ${operationName(op, move)} requires a protocol handler with resolve, stat, canonicalKey, and ${
				move ? "move" : op === "delete" ? "delete" : "write"
			}: ${displayPath}`,
		);
	}
	return handler;
}

function tryParseInternalEditTarget(
	requestedPath: string,
	op: EditTargetOperation,
	move: boolean,
): InternalEditTarget | undefined {
	const unwrappedPath = unwrapHashlineHeaderPath(requestedPath);
	if (!isInternalUrlPath(unwrappedPath)) return undefined;
	const wholeFilePath = peelWholeFileUrlSelector(unwrappedPath, "edit");
	const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(wholeFilePath)?.[1] ?? "";
	const userInfo = authority.includes("@") ? authority.slice(0, authority.lastIndexOf("@")) : "";
	if (userInfo.includes(":")) {
		throw new Error(
			"Internal edit resource URLs must not contain passwords; configure credentials on the host alias instead",
		);
	}
	const url = parseInternalUrl(wholeFilePath);
	if (url.password) {
		throw new Error(
			"Internal edit resource URLs must not contain passwords; configure credentials on the host alias instead",
		);
	}
	const scheme = normalizeScheme(url);
	if (LOCAL_BACKED_INTERNAL_SCHEMES.has(scheme)) return undefined;
	const handler = mutableHandlerForTarget(scheme, op, move, wholeFilePath);
	const canonicalPath = handler.canonicalKey(url);
	return {
		kind: "internal",
		scheme,
		requestedPath,
		url,
		handler,
		canonicalPath,
		displayPath: url.href,
	};
}

function classifyRemoteKind(kind: "directory" | "file" | "missing" | "other", displayPath: string): void {
	if (kind === "missing") throw new Error(`File not found: ${displayPath}`);
	if (kind === "directory") throw new Error(`Cannot edit remote directory: ${displayPath}`);
	if (kind === "other") throw new Error(`Cannot edit remote special file: ${displayPath}`);
}

async function readInternalTargetText(
	target: Extract<EditTarget, { kind: "internal" }>,
	context: EditTargetContext,
	knownKind?: "file",
): Promise<string> {
	if (!knownKind) {
		const kind = await target.handler.stat(target.url, resolveContext(context));
		classifyRemoteKind(kind, target.displayPath);
	}
	const resource = await target.handler.resolve(target.url, resolveContext(context));
	if (resource.isDirectory) throw new Error(`Cannot edit remote directory: ${target.displayPath}`);
	if (resource.immutable) throw new Error(`Cannot edit immutable remote resource: ${target.displayPath}`);
	// EditSession applies the native auto-generated-file guard when this content
	// is preloaded as a virtual resource.
	return resource.content;
}

async function preflightInternalTarget(
	target: Extract<EditTarget, { kind: "internal" }>,
	context: EditTargetContext,
	op: EditTargetOperation,
	allowMissing: boolean,
): Promise<"file" | "missing"> {
	const kind = await target.handler.stat(target.url, resolveContext(context));
	if (kind === "missing" && (op === "create" || allowMissing)) return "missing";
	classifyRemoteKind(kind, target.displayPath);
	return "file";
}

export async function resolveEditTarget(
	session: ToolSession,
	path: string,
	options: ResolveEditTargetOptions = {},
): Promise<EditTarget> {
	const op = options.op ?? "update";
	const internalTarget = tryParseInternalEditTarget(path, op, Boolean(options.move));
	if (options.enforcePlanMode !== false) {
		enforcePlanModeWrite(session, path, { op, move: options.move });
	}

	if (internalTarget) {
		const observedKind = await preflightInternalTarget(
			internalTarget,
			options.context ?? (await contextFromSession(session, options.signal)),
			op,
			options.allowMissing ?? false,
		);
		return { ...internalTarget, observedKind };
	}

	const absolutePath = resolvePlanPath(session, path);
	if (options.assertLocalEditable) {
		await assertEditableFile(absolutePath, path);
	}
	return {
		kind: "local",
		requestedPath: path,
		absolutePath,
		displayPath: path,
		canonicalPath: absolutePath,
	};
}

export async function resolveEditTargetForPreview(
	cwd: string,
	path: string,
	options: PreviewEditTargetOptions = {},
): Promise<EditTarget> {
	const op = options.op ?? "update";
	const internalTarget = tryParseInternalEditTarget(path, op, Boolean(options.move));
	if (internalTarget) {
		const observedKind = await preflightInternalTarget(internalTarget, { cwd, signal: options.signal }, op, false);
		return { ...internalTarget, observedKind };
	}
	const absolutePath = resolveToCwd(path, cwd);
	return {
		kind: "local",
		requestedPath: path,
		absolutePath,
		displayPath: path,
		canonicalPath: absolutePath,
	};
}

export async function readEditTargetText(target: EditTarget, context: EditTargetContext): Promise<string> {
	if (target.kind === "internal") {
		return readInternalTargetText(target, context);
	}
	try {
		return await Bun.file(target.absolutePath).text();
	} catch (error) {
		if (isEnoent(error)) throw new Error(`File not found: ${target.requestedPath}`);
		throw error;
	}
}

export async function readEditPreviewFileText(path: string, cwd: string, signal?: AbortSignal): Promise<string> {
	const target = await resolveEditTargetForPreview(cwd, path, { signal });
	return readEditTargetText(target, { cwd, signal });
}

export async function resolveEditVirtualResource(
	session: ToolSession,
	path: string,
	options: ResolveEditTargetOptions = {},
): Promise<ResolvedEditVirtualResource | undefined> {
	const context = options.context ?? (await contextFromSession(session, options.signal));
	const target = await resolveEditTarget(session, path, {
		...options,
		allowMissing: true,
		context,
	});
	if (target.kind === "local") return undefined;
	const content =
		target.observedKind === "missing" ? undefined : await readInternalTargetText(target, context, "file");
	return {
		target,
		resource: {
			canonicalUrl: target.canonicalPath,
			displayUrl: target.displayPath,
			content,
		},
	};
}

function protocolAuthority(target: InternalEditTarget): string {
	const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(target.canonicalPath);
	if (!match) throw new Error(`Invalid canonical internal edit URL: ${target.displayPath}`);
	return `${match[1].toLowerCase()}://${match[2]}`;
}

export async function applyInternalEditWrite(
	source: InternalEditTarget,
	request: InternalEditWriteRequest,
	context: EditTargetContext,
	destination?: InternalEditTarget,
): Promise<string> {
	if (request.op === "delete") {
		if (!source.handler.delete) throw new Error(`Cannot delete internal URL: ${source.displayPath}`);
		await source.handler.delete(source.url, writeContext(context));
		return "";
	}
	if (request.op === "move") {
		if (!destination || !request.moveTo) {
			throw new Error(`Internal edit move is missing a resolved destination: ${source.displayPath}`);
		}
		if (
			source.handler !== destination.handler ||
			source.scheme !== destination.scheme ||
			protocolAuthority(source) !== protocolAuthority(destination)
		) {
			throw new Error("Remote move destination must use the same protocol authority as the source");
		}
		if (!source.handler.move) throw new Error(`Cannot move internal URL: ${source.displayPath}`);
		await source.handler.move(source.url, destination.url, request.content, writeContext(context));
		return request.content ?? "";
	}
	if (request.op !== "create" && request.op !== "update") {
		throw new Error(`Unsupported internal edit operation: ${request.op}`);
	}
	if (request.content === undefined) {
		throw new Error(`Internal edit ${request.op} is missing content: ${source.displayPath}`);
	}
	if (!source.handler.write) throw new Error(`Cannot write internal URL: ${source.displayPath}`);
	await source.handler.write(source.url, request.content, writeContext(context));
	return request.content;
}

export function createInternalUrlEditFileSystem(
	targets: readonly Extract<EditTarget, { kind: "internal" }>[],
	context: EditTargetContext,
): InternalUrlEditFileSystem {
	return new InternalUrlEditFileSystem(targets, context);
}

export class InternalUrlEditFileSystem implements EditTargetFileSystem {
	readonly #targets = new Map<string, Extract<EditTarget, { kind: "internal" }>>();
	readonly #context: EditTargetContext;

	constructor(targets: readonly Extract<EditTarget, { kind: "internal" }>[], context: EditTargetContext) {
		for (const target of targets) {
			this.#targets.set(target.canonicalPath, target);
		}
		this.#context = context;
	}

	#target(path: string): Extract<EditTarget, { kind: "internal" }> {
		const target = this.#targets.get(path);
		if (!target) throw new Error(`No internal edit target registered for ${path}`);
		return target;
	}

	async exists(path: string): Promise<boolean> {
		const target = this.#target(path);
		const kind = await target.handler.stat(target.url, resolveContext(this.#context));
		return kind !== "missing";
	}

	async read(path: string): Promise<string> {
		return readInternalTargetText(this.#target(path), this.#context);
	}

	async readBinary(path: string): Promise<Uint8Array> {
		return encoder.encode(await this.read(path));
	}

	async write(path: string, content: string): Promise<void> {
		const target = this.#target(path);
		if (!target.handler.write) throw new Error(`Cannot write internal URL: ${target.displayPath}`);
		await target.handler.write(target.url, content, writeContext(this.#context));
	}

	async delete(path: string): Promise<void> {
		const target = this.#target(path);
		if (!target.handler.delete) throw new Error(`Cannot delete internal URL: ${target.displayPath}`);
		try {
			await target.handler.delete(target.url, writeContext(this.#context));
		} catch (error) {
			if (isEnoent(error)) throw new Error(`File not found: ${target.displayPath}`);
			throw error;
		}
	}

	async mkdir(_path: string): Promise<void> {
		// Remote parents are validated by the protocol handler/write backend.
	}

	async move(fromPath: string, toPath: string, content: string | undefined): Promise<void> {
		const from = this.#target(fromPath);
		const to = this.#target(toPath);
		if (from.scheme !== to.scheme || from.handler !== to.handler) {
			throw new Error("Remote move destination must use the same protocol handler as the source");
		}
		if (!from.handler.move) throw new Error(`Cannot move internal URL: ${from.displayPath}`);
		await from.handler.move(from.url, to.url, content, writeContext(this.#context));
	}
}
