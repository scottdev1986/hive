# Preserved-ref triage — measured 2026-07-25

Triage of the 49 `refs/hive-preserved/*` refs that survived the merged-tip sweep
recorded in `2026-07-25-orphan-worktree-reconciliation.md`. **Delete this file
once the retained refs are resolved.**

Read-only analysis. No ref, branch, or worktree was modified.

---

## 0. Safety: can a restart lose any of this? No.

Verified against source, not assumed.

`reconcilePreservedRefs` (`src/adapters/worktrees.ts:222-259`) is the only
automatic path that deletes a preservation ref. It deletes a ref **only** when
`git rev-list --count main..<tip>` is exactly `0`, and it does so with a
compare-and-delete (`update-ref -d <ref> <tip>`) so a concurrent re-preservation
fails the delete rather than being erased. Every one of these 49 refs has
`unmergedCommits > 0`, so every one takes the `report.kept` branch.

The only other two ways a preservation ref is removed are both explicit operator
actions, neither reachable from a restart:

- `src/daemon/server.ts:3014` — reached only when a kill is issued with
  `discardWork`, and only for that agent's own ref.
- `hive_preserve_branch` MCP tool with `preserved: false`
  (`src/daemon/server.ts:6040`), which additionally refuses live agents.

`deleteBranch` (`src/adapters/worktrees.ts:478`) deletes the branch but never
touches `refs/hive-preserved/*`; the ref alone keeps every object reachable.
There is no `git gc`, `--prune`, or `reflog expire` anywhere in `src/` or
`scripts/`.

**Conclusion: the claim holds. Restarting the daemon cannot lose any of these 49
refs.** This is a triage-at-leisure problem, not a pre-restart blocker.

---

## 1. Bucket counts

| Bucket | Refs | Meaning |
|---|---:|---|
| **A — content already on main** | 35 | Redone, rebased, squashed, or superseded. Nothing unique preserved. |
| **B — genuinely unique unmerged work** | 14 | Not on main in any form. Only bucket needing a human decision. |
| **C — cannot determine** | 0 | |

The 14 bucket-B refs are **6 distinct bodies of work**; the rest are duplicate
snapshots of the same work taken by successive agents.

## 2. Age distribution

Every ref tip falls between **2026-07-16 and 2026-07-21**. There is **nothing
from 2026-07-22 through today (07-25)**.

| Date | Refs |
|---|---:|
| 07-16 | 1 |
| 07-17 | 6 |
| 07-18 | 12 |
| 07-19 | 10 |
| 07-20 | 8 |
| 07-21 | 12 |

The expected cluster of near-empty refs from today's ~30 agent closures **does
not exist**. Today's agents either landed their work or held nothing to preserve.
This is entirely older material, 4–9 days old.

**Stale relative to current design docs:** only the C1.3 body of work is
measured against a live design row (see B1 — it is *not* stale). The review
evidence trees (B2) and the b2.5 handoff doc (B4) describe review passes and a
plan that main has since superseded with its own landed evidence under
`raw/qualification/`, so they are historical rather than pending.

---

## 3. BUCKET B — unique unmerged work (the decision list)

### B1. C1.3 pane chrome and focus attenuation — **the only substantive loss**

Five refs, one body of work, verified byte-identical on the C1.3 payload:

| Ref | Commits | Completeness |
|---|---:|---|
| `hive/nina-integrator-land-the-c1-3-chrom` | 4 | **most complete** |
| `hive/john-integrator-finish-a-killed-int` | 4 | identical payload to nina |
| `hive/maya-integrator-land-the-stranded-c` | 4 | identical payload to nina |
| `hive/hazelton-m1-item-4-c1-3-the-chrome-focu` | 3 | missing the docs commit (evidence doc 313 vs 415 lines) |
| `hazelton-c13` | 1 | earliest snapshot (tests 301 vs 343 lines, dead override not yet removed) |

