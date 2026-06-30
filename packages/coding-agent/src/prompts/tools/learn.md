Capture a reusable lesson into long-term memory, and optionally mint or enhance a managed skill in the same call.

Use after solving something whose insight will pay off again: a non-obvious fix, a project convention you had to discover, a workflow that worked.

Provide the optional `skill` object when the lesson is a repeatable *procedure* worth codifying as a `SKILL.md` (not just a fact). Managed skills are written to user scope (`~/.omp/agent/managed-skills`) or project scope (`.omp/managed-skills` in the current repository/project); `scope` is required. Use `scope: "project"` when the procedure depends on this repository's package layout, commands, conventions, generated files, deployment workflow, repo paths, or package-specific commands. Use `scope: "user"` only when the same procedure should apply across unrelated repositories. Managed skills NEVER touch user-authored skills. Frontmatter is generated from `name` and `description`.

Capture sparingly and specifically. One strong, reusable lesson beats several vague ones.
