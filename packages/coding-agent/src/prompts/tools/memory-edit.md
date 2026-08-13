Edit Mnemopi long-term memories by id. Only ids returned by `recall`.

Operations:
- `update`: working memory; replace content and/or importance.
- `forget`: permanently delete a working memory or recalled fact.
- `invalidate`: softly supersede working or episodic memory; optional `replacement_id`.

Fact ids — `recall` results marked `[facts]`: cannot be updated or invalidated. Inspect with `read memory://<id>`; `update`/`invalidate` → `not_editable`. To correct a fact, forget it and retain the corrected fact.

Prefer `invalidate` for stale memory whose history may still be useful. Use `forget` only for content requiring hard deletion.

MUST read full memory before `update`. Recall previews clipped: trailing `…` marks truncation; `full_length` original size. `update` replaces content wholesale → updating a preview deletes its unseen tail. First `read memory://<id>`; pass merged content in `content`.