Commits (nina's SHAs; john/maya carry the same subjects under different SHAs),
all 2026-07-20:

- `e0894225 feat(c1.3): pane chrome, focus attenuation, and the two hazard proofs`
- `ea763439 test(c1.3): natural positive control and appearance-fallout proofs`
- `9b366678 fix(c1.3): drop a mutation-proven-dead appearance override`
- `827026dd docs(c1.3): natural control, appearance fallout, and a dead-override finding`

**What it touches** — a real AppKit feature plus its proof harness, not a
document pass:

- `workspace/Sources/HiveWorkspace/PaneAttenuationView.swift` (new, 52 lines) —
  focus-by-attenuation overlay
- `workspace/Sources/HiveWorkspace/PaneBackgroundView.swift` (new, 31 lines) —
  semantic-color opaque pane fill replacing `NSVisualEffectView`
- `workspace/Sources/HiveWorkspace/PaneView.swift` — wiring
- `workspace/Tests/HiveWorkspaceTests/C13PaneChromeTests.swift` (new, 343 lines)
- `workspace/docs/c1-c13-chrome-focus-evidence.md` (new, 415 lines)
- `workspace/scripts/c13-mutation-proof.py` (new, ~250 lines) — mutation harness

**Evidence it is absent from main:** `git log main --grep='c1.3' -i` returns
zero commits; `git grep -i attenuat main -- workspace/` returns zero hits; all
six files above are absent from `main`. main carries `PaneFocusRingView.swift`
and `PaneStatusBorderView.swift` instead — related pane chrome, but not the
attenuation affordance or the hazard proofs.

**Read: valuable, not abandoned.** `planning/story-m1-c1-beautiful-blank-terminal.md:261`
still carries C1.3 as a live, un-descoped row demanding exactly this —
"focus-by-attenuation plus the system focus indicator … Overlay-view construction
is demonstrated, and the sublayer construction is demonstrated failing, so the
hazard is proven rather than asserted." The work matches the requirement,
includes its own mutation proof, and the last commit removes a mutation-proven-dead
override — the signature of a finished, self-reviewed increment, not a stub.
Three separate integrator agents (john, maya, nina) were each spawned to land it
and each was killed before doing so.

**Recommendation: land `hive/nina-…` (or john/maya — identical). Drop the other four.**

### B2. Independent review evidence trees — 3 refs, historical

`raw/review/` does not exist on `main` at all (main has `raw/reviews/` with one
unrelated file).

- **`hive/devon-category-code-review-cross-ven`** (1 commit, 07-18,
  `104d6871`) — `raw/review/b1-foundation-devon/`: a 94-line C build-id probe,
  an isolation runner shell script, an A/B diff, and a README. Devon's
  independent verification tooling for the B1 foundation review.
- **`hive/dexter-category-code-review-delta-cro`** (2 commits, 07-18,
  `3f458c59`, `0783c7f8`) — `raw/review/b1-repro-delta-dexter/` and
  `b1-repro-delta2-dexter/`: reproducibility sha256 manifests for shipped
  builds a/b/c, a repro driver script, a guard-unsorted probe, and a two-offset
  finding. 18 files, 630 lines.
- **`hive/deborah-cross-vendor-review-build-capa`** (1 commit, 07-18,
  `f7eb2bb9`) — two cross-vendor review write-ups for M1-A2 Inc 4 sessiond
  coexistence, one explicitly suffixed `-noland`.

**Read: archival, low value.** These are point-in-time review artifacts pinned
to commits (`ce4b7e00`, `c1497a50`, `a7ff468c`) that main has long since moved
past; one is self-labelled `noland`. The *findings* they produced were acted on
(the gate6 and B1 work landed). Losing the raw probe output loses reproducibility
of a superseded review, not any product capability.

### B3. geoff — broker-shutdown fail-open and the real-shell render proof — 2 refs

- **`hive/geoff-fix-the-hive-terminal-it-is-vi`** (2 commits, 07-19)
  - `0d8e80e7 fix(sessiond): restore PTY output post-processing (ONLCR)` —
    **this half is on main** as `025f75b6 fix(sessiond): keep OPOST|ONLCR after
    cfmakeraw (no live staircase)`; `ONLCR` appears 8× in main's `pty_host.zig`.
  - `519c5eb0 fix: fail open on gone broker at shutdown; observe RESIZE results` —
    **unique.** Adds `isSessiondBrokerUnavailable()` to `src/daemon/server.ts`
    (absent from main), RESIZE result observation in
    `AttachReplayClient.swift`, and a 244-line
    `workspace/Tests/HiveTerminalKitTests/RealShellRenderProofTests.swift`
    (no equivalent file on main).
- **`geoff-dirty-snapshot`** (07-19) — a **git stash commit** (two parents,
  `index on hive/geoff-…`) capturing geoff's uncommitted
  `RealShellRenderProofTests` working tree on top of `519c5eb0`. Strictly a
  dirty-state snapshot of the above.

**Read: worth one look, moderate value.** The fail-open-on-gone-broker behaviour
at shutdown is a real robustness fix and the real-shell render proof is a test
asset main lacks. Whether main still needs it depends on whether shutdown was
since reworked — worth 10 minutes of a reviewer's time, not a rewrite.
`geoff-dirty-snapshot` is redundant once the branch ref is dispositioned.

### B4. `hive/helga-fix-two-review-blockers-on-the` — 1 unique commit of 3

Two of three commits are patch-identical to main. Unique: `c4618c42
docs(b2.5): handoff for non-Grok successor (quota pause)` (07-19), touching
`workspace/docs/hive-terminal-b25-plan.md` (+131) and an EVIDENCE.md.

**Read: abandoned by design.** This is a handoff note written by an agent
pausing on a Grok quota exhaustion, for a successor. The successor work landed —
main carries the full b2.5 production-pane evidence under
`raw/qualification/hive-b25-production-pane/` and eight landed `b2.5` commits.
`workspace/docs/` does not exist on main; the plan doc's role was replaced. Safe
to drop.

### B5. `hulda-occlusion-reference-02bb827d` — 2 unique commits of 4

- `f0fe8663 instrument(workspace): log processOutput→invalidate→draw gate for #47`
- `02bb827d fix(workspace): present attach journal when AppKit still reports occluded`

**The fix itself is on main** — `occlusionState` and the attach `journal` are
both present in main's `HiveTerminalKit`, landed via the Gate 7 work
(`3cb46484`). What is unique is only the debug scaffolding
(`drawGateReason`, `testingMarkHighWaterForDrawGate` — both absent from main)
and the raw evidence artifacts `raw/hulda-blank-pane-AFTER-fixed.png`,
`raw/hulda-blank-pane-terminal-crop.png`, `raw/hulda-blank-pane-wire-fix.md`.

**Read: low value.** Diagnostic instrumentation for a bug that is fixed, plus
before/after screenshots. Keep only if the #47 screenshots are wanted for the
evidence record.

### B6. `hive/sam-verification-tripwire-for-the` and `sam-70-stop-gate-tripwire` — 2 refs, same commit

`ba3d0a39 test: #70 stop-gate tripwire (never land)` (07-20) — a **one-line**
addition to `scratch/stop-gate-tripwire.txt`. `scratch/` does not exist on main.

**Read: deliberately never-land.** The commit subject says so. This is a
tripwire probe verifying that the stop gate blocks a landing; its whole purpose
was to not reach main. Both refs are safe to drop.

---

## 4. BUCKET A — content already on main (35 refs)

Method: `git cherry -v main <ref>` for patch-id equivalence, then for each
commit `git cherry` reported as unique, a content check — either a byte-level
diff against the same-subject twin on main, or symbol/marker presence checks in
main's current source. Path-level tree diffs were **not** used as the signal:
main has advanced 970 commits since 07-16, so every ref "differs" from main on
its touched paths regardless of whether its work landed.

### A1. Fully patch-identical to main (`git cherry` reports every commit as `-`)

All commits in these refs have a patch-id twin already in main's history. Nothing
unique is preserved.

| Ref | Commits | What the work was |
|---|---:|---|
| `b25-production-pane-david-5b448217` | 2 | b2.5 production pane proof tooling + Codex worktree-trust canonicalization |
| `b25-production-pane-pre-rebase-42e74c55` | 4 | same series, pre-rebase snapshot |
| `b25-production-pane-first-rebase-0aa486b3` | 5 | same series, after first rebase |
| `b25-production-pane-second-rebase-a1f73119` | 6 | same series, after second rebase |
| `hive/david-m1-b2-github-issue-8-wire-hive` | 3 | the live branch of the same b2.5 series |
| `hive/james-m1-b2-b2-5-continuation-github` | 8 | b2.5 continuation through evidence-review closure |
| `harold-detached-973f41cc` | 2 | `Makefile` — `make build`/`make run` as canonical dev flow, `make clean` docs |
| `hattie-continue-a-crashed-agent-s-wor` | 2 | Swift workspace — C1 theme applied before attach, first-frame presentation on geometry-settle timeout |
| `horace-detached-fac2db0b` | 4 | daemon sessiond broker lifecycle + exclusive ownership proven by lock-holder pid |
| `hive/anna-advance-github-issue-6-m1-a4-c` | 1 | A4 close/reconnect drill WIP preserved at teardown |
| `hive/boris-independent-audit-fix-of-the-m` | 1 | M1-B1 gate 9 A-class reachability TRACE |
| `hive/chris-m1-b1-remainder-increment-3-pi` | 1 | identical commit to boris' |
| `hive/camila-story-m1-a2-respawn-sessiond-h` | 7 | sessiond frozen terminal-host client, negotiated control limits, daemon lifecycle wiring |
| `hive/crystal-m1-a2-production-sessionhost-b` | 7 | same seven commits, different SHAs |
| `hive/candace-story-m1-a2-cp-frozen-control` | 3 | neutral native host lifecycle, deadline-bounded tree termination |
| `hive/chiara-m1-a2-cp-native-ops-the-termin` | 2 | subset of candace's series |
| `hive/clinton-m1-a2-cp-native-ops-terminate` | 3 | same, plus frozen native LIST/INSPECT/TERMINATE handlers |
| `hive/lucas-github-issue-95-resume-path-co` | 1 | recovery — preserve live silent sessiond resumes |
| `hive/priya-github-issue-95-resume-path-co` | 1 | identical commit to lucas' |
| `hive/lucas-hold-do-not-hive-land-your-bra` | 3 | adapters — WP8 provider manifests, TG4 evidence, in-doubt/parse probe tightening |

### A2. Verified byte-identical to a differently-SHA'd twin on main

| Ref | Commits | Verification |
|---|---:|---|
| `harvey-followup-1005-1015` | 5 | 4 patch-identical; `10cf6e44` (DECSET 1005/1015 mouse coordinate formats) diffs **empty** against main's `56b2f012` on its touched paths |
| `harvey-residual-nits-hardening` | 3 | 2 patch-identical; `1f294882` (acceptance-matrix review nits) diffs **empty** against main's `371d1e94` |

### A3. Verified present on main by symbol and file checks

| Ref | Commits | Verification |
|---|---:|---|
| `duncan-gate10-groundwork` | 1 | `943407ba` "Build atomic terminal accessibility snapshot" → main's `280352d8`. Every touched file present on main (`Gate10SemanticSnapshotTests.swift`, `Gate10AccessibilityTests.swift`, `GhosttyGate10Probe/`); the only absent path is `0003-hive-semantic-snapshot.patch`, renumbered to `0004-…` on main. |
| `hive/duncan-category-complex-coding-m1-b1` | 1 | same commit as above |
| `hive/calvin-implement-gate-6-option-d-user` | 5 | 4 patch-identical; for the fifth (cross-library surface restore), all 10 added symbols incl. `testEveryLibVtAuthoredSplitRestoresIntoRealSurface`, `checkpointEngineId`, `makeManualSurface` are present on main |
| `hive/chester-m1-b1-gate-6-option-d-finalize` | 5 | identical series to calvin's |
| `hive/cindy-m1-b1-gate-6-option-d-finalize` | 5 | same series, different SHAs; same verification |
| `helena-production-sessiond-lifecycle` | 1 | `fdfc3617 feat(daemon): own sessiond broker lifecycle and stage hive-sessiond` — the same-subject commit inside `horace-detached-fac2db0b` is patch-identical to main, so this landed |
| `hive/james-implement-the-remaining-half-o` | 1 | `655f8820 fix: make sessiond liveness reports truthful` → main's `ceda3b74`, a **superset** (449 vs ~36 insertions). 8 of 9 markers present; `sessiondVendorProcessIsDead` was renamed on main to `sessiondAgentProviderRunIsDead` / `sessiondTerminalIsDead` |
| `hive/sarah-complete-github-issue-34-m1-a0` | 1 | `69c6dbb8` A0 freeze discriminators. main's `native/sessiond/test/pending-a1-contract.zig` contains **all 15** of the ref's tests; one (THV1-REAL-F) is reworded on main into a stricter ordering claim |
| `hive/zoe-complete-github-issue-34-m1-a0` | 1 | `954c02f4` — diffs **empty** against sarah's `69c6dbb8`; same verification |
| `hive/lucas-three-planning-deliverables-fr` | 1 | `bf5455b2` planning docs. All 5 files on main (`story-m3-s36-retrieval-core.md`, `story-m3-s37-digests-lifecycle.md`, `terminal-ownership-methodology.md`, both retrieval docs) and the `ADOPTED` banner is present on main |

### A4. Superseded — main carries a later implementation of the same work

| Ref | Commits | Verification |
|---|---:|---|
| `gate6-pin-d7a9104f` | 14 | All 24 touched files exist on main, and main is **strictly ahead**: `hive_checkpoint.zig` +425 lines, patches `0004-hive-semantic-snapshot` and `0005-hive-streaming-checkpoints` added. main's `a41e23df gate6: replay three-fix serializer + restore onto async main base` explicitly replays this series; all three memory-safety fixes (use-after-move, page-count preheat, grapheme/`hyperlink_map` side-table) are present on main. |
| `gate6-pre-rebase-backup` | 9 | Earlier snapshot of the same Gate-6 checkpoint-serializer effort; every surviving file is on main and superseded by the above. |
| `hive/amber-implement-the-missing-producti` | 1 | `1e5937d7 wip: production create backend + concrete launcher + controls` (07-17, `broker.zig` +930, `stub_host.zig` +338). 6 of amber's function names are absent from main, but main's `broker.zig` (3860 lines vs the ref's 3652) implements the same concern under a rewritten design — `registerCreatedHost`, `registerWithOwnership`, `registerGrant`, `CreatedHost`, `.createAdoptionSecret`, 35 launch/register sites. This is 8-day-old WIP against a file that has since been rebuilt. **Weakest A call in the set** — if any A deserves a second look, it is this one. |

---

## 5. Suggested disposition

1. **Land or explicitly reject `hive/nina-integrator-land-the-c1-3-chrom`.** It
   is the only ref holding product work that a live design row still asks for.
2. Decide whether the `raw/review/` evidence trees (B2) are worth keeping as
   history. If not, three refs go.
3. Give `hive/geoff-fix-the-hive-terminal-it-is-vi` `519c5eb0` a ten-minute
   review — fail-open-on-gone-broker at shutdown plus a real-shell render proof
   main does not have.
4. B4, B5, B6 (4 refs) can be dropped on sight: a superseded handoff note, debug
   scaffolding for a fixed bug, and a commit whose subject is "never land".
5. All 35 bucket-A refs can be dropped whenever convenient. They preserve nothing.

None of this is urgent. Nothing here is at risk from a restart.
