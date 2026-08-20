#Requires -Version 7.0

param(
	[switch] $DryRun
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-NativeCommand {
	param(
		[Parameter(Mandatory = $true)]
		[string] $Command,
		[Parameter(ValueFromRemainingArguments = $true)]
		[string[]] $Arguments
	)

	$joinedArgs = $Arguments -join " "
	if ($DryRun) {
		Write-Host "DRY-RUN: $Command $joinedArgs"
		return
	}

	& $Command @Arguments
	if ($LASTEXITCODE -ne 0) {
		throw "Command failed with exit code ${LASTEXITCODE}: $Command $joinedArgs"
	}
}

function Invoke-Step {
	param(
		[Parameter(Mandatory = $true)]
		[string] $Name,
		[Parameter(Mandatory = $true)]
		[scriptblock] $Action
	)

	Write-Host "==> $Name"
	& $Action
}

function Resolve-NativeVariant {
	foreach ($variableName in @("TARGET_VARIANT", "PI_NATIVE_VARIANT")) {
		$value = [Environment]::GetEnvironmentVariable($variableName, "Process")
		if (-not [string]::IsNullOrWhiteSpace($value)) {
			if ($value -notin @("baseline", "modern")) {
				throw "Unsupported ${variableName}: $value. Expected baseline or modern."
			}
			return [pscustomobject]@{ Name = $value; Source = "${variableName} override" }
		}
	}

	if ([System.Runtime.Intrinsics.X86.Avx2]::IsSupported) {
		return [pscustomobject]@{ Name = "modern"; Source = "AVX2 detected" }
	}
	return [pscustomobject]@{ Name = "baseline"; Source = "AVX2 unavailable" }
}

function Get-NativeBuildInputs {
	param(
		[Parameter(Mandatory = $true)]
		[string] $RepoRoot
	)

	$metadataJson = & cargo metadata --format-version 1 --filter-platform x86_64-pc-windows-msvc
	if ($LASTEXITCODE -ne 0) {
		throw "cargo metadata failed with exit code $LASTEXITCODE"
	}
	$metadata = $metadataJson | ConvertFrom-Json -Depth 100
	$packagesById = @{}
	foreach ($package in $metadata.packages) {
		$packagesById[$package.id] = $package
	}
	$nodesById = @{}
	foreach ($node in $metadata.resolve.nodes) {
		$nodesById[$node.id] = $node
	}

	$repoPrefix = [IO.Path]::GetFullPath($RepoRoot) + [IO.Path]::DirectorySeparatorChar
	$rootPackage = $metadata.packages |
		Where-Object {
			$_.name -eq "pi-natives" -and
			$_.manifest_path.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)
		} |
		Select-Object -First 1
	if ($null -eq $rootPackage) {
		throw "Could not find the local pi-natives package in cargo metadata"
	}

	$queue = [Collections.Generic.Queue[string]]::new()
	$queue.Enqueue($rootPackage.id)
	$visited = [Collections.Generic.HashSet[string]]::new()
	while ($queue.Count -gt 0) {
		$packageId = $queue.Dequeue()
		if (-not $visited.Add($packageId)) {
			continue
		}
		$node = $nodesById[$packageId]
		if ($null -eq $node) {
			continue
		}
		foreach ($dependencyId in $node.dependencies) {
			$queue.Enqueue($dependencyId)
		}
	}

	foreach ($packageId in $visited) {
		$package = $packagesById[$packageId]
		if ($null -eq $package -or -not $package.manifest_path.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
			continue
		}
		$packageDir = Split-Path $package.manifest_path -Parent
		Get-ChildItem -LiteralPath $packageDir -File -Recurse -Force |
			Where-Object { $_.FullName -notmatch "[\\/](target|\.git|node_modules)[\\/]" }
	}

	foreach ($relativePath in @(
		"Cargo.toml",
		"Cargo.lock",
		"rust-toolchain.toml",
		"packages/natives/package.json",
		"scripts/bazel-natives.ts",
		"packages/natives/scripts/build-bindings.ts",
		"packages/natives/scripts/gen-enums.ts",
		"scripts/host-detect.ts"
	)) {
		Get-Item -LiteralPath (Join-Path $RepoRoot $relativePath)
	}
}

