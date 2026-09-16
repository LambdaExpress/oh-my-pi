import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installRuntimeModuleResolver, resolveFileRequest, resolveRuntimeModule } from "@oh-my-pi/pi-utils";

/** `<scheme>:` specifiers — `node:`, `bun:`, `file:`, `data:` — never hit the filesystem walk. */
const PROTOCOL_SPECIFIER_RE = /^[a-z][a-z0-9+.-]*:/i;
const NODE_MODULES_DIR = "node_modules";
/** Extension-less bases (a session cwd, a package directory) resolve through a pseudo-file, the way `require` does. */
const EVAL_BASE_FILE = "[eval]";

/** True for `./x`, `../x`, `/x`, `D:\x` — as opposed to bare package names and protocols. */
function isFileRequest(request: string): boolean {
	if (PROTOCOL_SPECIFIER_RE.test(request)) return false;
	return (
		path.isAbsolute(request) ||
		request.startsWith("./") ||
		request.startsWith("../") ||
		request === "." ||
		request === ".." ||
		request.startsWith("~/")
	);
}

/**
 * Module resolution for the JavaScript eval kernel.
 *
 * A compiled omp binary cannot resolve bare specifiers against on-disk
 * `node_modules` trees — Bun's runtime resolver anchors to the embedded bundle
 * (oven-sh/bun#1763, #25500) — so `require("pkg")`, `createRequire(base)("pkg")`
 * and a package's own `require("dep")` all fail with "Cannot find module"
 * inside cells that are otherwise Node-compatible. The kernel therefore
 * supplies the missing half:
 *
 * - {@link registerFor} registers every `node_modules` root above a file or
 *   directory with the shared runtime resolver, which fixes the *nested* bare
 *   requires that run inside packages handed to Bun.
 * - {@link resolveBare}/{@link createRequire} resolve against those same roots,
 *   so cells never depend on the stock resolver succeeding.
 *
 * Registration installs a process-wide resolver patch, so it is limited to the
 * worker's isolated subprocess: in a Worker thread or the inline fallback the
 * patch would leak into the host process, where extensions rely on the stock
 * `createRequire` behavior.
 */
export class KernelModuleResolution {
	#patchGlobalResolver: boolean;
	#registeredRoots = new Set<string>();
	#rootsByStart = new Map<string, string[]>();
	#uninstallers: Array<() => void> = [];

	constructor(options: { patchGlobalResolver: boolean }) {
		this.#patchGlobalResolver = options.patchGlobalResolver;
	}

	/** `node_modules` roots reachable from a file or directory, nearest first. */
	#rootsFor(startPath: string): string[] {
		const start = path.resolve(startPath);
		const cached = this.#rootsByStart.get(start);
		if (cached) return cached;
		const roots: string[] = [];
		let dir = path.extname(start) ? path.dirname(start) : start;
		for (;;) {
			roots.push(path.basename(dir) === NODE_MODULES_DIR ? dir : path.join(dir, NODE_MODULES_DIR));
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
		this.#rootsByStart.set(start, roots);
		return roots;
	}

	/**
	 * Teach the runtime resolver every `node_modules` root above `startPath` so
	 * packages loaded from there can resolve their own dependencies. Idempotent
	 * per root and a no-op when the process-wide patch is not installed.
	 */
	registerFor(startPath: string): void {
		if (!this.#patchGlobalResolver) return;
		for (const root of this.#rootsFor(startPath)) {
			if (this.#registeredRoots.has(root) || !fs.existsSync(root)) continue;
			this.#registeredRoots.add(root);
			this.#uninstallers.push(installRuntimeModuleResolver({ runtimeNodeModules: root }));
		}
	}

	/** Resolve a bare specifier against the `node_modules` chain above `baseDir`. */
	resolveBare(baseDir: string, specifier: string): string | null {
		if (!specifier || PROTOCOL_SPECIFIER_RE.test(specifier) || isFileRequest(specifier)) return null;
		for (const root of this.#rootsFor(baseDir)) {
			const resolved = resolveRuntimeModule(root, specifier);
			if (resolved) return resolved;
		}
		return null;
	}

	/** Absolute path for a relative or absolute file request, or null when nothing matches. */
	resolveFile(basePathOrUrl: string, request: string): string | null {
		const base = basePathOrUrl.startsWith("file://") ? fileURLToPath(basePathOrUrl) : path.resolve(basePathOrUrl);
		return resolveFileRequest(base, request);
	}

	/**
	 * Node-compatible `require` bound to `basePathOrUrl` (a file, directory, or
	 * `file://` URL, as a string or `URL`).
	 *
	 * With the runtime resolver patch installed, `createRequire`-made requests
	 * reach it without a requester context, so relative requests cannot resolve at
	 * all: the wrapper turns those into absolute paths first (which the stock
	 * resolver still handles) and resolves bare specifiers against the on-disk
	 * roots, instead of relying on the patch's own fallback ordering.
	 */
	createRequire(basePathOrUrl: string | URL): NodeJS.Require {
		const base =
			basePathOrUrl instanceof URL
				? fileURLToPath(basePathOrUrl)
				: basePathOrUrl.startsWith("file://")
					? fileURLToPath(basePathOrUrl)
					: path.resolve(basePathOrUrl);
		this.registerFor(base);
		const baseFile = path.extname(base) ? base : path.join(base, EVAL_BASE_FILE);
		const native = createRequire(pathToFileURL(baseFile).href);
		if (!this.#patchGlobalResolver) return native;
		const lookup = (request: string): string | null =>
			isFileRequest(request) ? this.resolveFile(base, request) : this.resolveBare(path.dirname(base), request);
		const require = ((request: string) => native(lookup(request) ?? request)) as NodeJS.Require;
		const resolve = ((request: string, options?: { paths?: string[] }) =>
			lookup(request) ?? native.resolve(request, options)) as NodeJS.Require["resolve"] & {
			paths(request: string): string[] | null;
		};
		resolve.paths = request => native.resolve.paths(request);
		Object.defineProperties(require, {
			resolve: { value: resolve, configurable: true },
			cache: { get: () => native.cache, configurable: true },
			extensions: { get: () => native.extensions, configurable: true },
			main: { get: () => native.main, configurable: true },
		});
		return require;
	}

	/**
	 * The `node:module` surface with `createRequire` replaced by
	 * {@link createRequire}; every other export is re-exported verbatim. Cells
	 * reach for `createRequire` on this module far more often than for the rest of
	 * its surface, and the stock factory cannot resolve workspace packages here.
	 */
	shimNodeModule<T extends object>(namespace: T): T {
		return { ...namespace, createRequire: (base: string | URL) => this.createRequire(base) } as T;
	}

	/** Drop every resolver root this kernel registered. */
	dispose(): void {
		for (const uninstall of this.#uninstallers.splice(0)) uninstall();
		this.#registeredRoots.clear();
		this.#rootsByStart.clear();
	}
}
