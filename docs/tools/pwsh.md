# pwsh

> Run PowerShell 7 scripts directly; use only when PowerShell itself is required.

## Source
- Entry: `packages/coding-agent/src/tools/pwsh.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/pwsh.md`
- Related: `packages/coding-agent/src/tools/bash.ts` — the default shell tool for non-PowerShell work.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `script` | `string` | Yes | PowerShell script text. Passed directly; never wrapped in an outer `pwsh -Command` layer. Use multiline scripts for control flow, pipelines, and `$env:` references. |
| `cwd` | `string` | No | Working directory for the child process. Avoid `Set-Location` prefixes. |
| `env` | `Record<string, string>` | No | Extra child-process environment variables. |
| `timeout` | `number` | No | Seconds; defaults to `300`. `0` disables the command deadline; nonzero values are clamped to `1..3600`. |

## Outputs
- Returns merged stdout/stderr output.
- Exit code is shown on non-zero exit.
- Truncated output is spilled to an `artifact://<id>` link.
- Result details record the effective `timeoutSeconds` (`0` for no deadline) and the original `requestedTimeoutSeconds` when clamping changed it.

## Flow
1. The tool resolves internal URIs (`skill://`, `agent://`, `artifact://`, `local://`, …) in arguments to quoted filesystem paths.
2. The script runs through the local `pwsh` executable with the current `omp` process privileges; it does not elevate to administrator.
3. A finite deadline terminates the process tree on timeout. `timeout: 0` creates no execution timer; caller cancellation still terminates the process tree and preserves captured output.
4. Output streams are merged and returned; truncation spills to an artifact. Pipe draining remains bounded after the root process exits, including when the command has no deadline.

Use an explicit timeout for long-running commands. A script with `timeout: 0` continues until it exits or the caller cancels it; this does not make the operation safe to retry after an interruption.

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
- On Windows, PowerShell runs in a separate hidden console. Programs it starts cannot write directly onto omp's terminal through that inherited console; standard output and error are still captured in the tool result.
