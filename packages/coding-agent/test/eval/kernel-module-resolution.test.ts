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
