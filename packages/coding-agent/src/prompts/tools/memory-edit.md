Edit Mnemopi long-term memories by id.

Use only with ids returned by the `recall` tool. Operations:
- `update`: replace content and/or importance for a working memory.
- `forget`: permanently delete a working memory or recalled fact.
- `invalidate`: softly supersede a working or episodic memory, optionally pointing at `replacement_id`.

Recalled `[facts]` ids cannot be updated or invalidated; use `forget` and then `retain` the corrected fact.
Prefer `invalidate` when a memory became stale but its history may still be useful. Use `forget` only for content that should be hard-deleted.
