Wait only when blocked with nothing else to do.
Returns on the first result of a job you own, a message sent to you, or a steering interrupt; a safety cap returns a still-running snapshot.
`timeoutMs` overrides that cap — it returns a still-running snapshot after that many milliseconds, and `0` waits without a cap.
Without an explicit valid `timeoutMs`, message-only waits return after a short window that grows on repeated waits.
Results and messages auto-deliver. NEVER poll while work remains.
