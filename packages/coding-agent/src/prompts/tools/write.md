Creates, overwrites, or appends to a file at specified path.

<conditions>
- Creating new files explicitly required by task
- Replacing entire file contents when editing would be more complex
- Appending chunks to an existing `local://` artifact via `mode: "append"`
- Supports `.tar`, `.tar.gz`, `.tgz`, and `.zip` archive entries via `archive.ext:path/inside/archive`
- Supports SQLite row operations via `db.sqlite:table` (insert), `db.sqlite:table:key` (update with JSON content, delete with empty content)
</conditions>

<critical>
- You SHOULD use Edit tool for modifying existing files
- You NEVER create documentation files (*.md, README) unless explicitly requested
- You NEVER use emojis unless requested
</critical>
