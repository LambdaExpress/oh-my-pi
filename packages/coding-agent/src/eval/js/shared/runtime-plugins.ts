import * as bunModule from "bun";
import type {
	BunPlugin,
	BunRegisterPlugin,
	Loader,
	OnLoadCallback,
	OnLoadResult,
	OnLoadResultSourceCode,
	OnResolveArgs,
	OnResolveCallback,
	OnResolveResult,
	PluginBuilder,
	PluginConstraints,
} from "bun";

interface PluginHook<T> {
	filter: RegExp;
	namespace: string;
	callback: T;
}

interface RegisteredPlugin {
	ready: boolean;
	resolve: PluginHook<OnResolveCallback>[];
	load: PluginHook<OnLoadCallback>[];
}

const HOST_BUN = Bun;

/** Runtime hooks belong to a kernel, never Bun's process-wide plugin registry. */
export class RuntimePlugins {
	#plugins: RegisteredPlugin[] = [];
	#disposed = false;
	readonly bun: typeof Bun;
	readonly module: Record<string, unknown>;

	constructor() {
		const plugin = Object.assign((options: BunPlugin) => this.#register(options), {
			clearAll: () => {
				this.#plugins = [];
			},
		}) as BunRegisterPlugin;
		this.bun = Object.create(HOST_BUN, {
			plugin: { value: plugin, enumerable: true, configurable: true, writable: true },
		});
		this.module = { ...bunModule, default: this.bun, plugin };
	}

	#register(options: BunPlugin): void | Promise<void> {
		if (this.#disposed) throw new Error("Cannot register a plugin on a disposed JS runtime");
		const plugin: RegisteredPlugin = { ready: false, resolve: [], load: [] };
		const builder: PluginBuilder = {
			config: { entrypoints: [], target: "bun", plugins: [options] },
			onResolve: (constraints, callback) => {
				plugin.resolve.push(makeHook(constraints, callback));
				return builder;
			},
			onLoad: (constraints, callback) => {
				plugin.load.push(makeHook(constraints, callback));
				return builder;
			},
			module: (specifier, callback) => {
				const { namespace, path } = pluginLocation(specifier);
				return builder.onLoad(
					{ namespace, filter: new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) },
					callback,
				);
			},
			// These are build lifecycle hooks, not module-loader hooks. Do not
			// accept them and then silently discard their effects.
			onStart: () => unsupportedBuildHook("onStart"),
			onEnd: () => unsupportedBuildHook("onEnd"),
			onBeforeParse: () => unsupportedBuildHook("onBeforeParse"),
		};
		this.#plugins.push(plugin);
		try {
			const setup = options.setup(builder);
			if (setup && typeof setup.then === "function") {
				return setup.then(
					() => {
						plugin.ready = true;
					},
					error => {
						this.#plugins = this.#plugins.filter(candidate => candidate !== plugin);
						throw error;
					},
				);
			}
			plugin.ready = true;
		} catch (error) {
			this.#plugins = this.#plugins.filter(candidate => candidate !== plugin);
			throw error;
		}
	}

	async resolve(args: OnResolveArgs): Promise<OnResolveResult | undefined> {
		for (const plugin of this.#plugins) {
			if (!plugin.ready) continue;
			for (const hook of plugin.resolve) {
				if (!matches(hook, args.path, args.namespace)) continue;
				const result = await hook.callback(args);
				if (result != null) return result;
			}
		}
		return undefined;
	}

	resolveSync(args: OnResolveArgs): OnResolveResult | undefined {
		for (const plugin of this.#plugins) {
			if (!plugin.ready) continue;
			for (const hook of plugin.resolve) {
				if (!matches(hook, args.path, args.namespace)) continue;
				const result = synchronousHookResult(hook.callback(args), "onResolve");
				if (result != null) return result;
			}
		}
		return undefined;
	}

	hasLoader(target: string): boolean {
		const { path, namespace } = pluginLocation(target);
		return this.#plugins.some(plugin => plugin.ready && plugin.load.some(hook => matches(hook, path, namespace)));
	}

	async load(target: string, loader: Loader): Promise<OnLoadResult> {
		const { path, namespace } = pluginLocation(target);
		for (const plugin of this.#plugins) {
			if (!plugin.ready) continue;
			for (const hook of plugin.load) {
				if (!matches(hook, path, namespace)) continue;
				const result = await hook.callback({
					path,
					namespace,
					loader,
					defer: () => unsupportedBuildHook("onLoad.defer"),
				});
				if (result != null) return result;
			}
		}
		return undefined;
	}

	loadSync(target: string, loader: Loader): OnLoadResult {
		const { path, namespace } = pluginLocation(target);
		for (const plugin of this.#plugins) {
			if (!plugin.ready) continue;
			for (const hook of plugin.load) {
				if (!matches(hook, path, namespace)) continue;
				const result = synchronousHookResult(
					hook.callback({
						path,
						namespace,
						loader,
						defer: () => unsupportedBuildHook("onLoad.defer"),
					}),
					"onLoad",
				);
				if (result != null) return result;
			}
		}
		return undefined;
	}

	dispose(): void {
		this.#disposed = true;
		this.#plugins = [];
	}
}

