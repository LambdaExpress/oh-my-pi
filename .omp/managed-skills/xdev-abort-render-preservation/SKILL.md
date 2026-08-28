---
name: xdev-abort-render-preservation
description: "Use when an xd:// tool abort or error loses its mounted renderer, call arguments, or output-card shape."
---

When a `write xd://<tool>` call changes from the mounted tool frame to a generic `Write` error on abort:

1. Trace the final result metadata. `writeToolRenderer` delegates only when `WriteToolDetails.xdev` exists.
2. Do not special-case the generic TUI component. Preserve the tool result shape at the source.
3. Implement or repair `AgentTool.createAbortedResult` on the transport tool. Return the visible abort text plus `details.xdev = { tool, mode: "execute", args }` reconstructed from the outer write arguments.
4. Return `undefined` for non-device writes or undecodable device content so existing fallback behavior remains intact.
5. Verify the mounted renderer shows its original call arguments and the abort text in its output section, with no generic `Write` title.
6. Confirm runtime wrappers preserve the hook: `wrapToolWithMetaNotice` mutates in place, `ExtensionToolWrapper` forwards via `applyToolProxy`, and the ACP gate uses a `Proxy`.
7. Run the device write, mounted renderer, event-controller queue, and failed-turn rendering tests, then the coding-agent package check.
