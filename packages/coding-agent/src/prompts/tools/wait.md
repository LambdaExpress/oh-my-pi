Wait only when blocked with nothing else to do.
Returns on the first background result, peer message, or steering interrupt; a safety cap returns a still-running snapshot.
`timeoutMs` overrides that cap — it returns a still-running snapshot after that many milliseconds, and `0` waits without a cap.
Results and messages auto-deliver. NEVER poll while work remains.
