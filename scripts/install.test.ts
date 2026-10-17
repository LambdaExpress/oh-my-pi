import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// install.sh binary mode against a fake build service. The host is faked as
// musl Linux x64 by shadowing uname/ldd via PATH; MSYS sh on Windows prepends
// /usr/bin, so the stubs never win there.

const repoRoot = path.join(import.meta.dir, "..");
const BINARY = '#!/bin/sh\nprintf "%s\\n" "$*" >> "$OMP_INSTALL_TEST_EXECUTED"\necho "omp/1.0.0"\n';
const BINARY_SIZE = Buffer.byteLength(BINARY);
const PREVIOUS_BINARY = "#!/bin/sh\necho previous-install\n";
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function sha256(text: string): string {
	return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/**
 * A build service answering every update check with version 1.0.0 of
 * `omp-linux-musl-x64`, with overrides for the selected `file`. Every other
 * sha256 in the answer (other targets in `build.files[]`, the patch, a JSON
 * snippet in the notes) is wrong; decoy sizes stay valid even when the file's
 * size is not. The `download` URL holds a `\u0026`
 * escape the way Go's encoder writes presigned URLs.
 */
function startService(file: { name?: string; size?: unknown; sha256?: string } = {}): {
	url: string;
	requests: string[];
} {
	const requests: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			requests.push(url.pathname + url.search);
			if (url.pathname === "/dl/omp-linux-musl-x64") {
				return url.searchParams.get("b") === "2"
					? new Response(BINARY)
					: new Response("bad query", { status: 403 });
			}
			if (!url.pathname.startsWith("/api/products/omp/"))
				return Response.json({ error: "no_build" }, { status: 404 });
			const decoy = "0".repeat(64);
			const answer = {
				build: {
					id: "20261010-171748-fa5ff4a",
					product: "omp",
					version: "1.0.0",
					channel: "stable",
					notes: `Answers look like {"file":{"sha256":"${decoy}"},"version":"9.9.9"}`,
					files: [
						{
							name: "omp-linux-x64",
							platform: "linux",
							arch: "x86_64",
							size: BINARY_SIZE,
							sha256: decoy,
						},
						{
							name: "omp-linux-musl-x64",
							platform: "linux-musl",
							arch: "x86_64",
							size: BINARY_SIZE,
							sha256: decoy,
						},
					],
				},
				file: {
					name: "omp-linux-musl-x64",
					platform: "linux-musl",
					arch: "x86_64",
					kind: "archive",
					size: BINARY_SIZE,
					sha256: sha256(BINARY),
					url: "/d/omp/20261010-171748-fa5ff4a/omp-linux-musl-x64",
					...file,
				},
				download: `${server.url.origin}/dl/omp-linux-musl-x64?a=1&b=2`,
				patch: {
					format: "file",
					from: "20261009-000000-0000000",
					from_sha256: decoy,
					size: BINARY_SIZE,
					sha256: "f".repeat(64),
					url: `${server.url.origin}/patch`,
				},
			};
			return new Response(JSON.stringify(answer).replaceAll("&", "\\u0026"), {
				headers: { "Content-Type": "application/json" },
			});
		},
	});
	cleanups.push(() => server.stop(true));
	// Trailing slashes on PI_BUILD_URL are trimmed.
	return { url: `${server.url.origin}/`, requests };
}

async function writeExecutable(file: string, content: string): Promise<void> {
	await Bun.write(file, content);
	await fs.chmod(file, 0o755);
}

