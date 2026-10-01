import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

it("imports the CLI entry graph without loading dotenv before profile bootstrap", async () => {
	using tempDir = TempDir.createSync("@omp-js-process-import-");
	await Bun.write(path.join(tempDir.path(), ".env"), "OMP_PROCESS_ENTRY_ENV_PROBE=loaded-too-early\n");
	const env = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
	delete env.OMP_PROCESS_ENTRY_ENV_PROBE;
	env.HOME = tempDir.path();
	env.USERPROFILE = tempDir.path();
	const fixture = path.resolve(import.meta.dir, "../fixtures/js-process-entry-import.ts");
	const proc = Bun.spawn([process.execPath, fixture], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect(exitCode, stderr).toBe(0);
	expect(stdout).toBe("");
	expect(stderr).toBe("");
});

it("applies read preview preferences after cold tool and mode settings imports", async () => {
	using tempDir = TempDir.createSync("@omp-settings-import-");
	const probe = tempDir.join("probe.ts");
	const settingsUrl = new URL("../../src/config/settings.ts", import.meta.url).href;
	const registryUrl = new URL("../../src/config/registry.ts", import.meta.url).href;
	const modeSettingsUrl = new URL("../../src/modes/settings.ts", import.meta.url).href;
	const displayPreferencesUrl = new URL("../../../tui/src/chat/display-preferences.ts", import.meta.url).href;
	for (const entry of [new URL("../../src/tools/settings.ts", import.meta.url).href, modeSettingsUrl]) {
		await Bun.write(
			probe,
			`
import ${JSON.stringify(entry)};
import { Settings } from ${JSON.stringify(settingsUrl)};
import { bindEffects } from ${JSON.stringify(registryUrl)};
import {
	cfgReadToolResultPreview,
	cfgDisplayFoldToolRows,
	cfgDisplayShowTokenUsage,
} from ${JSON.stringify(modeSettingsUrl)};
import { chatTranscriptDisplayPreferences } from ${JSON.stringify(displayPreferencesUrl)};

const scoped = Settings.isolated({
	"read.toolResultPreview": true,
	"display.hideToolActivity": false,
	"display.foldToolRows": true,
	"terminal.showImages": false,
	"display.cacheMissMarker": true,
	"display.showTokenUsage": false,
	"display.showTurnTime": true,
});
const release = bindEffects(scoped);
try {
	const snapshots = [{ ...chatTranscriptDisplayPreferences }];
	cfgReadToolResultPreview.override(scoped, false);
	snapshots.push({ ...chatTranscriptDisplayPreferences });
	cfgReadToolResultPreview.override(scoped, true);
	cfgDisplayFoldToolRows.override(scoped, false);
	cfgDisplayShowTokenUsage.override(scoped, true);
	snapshots.push({ ...chatTranscriptDisplayPreferences });
	process.stdout.write(JSON.stringify(snapshots));
} finally {
	release();
}
`,
		);
		const proc = Bun.spawn([process.execPath, probe], {
			cwd: path.resolve(import.meta.dir, "../.."),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(exitCode, `${entry}: ${stderr}`).toBe(0);
		const initial = {
			hideToolActivity: false,
			readToolResultPreview: true,
			showImages: false,
			cacheMissMarker: true,
			foldToolRows: true,
			showTokenUsage: false,
			showTurnTime: true,
		};
		expect(JSON.parse(stdout)).toEqual([
			initial,
			{ ...initial, readToolResultPreview: false },
			{ ...initial, foldToolRows: false, showTokenUsage: true },
		]);
	}
}, 30_000);

async function pingComputerWorker(
	entry: string,
	id: string,
	argv: string[] = ["__omp_worker_computer"],
): Promise<unknown> {
	const worker = new Worker(entry, {
		type: "module",
		argv,
	});
	const response = Promise.withResolvers<unknown>();
	worker.addEventListener("message", event => {
		if (event.data?.type === "pong" && event.data.id === id) response.resolve(event.data);
	});
	worker.addEventListener("error", event => response.reject(event.error ?? new Error(event.message)));
	worker.postMessage({ type: "ping", id });
	try {
		return await response.promise;
	} finally {
		worker.terminate();
	}
}

it("starts ordinary CLI paths without loading computer worker or desktop modules", async () => {
	using tempDir = TempDir.createSync("@omp-cli-computer-imports-");
	const preload = tempDir.join("observe-imports.js");
	// The shared native addon also normalizes Windows paths. Observe the
	// computer-specific graph rather than disabling unrelated native features.
	await Bun.write(
		preload,
		`
import { writeSync } from "node:fs";

process.on("exit", () => {
	const registry = typeof Loader !== "undefined" && Loader.registry
		? [...Loader.registry.keys()]
		: Object.keys(require.cache);
	const modules = registry.map(module => String(module).replaceAll("\\\\", "/"));
	const computerModules = modules.filter(module =>
		module.endsWith("/tools/computer/worker.ts") ||
		module.endsWith("/tools/computer/worker-entry.ts") ||
		module.endsWith("/native/desktop.js")
	);
	const cliLoaded = modules.some(module => module.endsWith("/src/cli.ts"));
	writeSync(1, "\\nOMP_COMPUTER_IMPORTS:" + JSON.stringify({ cliLoaded, computerModules }) + "\\n");
});
`,
	);
	const cliPath = path.resolve(import.meta.dir, "../../src/cli.ts");
	for (const flag of ["--version", "--help"]) {
		const proc = Bun.spawn([process.execPath, "--preload", preload, cliPath, flag], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(exitCode, `${flag}: ${stderr}`).toBe(0);
		const observedGraph = stdout.match(/\nOMP_COMPUTER_IMPORTS:(.+)\n$/)?.[1];
		expect(observedGraph).toBeDefined();
		expect(JSON.parse(observedGraph!)).toEqual({ cliLoaded: true, computerModules: [] });
	}
	// Two cold CLI spawns (`--version`, `--help`) per run; assertions cover their
	// exit codes and imported graphs, not the wall time.
}, 30_000);

it("dispatches the computer worker through the CLI host selector in a child process", async () => {
	const fixture = path.resolve(import.meta.dir, "../fixtures/computer-worker-cli-selector.ts");
	const proc = Bun.spawn([process.execPath, fixture], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect(exitCode, stderr).toBe(0);
	expect(stdout).toBe('{"type":"pong","id":"computer-cli-selector"}\n');
});

it("loads the computer worker module directly outside a declared CLI host", async () => {
	const entry = new URL("../../src/tools/computer/worker-entry.ts", import.meta.url).href;
	const response = await pingComputerWorker(entry, "computer-direct-module", []);
	expect(response).toEqual({ type: "pong", id: "computer-direct-module" });
});

it("dispatches the computer worker from a single npm-style host bundle", async () => {
	using outDir = TempDir.createSync("@omp-computer-worker-bundle-");
	const packageDir = path.resolve(import.meta.dir, "../..");
	const nodeModulesDir = path.resolve(packageDir, "../../node_modules");
	fs.symlinkSync(nodeModulesDir, outDir.join("node_modules"), process.platform === "win32" ? "junction" : "dir");
	const output = await Bun.build({
		entrypoints: [path.join(packageDir, "test/fixtures/computer-worker-bundled-host.ts")],
		outdir: outDir.path(),
		naming: "cli.js",
		target: "bun",
		external: ["@oh-my-pi/pi-natives"],
		define: { "process.env.PI_BUNDLED": JSON.stringify("true") },
		throw: false,
	});
	expect(output.logs).toEqual([]);
	expect(output.outputs.map(file => path.basename(file.path))).toEqual(["cli.js"]);
	const response = await pingComputerWorker(output.outputs[0]!.path, "computer-npm-bundle");
	expect(response).toEqual({ type: "pong", id: "computer-npm-bundle" });
});

it("keeps non-computer selectors isolated in a compiled single-entry worker host", async () => {
	using tempDir = TempDir.createSync("@omp-compiled-worker-selector-");
	const packageDir = path.resolve(import.meta.dir, "../..");
	const outfile = path.join(tempDir.path(), process.platform === "win32" ? "worker-host.exe" : "worker-host");
	const build = Bun.spawn(
		[
			process.execPath,
			"build",
			"--compile",
			"--target=bun",
			`--outfile=${outfile}`,
			path.join(packageDir, "test/fixtures/compiled-worker-selector-host.ts"),
		],
		{ cwd: packageDir, stdout: "pipe", stderr: "pipe" },
	);
	const [buildExitCode, buildStderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
	expect(buildExitCode, buildStderr).toBe(0);
	const proc = Bun.spawn([outfile], {
		cwd: packageDir,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect(exitCode, stderr).toBe(0);
	expect(stdout).toBe('{"ok":true,"kind":"pong"}\n');
	// Compiles a standalone binary with `bun build --compile` before running it, so
	// this needs the same headroom as the other compile-backed tests.
}, 60_000);
