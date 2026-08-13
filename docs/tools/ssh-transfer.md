# ssh_transfer

> Transfer one file between the local filesystem and an SSH host.

## Source
- Entry: `packages/coding-agent/src/tools/ssh-transfer.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/ssh-transfer.md`
- Host resolution: `packages/coding-agent/src/ssh/host-registry.ts`
- Connection management: `packages/coding-agent/src/ssh/connection-manager.ts`
- Related: `packages/coding-agent/src/tools/ssh.ts` — remote command execution; `packages/coding-agent/src/tools/ssh-session.ts` — session-scoped aliases.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `op` | `"upload" \| "download"` | Yes | Transfer direction. Upload copies a local file to the remote host; download copies a remote file to the local filesystem. |
| `host` | `string` | Yes | SSH host name — a configured host or a session alias created by `ssh_session`. |
| `local_path` | `string` | Yes | Local file path. |
| `remote_path` | `string` | Yes | Absolute remote file path for the detected remote platform. |
| `overwrite` | `boolean` | No | Replace an existing destination. Default `false`; existing destinations are rejected unless set. |
| `async` | `boolean` | No | Run the transfer in the background with live progress. Default `false`. Background completion is delivered automatically; use `job` only to inspect or cancel. |

## Outputs
- Success returns the destination path and, for background transfers, a job id with progress updates.
- Background completion arrives automatically; `job` is for inspection or cancellation only.

## Flow
1. Resolve the host against persistent hosts and session aliases (`ssh_session`), merging the effective host registry.
2. Transfer exactly one regular file. Directories and batches are unsupported.
3. Existing destinations are rejected unless `overwrite: true`.
4. POSIX overwrite may use platform move commands when exact replacement is unavailable; a narrow concurrent-target race remains.
5. With `async: true`, the transfer runs in the background with live progress reporting.

## Errors
- Existing destination without `overwrite: true` is rejected.
- Non-absolute `remote_path` for the detected remote platform is rejected.
- Transfer failures surface the remote error, including connection and permission failures.

## Notes
- This tool is the required path for local ↔ remote file content; never embed file bytes or base64 in `ssh` command text.
- Persistent hosts and `ssh_session` aliases are both supported.
- One call handles one regular file; directories and batches are unsupported.