function Get-NativeBuildReason {
	param(
		[Parameter(Mandatory = $true)]
		[string] $RepoRoot,
		[Parameter(Mandatory = $true)]
		[string] $ArtifactPath
	)

	if (-not (Test-Path -LiteralPath $ArtifactPath -PathType Leaf)) {
		return "artifact is missing"
	}

	$artifact = Get-Item -LiteralPath $ArtifactPath
	$newestInput = Get-NativeBuildInputs -RepoRoot $RepoRoot |
		Sort-Object LastWriteTimeUtc -Descending |
		Select-Object -First 1
	if ($newestInput.LastWriteTimeUtc -gt $artifact.LastWriteTimeUtc) {
		$relativePath = [IO.Path]::GetRelativePath($RepoRoot, $newestInput.FullName)
		return "$relativePath is newer than the artifact"
	}
	return $null
}

function Restore-ProcessEnvironmentVariable {
	param(
		[Parameter(Mandatory = $true)]
		[string] $Name,
		[AllowNull()]
		[string] $Value
	)

	if ($null -eq $Value) {
		Remove-Item "Env:\$Name" -ErrorAction SilentlyContinue
	} else {
		[Environment]::SetEnvironmentVariable($Name, $Value, "Process")
	}
}

function Get-OmpBinaryPath {
	param(
		[Parameter(Mandatory = $true)]
		[string] $RepoRoot
	)

	$packageDir = Join-Path $RepoRoot "packages/coding-agent"
	$configuredOutput = [Environment]::GetEnvironmentVariable("OMP_BINARY_OUTFILE", "Process")
	if (-not [string]::IsNullOrWhiteSpace($configuredOutput)) {
		$resolved = [IO.Path]::GetFullPath((Join-Path $packageDir $configuredOutput))
	} else {
		$resolved = Join-Path $packageDir "dist/omp"
	}
	# Bun appends .exe to compiled outfiles on Windows; mirror that so the
	# hot-replace targets the file the compile actually writes.
	if (-not $resolved.EndsWith(".exe", [StringComparison]::OrdinalIgnoreCase)) {
		$resolved = "$resolved.exe"
	}
	return $resolved
}

