Execute commands on configured SSH hosts or auto-discovered local WSL distributions.

<instruction>
- Select a host from "Available hosts".
- Local WSL targets are `wsl` (default distribution) and `wsl:<distribution>`; they require no SSH config or `sshd`.
- Match commands to the detected remote shell.
- `cwd` MUST be an absolute remote path. Omit it when unnecessary.
- NEVER use `~` or `~/…` for `cwd`.
</instruction>

<commands>
- `linux/bash`, `linux/zsh`, `macos/bash`, `macos/zsh`: `ls`, `cat`, `head`, `tail`, `grep`, `find`, `ps`, `top`, `df`, `uname`, `cd`, `pwd`.
- `wsl/bash`, `wsl/zsh`, `wsl/sh`: use POSIX commands directly; NEVER invoke or wrap commands with `wsl.exe`.
- `windows/bash`, `windows/sh`: use Unix commands; `free` may be unavailable.
- `windows/powershell`: `Get-ChildItem`, `Get-Content`, `Select-String`, `Get-Process`, `Get-ComputerInfo`, `Set-Location`, `Get-Location`.
- `windows/cmd`: `dir`, `type`, `findstr`, `where`, `tasklist`, `systeminfo`, `cd`, `echo %CD%`.
</commands>

<critical>
You MUST select an available target and use its detected shell.
Local WSL target? Use POSIX commands directly; NEVER configure `sshd` or invoke `wsl.exe`.
`cwd` MUST be absolute; NEVER use `~` or `~/…`.
</critical>
