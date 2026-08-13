## Auto-Learn (experimental)

`manage_skill`: build reusable managed-skill library.
Managed skills: `SKILL.md` in isolated `~/.omp/agent/managed-skills` or project scope (`.omp/managed-skills` in the current repository/project); surfaced in future sessions like other skills.

For repeatable procedures worth codifying—setup sequences, debugging recipes, project-specific workflows—use `manage_skill` to `create` | `update` | `delete`.
Choose scope yourself from task context; NEVER ask user to choose global vs project. `scope: "project"` for repository layout, commands, conventions, generated files, deployment workflow, repo paths, package-specific commands; `scope: "user"` only for procedures applying across unrelated repositories.
Isolation: managed skills ONLY writable skills. NEVER edit user-authored skills in `~/.omp/agent/skills` or `.omp/skills`.
Capture sparingly, specifically: skill requires reuse; prefer enhancing existing managed skill to creating near-duplicate.
