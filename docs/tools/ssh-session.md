# ssh_session

> Manage SSH aliases stored on the current session branch.

## Source
- Entry: `packages/coding-agent/src/tools/ssh-session.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/ssh-session.md`
- Session reducer: `packages/coding-agent/src/session/session-ssh-config.ts`
- Effective host registry: `packages/coding-agent/src/ssh/host-registry.ts`
- Session persistence: `packages/coding-agent/src/session/session-manager.ts`

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `op` | `"create" \| "update" \| "delete" \| "list"` | Yes | Session alias operation. |
| `name` | `string` | Create/update/delete | Alias containing letters, numbers, `.`, `-`, or `_`; maximum 100 characters. |
| `host` | `string` | Create | SSH hostname or address. An update may replace it. |
| `username` | `string \| null` | No | SSH username. `null` clears it during update. |
| `port` | `number \| null` | No | Integer from 1 through 65535. `null` clears it during update. |
| `key_path` | `string \| null` | No | Path to a local private-key file. `null` clears it during update. |
| `password` | `string \| null` | No | Literal SSH password. `null` clears it during update. |
| `description` | `string \| null` | No | Human-readable alias description. `null` clears it during update. |
| `compat` | `boolean \| null` | No | Windows compatibility-shell preference. `null` clears it during update. |

`create` rejects `null` configurable fields. `update` preserves omitted fields and requires at least one configurable field. `list` and `delete` reject configurable fields.

## Outputs
- `create` and `update` return the alias target, changed field names, and `hasPassword`; they never return the password value.
- `delete` confirms the removed session alias and returns its non-secret view.
- `list` returns only aliases defined by the current session branch, sorted by name.
- Approval details and terminal rendering show `hasPassword` instead of the password.

## Flow
1. `create` appends an `ssh_config_change` upsert containing the complete alias configuration.
2. `update` reads the current branch value, applies supplied fields, and appends another complete upsert.
3. `delete` appends an `ssh_config_change` tombstone. It does not rewrite earlier records.
4. The session reducer reconstructs aliases by following the selected branch from root to leaf.
5. The effective host registry merges aliases with whole-entry precedence: current session, managed project config, managed user config, repository `ssh.json`, then repository `.ssh.json`.
6. A session alias therefore overrides a persistent alias with the same name. Deleting the session alias reveals the persistent alias again when one exists.
7. Every mutation refreshes `ssh`, `ssh_transfer`, and all `ssh://` consumers. With `xd://` enabled, remote command execution mounts at `xd://ssh`; explicit tool selection or disabled `xd://` keeps `ssh` top-level. The alias is immediately available to Read, Write, Grep, Edit, hashline snapshots, host indexes, and path autocomplete.
8. Switching branches, forking, rewinding, navigating the session tree, creating a new session, or switching session files reconstructs the aliases for the selected leaf and closes obsolete SSH connection targets.

## Persistence and credential handling
- Passwords are stored as plaintext in the local session JSONL inside `ssh_config_change` upsert entries. Protect the session file with the same care as a credentials file.
- Assistant `ssh_session` tool-call arguments, tool results, terminal events, Remote Procedure Call and Agent Client Protocol events, extension events, and collaboration events do not retain the password value.
- Share snapshots, HTML exports, and debug report bundles omit `ssh_config_change` entries or replace matching password text before leaving the local session store. This SSH-specific handling is always enabled, independent of general share-secret settings.
- Password authentication uses the existing SSH askpass path. The password enters the child-process environment and askpass input; it does not enter SSH arguments, ControlMaster paths, scripts, canonical resource keys, hashline snapshot keys, logs, errors, or artifact metadata.
- `key_path` accepts a filesystem path only. Inline private-key or certificate content is unsupported. Existing private-key existence and permission checks still apply.

## Branches, forks, deletion, and collaboration
- Branches and forks inherit the SSH configuration visible at their branch point. Later mutations affect only descendants of the new entry.
- Navigating to an earlier leaf can restore an older password because the historical upsert remains in the append-only journal.
- `delete` appends a tombstone. It does not physically erase earlier JSONL lines, branches, forked session files, copied files, or backups.
- To remove historical credentials, delete the relevant session files and backups after confirming they are no longer needed.
- `ssh_config_change` entries are excluded from collaboration snapshots and live entry broadcasts.
- Ordinary user chat remains part of the shared transcript. A password typed directly into a normal chat message can be visible to connected collaboration guests; use the `password` field of `ssh_session` instead.

## Side effects
- Filesystem: appends session journal entries and may cause SSH host-info cache or ControlMaster files to be created when the alias is used.
- Network: none for CRUD operations; using the alias through `ssh`, `xd://ssh`, `ssh_transfer`, or `ssh://` opens the remote connection.
- Session state: refreshes the effective host registry, SSH command and transfer tool registration, mounted or active tool sets, system prompt host list, and autocomplete host index.
- Persistent SSH configuration: never modified. `update` and `delete` only operate on aliases already defined in the session layer.

## Errors
- Invalid or missing alias names fail before mutation.
- Empty `host`, `username`, `key_path`, `password`, or `description` strings are rejected when supplied.
- Ports outside `1..65535` or non-integer ports are rejected.
- `create` fails when the session branch already defines the alias.
- `update` and `delete` fail when the alias exists only in persistent configuration or does not exist.
- `update` fails when no configurable field is supplied.

## Notes
- A session alias can intentionally shadow persistent project or user configuration without editing its JSON file.
- `list` reports the session layer, while `ssh`, `xd://ssh`, `ssh_transfer`, and `ssh://` use the merged effective registry.
- Session aliases are unavailable in a different session unless they are inherited through a forked session history.
- URL-embedded passwords remain unsupported, and configured aliases cannot be overridden with a different URL username or port.
- Glob continues to reject `ssh://` targets; this tool does not add remote recursive globbing.
