Manage Oh My Pi managed Git worktrees for isolated agent work.

<instruction>
Pick `op`. Managed worktrees belong to the current repository family.
- `list` — show managed worktrees for the current primary checkout.
- `add` — create a detached managed worktree. `base` defaults to `HEAD`; `dirtyPolicy` defaults to `ignore`.
- `path` — return the target cwd for a managed worktree.
- `switch` — move the current AI session cwd to the managed worktree target cwd. It NEVER opens or swaps to another session file.
- `merge` — apply managed-worktree changes back to the local checkout. The local checkout must be clean.
- `remove` — remove a managed worktree. Unapplied changes are snapshotted instead of discarded.
- `branch` — create a branch inside a detached managed worktree.
- `restore` — restore a managed worktree from its saved snapshot.
</instruction>

<output>
Returns a concise text summary plus structured `details` with `op`, `items`, `record`, `worktreeRoot`, `targetCwd`, `warnings`, `switchedCwd`, and `removed` when relevant.
</output>

<critical>
- Use `switch` only when subsequent tool calls should run inside that worktree.
- Use `merge` only when applying worktree changes to the local checkout is intended.
- Use `remove` only for the named managed worktree; it never clears all worktrees.
</critical>
