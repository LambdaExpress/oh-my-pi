Execute commands on configured SSH hosts using OMP-managed credentials.

<instruction>
- Select a host from "Available hosts".
- Match commands to the detected remote shell.
- `cwd` MUST be an absolute remote path. Omit it when unnecessary.
- NEVER use `~` or `~/…` for `cwd`.
</instruction>

<commands>
- `linux/bash`, `linux/zsh`, `macos/bash`, `macos/zsh`: `ls`, `cat`, `head`, `tail`, `grep`, `find`, `ps`, `top`, `df`, `uname`, `cd`, `pwd`.
- `windows/bash`, `windows/sh`: use Unix commands; `free` may be unavailable.
- `windows/powershell`: `Get-ChildItem`, `Get-Content`, `Select-String`, `Get-Process`, `Get-ComputerInfo`, `Set-Location`, `Get-Location`.
- `windows/cmd`: `dir`, `type`, `findstr`, `where`, `tasklist`, `systeminfo`, `cd`, `echo %CD%`.
</commands>

<critical>
You MUST select a configured host and use its detected shell.
`cwd` MUST be absolute; NEVER use `~` or `~/…`.
</critical>
