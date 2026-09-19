#!/usr/bin/env bun

import { createRequire } from "node:module";
import * as path from "node:path";
import { isDevelopmentBuildCode, parseReleaseCode } from "../src/release-code";
import { compileCodingAgent } from "./compile-binary";

const packageDir = path.join(import.meta.dir, "..");
const repoRoot = path.join(packageDir, "..", "..");

/** Binary cross-compilation settings selected by `CROSS_TARGET`. */
export interface CrossBuild {
	readonly id: string;
	readonly platform: string;
	readonly arch: string;
	readonly target: Bun.Build.CompileTarget;
}

/** Resolves a CROSS_TARGET value to the Bun compile target used by local binary builds. */
export function resolveCrossBuild(value: string | undefined): CrossBuild | null {
	switch (value) {
		case undefined:
		case "":
			return null;
		case "darwin-arm64":
			return { id: value, platform: "darwin", arch: "arm64", target: "bun-darwin-arm64" };
		case "darwin-x64":
			return { id: value, platform: "darwin", arch: "x64", target: "bun-darwin-x64" };
		case "linux-arm64":
			return { id: value, platform: "linux", arch: "arm64", target: "bun-linux-arm64" };
		case "linux-x64":
			return { id: value, platform: "linux", arch: "x64", target: "bun-linux-x64-baseline" };
		case "win32-x64":
		case "windows-x64":
			return { id: value, platform: "win32", arch: "x64", target: "bun-windows-x64-baseline" };
		case "win32-arm64":
		case "windows-arm64":
			return { id: value, platform: "win32", arch: "arm64", target: "bun-windows-arm64" };
		default:
			throw new Error(`Unsupported CROSS_TARGET: ${value}`);
	}
}

// Transformers.js is an optional, native-heavy dependency that is never bundled
// into the binary; the tiny-model worker `bun install`s it into a runtime cache
// on first use. The `catalog:` spec cannot be resolved from inside the compiled
// bunfs (issue #1763), so embed the concrete installed version here for the
// worker to pin its runtime install against.
const transformersManifest: unknown = createRequire(import.meta.url)("@huggingface/transformers/package.json");
if (
	typeof transformersManifest !== "object" ||
	transformersManifest === null ||
	!("version" in transformersManifest) ||
	typeof transformersManifest.version !== "string"
) {
	throw new Error("@huggingface/transformers package manifest has no string version");
}
const transformersVersion = transformersManifest.version;

async function runCommand(
	command: string[],
	env: NodeJS.ProcessEnv = Bun.env,
	cwd: string = packageDir,
): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd,
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
	}
}

/**
 * Execute what we just built. A broken module graph (for example a live
 * `import.meta` under precompiled bytecode, see issue #12127) dies before
 * printing anything, and only running the artifact catches it — every other
 * gate exercises the TypeScript entrypoint through `bun`, which cannot
 * reproduce the failure.
 */
async function verifyBinaryBoots(outfile: string): Promise<void> {
	const proc = Bun.spawn([outfile, "--version"], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (exitCode !== 0 || stdout.trim().length === 0) {
		throw new Error(
			`Compiled binary ${outfile} does not boot (exit code ${exitCode}).\n` +
				`stdout: ${stdout.trim()}\nstderr: ${stderr.trim()}`,
		);
	}
	console.log(`verified: ${outfile} boots (${stdout.trim()})`);
}

async function main(): Promise<void> {
	const configuredReleaseCode = Bun.env.OMP_RELEASE_CODE;
	if (
		configuredReleaseCode !== undefined &&
		parseReleaseCode(configuredReleaseCode) === undefined &&
		!isDevelopmentBuildCode(configuredReleaseCode)
	) {
		throw new Error(`OMP_RELEASE_CODE must be a non-negative safe integer or dev, got: ${configuredReleaseCode}`);
	}
	const releaseCode = configuredReleaseCode ?? "0";
	const crossBuild = resolveCrossBuild(Bun.env.CROSS_TARGET);
	const shouldAdhocSign = process.platform === "darwin" && !crossBuild && Bun.env.BUN_NO_CODESIGN_MACHO_BINARY !== "1";
	const outName = crossBuild ? `omp-${crossBuild.id}` : "omp";
	const configuredOutput = Bun.env.OMP_BINARY_OUTFILE?.trim();
	const outputPath = configuredOutput
		? path.resolve(packageDir, configuredOutput)
		: path.join(packageDir, "dist", outName);
	// Generate inside the try so the finally always restores the empty checked-in
	// placeholders (stats client archive, docs index) even on failure.
	try {
		await runCommand(["bun", "--cwd=../stats", "run", "gen:stats"]);
		// The in-memory legacy Pi virtual module reaches the coding-agent
		// `export/html` subpath, whose source imports `tool-views.generated.js`.
		// Rebuild it before compilation so clean checkouts that skipped install
		// hooks still contain that generated bundle.
		await runCommand(["bun", "--cwd=../collab-web", "run", "gen:tool-views"]);
		await runCommand(
			["bun", "--cwd=../natives", "run", "gen:native"],
			crossBuild ? { ...Bun.env, TARGET_PLATFORM: crossBuild.platform, TARGET_ARCH: crossBuild.arch } : Bun.env,
		);
		try {
			const compiledPath = await compileCodingAgent({
				repoRoot,
				entrypoint: path.join(packageDir, "src", "cli.ts"),
				outfile: outputPath,
				transformersVersion,
				releaseCode,
				target: crossBuild?.target,
				executablePath: Bun.env.BUN_COMPILE_EXECUTABLE_PATH || undefined,
				skipBuiltinCodesign: shouldAdhocSign,
			});

			if (shouldAdhocSign) {
				await runCommand(["codesign", "--force", "--sign", "-", outputPath]);
			}
			if (!crossBuild) {
				await verifyBinaryBoots(compiledPath);
			}
		} finally {
			await runCommand(["bun", "--cwd=../natives", "run", "gen:native:reset"]);
		}
	} finally {
		await runCommand(["bun", "--cwd=../stats", "run", "gen:stats:reset"]);
	}
}

if (import.meta.main) await main();