function Remove-StaleBinaryBackups {
	param(
		[Parameter(Mandatory = $true)]
		[string] $BinaryPath
	)

	$dir = Split-Path $BinaryPath -Parent
	if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
		return
	}
	$base = [IO.Path]::GetFileName($BinaryPath)
	$suffixLength = ".bak".Length
	Get-ChildItem -LiteralPath $dir -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
		$name = $_.Name
		if (-not $name.StartsWith("$base.", [StringComparison]::Ordinal)) {
			return
		}
		if (-not $name.EndsWith(".bak", [StringComparison]::Ordinal)) {
			return
		}
		# Legacy "<base>.bak" → empty middle; new "<base>.<timestamp>.<pid>.bak"
		# → dot-separated numeric run. Anything else is an unrelated *.bak file.
		$middle = ""
		if ($name.Length -ge $base.Length + 1 + $suffixLength) {
			$middle = $name.Substring($base.Length + 1, $name.Length - $base.Length - 1 - $suffixLength)
		}
		if ($middle.Length -gt 0 -and $middle -notmatch '^\d+(\.\d+)*$') {
			return
		}
		Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
	}
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
Push-Location $repoRoot
try {
	Invoke-Step "Switching to Node 24" {
		Invoke-NativeCommand nvm use 24
	}

	$selection = Resolve-NativeVariant
	$variant = $selection.Name
	Write-Host "==> Selected pi-natives $variant ($($selection.Source))"

	$artifactPath = Join-Path $repoRoot "packages/natives/native/pi_natives.win32-x64-$variant.node"
	$buildReason = Get-NativeBuildReason -RepoRoot $repoRoot -ArtifactPath $artifactPath
	if ($null -ne $buildReason) {
		$previousTargetVariant = [Environment]::GetEnvironmentVariable("TARGET_VARIANT", "Process")
		Invoke-Step "Building pi-natives $variant ($buildReason)" {
			$env:TARGET_VARIANT = $variant
			try {
				Invoke-NativeCommand bun --cwd=packages/natives run build
			} finally {
				Restore-ProcessEnvironmentVariable -Name "TARGET_VARIANT" -Value $previousTargetVariant
			}
		}
	} else {
		Write-Host "==> Reusing up-to-date pi-natives $variant"
	}

	$nativeSourceDir = Join-Path ([IO.Path]::GetTempPath()) "omp-native-$PID-$([guid]::NewGuid().ToString('N'))"
	$previousNativeSourceDir = [Environment]::GetEnvironmentVariable("PI_NATIVE_SOURCE_DIR", "Process")
	try {
		if ($DryRun) {
			Write-Host "DRY-RUN: stage $artifactPath in $nativeSourceDir"
		} else {
			New-Item -ItemType Directory -Path $nativeSourceDir | Out-Null
			Copy-Item -LiteralPath $artifactPath -Destination $nativeSourceDir
		}
		$ompBinaryPath = Get-OmpBinaryPath -RepoRoot $repoRoot
		$env:PI_NATIVE_SOURCE_DIR = $nativeSourceDir
		Invoke-Step "Building compiled omp with pi-natives $variant" {
			$ompBackupPath = "$ompBinaryPath.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).$PID.bak"
			if ($DryRun) {
				Write-Host "DRY-RUN: hot-replace $ompBinaryPath (move aside, build, restore on failure)"
				Invoke-NativeCommand bun --cwd=packages/coding-agent run build
				return
			}
			# Hot-replace semantics (mirrors cli/update-cli.ts): Windows permits
			# renaming a mapped executable; only overwriting or deleting it is
			# blocked. Move the previous build aside so the compile can write
			# the new exe even while the old one is still running.
			Remove-StaleBinaryBackups -BinaryPath $ompBinaryPath
			$binaryMovedAside = $false
			if (Test-Path -LiteralPath $ompBinaryPath -PathType Leaf) {
				Rename-Item -LiteralPath $ompBinaryPath -NewName ([IO.Path]::GetFileName($ompBackupPath))
				$binaryMovedAside = $true
			}
			try {
				Invoke-NativeCommand bun --cwd=packages/coding-agent run build
			} catch {
				# Roll back: remove any partial output from the failed compile,
				# then restore the previous binary.
				if (Test-Path -LiteralPath $ompBinaryPath -PathType Leaf) {
					Remove-Item -LiteralPath $ompBinaryPath -Force -ErrorAction SilentlyContinue
				}
				if ($binaryMovedAside -and (Test-Path -LiteralPath $ompBackupPath -PathType Leaf)) {
					Rename-Item -LiteralPath $ompBackupPath -NewName ([IO.Path]::GetFileName($ompBinaryPath))
				}
				throw
			}
			if ($binaryMovedAside) {
				# The moved-aside exe may still be mapped by a running process,
				# so deletion can fail until it exits; keep it for the next
				# build's stale-backup sweep instead of failing a good build.
				Remove-Item -LiteralPath $ompBackupPath -Force -ErrorAction SilentlyContinue
				if (Test-Path -LiteralPath $ompBackupPath -PathType Leaf) {
					Write-Host "==> Previous binary is still in use; kept as $ompBackupPath (removed on the next build)" -ForegroundColor DarkYellow
				}
			}
		}
	} finally {
		Restore-ProcessEnvironmentVariable -Name "PI_NATIVE_SOURCE_DIR" -Value $previousNativeSourceDir
		if (-not $DryRun) {
			Remove-Item -LiteralPath $nativeSourceDir -Recurse -Force -ErrorAction SilentlyContinue
		}
	}
} catch {
	Write-Host ""
	Write-Host "Build failed: $($_.Exception.Message)" -ForegroundColor Red
	throw
} finally {
	Pop-Location
}
