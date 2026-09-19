import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
// Deep import: the pi-utils barrel loads the host native addon, which is
// absent on cross-compiling release runners.
import { USER_AGENT } from "@oh-my-pi/pi-utils/dirs";
import { generateCollabWebEmbed, resetCollabWebEmbed } from "./embed-collab-web";
import { buildDocsIndexPayload } from "./generate-docs-index";
import { createLegacyPiVirtualModulePlugin } from "./legacy-pi-virtual-module";

/** Native runtime dependencies always resolved from the on-demand install instead of embedded into compiled binaries. */
export const COMPILED_EXTERNAL_DEPENDENCIES: readonly string[] = Object.freeze(["fastembed", "onnxruntime-node"]);

/** Inputs shared by local and release coding-agent binary builds. */
export interface CodingAgentCompileOptions {
	/** Absolute repository root used for package resolution. */
	readonly repoRoot: string;
	/** Absolute CLI entrypoint. */
	readonly entrypoint: string;
	/** Absolute standalone executable output path. */
	readonly outfile: string;
	/** Concrete Transformers.js version baked into the tiny-model worker. */
	readonly transformersVersion: string;
	/** Fork release code baked into `omp --version` and self-update verification. */
	readonly releaseCode?: string;
	/** Optional cross-compilation runtime target. */
	readonly target?: Bun.Build.CompileTarget;
	/** Optional unmodified Bun executable used as the standalone runtime template. */
	readonly executablePath?: string;
	/** Match release builds that minify identifiers while retaining names. */
	readonly minifyIdentifiers?: boolean;
	/** Disable Bun's built-in Darwin signing before the caller re-signs. */
	readonly skipBuiltinCodesign?: boolean;
}

const ICO_HEADER_SIZE = 6;
const ICO_DIRECTORY_ENTRY_SIZE = 16;

/**
 * Bun reports a failed bytecode pass only as an error log while still
 * resolving the build successfully, and the executable it writes then dies at
 * module load with `SyntaxError: import.meta is only valid inside modules.`
 * (issue #12127). The build verifies the artifact and drops bytecode when this
 * appears, so a failure can never ship.
 */
const BYTECODE_FAILURE_MESSAGE = /failed to generate bytecode/i;

/** The one dependency module in the graph that uses a non-inlinable `import.meta` member. */
const YARGS_APPLY_EXTENDS_MODULE = /yargs[\\/]build[\\/]lib[\\/]utils[\\/]apply-extends\.js$/;
const IMPORT_META_RESOLVE_CALL = "import.meta.resolve(";
const SHIM_REQUIRE_RESOLVE_CALL = "_shim.require.resolve(";
/** Any `import.meta` member Bun's bytecode pass cannot inline. */
const NON_INLINABLE_IMPORT_META = /\bimport\.meta\.(?!url\b|dir\b|main\b|path\b|dirname\b)[A-Za-z_$]/;

/**
 * Build plugin that removes the single non-inlinable `import.meta` usage in
 * the bundle graph so `bytecode: true` keeps working (issue #12127).
 *
 * `@puppeteer/browsers/lib/main.js` re-exports `CLI`, which pulls `yargs` in
 * through `lib/CLI.js`, and yargs' ESM build resolves extended configs with
 * `import.meta.resolve()`. Bun's bytecode pass inlines only
 * `import.meta.url`/`.dir`/`.main`/`.path`/`.dirname`; anything else survives
 * as a real `import.meta` and the module is evaluated as a script, so the
 * binary dies at boot. `applyExtends` loads the config through the yargs
 * platform shim's `require` right after resolving it, and that shim's `require`
 * is a `createRequire(import.meta.url)`, so resolving through it keeps the
 * original meaning. Drop this plugin once Bun inlines `import.meta.resolve`
 * (or yargs stops using it).
 */
