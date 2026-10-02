import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KernelModuleResolution } from "@oh-my-pi/pi-coding-agent/eval/js/shared/module-resolution";

// Compiled builds cannot resolve on-disk packages through the stock runtime, so
// these are the primitives the eval kernel leans on instead: a walk-up
// `node_modules` resolver and a require wrapper that survives the runtime's
// resolver patch. The end-to-end failure (cells importing installed packages)
// only reproduces inside a compiled binary; this file pins the contract those
// builds depend on.
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
});
