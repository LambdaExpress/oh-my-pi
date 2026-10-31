import { afterEach, describe, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { disposeVmContextsByOwner } from "../../src/eval/js/context-manager";
import { executeJs } from "../../src/eval/js/executor";
import type { JsExecutorOptions } from "../../src/eval/js/executor";
import { resolveJsPackageEnvironment } from "../../src/eval/js/package-installer";
import type { ToolSession } from "../../src/tools";

function makeSession(cwd: string, evalSessionId: string, options?: { autoProvision?: boolean }): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"eval.autoProvision": options?.autoProvision ?? true,
			"task.isolation.enabled": false,
			"task.enableLsp": true,
		}),
		taskDepth: 0,
		enableLsp: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => "p/active",
		getModelString: () => "p/fallback",
		getArtifactsDir: () => null,
		getSessionId: () => evalSessionId,
		getEvalSessionId: () => evalSessionId,
	};
}

const kernelOwners = new Set<string>();

function executorOptions(session: ToolSession, sessionId: string): JsExecutorOptions {
	kernelOwners.add(sessionId);
	return { cwd: session.cwd, sessionId, kernelOwnerId: sessionId, session };
}

function canResolve(specifier: string, fromDir: string): boolean {
	try {
		Bun.resolveSync(specifier, fromDir);
		return true;
	} catch {
		return false;
	}
}

/**
 * Picks a package OMP itself resolves but the workspace cannot. Prefers `@babel/parser`; a stray
 * `node_modules` above the temp dir (e.g. `npm i` run in the Windows profile dir) legitimately puts
 * it in the workspace's ancestry, so fall back to any other package installed for OMP.
 */
function ompOnlyPackage(workspaceDir: string): string {
	const ompDir = path.resolve(import.meta.dir, "../..");
	const repoModules = path.resolve(ompDir, "../../node_modules");
	const candidates = [
		"@babel/parser",
		...fsSync.readdirSync(repoModules).filter(name => !name.startsWith(".") && !name.startsWith("@")),
	];
	const picked = candidates.find(name => canResolve(name, ompDir) && !canResolve(name, workspaceDir));
	if (!picked) throw new Error(`Every OMP dependency is also resolvable from ${workspaceDir}`);
	return picked;
}

