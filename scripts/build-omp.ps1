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

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $repoRoot
try {
	Invoke-Step "Switching to Node 24" {
		Invoke-NativeCommand nvm use 24
	}

	foreach ($variant in @("baseline", "modern")) {
		Invoke-Step "Building pi-natives $variant" {
			$env:TARGET_VARIANT = $variant
			try {
				Invoke-NativeCommand bun --cwd=packages/natives run build
			} finally {
				Remove-Item Env:\TARGET_VARIANT -ErrorAction SilentlyContinue
			}
		}
	}

	Invoke-Step "Building compiled omp" {
		Invoke-NativeCommand bun --cwd=packages/coding-agent run build
	}
} finally {
	Remove-Item Env:\TARGET_VARIANT -ErrorAction SilentlyContinue
	Pop-Location
}
