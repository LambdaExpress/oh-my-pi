import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const pwsh = Bun.which("pwsh");
const payload = Buffer.from("installer fixture payload 中文\n", "utf8");
const previousBinary = Buffer.from("previous omp install\n");
const nativeBoundary = "OMP_INSTALL_TEST_NATIVE_BOUNDARY";
const downloadPath = "/payload?a=1&b=2";
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Parse the real installer, but load only its binary-install functions. Never
// dot-source the entrypoint: its success tail persists the developer's User PATH.
// Every native attempt throws before executing the supplied scriptblock, even
// when a metadata/checksum guard regresses, so no test can reach that tail.
const harness = String.raw`
$ErrorActionPreference = "Stop"
$tokens = $null
$parseErrors = $null
$installerAst = [System.Management.Automation.Language.Parser]::ParseFile($env:OMP_TEST_INSTALLER, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) {
    throw ($parseErrors | Out-String)
}
foreach ($name in @("Get-LatestCodeRelease", "Install-Binary")) {
    $definitions = @($installerAst.EndBlock.Statements | Where-Object {
        $_ -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq $name
    })
    if ($definitions.Count -ne 1) {
        throw "Expected one installer function named $name"
    }
    . ([scriptblock]::Create($definitions[0].Extent.Text))
}

$InstallDir = $env:OMP_TEST_INSTALL_DIR
$BuildTarget = $env:OMP_TEST_TARGET
$BuildUrl = $env:OMP_TEST_SERVICE_URL
$Repo = "fixture/omp"
$Ref = $env:OMP_TEST_REF
$script:MetadataRequests = [System.Collections.Generic.List[string]]::new()
$script:DownloadRequests = [System.Collections.Generic.List[string]]::new()
$script:MetadataRead = $false
$script:DownloadCompleted = $false
$script:NativeAttempts = 0

# Redirect only the expected external HTTP boundary to our loopback service.
# JSON parsing, HTTP errors, download streaming and hashing remain real cmdlets.
function Invoke-RestMethod {
    param([string]$Uri, [int]$TimeoutSec)
    $script:MetadataRequests.Add($Uri)
    if ($Uri -cne $env:OMP_TEST_METADATA_URI) {
        throw "Unexpected installer metadata request: $Uri"
    }
    $answer = Microsoft.PowerShell.Utility\Invoke-RestMethod -Uri "$BuildUrl/metadata" -TimeoutSec $TimeoutSec
    $script:MetadataRead = $true
    return $answer
}

function Invoke-WebRequest {
    param([string]$Uri, [string]$OutFile, [int]$TimeoutSec)
    $script:DownloadRequests.Add($Uri)
    if ($Uri -cne $env:OMP_TEST_DOWNLOAD_URI) {
        throw "Unexpected installer download request: $Uri"
    }
    if ([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($OutFile)) -cne $InstallDir) {
        throw "Installer download escaped its owned directory: $OutFile"
    }
    Microsoft.PowerShell.Utility\Invoke-WebRequest -Uri "$BuildUrl/payload?a=1&b=2" -OutFile $OutFile -TimeoutSec $TimeoutSec | Out-Null
    $script:DownloadCompleted = $true
}

function Invoke-Native {
    param([Parameter(Mandatory = $true)][scriptblock]$Command)
    $script:NativeAttempts++
    throw $env:OMP_TEST_NATIVE_BOUNDARY
}

$failure = $null
try {
    Install-Binary
} catch {
    $failure = $_.Exception.Message
}
if ($null -eq $failure) {
    throw "Installer escaped the native-execution test boundary"
}
[ordered]@{
    error = $failure
    metadataRequests = @($script:MetadataRequests)
    downloadRequests = @($script:DownloadRequests)
    metadataRead = $script:MetadataRead
    downloadCompleted = $script:DownloadCompleted
    nativeAttempts = $script:NativeAttempts
} | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $env:OMP_TEST_RESULT -Encoding UTF8
`;

interface InstallOptions {
	target?: "windows-x86_64" | "windows-arm64";
	ref?: string;
	configuredBuildUrl?: boolean;
	file?: { name?: unknown; size?: unknown; sha256?: unknown };
	fork?: boolean;
	checksum?: string;
}

interface InstallResult {
	installDir: string;
	metadataUri: string;
	downloadUri: string;
	requests: string[];
	state: {
		error: string;
		metadataRequests: string[];
		downloadRequests: string[];
		metadataRead: boolean;
		downloadCompleted: boolean;
		nativeAttempts: number;
	};
}