/** Windows drive prefixes are file paths, not plugin namespaces. */
export function pluginLocation(target: string): { path: string; namespace: string } {
	const prefix = /^[a-z][a-z0-9+.-]*:/i.exec(target);
	if (!prefix || /^[a-z]:[\\/]/i.test(target)) return { path: target, namespace: "file" };
	return { path: target.slice(prefix[0].length), namespace: prefix[0].slice(0, -1) };
}

function makeHook<T>(constraints: PluginConstraints, callback: T): PluginHook<T> {
	// Bun filters do not consume RegExp.lastIndex across imports.
	return {
		filter: new RegExp(constraints.filter.source, constraints.filter.flags.replace(/[gy]/g, "")),
		namespace: constraints.namespace || "file",
		callback,
	};
}

function matches<T>(hook: PluginHook<T>, path: string, namespace: string): boolean {
	return hook.namespace === namespace && hook.filter.test(path);
}

function unsupportedBuildHook(name: string): never {
	throw new Error(`${name} requires Bun.build({ plugins }); it is not available in the eval module loader`);
}

function synchronousHookResult<T>(result: T | Promise<T>, hook: string): T {
	if (result && typeof (result as Promise<T>).then === "function") {
		// The caller receives the synchronous incompatibility error. The hook's
		// rejected promise must not escape as an unrelated process-fatal rejection.
		void Promise.resolve(result).catch(() => {});
		throw new TypeError(`Async ${hook} hooks cannot be used with require(); use await import() instead`);
	}
	return result as T;
}

/** Compile only a plugin's replacement contents, never its dependency graph. */
export async function compilePluginSource(
	target: string,
	result: OnLoadResultSourceCode,
	loader: Loader,
): Promise<string> {
	const contents = result.contents;
	const source =
		typeof contents === "string"
			? contents
			: new TextDecoder().decode(
					ArrayBuffer.isView(contents)
						? new Uint8Array(contents.buffer, contents.byteOffset, contents.byteLength)
						: new Uint8Array(contents),
				);
	const selectedLoader = result.loader ?? loader;
	if (selectedLoader === "js") return source;
	if (selectedLoader === "ts" || selectedLoader === "tsx" || selectedLoader === "jsx") {
		return new HOST_BUN.Transpiler({ loader: selectedLoader, target: "bun" }).transformSync(source);
	}
	const built = await HOST_BUN.build({
		entrypoints: ["./eval-plugin-contents.js"],
		target: "bun",
		format: "esm",
		treeShaking: false,
		plugins: [
			{
				name: "eval-plugin-contents",
				setup(build) {
					build.onResolve({ filter: /.*/ }, args =>
						args.importer
							? { path: args.path, external: true }
							: { path: target, namespace: "eval-plugin-contents" },
					);
					build.onResolve({ filter: /.*/, namespace: "eval-plugin-contents" }, args => ({
						path: args.path,
						external: true,
					}));
					build.onLoad({ filter: /.*/, namespace: "eval-plugin-contents" }, () => ({
						contents: source,
						loader: selectedLoader,
					}));
				},
			},
		],
	});
	if (!built.success) throw new AggregateError(built.logs, `Cannot load plugin contents for ${target}`);
	const entry = built.outputs.find(output => output.kind === "entry-point");
	if (!entry) throw new Error(`Plugin loader ${selectedLoader} did not produce a JavaScript module for ${target}`);
	return await entry.text();
}