export function createImportMetaCompatPlugin(): Bun.BunPlugin {
	return {
		name: "omp-import-meta-compat",
		setup(build) {
			build.onLoad({ filter: YARGS_APPLY_EXTENDS_MODULE }, async args => {
				const source = await Bun.file(args.path).text();
				if (!source.includes(IMPORT_META_RESOLVE_CALL)) {
					return { contents: source, loader: "js" };
				}
				const patched = source.replaceAll(IMPORT_META_RESOLVE_CALL, SHIM_REQUIRE_RESOLVE_CALL);
				const leftover = NON_INLINABLE_IMPORT_META.exec(patched);
				if (leftover) {
					throw new Error(
						`${args.path} still uses ${leftover[0]} after the bytecode compatibility rewrite; ` +
							"extend createImportMetaCompatPlugin() in scripts/compile-binary.ts, otherwise the compiled binary cannot boot.",
					);
				}
				return { contents: patched, loader: "js" };
			});
		},
	};
}

/**
 * Put the largest ICO frame first without moving its payload.
 *
 * Bun 1.3.14 keeps its original `IDI_MYICON` group after applying a custom
 * Windows icon. That group points at icon resource 1, while Bun assigns custom
 * icon resource IDs in ICO directory order. A conventional smallest-first ICO
 * therefore makes Explorer upscale the 16px frame even though all larger
 * frames are present. Keeping the 256px frame at ID 1 makes the surviving group
 * resolve to the full-resolution Tauri icon.
 */
export function prioritizeLargestIcoFrame(source: Uint8Array): Uint8Array {
	if (source.byteLength < ICO_HEADER_SIZE) throw new Error("Windows icon has a truncated ICO header");
	const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
	const reserved = view.getUint16(0, true);
	const type = view.getUint16(2, true);
	const count = view.getUint16(4, true);
	if (reserved !== 0 || type !== 1 || count === 0) throw new Error("Windows icon is not a valid ICO file");
	if (ICO_HEADER_SIZE + count * ICO_DIRECTORY_ENTRY_SIZE > source.byteLength) {
		throw new Error("Windows icon has a truncated ICO directory");
	}

	const entries = Array.from({ length: count }, (_, index) => {
		const offset = ICO_HEADER_SIZE + index * ICO_DIRECTORY_ENTRY_SIZE;
		const width = source[offset] || 256;
		const height = source[offset + 1] || 256;
		const bitCount = view.getUint16(offset + 6, true);
		const dataSize = view.getUint32(offset + 8, true);
		const dataOffset = view.getUint32(offset + 12, true);
		if (dataOffset > source.byteLength || dataSize > source.byteLength - dataOffset) {
			throw new Error("Windows icon contains an out-of-bounds ICO frame");
		}
		return { offset, width, height, bitCount };
	}).sort((a, b) => b.width * b.height - a.width * a.height || b.bitCount - a.bitCount);

	const output = source.slice();
	for (const [index, entry] of entries.entries()) {
		output.set(
			source.subarray(entry.offset, entry.offset + ICO_DIRECTORY_ENTRY_SIZE),
			ICO_HEADER_SIZE + index * ICO_DIRECTORY_ENTRY_SIZE,
		);
	}
	return output;
}

async function createWindowsCompileIcon(repoRoot: string): Promise<string> {
	const sourcePath = path.join(repoRoot, "packages", "tauri-shell", "icons", "icon.ico");
	const tempPath = path.join(os.tmpdir(), `omp-windows-icon-${process.pid}-${Bun.randomUUIDv7()}.ico`);
	await Bun.write(tempPath, prioritizeLargestIcoFrame(await Bun.file(sourcePath).bytes()));
	return tempPath;
}

/**
 * Compile the coding-agent executable with its legacy Pi compatibility module
 * graph supplied by an in-memory build plugin rather than generated files.
 *
 * @returns Path of the executable Bun actually wrote, including the platform
 * suffix, so callers can execute it as a build gate.
 */
