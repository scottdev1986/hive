# B2.5 production-pane / row K evidence

Pin series continued from helga by horatio. Ports 43140+. Short homes only.

## Status

| Cell | Status | Artifact |
|------|--------|----------|
| Production wiring substrate (daemon-owned broker + visibility + handshake under short home @43140) | GREEN (substrate) | matrix/production-wiring.txt |
| Production wiring full (sessiond agent + HiveTerminalView under real Workspace) | GREEN (Codex, `a1f73119`) | matrix/production-wiring-pane.txt; manifests/production-wiring-pane.json |
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

### 2026-07-21 production-wiring runs

The twice-rebased full production cell is green at `a1f73119`: the worktree-pinned staged
release spawned a real Codex agent in a non-Hive repository, Workspace installed
`HiveTerminalView` on its exact sessiond locator, and the staged CLI both set and
read back dangerous autonomy before the unattended spawn. The pane presented
nonblank window contents with no hidden renderer PTY, and the live vendor
persisted the exact nonce through `hive_send`. Session
`ses_019f86dc-7e86-701d-9f9d-2363e5cfdc14` reached high-water 16,714 with 51
draws and a 59,670-byte ordered journal. The cell also mutates the display
preflight, locator, transcript, screenshot, and nonce checks to prove each
assertion bites.

The final daemon SIGKILL line is the harness's bounded cleanup fallback after
exact agent/root-session absence was verified; the same teardown-race precedent
is retained in `matrix/diagnostic-p14-locked-screen-crop.txt`, so it does not
qualify the pane result.

The previous rebased capture at `0aa486b3` reached high-water 22,670 with 78
draws and a 60,367-byte ordered journal; its digest-pinned capture remains as a
control.

The pre-rebase confirmation at `42e74c55`, session
`ses_019f86ce-458e-7ee1-961b-18a636f66fb1`, reached high-water 31,609 with 55
draws and a 99,295-byte ordered journal; its digest-pinned capture remains as a
control. The earlier full production run at `5b448217` likewise spawned a
real Codex agent in a non-Hive repository, Workspace installed
`HiveTerminalView` on its exact sessiond locator, presented nonblank window
contents with no hidden renderer PTY, and the live vendor persisted the exact
nonce through `hive_send`. The transcript reached 58,153 ordered bytes; the
cell also mutated the display preflight, locator, transcript, screenshot, and
nonce checks to prove each assertion bites.

Two failed controls are retained rather than edited away. Session
`ses_019f86b3-ed52-7d4b-883f-d21cea8041a5` shows Codex stopped at repository
trust because the spawn override used a logical/dotted project path. Session
`ses_019f86b6-cb8a-747c-8ae7-1226a4fbf721` shows the fixed renderer live while
the isolated proof still waited for an MCP approval. The earlier successful session
`ses_019f86bb-f335-7976-9dba-b9531d0f1f5c` uses the canonical inline-table
trust override and a read-only agent with Hive-owned tool prompts disabled.
Their screenshots and journals are digest-pinned below. The broader defect that
the readiness gate treats a live vendor parked at an interactive prompt as dead
is tracked separately as GitHub issue #95; this B2.5 work does not change that
policy.

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
now green.

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

#### Historical 2026-07-20 blocker record: the GUI gate, not quota

`matrix/production-wiring-pane.txt` (2026-07-20T06:04:12.348Z):

    MUTATION VERIFIED: locked session breaks the real-window pixel preflight
    FAIL: real Workspace pixel qualification requires an unlocked macOS session

Row K is defined as the real vendor TUIs driven **through the production pane**,
so it inherited that same real-window preflight. In that run, row K was
unattemptable on all three vendors. The 2026-07-21 run above supersedes this
blocker: the session was measured unlocked and the production-wiring-full cell
is green. Row K remains open because this cell proves production wiring and one
Codex execution nonce, not the full interaction matrix on all three vendors.

#### Historical 2026-07-20 quota snapshot

At that observation, Codex and Grok were recorded at 0% until their resets
(Codex 2026-07-26T00:00:27Z; Grok 2026-07-26T17:18:56Z, rolling). Those values
are retained as timestamped evidence, not current availability: the successful
Codex execution above proves enough capacity for this cell but does not measure
the account's remaining quota.

On the date itself: 2026-07-26 was **real and independently re-measured on
2026-07-20**,
not a C1-era artifact. But the attribution in the received story was wrong twice
over — the earliest 07-26 reset is **Codex's**, roughly 17 hours before Grok's,
so "deferred because of Grok" is narrower than what was measured. The C1 record
naming *both* pools was the accurate one.

#### Historical trap: a full sub-pool did not mean the vendor was available

`hive_quota_status` also reports Codex pool `codex_bengalfox`
(`gpt-5.3-codex-spark`) at used **0**, remaining **100%**, reset
2026-07-27T12:43:37Z. **This did not give Codex capacity at that observation.**
A run reserves against *every* pool that meters the model, all-or-nothing, and
the tightest pool governs (`src/daemon/quota-ledger.ts:1158-1164`). The
account-wide `["*"]` pool sat at 0% remaining, so it gated spark too. Reading the
spark row alone — or
checking only the first matching pool — is exactly how two deep-tier agents were
once routed onto a model whose own weekly pool was at 99%.

#### No capacity deferral is recorded for row K

Deliberately. B1 DoD-1 grants no carve-out, and none is sought here. The GUI
prerequisite and a Codex production execution are now green; the remaining row
K work is the full recorded Claude/Codex/Grok interaction matrix and independent
reproduction, not an inferred capacity waiver.

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
