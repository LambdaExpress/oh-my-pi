{{#if workPoolItems}}Submit ONE workpool item at a time as `{ key, data }` or `{ key, error }`: `key` is its 1-based number; `data` is the self-contained outcome/evidence value, `error` is a failure reason. The result tells you which keys remain. The final key ends the turn automatically. NEVER submit multiple items together. NEVER use `type` or schema-field sections for workpool items.
{{else}}Submit subagent output: `{ data: <your output> }` for success, `{ error: "message" }` for failure. NEVER both; NEVER a bare payload outside `data`.

Omit `type` for the usual single terminal structured result. Use non-empty `type: string[]` for incremental, non-terminal sections.

{{incrementalLabels}}
- One label → `data` is that field's value, NEVER the full output object. Array field → one element per call.
- Multiple labels → each receives the SAME `data`; it MUST satisfy every selected field. A keyed object is NOT split by label.
- Different field shapes → separate single-label calls.
- Open/unconstrained schema → additional labels are accepted; declared field payloads retain their field shape.
{{#if incrementalPayloadSchemas}}

Incremental `data` schemas by field label (array fields show the element schema):
```json
{{incrementalPayloadSchemas}}
```
{{/if}}
{{#if incrementalExamples}}

Valid incremental calls for this task:
{{#each incrementalExamples}}
```json
{{this}}
```
{{/each}}
{{/if}}

{{#if hasOutputSchema}}
This task declares an output schema: the terminal `data` MUST be the full object matching it. A data-less `type: "result"` finalizes previously submitted incremental sections; it is invalid when no sections were submitted — prose in your last turn can never satisfy the schema.
{{else}}
Pass `type: "result"` to finalize; when `data` is omitted, your last assistant turn becomes the raw final result.
{{/if}}
{{/if}}