export async function compileCodingAgent(options: CodingAgentCompileOptions): Promise<string> {
	const previousCodesignSetting = Bun.env.BUN_NO_CODESIGN_MACHO_BINARY;
	const isWindowsTarget = options.target?.startsWith("bun-windows-") ?? process.platform === "win32";
	const windowsIconPath = isWindowsTarget ? await createWindowsCompileIcon(options.repoRoot) : undefined;
	if (options.skipBuiltinCodesign) {
		Bun.env.BUN_NO_CODESIGN_MACHO_BINARY = "1";
	}
	try {
		await generateCollabWebEmbed(options.repoRoot);
		const compileOptions = {
			entrypoints: [options.entrypoint],
			root: options.repoRoot,
			external: [...COMPILED_EXTERNAL_DEPENDENCIES],
			define: {
				"process.env.PI_COMPILED": JSON.stringify("true"),
				"process.env.PI_TINY_TRANSFORMERS_VERSION": JSON.stringify(options.transformersVersion),
				"process.env.PI_DOCS_EMBED": JSON.stringify((await buildDocsIndexPayload()).payload),
				"process.env.OMP_RELEASE_CODE": JSON.stringify(options.releaseCode ?? "0"),
			},
			minify: {
				identifiers: options.minifyIdentifiers ?? false,
				keepNames: true,
			},
			compile: {
				// Bun's process-wide fetch User-Agent default. Any explicit
				// provider fingerprint (Anthropic/Codex OAuth) still wins.
				execArgv: [`--user-agent=${USER_AGENT}`],
				...(options.executablePath
					? { executablePath: options.executablePath }
					: options.target
						? { target: options.target }
						: {}),
				...(windowsIconPath ? { windows: { icon: windowsIconPath } } : {}),
				outfile: options.outfile,
				autoloadBunfig: false,
				autoloadDotenv: false,
				autoloadTsconfig: false,
				autoloadPackageJson: false,
			},
			throw: false,
		} satisfies Omit<Bun.BuildConfig, "bytecode" | "plugins">;
		const buildBundle = async (bytecode: boolean): Promise<Bun.BuildOutput> =>
			Bun.build({
				...compileOptions,
				// Precompiled bytecode skips parsing the ~20 MB bundle at boot:
				// `omp --version` 256 ms -> 30 ms on M4 Max (+52 MB binary).
				// Bytecode rejects top-level await in the bundle graph, and its
				// failure mode is a binary that cannot boot, so it is verified
				// below and dropped for the affected graph.
				bytecode,
				plugins: [await createLegacyPiVirtualModulePlugin(), createImportMetaCompatPlugin()],
			});
		const wantsBytecode = Bun.env.OMP_BUILD_BYTECODE !== "0";
		let output = await buildBundle(wantsBytecode);
		const bytecodeFailures = output.logs
			.filter(log => BYTECODE_FAILURE_MESSAGE.test(log.message))
			.map(log => log.message);
		if (wantsBytecode && bytecodeFailures.length > 0) {
			console.warn(
				`warning: precompiled bytecode failed for this bundle graph, rebuilding without it (slower startup):\n${bytecodeFailures.join("\n")}`,
			);
			output = await buildBundle(false);
		}
		if (!output.success) {
			throw new Error(`Coding-agent binary bundle failed:\n${output.logs.map(log => log.message).join("\n")}`);
		}
		// Bun appends the platform executable suffix (`.exe`) on Windows, so the
		// caller verifies the artifact Bun actually wrote rather than the request.
		return output.outputs[0]?.path ?? options.outfile;
	} finally {
		try {
			await resetCollabWebEmbed(options.repoRoot);
		} finally {
			try {
				if (windowsIconPath) await fs.rm(windowsIconPath, { force: true });
			} finally {
				if (previousCodesignSetting === undefined) {
					delete Bun.env.BUN_NO_CODESIGN_MACHO_BINARY;
				} else {
					Bun.env.BUN_NO_CODESIGN_MACHO_BINARY = previousCodesignSetting;
				}
			}
		}
	}
}
