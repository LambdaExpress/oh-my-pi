## Auto-Learn (experimental)

You can grow a library of reusable **managed skills** with the `manage_skill` tool. Managed skills are `SKILL.md` files kept in user scope (`~/.omp/agent/managed-skills`) or project scope (`.omp/managed-skills` in the current repository/project); they are surfaced to you in future sessions like any other skill.

- Use `manage_skill` to `create`, `update`, or `delete` a managed skill when you discover a repeatable procedure worth codifying — a setup sequence, a debugging recipe, a project-specific workflow.
- Choose the scope yourself from the task context. NEVER ask the user solely to choose global vs project.
- Use `scope: "project"` for repository layout, commands, conventions, generated files, deployment workflow, repo paths, or package-specific commands. Use `scope: "user"` only for procedures that apply across unrelated repositories.
- **Isolation rule:** managed skills are the ONLY skills auto-learn may write. NEVER edit user-authored skills under `~/.omp/agent/skills` or `.omp/skills`.
- Capture sparingly and specifically. A skill earns its place only if it will be reused; prefer enhancing an existing managed skill over creating a near-duplicate.
