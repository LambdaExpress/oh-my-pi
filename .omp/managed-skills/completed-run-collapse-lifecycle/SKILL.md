---
name: completed-run-collapse-lifecycle
description: "Use when changing completed-run collapse, queued follow-up, compaction rebuild, or transcript live-gate behavior in coding-agent."
---

## Completed-run lifecycle checks

1. Distinguish agent lifecycle boundaries from user-message boundaries. `app.message.followUp` may drain inside the current `agent_start`/`agent_end`, so a new non-synthetic user `message_start` can close a naturally completed assistant segment without another `agent_start`.
2. Before rebuilding a projection at that boundary, await `AgentSession.waitForMessagePersistence(finalAssistant)` because display listeners see `message_end` before JSONL persistence.
3. Split only when the final assistant belongs to the current lifecycle and satisfies `isCollapsibleRunFinalAssistant`. Preserve aborted, errored, tool-use, force-flush, and cross-lifecycle continuation spans.
4. During transcript rebuild, a recovered collapse summary and an active `CompletedRunGate` may share one user-message anchor. Render both in one transcript block: summary first, gate second. Report the summary rows through `getTranscriptBlockSettledRows()` while the gate remains unfinalized.
5. Verify both contracts:
   - same-lifecycle queued follow-up immediately records/rebuilds the preceding run after persistence;
   - compaction rebuild shows `※ collapsed` while `TranscriptContainer.getNativeScrollbackLiveRegionStart()` remains immediately after the stable summary.
6. Run the focused suites:
   - `bun --cwd=packages/coding-agent test test/modes/controllers/event-controller-completed-run-collapse.test.ts`
   - `bun --cwd=packages/coding-agent test test/interactive-mode-completed-run-collapse.test.ts test/compaction-lifecycle.test.ts`
