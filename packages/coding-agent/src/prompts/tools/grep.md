Searches files and internal URLs with Rust regex plus PCRE2 fallback.

<instruction>
- Supports Rust regex and PCRE2 syntax.
- Scope `path` to known files, directories, globs, or internal URLs; separate roots with `;` (e.g. `src; tests`).
- Broad searches can time out; scope them narrowly or use `glob` first.
- One-file line selector: `src/foo.ts:50-100` (selectors never choose the search root).
- Literal `\n` or `\\n` enables cross-line patterns.
- Internal URL directories are not recursive; read the listing, then grep specific files.
</instruction>

<critical>
- MUST use this instead of shell `grep`/`rg`.
- Open-ended multi-round search MUST use {{#if scoutAvailable}}Task + scout,{{else}}Task,{{/if}} not chained calls.
</critical>
