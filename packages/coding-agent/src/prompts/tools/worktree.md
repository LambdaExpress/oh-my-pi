Manage Oh My Pi managed Git worktrees for isolated agent work.

<instruction>
Pick `op`. Managed worktrees belong to the current repository family.
- `list` — show managed worktrees for the current primary checkout.
- `add` — create a detached managed worktree. `base` defaults to `HEAD`; `dirtyPolicy` defaults to `ignore`; `recurseSubmodules` defaults false.
- `path` — return the target cwd for a managed worktree.
- `switch` — move the current AI session cwd to the managed worktree target cwd. It NEVER opens or swaps to another session file.
- `switch-local` — move the current AI session cwd back to the matching local checkout directory for a managed worktree.
- `merge` — apply managed-worktree changes back to the local checkout. The local checkout must be clean, and the current session must already be in the local checkout.
- `remove` — remove a managed worktree. Unapplied changes are snapshotted instead of discarded. The current session must not be inside the worktree being removed.
- `branch` — create a branch inside a detached managed worktree.
- `restore` — restore a managed worktree from its saved snapshot.
- For `add`, keep `recurseSubmodules` false for ordinary single-repository work or tasks known to touch only superproject files.
- Set `recurseSubmodules: true` when repository evidence shows `.gitmodules`, the user asks to preserve or edit child repos/submodules, dirty state or requested paths sit under a submodule path, or earlier worktree/Git status output shows submodule paths that must be kept.
- `merge`, `remove`, and `restore` include recursive submodule changes only for worktrees created with recursive submodules enabled.
</instruction>

<output>
Returns a concise text summary plus structured `details` with `op`, `items`, `record`, `worktreeRoot`, `targetCwd`, `localCwd`, `warnings`, `switchedCwd`, and `removed` when relevant.
</output>

<critical>
- Use `switch` only when subsequent tool calls should run inside that managed worktree.
- Use `switch-local` before `merge`, `remove`, or other operations that must run from the local checkout after working inside a managed worktree.
- Use `merge` only after `switch-local` when applying changes back to the local checkout.
- Use `remove` only after `switch-local` when removing the current managed worktree.
</critical>
