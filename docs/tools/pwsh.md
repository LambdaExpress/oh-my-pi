# pwsh

> Run PowerShell 7 scripts directly; use only when PowerShell itself is required.

## Source
- Entry: `packages/coding-agent/src/tools/pwsh.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/pwsh.md`
- Executor: `packages/coding-agent/src/exec/pwsh-executor.ts` (when present)
- Related: `packages/coding-agent/src/tools/bash.ts` — the default shell tool for non-PowerShell work.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `script` | `string` | Yes | PowerShell script text. Passed directly; never wrapped in an outer `pwsh -Command` layer. Use multiline scripts for control flow, pipelines, and `$env:` references. |
| `cwd` | `string` | No | Working directory for the child process. Avoid `Set-Location` prefixes. |
| `env` | `Record<string, string>` | No | Extra child-process environment variables. |
| `timeout` | `number` | No | Timeout in seconds. Long-running commands need an explicit timeout. |

## Outputs
- Returns merged stdout/stderr output.
- Exit code is shown on non-zero exit.
- Truncated output is spilled to an `artifact://<id>` link.

## Flow
1. The tool resolves internal URIs (`skill://`, `agent://`, `artifact://`, `local://`, …) in arguments to quoted filesystem paths.
2. The script runs through the local `pwsh` executable with the current `omp` process privileges; it does not elevate to administrator.
3. Output streams are merged and returned; truncation spills to an artifact.

## When to use
- Default shell work goes to `bash`; reach for `pwsh` only for PowerShell-specific syntax, cmdlets, providers/drives, `$env:`/`$PS*` state, or Windows shell semantics.
- A Windows host alone is not a PowerShell-specific requirement.
- Prefer `bash` for POSIX commands, Git/Bun/Cargo/Node CLIs, and simple pipelines unless PowerShell behavior is the subject.
- Prefer `eval` for JavaScript/Python/Ruby/Julia code with persistent runtime state.

## Errors
- The tool is unavailable when `pwsh` is missing from PATH.
- Non-zero exits are surfaced with the exit code.
- Administrator-only operations require starting `omp` itself from an elevated terminal.

## Notes
- Never wrap PowerShell in `bash` or nested `pwsh -Command`; use this tool directly.
- Use `script`, not `command`.
