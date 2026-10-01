Capture reusable lessons in long-term memory; optionally mint/enhance a managed skill in the same call.

Use after solving insight likely to pay off again: a non-obvious fix, discovered project convention, or workflow that worked.

{{#if globalScope}}`scope: global` stores a lesson in the shared bank every project recalls; reserve it for cross-project lessons.
{{/if}}`skill` optional; provide only for a repeatable procedure worth codifying as `SKILL.md`, not a fact. Managed skills: user scope `~/.omp/agent/managed-skills` or project scope `.omp/managed-skills` in current repository/project; surfaced as normal skills next session. `skill.scope` REQUIRED: `"project"` when procedure depends on this repo's package layout, commands, conventions, generated files, deployment workflow, repo paths, or package-specific commands; `"user"` only when the same procedure applies across unrelated repositories. Lesson `scope` and `skill.scope` are independent. NEVER touch user-authored skills. Frontmatter: generated from `name` and `description`.

Capture sparingly, specifically: one strong reusable lesson > several vague ones.
