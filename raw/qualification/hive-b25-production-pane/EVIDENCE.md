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
| Row K Claude | OPEN | **no capture exists** — owed, see "Row K is owed" below |
| Row K Codex | OPEN | **no capture exists** — owed, see "Row K is owed" below |
| Row K Grok | OPEN | **no capture exists** — owed, see "Row K is owed" below |
| Gate-10 Instruments leak/UAF | OPEN (multi-pane waits #40) | — |
| Gate-10 multi-pane latency | OPEN (waits #40) | — |

## Row K is owed — no capture exists

The three row K rows above previously cited `matrix/row-k-claude.txt`,
`matrix/row-k-codex.txt` and `matrix/row-k-grok.txt`. **Those files have never
existed in this tree.** They were intended filenames written alongside the row
definitions, not references to captures — but the Artifact column made them
read as recorded evidence. Corrected 2026-07-20 per the M1 definition-of-done
audit (`planning/m1-definition-of-done-audit.md`, `2e11217c`).

Row K — real Claude Code, Codex and Grok interactive TUIs driven through the
production pane — **is owed in full on all three vendors**. Nothing about it has
been measured. It is not a formality: row K gates four separate closures — B1
DoD-1 (`planning/story-m1-b1-ghosttykit-qualification.md:68`, the A–K matrix green with K on all three
vendor TUIs, no carve-out), B2 DoD-6, B2.5, and the Removal Gate itself
(`planning/story-001-gut-tmux.md:16` — "If ANY matrix cell fails, this story cannot
execute"). Row K also depends on the production-wiring-full cell above, which is
itself still OPEN.

When the captures are taken, restore the filenames to the Artifact column and
add their digests to `evidence-sha256.txt`. Until then this section is the
honest state.

### The "capacity-deferred to 2026-07-26" claim is UNSOURCED

Row K is sometimes described as capacity-deferred to 2026-07-26 because of Grok
quota. **That linkage is not recorded anywhere and should not be repeated as
fact.**

What is genuinely on main is narrower, and C1-scoped:

- `workspace/docs/c1-c11-typography-evidence.md:76` — Grok measured at 0% weekly
  capacity, marked `CAPACITY-DEFERRED` until the 2026-07-26 reset, with no
  attempt and no fabricated fixture. This is a **C1.1 typography** row.
- `workspace/docs/hive-terminal-c12-cross-vendor-review-hollis2.md:10` — the
  Codex **and** Grok pools are both quota-exhausted until 2026-07-26. This is a
  **C1.2 cross-vendor review** statement.

The quota exhaustion is real, it was properly measured, and it would plausibly
block a row K capture too. But no B1, B2 or B2.5 document, and not issue #36,
ties row K to that date — and note that the C1 record names *Codex and Grok*,
so even "deferred due to Grok" is narrower than what was measured. The
deferral was recorded for C1 and then carried to row K in conversation without
ever being written down.

Two consequences for whoever picks this up: row K's blocker is currently
**unknown**, not "Grok quota" — re-measure vendor capacity rather than assuming
the C1 reading still holds; and if the deferral is real, record it *here*, where
row K is tracked, with its own measurement. Whether a documented Grok deferral
could close M1's exit at all is an open user ruling
(`planning/m1-definition-of-done-audit.md` §5 Q3) — B1 DoD-1 grants no carve-out.

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
