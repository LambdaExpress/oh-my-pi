import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { $ } from "bun";
import { resolveCrossBuild } from "../packages/coding-agent/scripts/build-binary";
import { compileCodingAgent, prioritizeLargestIcoFrame } from "../packages/coding-agent/scripts/compile-binary";

const repoRoot = path.join(import.meta.dir, "..");

describe("Windows release binary target", () => {
	it("keeps Explorer on the Tauri icon's 256px frame when Bun preserves its default icon group", async () => {
		const source = await Bun.file(path.join(repoRoot, "packages", "tauri-shell", "icons", "icon.ico")).bytes();
		const prioritized = prioritizeLargestIcoFrame(source);

		expect(prioritized[6]).toBe(0);
		expect(prioritized[7]).toBe(0);
		expect(prioritized).toHaveLength(source.length);
	});

	it("builds both Windows architecture release assets with their native runtimes", async () => {
		const result = await $`bun scripts/ci-release-build-binaries.ts --dry-run --targets win32-x64,win32-arm64`
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
		expect(output).toContain("Building packages/coding-agent/binaries/omp-windows-arm64.exe...");
		expect(output).toContain(
			"DRY RUN Bun.build target=bun-windows-arm64 outfile=packages/coding-agent/binaries/omp-windows-arm64.exe",
		);
		expect(output).toContain("external=fastembed,onnxruntime-node");
		expect(output).toContain("releaseCode=42");
		expect(output).not.toContain("bun-windows-x64-modern");
	});

	it("resolves local Windows cross-build aliases for both architectures", () => {
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
		expect(resolveCrossBuild("win32-arm64")).toEqual({
			id: "win32-arm64",
			platform: "win32",
			arch: "arm64",
			target: "bun-windows-arm64",
		});
		expect(resolveCrossBuild("windows-arm64")).toEqual({
			id: "windows-arm64",
			platform: "win32",
			arch: "arm64",
			target: "bun-windows-arm64",
		});
	});
});

it("runs compiled bytecode containing dependency import.meta.resolve calls", async () => {
	using temp = TempDir.createSync("@omp-bytecode-");
	const entrypoint = temp.join("entry.ts");
	const outfile = temp.join(process.platform === "win32" ? "probe.exe" : "probe");
	await Bun.write(entrypoint, 'console.log(import.meta.resolve("node:fs"));\n');
	await compileCodingAgent({
		repoRoot: temp.path(),
		entrypoint,
		outfile,
		transformersVersion: "unused",
	});
	const result = await $`${outfile}`.quiet().nothrow();
	expect(result.exitCode).toBe(0);
	expect(result.text().trim()).toBe("node:fs");
}, 30_000);
describe("macOS release binary entitlements", () => {
	it("allows Xcode MCP automation through Apple Events", async () => {
		const entitlements = await Bun.file(path.join(repoRoot, "scripts/macos-entitlements.plist")).text();

		expect(entitlements).toContain("<key>com.apple.security.automation.apple-events</key>\n\t<true/>");
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
