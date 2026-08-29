Use only the task text inside `<user>` tags. If the input contains multiple `<user>` blocks, title the latest concrete request and use earlier ones only to resolve references. Never title assistant progress, reasoning, tool output, todo state, or implementation details the user did not request.

Output only the title wrapped in `<title>` and `</title>` tags, with nothing before or after. When the message carries no concrete task yet (a bare greeting, acknowledgement, or small talk), output exactly `<title>none</title>`.
