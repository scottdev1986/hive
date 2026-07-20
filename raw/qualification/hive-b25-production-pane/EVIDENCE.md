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

Two consequences for whoever picks this up: row K's blocker was **unknown**, not
"Grok quota" — so vendor capacity was re-measured rather than inherited; and if
a deferral is real, it belongs *here*, where row K is tracked, with its own
measurement. Whether a documented Grok deferral could close M1's exit at all is
an open user ruling (`planning/m1-definition-of-done-audit.md` §5 Q3) — B1 DoD-1
grants no carve-out. **That re-measurement is below, and it resolves the blocker
to something that is not quota at all.**

### Re-measured 2026-07-20 — quota is NOT row K's binding blocker

Measured by ines at 2026-07-20T12:43–12:46Z via `hive_quota_status`, reading the
live vendor surfaces. Every figure below is quoted with its surface, its
observation time and its confidence label; none is carried from a document, and
none is smoothed. A bare percentage in this table would be unusable — the label
is what makes it evidence.

| Vendor | State | Surface | Raw reading (weekly unless noted) | Confidence / freshness |
|---|---|---|---|---|
| Claude | measured | statusline | 5h: used 15, remaining 67.5% (reset 2026-07-20T13:30:00Z). Weekly: used 45, remaining 51.7% (reset 2026-07-25T19:00:00Z) | reported / fresh; observed 12:45:45.824Z. Both windows carry an ESTIMATED reservation (17.5 / 3.3) |
| Codex | measured | provider `account/rateLimits/read` | pool `codex` (prolite, models `["*"]`): used **100**, remaining **0%**, reset 2026-07-26T00:00:27Z. Five-hour: `not-metered` | **authoritative** / fresh; observed 12:43:37.513Z |
| Grok | measured | ACP `_x.ai/billing` → `config.creditUsagePercent` | used **100**, remaining **0%**, reset 2026-07-26T17:18:56Z (rolling). Five-hour: `not-metered` | reported / fresh; observed 12:43:38.486Z |

Codex's `not-metered` five-hour is a **positive statement**, not a failed read:
that pool meters one weekly window and no five-hour window exists.

**Grok is measurable — an older reading that said otherwise is superseded.**
`config.creditUsagePercent` is a validated 0–100 used-gauge: across a measured
burn it moved 2→3→4→7→8 while the money rails stayed flat at zero, and a
probe-only control run three times did not move it
(`docs/providers/quota-surfaces.md:70+`). The parser
(`src/daemon/quota-sources.ts:940-982`) refuses to fabricate 0/100 — an
unreadable percent yields `weeklyMeterState: "unknown"` — so the 100 above is a
real measurement, not an absence rendered as a number. What is *not* a gauge is
the money-guard set (`onDemandCap` / `onDemandUsed` / `prepaidBalance`); those
zeros mean paid overflow is off, never "empty tank", and must never be rendered
as remaining capacity.

#### The binding blocker is the unlocked-GUI gate, not quota

`matrix/production-wiring-pane.txt` (2026-07-20T06:04:12.348Z):

    MUTATION VERIFIED: locked session breaks the real-window pixel preflight
    FAIL: real Workspace pixel qualification requires an unlocked macOS session

Row K is defined as the real vendor TUIs driven **through the production pane**,
so it inherits that same real-window preflight. Consequence: **row K is
unattemptable today on all three vendors — including Claude, which has ample
quota.** The production-wiring-full cell is a hard prerequisite, and it is
gated on a human action, not on capacity.

#### Codex and Grok at 0% is a SECOND constraint, not the reason row K is open

Once the GUI gate clears, quota bites next: Claude could attempt row K
immediately, Codex and Grok not until their resets (Codex 2026-07-26T00:00:27Z;
Grok 2026-07-26T17:18:56Z, rolling — it drifts, so do not treat it as a calendar
boundary). This is sequencing information. It is **not** the reason row K is
open, and it must not be restated as one.

On the date itself: 2026-07-26 is **real and independently re-measured today**,
not a C1-era artifact. But the attribution in the received story was wrong twice
over — the earliest 07-26 reset is **Codex's**, roughly 17 hours before Grok's,
so "deferred because of Grok" is narrower than what was measured. The C1 record
naming *both* pools was the accurate one.

#### Trap: a full sub-pool does not mean the vendor is available

`hive_quota_status` also reports Codex pool `codex_bengalfox`
(`gpt-5.3-codex-spark`) at used **0**, remaining **100%**, reset
2026-07-27T12:43:37Z. **This does not give Codex capacity today.** A run reserves
against *every* pool that meters the model, all-or-nothing, and the tightest pool
governs (`src/daemon/quota-ledger.ts:1158-1164`). The account-wide `["*"]` pool
sits at 0% remaining, so it gates spark too. Reading the spark row alone — or
checking only the first matching pool — is exactly how two deep-tier agents were
once routed onto a model whose own weekly pool was at 99%.

#### No capacity deferral is recorded for row K

Deliberately. The measured binding blocker is the unlocked-GUI gate; recording a
capacity deferral would re-attribute row K's openness to quota and recreate the
defect this section exists to correct. B1 DoD-1 grants no carve-out, and none is
sought here. The critical path is a human unlock session, after which Claude's
row K becomes attemptable and Codex/Grok follow their 07-26 resets.

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
