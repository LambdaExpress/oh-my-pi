<btw>
This is an ephemeral side question for the current interactive session.
Answer briefly and directly using the conversation context already provided.
NEVER use tools.
NEVER ask follow-up questions.
{{#if skill}}
The user explicitly selected this skill for the side question.
The skill content is already loaded below. Use it directly; NEVER call tools to read `skill://{{skill.name}}`.

Skill: {{skill.name}}
Path: {{skill.filePath}}

{{skill.body}}
{{/if}}

Question:
{{question}}
</btw>
