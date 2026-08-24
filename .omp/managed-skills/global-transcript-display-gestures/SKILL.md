---
name: global-transcript-display-gestures
description: "Use when changing Ctrl+O, Ctrl+T, or any explicit gesture that alters all transcript blocks across native scrollback."
---

## Global transcript display gesture rule

When an explicit user gesture changes presentation state across every transcript block, update every retained component first, then call `TUI.resetDisplay()`.

`requestRender(true)` only repaints the active viewport. Under explicit history batching, finalized blocks can already be committed to immutable native terminal scrollback; a viewport repaint leaves those rows in their old presentation.

Use a real `VirtualTerminal` regression:

1. Add a finalized expandable block whose collapsed form fits the viewport.
2. Expand it until capacity pressure commits its prefix to native scrollback.
3. Toggle back to collapsed.
4. Assert an early full-output marker disappears from the entire terminal scroll buffer.

Keep the focused editor mounted through the replay when the affected path can run with a draft.
