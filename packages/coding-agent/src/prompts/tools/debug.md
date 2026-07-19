Debugger access. Prefer over bash for program state, breakpoints, stepping, or thread inspection.
Only one active session at a time. `program` is a target path, not a shell command.
Directories need a directory-capable adapter (e.g. `dlv`).

<instruction>
- Adapter availability unknown? Run `adapters` before `launch`/`attach`.
- `output(wait_for:"regex")` waits for current-execution output. Use it to synchronize launched services before triggering requests; `all_output:true` includes bounded history.
- `continue` waits for the next tree-level stop or termination by default. Use `continue(wait_for_stop:false)` to receive an execution id after DAP accepts the request.
- Request-triggered breakpoints MUST use this flow:
  1. `launch`/`attach`, then `set_breakpoint`.
  2. `continue(wait_for_stop:false)`.
  3. Start the request with `bash(async:true, pty:false, timeout:0)`. The client NEVER impose a shorter response deadline than breakpoint inspection.
  4. Call `wait_for_stop` with both returned ids.
  5. Inspect the bounded stop snapshot and fix the defect.
  6. Resume with `continue(wait_for_stop:false)`, then collect the request with `hub wait`.
- The trigger Bash MUST run in the background. Foreground requests deadlock while the debuggee is paused.
- Trigger wins? Inspect its result. The debug execution remains active; NEVER replay until it stops or terminates.
- Stop wins? Resume the debuggee before waiting for the trigger job.
- Timeout or abort cancels only observation. Repeat `wait_for_stop` with the same execution id; NEVER replay.
- Follow returned `Next` calls. Execution, trigger, and session ids are not interchangeable.
- After a fix, replay the prior Bash call with identical `command`, `cwd`, `env`, `timeout`, `pty:false`, and `async:true`.
</instruction>
