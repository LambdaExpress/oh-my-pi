import * as fs from "node:fs";
import { isBuiltin } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as vm from "node:vm";
import { KernelModuleResolution } from "./module-resolution";
import { analyzeModuleSource, stripTypeScriptSyntax } from "./rewrite-imports";

interface LocalModuleEntry {
	version: number;
	identifier: string;
	module: vm.SourceTextModule;
	/** Memoized link+evaluate of this module as a graph root; set lazily by `#loadLocalModule`. */
	loaded?: Promise<void>;
}

export type LocalImportResolution = { mode: "local"; value: unknown } | { mode: "external"; target: string };

const LOCAL_MODULE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx", ".mts"]);
/** `node_modules` path segment in either separator spelling — resolution results mix `/` and `\` on Windows. */
const NODE_MODULES_SEGMENT_RE = /(?:^|[\\/])node_modules(?:[\\/]|$)/;

export class LocalModuleLoader {
	#context: vm.Context;
	#sessionTag: string;
	#resolution: KernelModuleResolution;
	#moduleMtimes = new Map<string, number>();
	#moduleDeps = new Map<string, Set<string>>();
	#moduleParents = new Map<string, Set<string>>();
	#moduleVersions = new Map<string, number>();
	#moduleEntries = new Map<string, LocalModuleEntry>();
	#moduleBuilds = new Map<string, Promise<LocalModuleEntry>>();
	#externalModules = new Map<string, Promise<vm.Module>>();
	#requireCache = new Map<string, NodeJS.Require>();
	#modulePaths = new WeakMap<vm.Module, string>();
	#packageRoot: string | undefined;
	#linkChain: Promise<void> = Promise.resolve();

	constructor(sessionId: string, options: { patchGlobalResolver?: boolean } = {}) {
		this.#context = vm.createContext(globalThis);
		this.#sessionTag = Bun.hash(sessionId).toString(16);
		this.#resolution = new KernelModuleResolution({ patchGlobalResolver: options.patchGlobalResolver ?? false });
	}

	setPackageRoot(packageRoot: string | undefined): void {
		const normalized = packageRoot ? path.resolve(packageRoot) : undefined;
		if (normalized === this.#packageRoot) return;
		this.#packageRoot = normalized;
		if (normalized) this.#resolution.registerFor(normalized);
		this.#requireCache.clear();
	}

	async resolveForRun(baseDir: string, source: string): Promise<LocalImportResolution> {
		this.#refreshTrackedLocalModules();
		return await this.#resolveFromBase(baseDir, source);
	}

	async resolveForModule(moduleUrl: string, source: string, cwd: string): Promise<LocalImportResolution> {
		this.#refreshTrackedLocalModules();
		const modulePath = this.filenameForUrl(moduleUrl);
		const baseDir = modulePath ? path.dirname(modulePath) : cwd;
		return await this.#resolveFromBase(baseDir, source);
	}

	requireForFile(moduleUrlOrPath: string | undefined, cwd: string): NodeJS.Require {
		return this.createRequireFor(this.filenameForUrl(moduleUrlOrPath) ?? path.join(cwd, "[eval]"));
	}

	/** `createRequire`-compatible factory for an arbitrary base path or `file://` URL. */
	createRequireFor(basePathOrUrl: string | URL): NodeJS.Require {
		const key = String(basePathOrUrl);
		const cached = this.#requireCache.get(key);
		if (cached) return cached;
		const created = this.#buildRequire(basePathOrUrl, this.#packageRoot);
		this.#requireCache.set(key, created);
		return created;
	}

	/**
	 * `require` bound to `basePathOrUrl`.
	 *
	 * Both requires come from {@link KernelModuleResolution}, which is the only
	 * resolver that sees on-disk packages inside a compiled binary; bare specifiers
	 * the importing project cannot resolve fall back to the selected package
	 * environment ({@link setPackageRoot}), whose own `node_modules` is where a
	 * `%bun add`-installed dependency lives.
	 */
	#buildRequire(basePathOrUrl: string | URL, packageRoot: string | undefined): NodeJS.Require {
		const primary = this.#resolution.createRequire(basePathOrUrl);
		if (!packageRoot) return primary;
		const fallback = this.#resolution.createRequire(path.join(packageRoot, "package.json"));
		const requireWithFallback = ((id: string) => {
			if (!isBareSpecifier(id)) return primary(id);
			let primaryResolutionError: unknown;
			try {
				primary.resolve(id);
			} catch (error) {
				primaryResolutionError = error;
			}
			if (!primaryResolutionError) return primary(id);
			try {
				fallback.resolve(id);
			} catch (fallbackError) {
				throw packageFallbackError(primaryResolutionError, fallbackError, packageRoot);
			}
			return fallback(id);
		}) as NodeJS.Require;
		const resolve = ((id: string, options?: { paths?: string[] }) => {
			try {
				return primary.resolve(id, options);
			} catch (primaryError) {
				if (!isBareSpecifier(id)) throw primaryError;
				try {
					return fallback.resolve(id, options);
				} catch (fallbackError) {
					throw packageFallbackError(primaryError, fallbackError, packageRoot);
				}
			}
		}) as NodeJS.Require["resolve"] & { paths(request: string): string[] | null };
		resolve.paths = request => primary.resolve.paths(request);
		Object.defineProperties(requireWithFallback, {
			resolve: { value: resolve },
			cache: { value: primary.cache },
			extensions: { value: primary.extensions },
			main: { value: primary.main },
		});
		return requireWithFallback;
	}

