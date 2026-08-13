Managed skill: `SKILL.md` in isolated user scope `~/.omp/agent/managed-skills` or project scope `.omp/managed-skills` in the current repository/project; surfaced like a normal skill in future sessions. `scope` is required.

Use: repeatable procedures worth codifying — setup sequence, debugging recipe, project-specific workflow.
User-authored skills separate; tool NEVER edits them.

- `action: "create"` — fails if skill exists.
- `action: "update"` — overwrites body; fails if skill absent.
- `action: "delete"` — fails if skill absent.

- Use `scope: "project"` when the procedure depends on this repository's package layout, commands, conventions, generated files, deployment workflow, or other project-local facts.
- Use `scope: "user"` only when the same procedure should apply across unrelated repositories.
- Lesson mentions repo paths or package-specific commands? Choose `scope: "project"`.

`name`: kebab-case (lowercase letters, digits, hyphens).
`description`: specific; drives discovery.
No frontmatter in `body`; generated from `name` and `description`.
