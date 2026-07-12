Manage SSH aliases for the current session.

<instruction>
- `create` requires `name` and `host`; it may temporarily shadow a configured alias.
- `update` changes an existing session alias. Omitted fields stay unchanged; `null` clears optional fields.
- `delete` removes a session alias; any shadowed configured alias becomes available again.
- `list` returns session aliases and `hasPassword` status. It NEVER returns password values.
- Names accept letters, numbers, `.`, `-`, and `_`; maximum 100 characters.
- Ports MUST be integers from 1 through 65535.
- `key_path` MUST reference a local private-key file. NEVER pass inline private-key content.
- `password` persists with the session. Deleting an alias does not erase existing session history or copies.
</instruction>

<critical>
Use `password` only in this tool's arguments. NEVER repeat it in chat, logs, URLs, commands, or later tool calls.
</critical>