	/** Drop the resolver roots this kernel registered (worker teardown). */
	dispose(): void {
		this.#resolution.dispose();
	}

	filenameForUrl(moduleUrlOrPath: string | undefined): string | null {
		if (!moduleUrlOrPath) return null;
		if (moduleUrlOrPath.startsWith("file://")) return fileURLToPath(moduleUrlOrPath);
		return path.isAbsolute(moduleUrlOrPath) ? moduleUrlOrPath : null;
	}

	dirnameForUrl(moduleUrlOrPath: string | undefined, cwd: string): string {
		const filename = this.filenameForUrl(moduleUrlOrPath);
		return filename ? path.dirname(filename) : cwd;
	}

	async #resolveFromBase(baseDir: string, source: string): Promise<LocalImportResolution> {
		const resolved = this.#resolveImportSpecifier(baseDir, source);
		if (isManagedLocalModulePath(resolved)) {
			const module = await this.#loadLocalModule(resolved);
			return { mode: "local", value: module.namespace };
		}
		const target = normalizeImportTarget(resolved);
		this.#registerTargetRoots(target);
		return { mode: "external", target };
	}

	/**
	 * Register the `node_modules` roots above an already-normalized import target.
	 * Packages loaded from disk run their own `require("dep")` through the stock
	 * resolver, which a compiled binary cannot satisfy (oven-sh/bun#25500).
	 */
	#registerTargetRoots(target: string): void {
		if (target.startsWith("file://")) this.#resolution.registerFor(fileURLToPath(target));
		else if (path.isAbsolute(target)) this.#resolution.registerFor(target);
	}

	/**
	 * Resolve an import specifier against `baseDir`.
	 *
	 * Resolve installed packages from their manifests first: a compiled Bun can
	 * miss packages or return an entry that ignores their export maps. The stock
	 * resolver still handles package self-references and file requests; the
	 * kernel's filesystem walk covers file requests it cannot resolve.
	 *
	 * A bare specifier the importing project does not have is retried against the
	 * selected package environment ({@link setPackageRoot}); when neither has it,
	 * both failures are reported together so the missing dependency is actionable.
	 */
	#resolveImportSpecifier(baseDir: string, source: string): string {
		if (/^[a-z][a-z0-9+.-]*:/i.test(source) || isBuiltin(source)) return source;
		this.#resolution.registerFor(baseDir);
		if (isLocalPathSpecifier(source)) {
			try {
				return Bun.resolveSync(source, baseDir);
			} catch {
				// Returned verbatim when nothing matches, so the eventual `import`
				// reports the loader's own error instead of a synthesized path.
				return this.#resolution.resolveFile(baseDir, source) ?? source;
			}
		}
		const packageRoot = this.#packageRoot;
		const onDisk = this.#resolution.resolveBare(baseDir, source, "import");
		if (onDisk) return onDisk;
		let projectError: unknown;
		try {
			return resolveBareSpecifierWithinProject(source, baseDir);
		} catch (error) {
			projectError = error;
		}
		if (packageRoot !== undefined) {
			const fallbackOnDisk = this.#resolution.resolveBare(packageRoot, source, "import");
			if (fallbackOnDisk) return fallbackOnDisk;
			try {
				return resolveBareSpecifierWithinProject(source, packageRoot);
			} catch (error) {
				throw packageFallbackError(projectError, error, packageRoot);
			}
		}
		throw projectError;
	}

	async #ensureLocalModule(modulePath: string): Promise<LocalModuleEntry> {
		const existing = this.#moduleEntries.get(modulePath);
		if (existing) return existing;
		const building = this.#moduleBuilds.get(modulePath);
		if (building) return await building;
		const buildPromise = this.#buildLocalModule(modulePath).finally(() => {
			if (this.#moduleBuilds.get(modulePath) === buildPromise) this.#moduleBuilds.delete(modulePath);
		});
		this.#moduleBuilds.set(modulePath, buildPromise);
		return await buildPromise;
	}

	// Construct (parse + register) a local module WITHOUT linking or evaluating it.
	// Linking and evaluation are driven once from the graph root in `#linkAndEvaluate`;
	// doing them per-module inside the recursive linker re-enters Bun's node:vm linker
	// mid-instantiation, which segfaults JSC (getImportedModule on a null record) whenever
	// the local graph contains an import cycle.
	async #buildLocalModule(modulePath: string): Promise<LocalModuleEntry> {
		const rawSource = fs.readFileSync(modulePath, "utf8");
		const stripped = stripTypeScriptSyntax(rawSource, {
			force: isTypeScriptModulePath(modulePath),
			loader: stripLoaderForPath(modulePath),
		});
		const moduleDir = path.dirname(modulePath);
		const localDeps = new Set<string>();
		const analysis = await analyzeModuleSource(stripped);
		for (const specifier of analysis.sources) {
			const resolved = this.#resolveImportSpecifier(moduleDir, specifier);
			if (isManagedLocalModulePath(resolved)) {
				localDeps.add(resolved);
			}
		}
		this.#setModuleDependencies(modulePath, localDeps);
		this.#moduleMtimes.set(modulePath, fs.statSync(modulePath).mtimeMs);
		const version = this.#moduleVersions.get(modulePath) ?? 1;
		this.#moduleVersions.set(modulePath, version);
		const fileUrl = pathToFileURL(modulePath).href;
		const identifier = `${fileUrl}?omp-session=${this.#sessionTag}&v=${version}`;
		const wrappedSource = buildModuleSource(stripped, modulePath, analysis.bindings);
		const module = new vm.SourceTextModule(wrappedSource, {
			context: this.#context,
			identifier,
			initializeImportMeta: meta => {
				(meta as { url?: string; path?: string; dir?: string }).url = fileUrl;
				(meta as { url?: string; path?: string; dir?: string }).path = modulePath;
				(meta as { url?: string; path?: string; dir?: string }).dir = moduleDir;
			},
			importModuleDynamically: async specifier => {
				return await this.#resolveDynamicImport(modulePath, String(specifier));
			},
		});
		this.#modulePaths.set(module, modulePath);
		const entry: LocalModuleEntry = { version, identifier, module };
		this.#moduleEntries.set(modulePath, entry);
		return entry;
	}

	// Construct (if needed) then link+evaluate a local module as a graph root, returning
	// the evaluated module. Link and evaluate run exactly once over the whole reachable
	// graph; the static linker only constructs dependencies, letting node:vm instantiate
	// cyclic graphs in a single pass.
	async #loadLocalModule(modulePath: string): Promise<vm.SourceTextModule> {
		const entry = await this.#ensureLocalModule(modulePath);
		entry.loaded ??= this.#linkAndEvaluate(entry, modulePath);
		await entry.loaded;
		return entry.module;
	}

	async #linkAndEvaluate(entry: LocalModuleEntry, modulePath: string): Promise<void> {
		const { module } = entry;
		try {
			// Serialize the link phase across every graph root. Bun's node:vm linker
			// segfaults (getImportedModule on a null record) when two link passes
			// instantiate overlapping module instances concurrently — e.g.
			// Promise.all([import("./a"), import("./b")]) over a graph that shares
			// dependencies. Holding the lock for the whole module.link() (including its
			// async resolver callbacks) guarantees the linker is never re-entered
			// mid-instantiation. The lock is released before evaluate(), so a dynamic
			// import during evaluation can re-acquire it without deadlock.
			await this.#serializeLink(async () => {
				if (module.status === "unlinked") await module.link(this.#linkResolve);
			});
			if (module.status === "linked") await module.evaluate();
		} catch (error) {
			this.#invalidateFailedLoad(modulePath);
			throw error;
		}
		if (module.status === "errored") {
			this.#invalidateFailedLoad(modulePath);
			throw module.error;
		}
	}

	// Promise-chain mutex serializing node:vm link passes (see #linkAndEvaluate).
	// #linkChain is kept non-rejecting so a failed link never wedges the queue.
	#serializeLink<T>(run: () => Promise<T>): Promise<T> {
		const result = this.#linkChain.then(run);
		this.#linkChain = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	// Shared static-link resolver for `module.link()`. node:vm passes the referencing
	// module and reuses this one resolver for the entire graph, so the referrer path is
	// recovered from `#modulePaths`. Local dependencies are constructed but NOT linked or
	// evaluated here (the root drives that); externals are loaded eagerly — they carry no
	// imports and cannot participate in a cycle.
	#linkResolve = async (specifier: string, referencingModule: vm.Module): Promise<vm.Module> => {
		const referrerPath = this.#modulePaths.get(referencingModule);
		if (referrerPath === undefined) {
			throw new Error(`local module loader: unknown referrer while linking "${specifier}"`);
		}
		const resolved = this.#resolveImportSpecifier(path.dirname(referrerPath), specifier);
		if (isManagedLocalModulePath(resolved)) {
			return (await this.#ensureLocalModule(resolved)).module;
		}
		return await this.#ensureExternalModule(normalizeImportTarget(resolved));
	};

	// Resolver for runtime `import()` inside evaluated module code: the result must be a
	// fully linked+evaluated module, so local targets are loaded as graph roots.
	async #resolveDynamicImport(referrerPath: string, specifier: string): Promise<vm.Module> {
		const resolved = this.#resolveImportSpecifier(path.dirname(referrerPath), specifier);
		if (isManagedLocalModulePath(resolved)) {
			return await this.#loadLocalModule(resolved);
		}
		return await this.#ensureExternalModule(normalizeImportTarget(resolved));
	}

	// A failed link/evaluate can leave a partial graph cached. Drop every reachable module
	// that is not fully evaluated so the next attempt reconstructs it; fully evaluated
	// modules keep valid namespaces and stay cached.
	#invalidateFailedLoad(rootPath: string): void {
		const stack = [rootPath];
		const seen = new Set<string>();
		while (stack.length > 0) {
			const current = stack.pop();
			if (current === undefined || seen.has(current)) continue;
			seen.add(current);
			const entry = this.#moduleEntries.get(current);
			if (entry && entry.module.status === "evaluated") continue;
			this.#moduleEntries.delete(current);
			this.#moduleBuilds.delete(current);
			const deps = this.#moduleDeps.get(current);
			if (deps) for (const dep of deps) stack.push(dep);
		}
	}

	async #ensureExternalModule(target: string): Promise<vm.Module> {
		const existing = this.#externalModules.get(target);
		if (existing) return await existing;
		const loadPromise = (async () => {
			this.#registerTargetRoots(target);
			const loaded = await import(target);
			const namespace =
				target === "node:module" || target === "module" ? this.#resolution.shimNodeModule(loaded) : loaded;
			const exportNames = Object.keys(namespace);
			const module = new vm.SyntheticModule(
				exportNames,
				function () {
					for (const name of exportNames) {
						this.setExport(name, namespace[name as keyof typeof namespace]);
					}
				},
				{ context: this.#context, identifier: target },
			);
			await module.link(() => {
				throw new Error("Synthetic external modules have no dependencies");
			});
			await module.evaluate();
			return module;
		})();
		this.#externalModules.set(target, loadPromise);
		try {
			return await loadPromise;
		} catch (error) {
			if (this.#externalModules.get(target) === loadPromise) this.#externalModules.delete(target);
			throw error;
		}
	}

	#refreshTrackedLocalModules(): void {
		const changed: string[] = [];
		for (const [modulePath, previousMtime] of this.#moduleMtimes.entries()) {
			let nextMtime: number | undefined;
			try {
				nextMtime = fs.statSync(modulePath).mtimeMs;
			} catch {
				nextMtime = undefined;
			}
			if (nextMtime === previousMtime) continue;
			if (nextMtime === undefined) this.#moduleMtimes.delete(modulePath);
			else this.#moduleMtimes.set(modulePath, nextMtime);
			changed.push(modulePath);
		}
		for (const modulePath of changed) {
			this.#invalidateModuleAndParents(modulePath, new Set());
		}
	}

	#invalidateModuleAndParents(modulePath: string, seen: Set<string>): void {
		if (seen.has(modulePath)) return;
		seen.add(modulePath);
		this.#moduleEntries.delete(modulePath);
		this.#moduleBuilds.delete(modulePath);
		this.#moduleVersions.set(modulePath, (this.#moduleVersions.get(modulePath) ?? 1) + 1);
		const parents = [...(this.#moduleParents.get(modulePath) ?? [])];
		for (const parent of parents) this.#invalidateModuleAndParents(parent, seen);
	}

	#setModuleDependencies(modulePath: string, deps: Set<string>): void {
		const previousDeps = this.#moduleDeps.get(modulePath);
		if (previousDeps) {
			for (const dep of previousDeps) {
				const parents = this.#moduleParents.get(dep);
				if (!parents) continue;
				parents.delete(modulePath);
				if (parents.size === 0) this.#moduleParents.delete(dep);
			}
		}
		this.#moduleDeps.set(modulePath, new Set(deps));
		for (const dep of deps) {
			const parents = this.#moduleParents.get(dep) ?? new Set<string>();
			parents.add(modulePath);
			this.#moduleParents.set(dep, parents);
		}
	}
}

