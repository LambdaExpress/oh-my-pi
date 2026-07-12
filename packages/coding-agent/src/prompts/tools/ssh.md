Runs commands on remote hosts.

Hosts may come from persistent SSH configuration or session aliases created with `ssh_session`. Session aliases are also available to Read-like tools as `ssh://<alias>/<absolute-path>`.

<commands>
**linux/bash, linux/zsh, macos/bash, macos/zsh** — Unix-like:
- Files: `ls`, `cat`, `head`, `tail`, `grep`, `find`
- System: `ps`, `top`, `df`, `uname` (all), `free` (Linux only)
- Navigation: `cd`, `pwd`
**windows/bash, windows/sh** — Windows Unix layer (WSL, Cygwin, Git Bash):
- Files/System/Navigation: same as Unix-like above, minus `free`
**windows/powershell** — PowerShell:
- Files: `Get-ChildItem`, `Get-Content`, `Select-String`
- System: `Get-Process`, `Get-ComputerInfo`
- Navigation: `Set-Location`, `Get-Location`
**windows/cmd** — Command Prompt:
- Files: `dir`, `type`, `findstr`, `where`
- System: `tasklist`, `systeminfo`
- Navigation: `cd`, `echo %CD%`
</commands>

<critical>
You MUST verify the shell type from "Available hosts" and use matching commands.
You SHOULD omit `cwd` unless required. `cwd` MUST be an explicit remote path; NEVER use `~` or `~/…`.
</critical>
