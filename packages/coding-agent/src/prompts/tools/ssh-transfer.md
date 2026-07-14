Transfers one file between the local filesystem and an SSH host.

- You MUST use this for local ↔ remote file content.
- You NEVER embed file bytes or base64 in `ssh` commands.
- One call handles one regular file; directories and batches are unsupported.
- `remote_path` MUST be absolute for the detected remote platform.
- Existing destinations are rejected unless `overwrite: true`.
- POSIX overwrite MAY use platform move commands when exact replacement is unavailable; a narrow concurrent-target race remains.
- Set `async: true` for background transfer and live progress.
- Background completion arrives automatically; use `job` only to inspect or cancel.
- Persistent hosts and `ssh_session` aliases are both supported.

<critical>
You MUST use `ssh_transfer` for local ↔ remote files.
You NEVER transfer file payloads through `ssh` command text.
</critical>
