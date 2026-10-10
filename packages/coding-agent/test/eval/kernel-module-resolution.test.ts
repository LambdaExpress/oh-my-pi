import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KernelModuleResolution } from "@oh-my-pi/pi-coding-agent/eval/js/shared/module-resolution";
import { JsRuntime, type RuntimeHooks } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";

// Compiled builds cannot resolve on-disk packages through the stock runtime, so
// these are the primitives the eval kernel leans on instead: a walk-up
// `node_modules` resolver and a require wrapper that survives the runtime's
// resolver patch. The end-to-end failure (cells importing installed packages)
// only reproduces inside a compiled binary; this file pins the contract those
// builds depend on.
// The runtime cases also cover plugins crossing the native-Bun / VM-loader boundary.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-kernel-resolution-"));

function writeFixture(relative: string, content: string): void {
	const target = path.join(root, relative);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
}

writeFixture(
	"node_modules/fixture-pkg/package.json",
	JSON.stringify({ name: "fixture-pkg", version: "1.0.0", main: "lib/index.js" }),
);
writeFixture("node_modules/fixture-pkg/lib/index.js", "module.exports = { marker: require('./dep.js') };\n");
writeFixture("node_modules/fixture-pkg/lib/dep.js", "module.exports = 'dep';\n");
writeFixture("node_modules/fixture-pkg/extra/thing.js", "module.exports = 'sub';\n");
writeFixture(
	"node_modules/@scope/fixture-pkg/package.json",
	JSON.stringify({ name: "@scope/fixture-pkg", main: "index.js" }),
);
writeFixture("node_modules/@scope/fixture-pkg/index.js", "module.exports = 'scoped';\n");
writeFixture("project/package.json", JSON.stringify({ name: "fixture-project", version: "1.0.0" }));
writeFixture(
	"workspace/package.json",
	JSON.stringify({
		name: "@fixture/workspace",
		type: "module",
		main: "./private.cjs",
		exports: {
			".": { types: "./missing.d.ts", import: "./src/index.ts", require: "./index.cjs" },
			"./tools/*": { import: "./src/tools/*.ts", require: "./tools/*.cjs" },
			"./tools/internal/*": null,
			"./tools/exact": { import: "./src/exact.ts" },
		},
	}),
);
writeFixture("workspace/src/index.ts", "export const marker = 'import';\n");
writeFixture("workspace/index.cjs", "module.exports = 'require';\n");
writeFixture("workspace/private.cjs", "module.exports = 'private';\n");
writeFixture("workspace/src/tools/value.ts", "export const marker = 'wildcard';\n");
writeFixture("workspace/src/tools/exact.ts", "export const marker = 'wrong';\n");
writeFixture("workspace/src/exact.ts", "export const marker = 'exact';\n");
writeFixture("workspace/src/tools/internal/value.ts", "export const marker = 'hidden';\n");
writeFixture("workspace/tools/value.cjs", "module.exports = 'require-subpath';\n");
fs.mkdirSync(path.join(root, "node_modules/@fixture"), { recursive: true });
fs.symlinkSync(
	path.join(root, "workspace"),
	path.join(root, "node_modules/@fixture/workspace"),
	process.platform === "win32" ? "junction" : "dir",
);

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const resolution = new KernelModuleResolution({ patchGlobalResolver: false });
const hooks: RuntimeHooks = {
	onText() {},
	onDisplay() {},
	callTool: async () => undefined,
};

