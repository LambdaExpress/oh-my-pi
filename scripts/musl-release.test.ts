import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function run(
	command: string[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(command, {
		cwd: repoRoot,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function writeExecutable(directory: string, name: string, content: string): Promise<void> {
	const file = path.join(directory, name);
	await Bun.write(file, content);
	await fs.chmod(file, 0o755);
}

function shellPath(filePath: string): string {
	if (process.platform !== "win32") return filePath;
	return filePath.replace(/^([A-Za-z]):[\\/]/, (_, drive: string) => `/${drive.toLowerCase()}/`).replaceAll("\\", "/");
}

describe("musl release artifacts", () => {
	test("builds the requested x64 and arm64 musl asset names with Bun's musl targets", async () => {
		const result = await run([
			"bun",
			"scripts/ci-release-build-binaries.ts",
			"--dry-run",
			"--targets",
			"linux-musl-x64,linux-musl-arm64",
		]);

		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain(
			"Bun.build target=bun-linux-x64-musl-baseline outfile=packages/coding-agent/binaries/omp-linux-musl-x64",
		);
		expect(result.stdout).toContain(
			"Bun.build target=bun-linux-arm64-musl outfile=packages/coding-agent/binaries/omp-linux-musl-arm64",
		);
	});

	test("selects the musl asset when the Linux host reports musl", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-musl-install-"));
		tempDirs.push(dir);
		const binDir = path.join(dir, "bin");
		const installDir = path.join(dir, "install");
		await fs.mkdir(binDir);
		await writeExecutable(binDir, "uname", '#!/bin/sh\n[ "$1" = "-s" ] && echo Linux || echo x86_64\n');
		await writeExecutable(binDir, "ldd", "#!/bin/sh\necho 'musl libc (x86_64)'\n");
		await writeExecutable(
			binDir,
			"curl",
			`#!/bin/sh
case "$*" in
  *api.github.com*) echo '[{"tag_name":"code-7","draft":false,"prerelease":false}]' ;;
  *) while [ "$#" -gt 0 ]; do
       [ "$1" = "-o" ] && { printf '#!/bin/sh\necho omp/18.0.4+code.7\n' > "$2"; exit 0; }
       shift
     done ;;
esac
`,
		);
		const env = { ...process.env, HOME: shellPath(dir), PI_INSTALL_DIR: shellPath(installDir) };

		const result = await run(
			[
				"sh",
				"-c",
				'PATH="$1:$PATH"; export PATH; shift; . "$@"',
				"sh",
				shellPath(binDir),
				"scripts/install.sh",
				"--binary",
			],
			env,
		);

		expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
		expect(result.stdout).toContain("Downloading omp-linux-musl-x64...");
		expect(await Bun.file(path.join(installDir, "omp")).text()).toContain("+code.7");
	});

	test("replaces an existing upstream omp with the fork binary even when native Bun is available", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fork-bootstrap-"));
		tempDirs.push(dir);
		const binDir = path.join(dir, "bin");
		await fs.mkdir(binDir);
		await writeExecutable(binDir, "uname", '#!/bin/sh\n[ "$1" = "-s" ] && echo Linux || echo x86_64\n');
		await writeExecutable(binDir, "ldd", "#!/bin/sh\necho 'glibc 2.39'\n");
		await writeExecutable(binDir, "omp", "#!/bin/sh\necho omp/18.0.4\n");
		await writeExecutable(
			binDir,
			"bun",
			`#!/bin/sh
case "$1" in
  --version) echo 1.3.14 ;;
  -e) echo x64 ;;
  *) echo "installer unexpectedly used the upstream npm path" >&2; exit 99 ;;
esac
`,
		);
		await writeExecutable(
			binDir,
			"curl",
			`#!/bin/sh
case "$*" in
  *api.github.com*) echo '[{"tag_name":"code-9","draft":false,"prerelease":false}]' ;;
  *) while [ "$#" -gt 0 ]; do
       [ "$1" = "-o" ] && { printf '#!/bin/sh\necho omp/18.0.4+code.9\n' > "$2"; exit 0; }
       shift
     done ;;
esac
`,
		);
		const env = { ...process.env, HOME: shellPath(dir) };

		const result = await run(
			["sh", "-c", 'PATH="$1:$PATH"; export PATH; exec sh "$2"', "sh", shellPath(binDir), "scripts/install.sh"],
			env,
		);

		expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
		expect(result.stdout).toContain("Downloading omp-linux-x64...");
		expect(await Bun.file(path.join(binDir, "omp")).text()).toContain("+code.9");
	});
});
