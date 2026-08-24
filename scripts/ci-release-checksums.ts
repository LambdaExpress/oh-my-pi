#!/usr/bin/env bun
/**
 * Generate `sha256sum`-compatible checksums for release assets.
 *
 * Usage:
 *   bun scripts/ci-release-checksums.ts <out-file> <asset>...
 *   bun scripts/ci-release-checksums.ts --markdown <out-file> <asset>...
 *
 * Each `<asset>` is hashed and written as a `<sha256>  <basename>` line,
 * sorted by basename, so the result can be verified after download with
 * `sha256sum -c SHA256SUMS.txt` (or `shasum -a 256 -c` on macOS).
 *
 * The default output is shipped as an asset by the standard release workflow.
 * `--markdown` writes the same complete digests into a temporary Release body
 * file for code releases, so no separate checksum asset is needed there.
 */

import * as path from "node:path";

export interface ChecksumEntry {
	name: string;
	sha256: string;
}

export function formatChecksums(entries: readonly ChecksumEntry[]): string {
	return entries
		.slice()
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(({ sha256, name }) => `${sha256}  ${name}\n`)
		.join("");
}

/** Format complete asset digests for direct inclusion in GitHub Release notes. */
export function formatChecksumsMarkdown(entries: readonly ChecksumEntry[]): string {
	return `## SHA256\n\n\`\`\`text\n${formatChecksums(entries)}\`\`\`\n`;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const markdown = args[0] === "--markdown";
	const [outFile, ...assetPaths] = markdown ? args.slice(1) : args;
	if (!outFile || assetPaths.length === 0) {
		throw new Error("usage: ci-release-checksums.ts [--markdown] <out-file> <asset>...");
	}

	const entries = await Promise.all(
		assetPaths.map(async assetPath => {
			const hasher = new Bun.CryptoHasher("sha256");
			for await (const chunk of Bun.file(assetPath).stream()) {
				hasher.update(chunk);
			}
			return { name: path.basename(assetPath), sha256: hasher.digest("hex") };
		}),
	);

	await Bun.write(outFile, markdown ? formatChecksumsMarkdown(entries) : formatChecksums(entries));
	console.log(`Wrote ${entries.length} checksum(s) to ${outFile}`);
}

if (import.meta.main) {
	await main();
}
