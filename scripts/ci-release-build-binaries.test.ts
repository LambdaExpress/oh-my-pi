import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $ } from "bun";
import { resolveCrossBuild } from "../packages/coding-agent/scripts/build-binary";
import { prioritizeLargestIcoFrame } from "../packages/coding-agent/scripts/compile-binary";

const repoRoot = path.join(import.meta.dir, "..");

describe("Windows release binary target", () => {
	it("keeps Explorer on the Tauri icon's 256px frame when Bun preserves its default icon group", async () => {
		const source = await Bun.file(path.join(repoRoot, "packages", "tauri-shell", "icons", "icon.ico")).bytes();
		const prioritized = prioritizeLargestIcoFrame(source);

		expect(prioritized[6]).toBe(0);
		expect(prioritized[7]).toBe(0);
		expect(prioritized).toHaveLength(source.length);
	});

	it("builds the generic Windows release asset with the baseline runtime", async () => {
		const result = await $`bun scripts/ci-release-build-binaries.ts --dry-run --targets win32-x64`
			.cwd(repoRoot)
			.env({ ...Bun.env, OMP_RELEASE_CODE: "42" })
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(0);
		const output = result.text();

		expect(output).toContain("Building packages/coding-agent/binaries/omp-windows-x64.exe...");
		expect(output).toContain(
			"DRY RUN Bun.build target=bun-windows-x64-baseline outfile=packages/coding-agent/binaries/omp-windows-x64.exe",
		);
		expect(output).toContain("external=fastembed,onnxruntime-node");
		expect(output).toContain("releaseCode=42");
		expect(output).not.toContain("bun-windows-x64-modern");
	});

	it("uses the baseline runtime for local Windows cross-build aliases", () => {
		expect(resolveCrossBuild("win32-x64")).toEqual({
			id: "win32-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
		});
		expect(resolveCrossBuild("windows-x64")).toEqual({
			id: "windows-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
		});
	});
});

describe("macOS release binary targets", () => {
	it("builds native Apple Silicon and Intel assets with the embedded release code", async () => {
		const result = await $`bun scripts/ci-release-build-binaries.ts --dry-run --targets darwin-arm64,darwin-x64`
			.cwd(repoRoot)
			.env({ ...Bun.env, OMP_RELEASE_CODE: "42" })
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(0);
		const output = result.text();

		expect(output).toContain(
			"DRY RUN Bun.build target=bun-darwin-arm64 outfile=packages/coding-agent/binaries/omp-darwin-arm64 releaseCode=42",
		);
		expect(output).toContain(
			"DRY RUN Bun.build target=bun-darwin-x64 outfile=packages/coding-agent/binaries/omp-darwin-x64 releaseCode=42",
		);
	});
});
