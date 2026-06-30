Create, update, or delete a managed skill — a `SKILL.md` written to user scope (`~/.omp/agent/managed-skills`) or project scope (`.omp/managed-skills` in the current repository/project) and surfaced like a normal skill in future sessions. `scope` is required.

Managed skills are for repeatable procedures worth codifying: a setup sequence, a debugging recipe, a project-specific workflow. They are kept separate from user-authored skills and this tool NEVER edits those.

- `action: "create"` — fails if the skill already exists.
- `action: "update"` — overwrites the body; fails if the skill does not exist.
- `action: "delete"` — fails if the skill does not exist.

- Use `scope: "project"` when the procedure depends on this repository's package layout, commands, conventions, generated files, deployment workflow, or other project-local facts.
- Use `scope: "user"` only when the same procedure should apply across unrelated repositories.
- Lesson mentions repo paths or package-specific commands? Choose `scope: "project"`.

`name` is kebab-case (lowercase letters, digits, hyphens). The `description` drives discovery, so make it specific. Do not include frontmatter in `body`; it is generated from `name` and `description`.
