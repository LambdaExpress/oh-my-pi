import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const pwsh = Bun.which("pwsh");
const tempDirs: string[] = [];

async function writeFixture(root: string, relativePath: string, content = "fixture\n"): Promise<void> {
	const filePath = path.join(root, relativePath);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content);
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!pwsh)("build-omp.ps1", () => {
	it("reuses the Windows Cargo artifact when Bazel-only version metadata is absent", async () => {
		const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-build-ps1-"));
		tempDirs.push(fixtureRoot);

		const fixtureScript = path.join(fixtureRoot, "scripts", "build-omp.ps1");
		await fs.mkdir(path.dirname(fixtureScript), { recursive: true });
		await fs.copyFile(path.join(import.meta.dir, "build-omp.ps1"), fixtureScript);

		for (const relativePath of [
			"Cargo.toml",
			"Cargo.lock",
			"rust-toolchain.toml",
			"packages/natives/package.json",
			"scripts/bazel-natives.ts",
			"BUILD.bazel",
			"MODULE.bazel",
			"MODULE.bazel.lock",
			".bazelrc",
			"packages/natives/scripts/build-bindings.ts",
			"packages/natives/scripts/gen-enums.ts",
			"scripts/host-detect.ts",
			"bazel/placeholder.bzl",
			"crates/pi-natives/Cargo.toml",
		]) {
			await writeFixture(fixtureRoot, relativePath);
		}

		const artifactPath = path.join(fixtureRoot, "packages/natives/native/pi_natives.win32-x64-modern.node");
		await writeFixture(fixtureRoot, path.relative(fixtureRoot, artifactPath));
		const future = new Date(Date.now() + 60_000);
		await fs.utimes(artifactPath, future, future);

		const packageId = "path+file:///fixture#pi-natives@0.0.0";
		const metadata = JSON.stringify({
			packages: [
				{
					id: packageId,
					name: "pi-natives",
					manifest_path: path.join(fixtureRoot, "crates/pi-natives/Cargo.toml"),
				},
			],
			resolve: { nodes: [{ id: packageId, dependencies: [] }] },
		});
		const escapedScript = fixtureScript.replaceAll("'", "''");
		const command = [
			'$metadata = [Environment]::GetEnvironmentVariable("OMP_TEST_CARGO_METADATA")',
			"function global:cargo { Write-Output $metadata; $global:LASTEXITCODE = 0 }",
			`& '${escapedScript}' -DryRun`,
		].join("; ");
		const proc = Bun.spawn([pwsh!, "-NoProfile", "-NonInteractive", "-Command", command], {
			env: {
				...process.env,
				OMP_TEST_CARGO_METADATA: metadata,
				TARGET_VARIANT: "modern",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
		expect(stdout).toContain("Reusing up-to-date pi-natives modern");
		expect(stdout).not.toContain("Build failed");
	});
});
