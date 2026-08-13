---
name: tauri-windows-project-cwd
description: Diagnose and verify Windows Tauri project switching when canonical paths cross the coding-agent --cwd boundary
---

## Trigger

Use when the Tauri shell opens or switches a Windows project but coding-agent starts in the wrong directory or session initialization fails on a path containing `\\?\`.

## Procedure

1. Inspect the folder-picker/canonical path separately from the CLI `--cwd` argument and the session-reported workspace cwd.
2. Keep canonical extended-length paths inside `CoreEngine` for project identity comparisons and `current_dir`.
3. Convert only the CLI-facing project argument to a normal Win32 path. Handle verbatim disk and verbatim UNC prefixes structurally.
4. Retain defense in depth at `pi-utils` `setProjectDir()` with `stripWindowsExtendedLengthPathPrefix()` so non-Tauri callers cannot propagate an extended prefix into session path encoding.
5. Test the external-process boundary using the fake OMP fixture: launcher cwd differs from the selected project, canonical internal path remains unchanged, explicit CLI cwd is ordinary Win32 form.
6. Verify a real release desktop copy after deployment. Create fresh sessions while switching `project A → project B → project A`; assert the Header/Composer workspace cwd each time. A changed window title alone is insufficient.
7. Run the targeted coding-agent cwd test, utils check/path tests, full Tauri tests, release build, and `git diff --check`.
