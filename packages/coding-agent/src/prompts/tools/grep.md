Greps files using regex (Rust regex + PCRE2).

<instruction>
- Supports Rust regex and PCRE2 syntax.
- `path`: SHOULD scope to a known path (e.g. `src`); pass several as a delimited list (`src; tests`). Append a line selector to one file path (e.g. `src/foo.ts:50-100`); selectors never choose the search root.
- Cross-line patterns detected from literal `\n` or `\\n` in `pattern`.
- Internal URL directories are not recursive; read the listing, then grep specific files.
</instruction>

<critical>
- MUST use this over bash when searching!
- Open-ended multi-round search → Task tool + scout subagent, NOT chained `grep` calls.
</critical>