function sha256(bytes: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function runInstall(options: InstallOptions = {}): Promise<InstallResult> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-install-powershell-"));
	cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
	const installDir = path.join(root, "install");
	const resultPath = path.join(root, "result.json");
	await fs.mkdir(installDir);
	await fs.writeFile(path.join(installDir, "omp.exe"), previousBinary);

	const target = options.target ?? "windows-x86_64";
	const fileName = target === "windows-arm64" ? "omp-windows-arm64.exe" : "omp-windows-x64.exe";
	const checksum = options.checksum ?? sha256(payload);
	const requests: string[] = [];
	const release = {
		tag_name: "code-1",
		draft: false,
		prerelease: false,
		body: `${checksum}  ${fileName}\n`,
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			requests.push(url.pathname + url.search);
			if (url.pathname + url.search === downloadPath) return new Response(payload);
			if (url.pathname !== "/metadata") return new Response("unexpected request", { status: 404 });
			const answer = options.fork
				? options.ref
					? release
					: [release]
				: {
						build: { version: "1.0.0" },
						file: { name: fileName, size: payload.byteLength, sha256: checksum, ...options.file },
						download: `${server.url.origin}${downloadPath}`,
					};
			return new Response(JSON.stringify(answer).replaceAll("&", "\\u0026"), {
				headers: { "Content-Type": "application/json" },
			});
		},
	});
	cleanups.push(() => server.stop(true));

	const buildUrl = server.url.origin;
	const metadataUri = options.fork
		? `https://api.github.com/repos/fixture/omp/releases${options.ref ? `/tags/${options.ref}` : "?per_page=100"}`
		: `${buildUrl}/api/products/omp/${options.ref ? `versions/${options.ref.slice(1)}/${target}` : `latest/${target}?channel=stable`}`;
	const downloadUri = options.fork
		? `https://github.com/fixture/omp/releases/download/${release.tag_name}/${fileName}`
		: `${buildUrl}${downloadPath}`;
	const proc = Bun.spawn(
		[
			pwsh!,
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			Buffer.from(harness, "utf16le").toString("base64"),
		],
		{
			cwd: root,
			env: {
				...process.env,
				PI_BUILD_URL: (options.configuredBuildUrl ?? !options.fork) ? buildUrl : "",
				OMP_TEST_INSTALLER: path.join(import.meta.dir, "install.ps1"),
				OMP_TEST_INSTALL_DIR: installDir,
				OMP_TEST_TARGET: target,
				OMP_TEST_REF: options.ref ?? "",
				OMP_TEST_SERVICE_URL: buildUrl,
				OMP_TEST_METADATA_URI: metadataUri,
				OMP_TEST_DOWNLOAD_URI: downloadUri,
				OMP_TEST_NATIVE_BOUNDARY: nativeBoundary,
				OMP_TEST_RESULT: resultPath,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	cleanups.push(() => {
		if (proc.exitCode === null) proc.kill();
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
	const state = JSON.parse((await fs.readFile(resultPath, "utf8")).replace(/^\uFEFF/, "")) as InstallResult["state"];
	return { installDir, metadataUri, downloadUri, requests, state };
}

async function expectPreserved(result: InstallResult, downloaded: boolean, nativeAttempts: 0 | 1): Promise<void> {
	expect(result.state.metadataRead).toBe(true);
	expect(result.state.metadataRequests).toEqual([result.metadataUri]);
	expect(result.state.downloadRequests).toEqual(downloaded ? [result.downloadUri] : []);
	expect(result.state.downloadCompleted).toBe(downloaded);
	expect(result.requests).toEqual(downloaded ? ["/metadata", downloadPath] : ["/metadata"]);
	expect(result.state.nativeAttempts).toBe(nativeAttempts);
	if (nativeAttempts === 1) expect(result.state.error).toBe(nativeBoundary);
	else expect(result.state.error).not.toBe(nativeBoundary);
	expect(await fs.readFile(path.join(result.installDir, "omp.exe"))).toEqual(previousBinary);
	expect(await fs.readdir(result.installDir)).toEqual(["omp.exe"]);
}

describe.skipIf(!pwsh)("install.ps1 binary integrity boundaries", () => {
	test.each([
		["windows-x86_64", "omp-windows-arm64.exe"],
		["windows-arm64", "omp-windows-x64.exe"],
		["windows-x86_64", "OMP-WINDOWS-X64.EXE"],
		["windows-x86_64", ["omp-windows-x64.exe"]],
	] as const)("rejects %s metadata naming %s despite a valid SHA", async (target, name) => {
		const result = await runInstall({ target, file: { name } });
		await expectPreserved(result, false, 0);
	});

	test.each([
		["missing", undefined],
		["null", null],
		["zero", 0],
		["negative", -1],
		["fractional", 1.5],
		["numeric string", String(payload.byteLength)],
		["boolean", true],
		["array", [payload.byteLength]],
		["object", { size: payload.byteLength }],
		["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
	] as const)("rejects %s advertised size before downloading", async (_label, size) => {
		const result = await runInstall({ file: { size } });
		await expectPreserved(result, false, 0);
	});

	test("rejects a valid-SHA download whose byte length differs from metadata", async () => {
		const result = await runInstall({ file: { size: payload.byteLength + 1 } });
		await expectPreserved(result, true, 0);
	});

	test("retains SHA verification when the advertised byte length matches", async () => {
		const result = await runInstall({ checksum: sha256("different payload") });
		await expectPreserved(result, true, 0);
	});

	test.each(["windows-x86_64", "windows-arm64"] as const)(
		"admits valid %s metadata only as far as the safe native boundary",
		async target => {
			const result = await runInstall({ target });
			await expectPreserved(result, true, 1);
		},
	);

	test("routes an explicit version ref to the build service without an environment override", async () => {
		const result = await runInstall({ ref: "v1.0.0", configuredBuildUrl: false });
		await expectPreserved(result, true, 1);
	});

	test("keeps the default fork checksum-body route without size metadata", async () => {
		const result = await runInstall({ fork: true });
		await expectPreserved(result, true, 1);
	});

	test("keeps code refs on the fork even when a build-service override is configured", async () => {
		const result = await runInstall({ fork: true, ref: "code-1", configuredBuildUrl: true });
		await expectPreserved(result, true, 1);
	});

	test("still rejects a fork download that differs from the release-body checksum", async () => {
		const result = await runInstall({ fork: true, checksum: sha256("different fork payload") });
		await expectPreserved(result, true, 0);
	});
});