async function runInstall(
	buildUrl: string,
	args: string[],
	{ existing = false }: { existing?: boolean } = {},
): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
	installDir: string;
	executionMarker: string;
}> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-install-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	const binDir = path.join(dir, "bin");
	const installDir = path.join(dir, "install");
	const executionMarker = path.join(dir, "executed");
	await fs.mkdir(binDir);
	await fs.mkdir(installDir);
	await writeExecutable(path.join(binDir, "uname"), '#!/bin/sh\n[ "$1" = "-s" ] && echo Linux || echo x86_64\n');
	await writeExecutable(path.join(binDir, "ldd"), "#!/bin/sh\necho 'musl libc (x86_64)'\n");
	if (existing) await writeExecutable(path.join(installDir, "omp"), PREVIOUS_BINARY);
	const proc = Bun.spawn(["sh", "scripts/install.sh", ...args], {
		cwd: repoRoot,
		env: {
			...process.env,
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
			HOME: dir,
			PI_INSTALL_DIR: installDir,
			PI_BUILD_URL: buildUrl,
			OMP_INSTALL_TEST_EXECUTED: executionMarker,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr, installDir, executionMarker };
}

async function expectRetainedInstall(result: Awaited<ReturnType<typeof runInstall>>): Promise<void> {
	expect(result.exitCode, result.stdout + result.stderr).not.toBe(0);
	expect(await Bun.file(result.executionMarker).exists()).toBe(false);
	expect(await fs.readdir(result.installDir)).toEqual(["omp"]);
	expect(await Bun.file(path.join(result.installDir, "omp")).text()).toBe(PREVIOUS_BINARY);
}

describe.skipIf(process.platform === "win32")("install.sh binary mode", () => {
	test("installs and smokes the host file using its own size and sha256", async () => {
		const service = startService();
		const result = await runInstall(service.url, ["--binary"]);

		expect(result.exitCode, result.stdout + result.stderr).toBe(0);
		expect(service.requests[0]).toBe("/api/products/omp/latest/linux-musl-x86_64?channel=stable");
		expect(await fs.readdir(result.installDir)).toEqual(["omp"]);
		expect(await Bun.file(path.join(result.installDir, "omp")).text()).toBe(BINARY);
		expect(await Bun.file(result.executionMarker).text()).toBe("--version\n");
	});

	test("retains the prior install without executing a different host's valid-checksum file", async () => {
		const service = startService({ name: "omp-linux-x64" });
		const result = await runInstall(service.url, ["--binary"], { existing: true });

		await expectRetainedInstall(result);
		expect(service.requests).toEqual(["/api/products/omp/latest/linux-musl-x86_64?channel=stable"]);
	});

	test("retains the prior install without executing a valid-checksum download of the wrong length", async () => {
		const service = startService({ size: BINARY_SIZE + 1 });
		const result = await runInstall(service.url, ["--binary"], { existing: true });

		await expectRetainedInstall(result);
		expect(service.requests).toEqual([
			"/api/products/omp/latest/linux-musl-x86_64?channel=stable",
			"/dl/omp-linux-musl-x64?a=1&b=2",
		]);
	});

	const invalidSizes: [string, unknown][] = [
		["missing", undefined],
		["null", null],
		["zero", 0],
		["negative", -1],
		["fractional", 1.5],
		["numeric string", String(BINARY_SIZE)],
		["boolean", true],
		["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
	];
	test.each(invalidSizes)("rejects a %s file size without falling back to decoy metadata", async (_, size) => {
		const service = startService({ size });
		const result = await runInstall(service.url, ["--binary", "--ref", "v1.0.0"], { existing: true });

		await expectRetainedInstall(result);
		expect(service.requests).toEqual(["/api/products/omp/versions/1.0.0/linux-musl-x86_64"]);
	});

	test("retains the prior install without executing a download with the wrong file sha256", async () => {
		const service = startService({ sha256: sha256("something else") });
		const result = await runInstall(service.url, ["--binary"], { existing: true });

		await expectRetainedInstall(result);
	});

	test("--ref resolves a release tag through the versions endpoint and rejects other refs", async () => {
		const service = startService();
		const tagged = await runInstall(service.url, ["--binary", "--ref", "v1.0.0"], { existing: true });
		expect(tagged.exitCode, tagged.stdout + tagged.stderr).toBe(0);
		expect(service.requests[0]).toBe("/api/products/omp/versions/1.0.0/linux-musl-x86_64");
		expect(await Bun.file(path.join(tagged.installDir, "omp")).text()).toBe(BINARY);
		expect(await fs.readdir(tagged.installDir)).toEqual(["omp"]);
		expect(await Bun.file(tagged.executionMarker).text()).toBe("--version\n");

		const branch = await runInstall(service.url, ["--binary", "--ref", "main"], { existing: true });
		await expectRetainedInstall(branch);
		expect(service.requests).toHaveLength(2);
	});
});