describe("kernel module resolution", () => {
	test("resolves bare specifiers against the node_modules chain above the requester", () => {
		expect(resolution.resolveBare(root, "fixture-pkg")).toBe(
			path.join(root, "node_modules/fixture-pkg/lib/index.js"),
		);
		expect(resolution.resolveBare(path.join(root, "node_modules/fixture-pkg/lib"), "@scope/fixture-pkg")).toBe(
			path.join(root, "node_modules/@scope/fixture-pkg/index.js"),
		);
		expect(resolution.resolveBare(root, "fixture-pkg/extra/thing.js")).toBe(
			path.join(root, "node_modules/fixture-pkg/extra/thing.js"),
		);
		expect(resolution.resolveBare(root, "fixture-absent")).toBeNull();
		expect(resolution.resolveBare(root, "node:fs")).toBeNull();
	});

	test("resolves file requests with the same probing require uses", () => {
		expect(resolution.resolveFile(path.join(root, "node_modules/fixture-pkg"), "./lib/dep")).toBe(
			path.join(root, "node_modules/fixture-pkg/lib/dep.js"),
		);
		expect(resolution.resolveFile(path.join(root, "node_modules/fixture-pkg/lib/index.js"), "./dep")).toBe(
			path.join(root, "node_modules/fixture-pkg/lib/dep.js"),
		);
		expect(resolution.resolveFile(root, "./missing-dep")).toBeNull();
	});

	test("resolves workspace import exports through their real paths without changing require conditions", () => {
		expect(resolution.resolveBare(root, "@fixture/workspace", "import")).toBe(
			fs.realpathSync(path.join(root, "workspace/src/index.ts")),
		);
		expect(resolution.resolveBare(root, "@fixture/workspace/tools/value", "import")).toBe(
			fs.realpathSync(path.join(root, "workspace/src/tools/value.ts")),
		);
		expect(resolution.resolveBare(root, "@fixture/workspace/tools/exact", "import")).toBe(
			fs.realpathSync(path.join(root, "workspace/src/exact.ts")),
		);
		const require = resolution.createRequire(path.join(root, "project/package.json"));
		expect(require(resolution.resolveBare(root, "@fixture/workspace")!)).toBe("require");
		expect(require(resolution.resolveBare(root, "@fixture/workspace/tools/value")!)).toBe("require-subpath");
	});

	test("does not resolve private or excluded workspace files around the export map", () => {
		for (const specifier of [
			"@fixture/workspace/private.cjs",
			"@fixture/workspace/tools/internal/value",
			"@fixture/workspace/tools/../index",
		]) {
			expect(() => resolution.resolveBare(root, specifier, "import")).toThrow("Cannot resolve package entry");
		}
	});

	test("does not fall through an installed package to an ancestor's exported subpath", () => {
		writeFixture(
			"isolated-project/node_modules/@fixture/workspace/package.json",
			JSON.stringify({ name: "@fixture/workspace", exports: { ".": "./index.js" } }),
		);
		writeFixture("isolated-project/node_modules/@fixture/workspace/index.js", "exports.marker = 'nearest';\n");
		expect(() =>
			resolution.resolveBare(path.join(root, "isolated-project"), "@fixture/workspace/tools/value", "import"),
		).toThrow("Cannot resolve package entry");
	});

	test("createRequire loads an installed package together with its own dependencies", () => {
		const require = resolution.createRequire(path.join(root, "project/package.json"));
		expect((require("fixture-pkg") as { marker: string }).marker).toBe("dep");
		expect(require.resolve("fixture-pkg")).toBe(path.join(root, "node_modules/fixture-pkg/lib/index.js"));
	});

	test("node:module keeps its exports and exposes the kernel createRequire", () => {
		const require = resolution.createRequire(root);
		const nodeModule = require("node:module") as typeof import("node:module");
		expect(nodeModule.builtinModules).toContain("fs");
		const scoped = nodeModule.createRequire(path.join(root, "project/package.json"));
		expect((scoped("fixture-pkg") as { marker: string }).marker).toBe("dep");
	});

	test("Bun onResolve aliases retain cyclic graphs, dynamic imports, package fallback and hot reload", async () => {
		const cwd = path.join(root, "plugin-graph");
		const sourceRoot = path.join(cwd, "src");
		const entry = path.join(sourceRoot, "proxy/service.js");
		const bridge = path.join(sourceRoot, "api/bridge.js");
		writeFixture(
			"plugin-graph/src/proxy/service.js",
			[
				'import { bridgeValue } from "@/api/bridge";',
				'import fallback from "fixture-plugin-fallback";',
				'export const serviceName = "service";',
				'export async function result() { return [bridgeValue(), (await import("@/api/lazy")).value, fallback]; }',
			].join("\n"),
		);
		writeFixture(
			"plugin-graph/src/api/bridge.js",
			[
				'import { serviceName } from "@/proxy/service";',
				'import { value } from "@/api/value";',
				'export function bridgeValue() { return serviceName + ":" + value; }',
			].join("\n"),
		);
		writeFixture("plugin-graph/src/api/value.js", 'export const value = "first";');
		writeFixture("plugin-graph/src/api/lazy.js", 'export const value = "dynamic";');
		writeFixture(
			"plugin-environment/node_modules/fixture-plugin-fallback/package.json",
			JSON.stringify({ name: "fixture-plugin-fallback", main: "index.cjs" }),
		);
		writeFixture(
			"plugin-environment/node_modules/fixture-plugin-fallback/index.cjs",
			'module.exports = "environment";',
		);
		const runtime = new JsRuntime({
			initialCwd: cwd,
			sessionId: "plugin-graph",
			packageRoot: path.join(root, "plugin-environment"),
		});
		try {
			const value = await runtime.run(
				`(async () => {
					const exitIpPath = await import("node:path");
					Bun.plugin({
						name: "source-alias",
						setup(build) {
							build.onResolve({ filter: /^@\\// }, args => ({
								path: exitIpPath.resolve(${JSON.stringify(sourceRoot)},
									args.path.slice(2) + (args.path.endsWith(".js") ? "" : ".js"))
							}));
						}
					});
					const [service, bridge] = await Promise.all([
						import(${JSON.stringify(entry.replaceAll("\\", "/"))}), import(${JSON.stringify(bridge)})
					]);
					return [await service.result(), bridge.bridgeValue(), service === await import("@/proxy/service")];
				})()`,
				path.join(cwd, "cell.js"),
				hooks,
			);
			expect(value).toEqual([["service:first", "dynamic", "environment"], "service:first", true]);

			const leaf = path.join(sourceRoot, "api/value.js");
			const previousMtime = fs.statSync(leaf).mtimeMs;
			writeFixture("plugin-graph/src/api/value.js", 'export const value = "updated";');
			fs.utimesSync(leaf, new Date(previousMtime + 1000), new Date(previousMtime + 1000));
			expect(
				await runtime.run(`(await import(${JSON.stringify(entry)})).result()`, path.join(cwd, "cell.js"), hooks),
			).toEqual(["service:updated", "dynamic", "environment"]);
		} finally {
			runtime.dispose();
		}
	});

	test("ordered asynchronous onResolve hooks resolve relative paths with the actual static and dynamic importer", async () => {
		const cwd = path.join(root, "plugin-relative");
		const entry = path.join(cwd, "nested/entry.js");
		writeFixture(
			"plugin-relative/nested/entry.js",
			'import { value } from "mapped-static"; export async function result() { return [value, (await import("mapped-dynamic")).value]; }',
		);
		writeFixture("plugin-relative/nested/dep.js", 'export const value = "relative";');
		const runtime = new JsRuntime({ initialCwd: cwd, sessionId: "plugin-relative" });
		try {
			expect(
				await runtime.run(
					`(async () => {
						await Bun.plugin({
							name: "relative-resolver",
							async setup(build) {
								await Promise.resolve();
								build.onResolve({ filter: /^mapped-/, namespace: "other" }, () => {
									throw new Error("wrong namespace");
								});
								build.onResolve({ filter: /^mapped-/ }, async () => undefined);
								build.onResolve({ filter: /^mapped-/g }, async args => {
									await Promise.resolve();
									if (args.importer !== ${JSON.stringify(entry)} ||
										args.resolveDir !== ${JSON.stringify(path.dirname(entry))} ||
										args.kind !== (args.path.endsWith("static") ? "import-statement" : "dynamic-import")) {
										throw new Error("incorrect import context");
									}
									return { path: "./dep.js" };
								});
								build.onResolve({ filter: /dep\\.js$/ }, () => {
									throw new Error("redirects must not chain");
								});
							}
						});
						return (await import(${JSON.stringify(entry)})).result();
					})()`,
					path.join(cwd, "cell.js"),
					hooks,
				),
			).toEqual(["relative", "relative"]);
		} finally {
			runtime.dispose();
		}
	});

	test("Bun plugin namespaces load real source and object modules without native plugin registration", async () => {
		const runtime = new JsRuntime({ initialCwd: root, sessionId: "plugin-namespaces" });
		try {
			expect(
				await runtime.run(
					`(async () => {
						const { plugin } = await import("bun");
						plugin({
							name: "virtual-modules",
							setup(build) {
								build.onResolve({ filter: /^virtual-entry$/ }, () => ({ path: "entry", namespace: "fixture" }));
								build.onLoad({ filter: /^entry$/, namespace: "fixture" }, async () => ({
									loader: "ts",
									contents: 'import { value } from "./value"; export const answer: number = value + 1;'
								}));
								build.onResolve({ filter: /^\\.\\/value$/, namespace: "fixture" }, args => {
									if (args.importer !== "entry" || args.resolveDir !== "") throw new Error("virtual context lost");
									return { path: "value", namespace: "fixture" };
								});
								build.onLoad({ filter: /^value$/, namespace: "fixture" }, () => ({
									loader: "object", exports: { value: 41 }
								}));
								build.module("fixture:message", () => ({ loader: "object", exports: { text: "loaded" } }));
								build.module("fixture:data", () => ({ loader: "json", contents: '{"ok":true}' }));
							}
						});
						return [(await import("virtual-entry")).answer, (await import("fixture:message")).text,
							(await import("fixture:data")).default.ok];
					})()`,
					path.join(root, "cell.js"),
					hooks,
				),
			).toEqual([42, "loaded", true]);
		} finally {
			runtime.dispose();
		}
	});

	test("same-realm kernels isolate plugin registrations, clearAll and disposal", async () => {
		writeFixture("plugin-isolation/first.js", 'export const value = "first";');
		writeFixture("plugin-isolation/second.js", 'export const value = "second";');
		const cwd = path.join(root, "plugin-isolation");
		const filename = path.join(cwd, "cell.js");
		const first = new JsRuntime({ initialCwd: cwd, sessionId: "plugin-isolation-first" });
		const second = new JsRuntime({ initialCwd: cwd, sessionId: "plugin-isolation-second" });
		const install = (file: string) => `(async () => {
			const { plugin } = await import("bun");
			plugin({ name: "isolated", setup(build) {
				build.onResolve({ filter: /^kernel-isolated-alias$/ }, () => ({ path: ${JSON.stringify(file)} }));
			}});
			return (await import("kernel-isolated-alias")).value;
		})()`;
		const load = '(await import("kernel-isolated-alias")).value';
		try {
			expect(await first.run(install("./first.js"), filename, hooks)).toBe("first");
			await expect(second.run(load, filename, hooks)).rejects.toThrow();
			expect(await second.run(install("./second.js"), filename, hooks)).toBe("second");
			expect(await first.run(load, filename, hooks)).toBe("first");

			await second.run("Bun.plugin.clearAll();", filename, hooks);
			await expect(second.run(load, filename, hooks)).rejects.toThrow();
			expect(await first.run(load, filename, hooks)).toBe("first");
			first.dispose();
			expect(await second.run(install("./second.js"), filename, hooks)).toBe("second");

			// A native import outside either kernel never sees either registry.
			const hostAlias = "kernel-isolated-alias";
			await expect(import(hostAlias)).rejects.toThrow();
		} finally {
			first.dispose();
			second.dispose();
		}
	});

	test("module Bun bindings retain their kernel across cells, imports, require and owner switches", async () => {
		writeFixture(
			"plugin-binding/registry.js",
			`import { plugin } from "bun";
			export function install(value) {
				if (Bun.plugin !== plugin) throw new Error("module plugin registry differs from Bun");
				Bun.plugin({ name: "module-binding", setup(build) {
					build.onResolve({ filter: /^runtime-bound-value$/ }, () => ({ path: "value", namespace: "runtime-bound" }));
					build.module("runtime-bound:value", () => ({ loader: "object", exports: { value } }));
				}});
			}
			export function required() { return require("runtime-bound-value").value; }
			export async function imported() { return (await import("runtime-bound-value")).value; }`,
		);
		writeFixture(
			"plugin-binding/own-bun.js",
			'import Bun from "bun"; export const plugin = Bun.plugin; export const hash = Bun.hash("native");',
		);
		const cwd = path.join(root, "plugin-binding");
		const filename = path.join(cwd, "cell.js");
		const first = new JsRuntime({ initialCwd: cwd, sessionId: "module-binding-first" });
		const second = new JsRuntime({ initialCwd: cwd, sessionId: "module-binding-second" });
		try {
			await first.run(
				'import { install as installFirst } from "./registry.js"; installFirst("first");',
				filename,
				hooks,
			);
			await second.run(
				'import { install as installSecond } from "./registry.js"; installSecond("second");',
				filename,
				hooks,
			);
			expect(
				await first.run(
					'import { required as requiredFirst, imported as importedFirst } from "./registry.js"; [requiredFirst(), await importedFirst()];',
					filename,
					hooks,
				),
			).toEqual(["first", "first"]);
			expect(
				await second.run(
					'import { required as requiredSecond, imported as importedSecond } from "./registry.js"; [requiredSecond(), await importedSecond()];',
					filename,
					hooks,
				),
			).toEqual(["second", "second"]);
			expect(await first.run("[requiredFirst(), await importedFirst()];", filename, hooks)).toEqual([
				"first",
				"first",
			]);
			expect(
				await first.run(
					'(async () => { const own = await import("./own-bun.js"); return [own.plugin === Bun.plugin, own.hash]; })()',
					filename,
					hooks,
				),
			).toEqual([true, Bun.hash("native")]);
		} finally {
			first.dispose();
			second.dispose();
			for (const key of [
				"installFirst",
				"installSecond",
				"requiredFirst",
				"requiredSecond",
				"importedFirst",
				"importedSecond",
			]) {
				delete (globalThis as Record<string, unknown>)[key];
			}
		}
	});

	test("source Worker runtimes execute plugin cells and preserve the native Bun descriptors", async () => {
		const filename = path.join(root, "plugin-worker/cell.js");
		const workerEntry = path.join(root, "plugin-worker/worker.ts");
		const install = `Bun.plugin({ name: "worker-binding", setup(build) {
			build.module("worker-binding:value", () => ({ loader: "object", exports: { answer: 42 } }));
		}});`;
		const load = `import { answer as workerAnswer } from "worker-binding:value";
			[workerAnswer, (await import("worker-binding:value")).answer,
				require("worker-binding:value").answer,
				new TextDecoder().decode(Bun.gunzipSync(Bun.gzipSync("worker")))];`;
		writeFixture(
			"plugin-worker/worker.ts",
			`import { JsRuntime } from ${JSON.stringify(import.meta.resolve("@oh-my-pi/pi-coding-agent/eval/js/shared/runtime"))};
			const nativeBun = Object.getOwnPropertyDescriptor(globalThis, "Bun");
			const nativePlugin = Object.getOwnPropertyDescriptor(Bun, "plugin");
			const unchanged = () => {
				const bun = Object.getOwnPropertyDescriptor(globalThis, "Bun");
				const plugin = Object.getOwnPropertyDescriptor(Bun, "plugin");
				return ["value", "writable", "enumerable", "configurable", "get", "set"].every(
					key => bun?.[key] === nativeBun?.[key] && plugin?.[key] === nativePlugin?.[key]
				);
			};
			try {
				const runtime = new JsRuntime({ initialCwd: ${JSON.stringify(root)}, sessionId: "worker-binding" });
				const hooks = { onText() {}, onDisplay() {}, callTool: async () => undefined };
				let value;
				let activeUnchanged;
				try {
					await runtime.run(${JSON.stringify(install)}, ${JSON.stringify(filename)}, hooks);
					value = await runtime.run(${JSON.stringify(load)}, ${JSON.stringify(filename)}, hooks);
					activeUnchanged = unchanged();
				} finally {
					runtime.dispose();
				}
				postMessage({ value, activeUnchanged, disposedUnchanged: unchanged() });
			} catch (error) {
				postMessage({ error: String(error?.stack ?? error) });
			}`,
		);
		const worker = new Worker(workerEntry, { type: "module" });
		const response = Promise.withResolvers<unknown>();
		const timeout = setTimeout(() => response.reject(new Error("Worker runtime did not respond")), 10_000);
		worker.addEventListener("message", event => response.resolve(event.data));
		worker.addEventListener("error", event => response.reject(event.error ?? new Error(event.message)));
		try {
			expect(await response.promise).toEqual({
				value: [42, 42, 42, "worker"],
				activeUnchanged: true,
				disposedUnchanged: true,
			});
		} finally {
			clearTimeout(timeout);
			worker.terminate();
		}
	}, 15_000);

	test("synchronous require aliases share the plugin registry and asynchronous hooks report incompatibility", async () => {
		writeFixture("plugin-require/value.cjs", 'module.exports = { value: "required" };');
		const cwd = path.join(root, "plugin-require");
		const filename = path.join(cwd, "cell.js");
		const runtime = new JsRuntime({ initialCwd: cwd, sessionId: "plugin-require" });
		try {
			expect(
				await runtime.run(
					`(async () => {
						const { createRequire } = await import("node:module");
						const scopedRequire = createRequire(${JSON.stringify(filename)});
						scopedRequire("bun").plugin({ name: "require-alias", setup(build) {
							build.onResolve({ filter: /^require-alias$/ }, () => ({ path: "./value.cjs" }));
							build.onResolve({ filter: /^async-require-alias$/ }, async () => ({ path: "./value.cjs" }));
						}});
						return [require("require-alias").value, scopedRequire("require-alias").value,
							(await import("require-alias")).default.value];
					})()`,
					filename,
					hooks,
				),
			).toEqual(["required", "required", "required"]);
			await expect(runtime.run('require("async-require-alias")', filename, hooks)).rejects.toThrow(
				"Async onResolve hooks cannot be used with require()",
			);
			expect(await runtime.run('(await import("async-require-alias")).default.value', filename, hooks)).toBe(
				"required",
			);
		} finally {
			runtime.dispose();
		}
	});

	test("onResolve errors are preserved and failed plugin setup does not register partial hooks", async () => {
		const runtime = new JsRuntime({ initialCwd: root, sessionId: "plugin-errors" });
		const filename = path.join(root, "cell.js");
		try {
			await runtime.run(
				`Bun.plugin({ name: "error", setup(build) {
					build.onResolve({ filter: /^resolver-error$/ }, () => { throw new Error("resolver rejected the import"); });
				}});`,
				filename,
				hooks,
			);
			await expect(runtime.run('await import("resolver-error")', filename, hooks)).rejects.toThrow(
				"resolver rejected the import",
			);
			await expect(
				runtime.run(
					`await Bun.plugin({ name: "failed-setup", async setup(build) {
						build.onResolve({ filter: /^partially-registered$/ }, () => ({ path: "node:path" }));
						throw new Error("setup failed");
					}});`,
					filename,
					hooks,
				),
			).rejects.toThrow("setup failed");
			await expect(runtime.run('await import("partially-registered")', filename, hooks)).rejects.toThrow();
		} finally {
			runtime.dispose();
		}
	});
});