describe("persistent JavaScript package environments", () => {
	const managedRoots: string[] = [];
	const kernelProcesses: Process[] = [];

	afterEach(async () => {
		await Promise.all([...kernelOwners].map(owner => disposeVmContextsByOwner(owner)));
		kernelOwners.clear();
		for (const kernel of kernelProcesses.splice(0)) {
			// Owner disposal acknowledges closure before the subprocess has necessarily exited.
			expect(await kernel.waitForExit({ timeoutMs: 10_000 })).toBe(true);
		}
		await Promise.all(
			managedRoots
				.splice(0)
				.flatMap(root => [
					fs.rm(root, { recursive: true, force: true }),
					fs.rm(`${root}.install.lock`, { force: true }),
				]),
		);
	}, 15_000);

	it("requires absolute package directories through main and index in the isolated kernel", async () => {
		const workspace = TempDir.createSync("@omp-js-directory-require-");
		// Dispose the kernel before removing its cwd on Windows.
		managedRoots.push(workspace.path());
		const mainDir = path.join(workspace.path(), "node_modules/fixture-main");
		const indexDir = path.join(workspace.path(), "node_modules/fixture-index");
		await fs.mkdir(path.join(mainDir, "lib"), { recursive: true });
		await fs.mkdir(indexDir, { recursive: true });
		await Bun.write(
			path.join(mainDir, "package.json"),
			JSON.stringify({ name: "fixture-main", main: "lib/entry.js" }),
		);
		await Bun.write(path.join(mainDir, "lib/entry.js"), "module.exports = 'main-entry';\n");
		await Bun.write(path.join(indexDir, "index.js"), "module.exports = 'index-entry';\n");
		const sessionId = `js-directory-require:${crypto.randomUUID()}`;
		const session = makeSession(workspace.path(), sessionId);
		const options = { ...executorOptions(session, sessionId), environment: "project" as const };
		const started = await executeJs("print(process.pid);", options);
		expect(started.exitCode, started.output).toBe(0);
		const kernelPid = Number(started.output.trim());
		expect(Number.isSafeInteger(kernelPid)).toBe(true);
		if (kernelPid !== process.pid) {
			// Open while alive: the stable reference cannot target a later process that reuses this PID.
			const kernel = Process.fromPid(kernelPid);
			expect(kernel).not.toBeNull();
			if (kernel) {
				kernelProcesses.push(kernel);
				expect(kernel.ppid).toBe(process.pid);
			}
		}
		const result = await executeJs(
			[
				`var directoryRequire = require("node:module").createRequire(${JSON.stringify(path.join(workspace.path(), "cell.js"))});`,
				"print(JSON.stringify([",
				`require(${JSON.stringify(mainDir.replaceAll("\\", "/"))}),`,
				`require(${JSON.stringify(indexDir)}),`,
				`directoryRequire(${JSON.stringify(mainDir)}),`,
				`require.resolve(${JSON.stringify(mainDir.replaceAll("\\", "/"))}),`,
				`process.pid !== ${process.pid}`,
				"]));",
			].join("\n"),
			options,
		);

		expect(result.exitCode, result.output).toBe(0);
		expect(JSON.parse(result.output.trim())).toEqual([
			"main-entry",
			"index-entry",
			"main-entry",
			path.join(mainDir, "lib/entry.js"),
			true,
		]);
	}, 20_000);

	it("refuses an implicit managed environment bootstrap when auto-provisioning is disabled", async () => {
		using workspace = TempDir.createSync("@omp-js-package-policy-");
		const sessionId = `js-package-policy:${crypto.randomUUID()}`;
		const session = makeSession(workspace.path(), sessionId, { autoProvision: false });
		const environment = resolveJsPackageEnvironment(workspace.path());
		managedRoots.push(environment.root);

		const result = await executeJs("", {
			...executorOptions(session, sessionId),
			packages: ["package-that-must-not-be-fetched"],
		});
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("eval.autoProvision is disabled");
		await expect(fs.access(path.join(environment.root, "package.json"))).rejects.toBeDefined();
	});

	it("resolves file imports from the filename while preserving cwd and repeat execution", async () => {
		using workspace = TempDir.createSync("@omp-js-file-workspace-");
		using scriptDir = TempDir.createSync("@omp-js-file-script-");
		const filename = path.join(scriptDir.path(), "loaded.ts");
		const source = [
			'import { amount } from "./sibling.ts";',
			"globalThis.fileLoadCount = (globalThis.fileLoadCount ?? 0) + 1;",
			"var fileLoadedValue = fileSeed + amount;",
			"function fileAnswer() { return fileLoadedValue; }",
			"var fileObservedCwd = process.cwd();",
		].join("\n");
		await Bun.write(path.join(scriptDir.path(), "sibling.ts"), "export const amount = 2;\n");
		await Bun.write(filename, source);

		const sessionId = `js-file:${crypto.randomUUID()}`;
		const session = makeSession(workspace.path(), sessionId);
		const options = executorOptions(session, sessionId);
		await executeJs("var fileSeed = 10;", options);
		const first = await executeJs(source, { ...options, filename });
		const second = await executeJs(source, { ...options, filename });
		expect(first.exitCode).toBe(0);
		expect(second.exitCode).toBe(0);
		expect(first.output).not.toContain(source);
		expect(second.output).not.toContain(source);

		const reloadSource = "fileLoadedValue += 1; fileLoadedValue;";
		await Bun.write(filename, reloadSource);
		const reloaded = await executeJs(reloadSource, { ...options, filename });
		expect(reloaded.output.trim()).toBe("13");

		const retained = await executeJs("JSON.stringify([fileAnswer(), fileObservedCwd, fileLoadCount])", options);
		expect(JSON.parse(retained.output.trim())).toEqual([13, await fs.realpath(workspace.path()), 2]);
	});

	it("does not resolve a missing project package from OMP's own dependencies", async () => {
		// Dynamic import is the behavior under test: a static import would be
		// resolved by this test module's own dependency graph.
		using workspace = TempDir.createSync("@omp-js-package-missing-");
		const sessionId = `js-package-missing:${crypto.randomUUID()}`;
		const session = makeSession(workspace.path(), sessionId);
		const specifier = ompOnlyPackage(workspace.path());
		const result = await executeJs(`await import(${JSON.stringify(specifier)})`, executorOptions(session, sessionId));
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("JS package environment fallback");
	});

	it("imports and refreshes workspace exports with type-only imports and realpath-relative dependencies", async () => {
		using workspace = TempDir.createSync("@omp-js-workspace-exports-");
		const packageDir = workspace.join("packages/library");
		await Bun.write(
			path.join(packageDir, "package.json"),
			JSON.stringify({
				name: "@fixture/library",
				type: "module",
				exports: { "./tools/*": { types: "./types/*.d.ts", import: "./src/*.ts" } },
			}),
		);
		await Bun.write(
			path.join(packageDir, "src/value.ts"),
			'import { marker } from "fixture-dependency"; export const value = marker + ":workspace";\n',
		);
		await Bun.write(
			path.join(packageDir, "node_modules/fixture-dependency/package.json"),
			JSON.stringify({ name: "fixture-dependency", main: "./index.js" }),
		);
		await Bun.write(path.join(packageDir, "node_modules/fixture-dependency/index.js"), 'exports.marker = "local";\n');
		await fs.mkdir(workspace.join("node_modules/@fixture"), { recursive: true });
		await fs.symlink(
			packageDir,
			workspace.join("node_modules/@fixture/library"),
			process.platform === "win32" ? "junction" : "dir",
		);
		await Bun.write(
			workspace.join("entry.ts"),
			[
				'import type { Unused } from "uninstalled-types";',
				'import { type AlsoUnused } from "another-uninstalled-type";',
				'import { value } from "@fixture/library/tools/value";',
				"export const answer: string = value;",
			].join("\n"),
		);
		const sessionId = `js-workspace-exports:${crypto.randomUUID()}`;
		const session = makeSession(workspace.path(), sessionId);
		const result = await executeJs(
			'import { answer } from "./entry.ts"; answer;',
			executorOptions(session, sessionId),
		);
		expect(result.exitCode, result.output).toBe(0);
		expect(result.output.trim()).toBe("local:workspace");

		const filename = path.join(packageDir, "src/value.ts");
		const updatedTime = new Date((await fs.stat(filename)).mtimeMs + 2_000);
		await Bun.write(
			filename,
			'import { marker } from "fixture-dependency"; export const value = marker + ":updated";\n',
		);
		await fs.utimes(filename, updatedTime, updatedTime);
		const updated = await executeJs(
			'import { answer as updatedAnswer } from "./entry.ts"; updatedAnswer;',
			executorOptions(session, sessionId),
		);
		expect(updated.exitCode, updated.output).toBe(0);
		expect(updated.output.trim()).toBe("local:updated");
	});

	it("preserves module-owned require and filename bindings", async () => {
		using workspace = TempDir.createSync("@omp-js-module-bindings-");
		await Bun.write(workspace.join("directory.ts"), 'export const directory = "module-dir";\n');
		await Bun.write(
			workspace.join("block-shadow.ts"),
			'if (true) { function require() { return "shadow"; } void require; } export const separator = require("node:path").sep;\n',
		);
		await Bun.write(
			workspace.join("entry.ts"),
			[
				'import { directory as __dirname } from "./directory.ts";',
				'export function require(value: string) { return "module:" + value; }',
				'const { __filename } = { __filename: "module-file" };',
				'import { separator } from "./block-shadow.ts";',
				'export const answer = [require("value"), __dirname, __filename, separator];',
			].join("\n"),
		);
		const sessionId = `js-module-bindings:${crypto.randomUUID()}`;
		const session = makeSession(workspace.path(), sessionId);
		const result = await executeJs(
			'import { answer } from "./entry.ts"; JSON.stringify(answer);',
			executorOptions(session, sessionId),
		);
		expect(result.exitCode, result.output).toBe(0);
		expect(JSON.parse(result.output.trim())).toEqual(["module:value", "module-dir", "module-file", path.sep]);
	});

	it("uses the selected package environment only when the project does not own the package", async () => {
		using workspace = TempDir.createSync("@omp-js-package-boundary-");
		const environment = resolveJsPackageEnvironment(workspace.path());
		managedRoots.push(environment.root);
		await Bun.write(
			workspace.join("node_modules/fixture-owned/package.json"),
			JSON.stringify({ name: "fixture-owned", exports: { ".": "./index.js" } }),
		);
		await Bun.write(workspace.join("node_modules/fixture-owned/index.js"), 'exports.value = "project";\n');
		await Bun.write(workspace.join("node_modules/fixture-owned/private.js"), 'exports.value = "private";\n');
		for (const name of ["fixture-owned", "fixture-fallback"]) {
			await Bun.write(
				path.join(environment.root, "node_modules", name, "package.json"),
				JSON.stringify({ name, main: "./index.js" }),
			);
			await Bun.write(
				path.join(environment.root, "node_modules", name, "index.js"),
				'exports.value = "environment";\n',
			);
			await Bun.write(
				path.join(environment.root, "node_modules", name, "private.js"),
				'exports.value = "environment-private";\n',
			);
		}
		const sessionId = `js-package-boundary:${crypto.randomUUID()}`;
		const session = makeSession(workspace.path(), sessionId);
		const options = executorOptions(session, sessionId);
		// These imports must run inside the kernel, not in the test runner's package graph.
		const result = await executeJs(
			'JSON.stringify([(await import("fixture-owned")).value, (await import("fixture-fallback")).value]);',
			options,
		);
		expect(result.exitCode, result.output).toBe(0);
		expect(JSON.parse(result.output.trim())).toEqual(["project", "environment"]);
		const hidden = await executeJs('await import("fixture-owned/private.js");', options);
		expect(hidden.exitCode).toBe(1);
		expect(hidden.output).toContain("Cannot resolve package entry");
		expect(hidden.output).not.toContain("JS package environment fallback");
	});

	it("imports repository modules whose transitive graph uses import.meta during initialization", async () => {
		using workspace = TempDir.createSync("@omp-js-repository-import-");
		const filename = path.resolve(import.meta.dir, "../../src/tools/path-utils.ts");
		const sessionId = `js-repository-import:${crypto.randomUUID()}`;
		const session = makeSession(workspace.path(), sessionId);
		const result = await executeJs(
			`import { parseFindPattern } from ${JSON.stringify(filename)}; JSON.stringify(parseFindPattern("D:/IDA*/"));`,
			executorOptions(session, sessionId),
		);
		expect(result.exitCode, result.output).toBe(0);
		expect(JSON.parse(result.output.trim())).toEqual({ basePath: "D:/", globPattern: "IDA*/", hasGlob: true });
	}, 30_000);
});
