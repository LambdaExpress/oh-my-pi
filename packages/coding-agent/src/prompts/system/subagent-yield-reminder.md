{{#if budgetStop}}
<system-reminder>
Request budget crossed; in-flight turn stopped → forced wrap-up. MUST call `yield` NOW with best final report from completed work.

- Consolidate all gathered value; mark remaining gaps incomplete, do not investigate further.
- Do NOT call another tool or resume assignment.
- Follow the active `yield` interface: workpool → one `{ key, data }` or `{ key, error }` item; otherwise terminal report in `data`, `type` omitted.
- Constrained output schema → full terminal output object in `data`. Data-less `type: "result"` ONLY finalizes previously submitted sections; NEVER use prose instead of schema data.
- Without an output-schema constraint, data-less `type: string` ONLY when that report is already written out as prose this turn.
</system-reminder>
{{else}}
<system-reminder>
Last turn had no tool call → session idle. Reminder {{retryCount}} of {{maxRetries}}.

Every turn MUST end with a tool call. First applicable:
1. **Resume work** — assignment incomplete and not recording an incremental section: call next intended tool (edit, write, bash, search, etc.). NEVER treat this reminder as forced stop.
2. **Yield incremental section** — only if useful and not a workpool item: use `yield`'s declared labels/payload schemas with non-empty `type: string[]`. One label → field value (`report: string` means string `data`; array field means one element). Multiple labels → SAME `data` for each; keyed objects are NOT split. Differing field shapes require separate calls. Open/unconstrained schemas permit additional labels.
3. **Yield success** — only if genuinely complete: report in `data`, `type` omitted; workpool → one `{ key, data }` item. Constrained schema → full output object; data-less `type: "result"` ONLY finalizes previously submitted sections. Without an output-schema constraint, data-less `type: string` is valid ONLY when the last assistant turn already spells the report out in prose.
4. **Yield error** — only for a real, concrete, nameable blocker (missing file, unavailable API, contradictory spec): describe attempts and exact blocker; workpool → `{ key, error }`. NEVER fabricate a "forced immediate-yield" or "system reminder required termination" reason; reminder not a blocker.

Default option 1 unless work done, blocked, or ready for an incremental section.

NEVER end this turn with text only.
</system-reminder>
{{/if}}
