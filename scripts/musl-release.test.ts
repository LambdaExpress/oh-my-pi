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
	env?: Record<string, string | undefined>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(command, { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" });
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

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function createInstallerFixture(options: { musl: boolean; badChecksum?: boolean; existing?: boolean }) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fork-install-"));
	tempDirs.push(dir);
	const binDir = path.join(dir, "bin");
	const installDir = options.existing ? binDir : path.join(dir, "install");
	await fs.mkdir(binDir);
	await writeExecutable(binDir, "uname", '#!/bin/sh\n[ "$1" = "-s" ] && echo Linux || echo x86_64\n');
	await writeExecutable(binDir, "ldd", `#!/bin/sh\necho '${options.musl ? "musl libc (x86_64)" : "glibc 2.39"}'\n`);
	const binary = "#!/bin/sh\necho omp/18.0.4+code.9\n";
	const binaryName = `omp-linux-${options.musl ? "musl-" : ""}x64`;
	const digest = options.badChecksum ? "0".repeat(64) : new Bun.CryptoHasher("sha256").update(binary).digest("hex");
	const release = JSON.stringify({
		tag_name: "code-9",
		draft: false,
		prerelease: false,
		body: `## SHA256\n\n\`\`\`text\n${digest}  ${binaryName}\n\`\`\`\n`,
	});
	const requests = path.join(dir, "requests");
	await writeExecutable(
		binDir,
		"curl",
		`#!/bin/sh
printf '%s\\n' "$*" >> ${shellQuote(shellPath(requests))}
case "$*" in
  */releases/tags/code-9*) printf '%s\\n' ${shellQuote(release)} ;;
  *api.github.com*) printf '%s\\n' ${shellQuote(`[${release}]`)} ;;
  *) while [ "$#" -gt 0 ]; do
       [ "$1" = "-o" ] && { printf '%s' ${shellQuote(binary)} > "$2"; exit 0; }
       shift
     done
     exit 1 ;;
esac
`,
	);
	if (options.existing) {
		await writeExecutable(binDir, "omp", "#!/bin/sh\necho upstream\n");
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
	}
	const env = { ...process.env, HOME: shellPath(dir), PI_BUILD_URL: "", PI_INSTALL_DIR: "" };
	if (!options.existing) env.PI_INSTALL_DIR = shellPath(installDir);
	return {
		binDir,
		installDir,
		binary,
		requests,
		env,
		run: () =>
			run(
				// Source after setting PATH: a fresh MSYS sh can prepend /usr/bin
				// and hide the host/download fixtures on Windows.
				[
					"sh",
					"-c",
					'installer=$2; PATH="$1:$PATH"; export PATH; shift 2; . "$installer" "$@"',
					"sh",
					shellPath(binDir),
					"scripts/install.sh",
				],
				env,
			),
	};
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

	test("selects and verifies the fork musl asset when the Linux host reports musl", async () => {
		const fixture = await createInstallerFixture({ musl: true });
		const result = await fixture.run();
		expect(result.exitCode, result.stderr + result.stdout).toBe(0);
		expect(await Bun.file(fixture.requests).text()).toContain("/releases/download/code-9/omp-linux-musl-x64");
		expect(await Bun.file(path.join(fixture.installDir, "omp")).text()).toBe(fixture.binary);
		expect(await fs.readdir(fixture.installDir)).toEqual(["omp"]);
	});

	test("replaces an existing upstream omp with the fork binary even when native Bun is available", async () => {
		const fixture = await createInstallerFixture({ musl: false, existing: true });
		const result = await fixture.run();
		expect(result.exitCode, result.stderr + result.stdout).toBe(0);
		expect(await Bun.file(fixture.requests).text()).toContain("/releases/download/code-9/omp-linux-x64");
		expect(await Bun.file(path.join(fixture.installDir, "omp")).text()).toBe(fixture.binary);
	});

	test("keeps an existing install when the fork release checksum does not match", async () => {
		const fixture = await createInstallerFixture({ musl: false, existing: true, badChecksum: true });
		const result = await fixture.run();
		expect(result.exitCode).not.toBe(0);
		expect(await Bun.file(path.join(fixture.installDir, "omp")).text()).toBe("#!/bin/sh\necho upstream\n");
		expect(
			(await fs.readdir(fixture.installDir)).filter(name => name.includes(".new") || name.includes(".bak")),
		).toEqual([]);
	});
});
