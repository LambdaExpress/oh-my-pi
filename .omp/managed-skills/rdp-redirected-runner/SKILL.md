---
name: rdp-redirected-runner
description: Use when executing commands on a Windows RDP target through a redirected local RDPPath runner under ~/.omp/cache/rdp.
---

# RDP Redirected-Drive Runner

Use this when the user wants remote command execution through Windows RDP disk redirection, especially with local `~/.omp/cache/rdp` mounted into the RDP session as `R:` / `\\tsclient\R`.

<critical>
- RDP is GUI + virtual channels, not a command-exec protocol.
- NEVER rely on RemoteApp unless the server publishes it.
- NEVER implement the runner as a Windows Service when it depends on `\\tsclient`.
- You MUST run the runner in the logged-in RDP user session.
- You MUST verify by reading a result JSON from local RDPPath.
</critical>

## Known-good architecture

- Local RDPPath: `C:\Users\<user>\.omp\cache\rdp` or `~/.omp/cache/rdp`.
- Local maps RDPPath to a drive letter, usually `R:` via `subst`.
- RDP redirects `R:` into the remote desktop.
- Remote sees it as `\\tsclient\R`.
- A user-session PowerShell runner polls `\\tsclient\R\jobs\*.ps1`.
- Runner moves jobs to `running\`, executes them, writes `results\<job-id>.json`.
- Local assistant reads `~/.omp/cache/rdp/results/<job-id>.json`.

## Why not Windows Service

Windows Services run in Session 0. RDP redirected drives live in the interactive user session. A service usually cannot see `\\tsclient\R`. Use a foreground/session runner launched by the logged-in user. If a real service is required, use SMB, WinRM, SSH, or a remote-local work directory instead of RDP drive redirection.

## Stable launcher

Use UNC direct launch. `pushd`/temporary drive letters can hang PowerShell execution.

`start-omp-rdp-runner.cmd`:

```cmd
@echo on
setlocal
echo [OMP] launcher path: %~dp0
echo [OMP] starting PowerShell runner from UNC path...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0omp-rdp-runner.ps1"
set OMP_RDP_RUNNER_EXIT=%ERRORLEVEL%
echo [OMP] runner exited with %OMP_RDP_RUNNER_EXIT%
pause
exit /b %OMP_RDP_RUNNER_EXIT%
```

`stop-omp-rdp-runner.cmd`:

```cmd
@echo off
if not exist "%~dp0control" mkdir "%~dp0control"
echo stop requested > "%~dp0control\stop"
```

## Runner behavior contract

Runner MUST:

- Create `jobs`, `running`, `done`, `results`, `control`.
- Write `runner-ready.json` before polling.
- Poll `jobs\*.ps1` every 2 seconds by default.
- Move each job to `running\<job-id>.ps1` before execution.
- Execute jobs inline in the runner PowerShell process.
- Write `results\<job-id>.json` with `ok`, `exitCode`, timestamps, remote identity, `stdout`, `error`.
- Move completed scripts to `done\<job-id>.<timestamp>.ps1`.
- Stop when `control\stop` exists.

Runner SHOULD avoid spawning nested `powershell.exe` for jobs. In this environment, child PowerShell from a temporary mapped drive hung; inline execution completed.

## Job protocol

Local assistant writes:

```text
~/.omp/cache/rdp/jobs/<job-id>.ps1
```

Remote runner executes from:

```text
\\tsclient\R\running\<job-id>.ps1
```

Remote runner writes:

```text
\\tsclient\R\results\<job-id>.json
```

Local assistant reads:

```text
~/.omp/cache/rdp/results/<job-id>.json
```

Result JSON shape:

```json
{
  "id": "job-id",
  "ok": true,
  "exitCode": 0,
  "startedAt": "...",
  "finishedAt": "...",
  "durationMs": 123,
  "remoteComputer": "RELAYTEST",
  "remoteUser": "RELAYTEST\\Shinetech",
  "runnerRoot": "\\\\tsclient\\R",
  "script": "\\\\tsclient\\R\\running\\job-id.ps1",
  "stdout": "...",
  "error": null
}
```

## Verified probe

Probe job:

```powershell
$ErrorActionPreference = 'Stop'
[pscustomobject]@{
	message = 'hello from remote RDP runner'
	remoteComputer = $env:COMPUTERNAME
	remoteUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
	psVersion = $PSVersionTable.PSVersion.ToString()
	ranAt = (Get-Date).ToString('o')
	jobScriptPath = $PSCommandPath
	jobScriptRoot = Split-Path -Parent $PSCommandPath
} | ConvertTo-Json -Depth 4
```

Verified output included:

```text
runnerRoot = \\tsclient\R
script = \\tsclient\R\running\rdp-runner-probe.ps1
ok = true
exitCode = 0
remoteComputer = RELAYTEST
remoteUser = RELAYTEST\Shinetech
```

## Workflow

1. Create or refresh runner files in local RDPPath.
2. Ensure RDP session redirects local `R:`.
3. In the remote desktop, run `start-omp-rdp-runner.cmd` from redirected drive.
4. Confirm `runner-ready.json` appears locally.
5. Write job scripts into local `jobs\`.
6. Wait for `results\<job-id>.json`.
7. Read result with the `read` tool.
8. Stop runner via `stop-omp-rdp-runner.cmd` or local `control\stop`.

## Troubleshooting

- `CMD does not support UNC paths as current directories`: harmless if launcher uses UNC direct `powershell.exe -File "%~dp0..."`; avoid `cd /d`.
- `pushd` maps `\\tsclient\R` to `X:`/`Y:` but PowerShell hangs: use UNC direct launch.
- RemoteApp says app not authorized: server-side allowlist blocks it. Use full desktop session runner.
- No `runner-ready.json`: runner did not start or is running old code. Close the remote CMD window, refresh files, relaunch.
- Job stuck in `running`: close old runner, move script back to `jobs`, use inline execution runner.
- `\\tsclient` not visible: drive redirection failed; reconnect RDP with `redirectdrives:i:1` and `drivestoredirect:s:R:\`.

<critical>
- Use a user-session runner, not a Windows Service.
- Launch via UNC direct path, not `pushd` mapped drive.
- Treat RDP as transport + UI; runner provides command execution.
- Prove success only by reading local `results/<job-id>.json`.
</critical>
