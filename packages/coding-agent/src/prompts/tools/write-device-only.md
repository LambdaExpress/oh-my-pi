Executes a mounted `xd://` tool device: `path` is `xd://<tool>` and `content` is the device's JSON arguments object. `read xd://` lists the mounted devices; `read xd://<tool>` shows a device's full docs.

Also accepts:
- `local://<name>`: session scratch files (reports, drafts, notes).
- `agent://<id>` / `agent://all`: peer messages when enabled; `content` is verbatim message text, not device JSON.
- `proc://<id>/kill`: cancel background work; omit `content`.

Working-tree writes, other internal-URL writes, and `proc://<id>` stdin are rejected. Mounted devices retain their own permission checks.
