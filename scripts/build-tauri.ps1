#Requires -Version 7.0

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not $IsWindows) {
	throw "The Tauri shell executable can only be built on Windows."
}

$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if ($null -eq $cargo) {
	throw "Cargo was not found on PATH. Install the Rust toolchain from https://rustup.rs/ and retry."
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$packageDir = Join-Path $repoRoot "packages/tauri-shell"
$manifestPath = Join-Path $packageDir "Cargo.toml"
$targetDir = Join-Path $packageDir "target"
$outputPath = Join-Path $packageDir "dist/omp-shell.exe"

Write-Host "==> Building the Tauri shell"
& $cargo.Source build --manifest-path $manifestPath --target-dir $targetDir --locked --release
if ($LASTEXITCODE -ne 0) {
	throw "Tauri shell build failed with exit code $LASTEXITCODE."
}

$artifactPath = Join-Path $targetDir "release/omp-shell.exe"
if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
	throw "Cargo completed without producing the expected executable: $artifactPath"
}

$outputDir = Split-Path $outputPath -Parent
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

# A running Windows executable cannot be overwritten. Retire the old directory
# entry without stopping the process, then install the new build at the stable
# shortcut target. Retired images are removed by a later build after they exit.
Get-ChildItem -LiteralPath $outputDir -Filter "omp-shell.retired-*.exe" -File -ErrorAction SilentlyContinue | ForEach-Object {
	try {
		Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop
	} catch {
		# The retired image is still running; a later build will remove it.
	}
}

$stagedPath = Join-Path $outputDir "omp-shell.next.exe"
Copy-Item -LiteralPath $artifactPath -Destination $stagedPath -Force
try {
	Move-Item -LiteralPath $stagedPath -Destination $outputPath -Force
} catch {
	if (-not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
		Remove-Item -LiteralPath $stagedPath -Force -ErrorAction SilentlyContinue
		throw
	}
	$retiredPath = Join-Path $outputDir "omp-shell.retired-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).exe"
	try {
		Move-Item -LiteralPath $outputPath -Destination $retiredPath
		Move-Item -LiteralPath $stagedPath -Destination $outputPath
		Write-Host "==> Retired the running shell to $retiredPath" -ForegroundColor Yellow
	} catch {
		Remove-Item -LiteralPath $stagedPath -Force -ErrorAction SilentlyContinue
		throw "Could not update $outputPath while it is running. Close the desktop shell and retry. $($_.Exception.Message)"
	}
}

$executable = Get-Item -LiteralPath $outputPath
Write-Host "==> Built $($executable.FullName) ($([Math]::Round($executable.Length / 1MB, 2)) MiB)" -ForegroundColor Green

$desktopDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
if ([string]::IsNullOrWhiteSpace($desktopDir)) {
	throw "Windows did not return a desktop directory for the current user."
}

$shortcutPath = Join-Path $desktopDir "omp shell.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $executable.FullName
$shortcut.WorkingDirectory = $repoRoot
$shortcut.IconLocation = "$($executable.FullName),0"
$shortcut.Description = "Open the omp desktop shell"
$shortcut.Save()

Write-Host "==> Created desktop shortcut $shortcutPath" -ForegroundColor Green
