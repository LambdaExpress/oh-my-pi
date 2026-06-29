Runs PowerShell 7 scripts directly via `pwsh`; use only when PowerShell itself is required.

<instruction>
- Default shell work → `bash`; reach for `pwsh` only for PowerShell-specific syntax, cmdlets, providers/drives, `$env:`/`$PS*` state, or Windows shell semantics.
- Use `script` for PowerShell code; no outer `pwsh -Command` wrapper.
- `cwd` sets the working directory; avoid `Set-Location` prefixes.
- `env: { NAME: "…" }` sets child-process environment variables.
- Use multiline `script` for PowerShell control flow, pipelines, and `$env:` references.
- Internal URIs (`skill://`, `agent://`, `artifact://`, `local://`, …) auto-resolve to quoted filesystem paths.
- Runs with the current `omp` process privileges; it does not elevate to administrator.
- Prefer `bash` for POSIX commands, Git/Bun/Cargo/Node CLIs, and simple pipelines unless PowerShell behavior is the subject.
- Prefer `eval` for JavaScript/Python/Ruby/Julia code with persistent runtime state.
</instruction>

<output>
- Returns merged stdout/stderr output.
- Exit code shown on non-zero exit.
- Truncated output → `artifact://<id>`.
</output>

<critical>
- Default to `bash`; use `pwsh` only when PowerShell-specific behavior is required.
- NEVER wrap PowerShell in `bash` or nested `pwsh -Command`; use this tool directly.
- Use `script`, not `command`.
- Long-running commands need an explicit `timeout`.
- Administrator-only operations require starting `omp` itself from an elevated terminal.
- This tool is unavailable when `pwsh` is missing from PATH.
</critical>

<examples>
```json
{"script":"Get-Command cc -All | Select-Object Source, Version","cwd":"D:/project/oh-my-pi"}
```

```json
{"script":"$env:TARGET_VARIANT = 'baseline'\nbun --cwd=packages/natives run build\nRemove-Item Env:\\TARGET_VARIANT","timeout":900,"cwd":"D:/project/oh-my-pi"}
```
</examples>