function buildModuleSource(source: string, modulePath: string, bindings: ReadonlySet<string>): string {
	const moduleDir = path.dirname(modulePath);
	const fileUrl = pathToFileURL(modulePath).href;
	return [
		// Bun can evaluate a linked module without calling initializeImportMeta.
		// Seed its metadata before top-level initializers use it as well.
		`import.meta.url = ${JSON.stringify(fileUrl)};`,
		`import.meta.path = ${JSON.stringify(modulePath)};`,
		`import.meta.dir = ${JSON.stringify(moduleDir)};`,
		bindings.has("require") ? "" : `const require = globalThis.__omp_get_require__(${JSON.stringify(fileUrl)});`,
		bindings.has("__filename") ? "" : `const __filename = ${JSON.stringify(modulePath)};`,
		bindings.has("__dirname") ? "" : `const __dirname = ${JSON.stringify(moduleDir)};`,
		source,
	].join("\n");
}

function resolveBareSpecifierWithinProject(source: string, baseDir: string): string {
	const resolved = Bun.resolveSync(source, baseDir);
	if (!path.isAbsolute(resolved)) {
		throw new Error(
			`Refusing non-file resolution ${JSON.stringify(resolved)} for bare package ${JSON.stringify(source)} from ${baseDir}`,
		);
	}
	const segments = source.split("/");
	const packageName = source.startsWith("@") ? segments.slice(0, 2) : segments.slice(0, 1);
	const target = path.resolve(resolved);
	let ancestor = path.resolve(baseDir);
	for (;;) {
		if (fs.existsSync(path.join(ancestor, "node_modules", ...packageName))) return resolved;
		const parent = path.dirname(ancestor);
		if (parent !== ancestor && fs.existsSync(path.join(ancestor, "package.json")) && pathIsWithin(ancestor, target)) {
			return resolved;
		}
		if (parent === ancestor) break;
		ancestor = parent;
	}
	throw new Error(
		`Refusing package ${JSON.stringify(source)} resolved outside the importing project's ancestry: ${resolved}`,
	);
}

function pathIsWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function packageFallbackError(projectError: unknown, fallbackError: unknown, packageRoot: string): Error {
	const projectMessage = projectError instanceof Error ? projectError.message : String(projectError);
	const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
	return new Error(
		`${projectMessage}\nJS package environment fallback ${packageRoot} also failed: ${fallbackMessage}\n` +
			"Install the missing dependency with %bun add (select %environment project only to modify the project).",
		{ cause: projectError },
	);
}

function isBareSpecifier(source: string): boolean {
	return !isLocalPathSpecifier(source) && !/^[a-z][a-z0-9+.-]*:/i.test(source) && !isBuiltin(source);
}
function isLocalPathSpecifier(source: string): boolean {
	return (
		source.startsWith("./") ||
		source.startsWith("../") ||
		source === "." ||
		source === ".." ||
		source.startsWith("/") ||
		source.startsWith("~/") ||
		/^[a-zA-Z]:[\\/]/.test(source)
	);
}

function isTypeScriptModulePath(modulePath: string): boolean {
	const ext = path.extname(modulePath);
	return ext === ".ts" || ext === ".tsx" || ext === ".mts";
}

function stripLoaderForPath(modulePath: string): "ts" | "tsx" {
	return path.extname(modulePath) === ".tsx" ? "tsx" : "ts";
}

function isManagedLocalModulePath(target: string): boolean {
	// Bare workspace packages resolve to real paths outside node_modules. Keep
	// their transitive imports in this graph too: compiled Bun cannot resolve
	// those packages' bare imports if they escape to its native ESM loader.
	return (
		path.isAbsolute(target) &&
		LOCAL_MODULE_EXTENSIONS.has(path.extname(target)) &&
		!NODE_MODULES_SEGMENT_RE.test(target)
	);
}

function normalizeImportTarget(target: string): string {
	if (path.isAbsolute(target)) return pathToFileURL(target).href;
	return target;
}
