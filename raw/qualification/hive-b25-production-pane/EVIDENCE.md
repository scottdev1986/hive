# B2.5 production-pane / row K evidence

Pin series continued from helga by horatio. Ports 43140+. Short homes only.

## Status

| Cell | Status | Artifact |
|------|--------|----------|
| Production wiring substrate (daemon-owned broker + visibility + handshake under short home @43140) | GREEN (substrate) | matrix/production-wiring.txt |
| Production wiring full (sessiond agent + HiveTerminalView under real Workspace) | OPEN | matrix/production-wiring-pane.txt |
| A4 exact per-pane close | GREEN | matrix/a4-exact-close.txt |
| A4 concurrent quit + process-tree | COMPOSED-NOW / FAITHFUL-PENDING-UNLOCK | matrix/a4-quit.txt; matrix/diagnostic-a4-quit-harness-entanglement.txt |
| A4 non-Hive project | GREEN | matrix/a4-non-hive-project.txt |
| A4 restart/reconnect/replay | GREEN | matrix/a4-reconnect-replay.txt |
| 100 MiB pane ordered-output | GREEN | matrix/stress-100mib-pane.txt; matrix/stress-100mib-pane-xctest.txt; manifests/stress-100mib-pane.json |
| Row K Claude | OPEN | matrix/row-k-claude.txt |
| Row K Codex | OPEN | matrix/row-k-codex.txt |
| Row K Grok | OPEN | matrix/row-k-grok.txt |
| Gate-10 Instruments leak/UAF | OPEN (multi-pane waits #40) | — |
| Gate-10 multi-pane latency | OPEN (waits #40) | — |

## Provenance

See `provenance.txt` and `evidence-sha256.txt` after first GREEN cell.

The quit row composes three independently measured clauses: p14's real
production Workspace/vendor lifecycle, the live sentinel provider-tree stop,
and AppDelegate's wait-for-success / refuse-on-survivor tests. Vendor identity
is required by row K, not by A4 lifecycle attribution. A faithful app-quit run
on the daemon-self-owned production stack remains in the unlock batch.

The 100 MiB row runs 1,600 content-sensitive frames through a real agent
`PaneView` and `HiveTerminalView` using the production `pumpHostFrame` →
`AttachReplayClient` → ordered applicator → Ghostty C path. The locked XCTest
uses Ghostty's real headless manual surface, while the separate production-pane
cell owns physical Metal/window evidence. Gate 5's checksum-verified full-volume
sink and single-byte mutation remain the byte-loss prior art; this row adds the
pane path, APPLIED receipts, semantic tail, and measured main-run-loop latency.
