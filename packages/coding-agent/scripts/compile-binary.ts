import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
 */
export async function compileCodingAgent(options: CodingAgentCompileOptions): Promise<void> {
	const previousCodesignSetting = Bun.env.BUN_NO_CODESIGN_MACHO_BINARY;
	const isWindowsTarget = options.target?.startsWith("bun-windows-") ?? process.platform === "win32";
	const windowsIconPath = isWindowsTarget ? await createWindowsCompileIcon(options.repoRoot) : undefined;
	if (options.skipBuiltinCodesign) {
		Bun.env.BUN_NO_CODESIGN_MACHO_BINARY = "1";
	}
	try {
		await generateCollabWebEmbed(options.repoRoot);
		const output = await Bun.build({
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
			plugins: [await createLegacyPiVirtualModulePlugin()],
			compile: {
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
		});
		if (!output.success) {
			throw new Error(`Coding-agent binary bundle failed:\n${output.logs.map(log => log.message).join("\n")}`);
		}
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
