# M1-B3 — New smoke harness on the sessiond/HiveTerminalKit spine

Milestone: M1, track B. GitHub issue #9.
Origin: `planning/backlog-outline.md:43` (one-line card), promoted to a story doc under approval-package digest ruling **P3** (2026-07-20). B3 carries no live-proof invariant, but it sits on the critical path to the atomic cut, and it defines its own scope only by reference to the coverage STORY-002 is simultaneously deleting — so it needs a frozen baseline, which this doc pins.
Status: RATIFIED for execution — user approval granted 2026-07-20 (backlog-outline.md ratified header + digest ruling P1), scoped to `main@0b604f6e`.

## Why

STORY-002 deletes the legacy SwiftTerm/tmux smoke harness (`workspace/scripts/smoke.sh` + `workspace/Sources/HiveWorkspace/SmokeRunner.swift`). B3 replaces it with **equivalent-or-better** coverage driving the new sessiond + HiveTerminalKit spine, so the deletion does **not lose the safety net**. B3 is the removal gate's evidence that nothing was silently dropped in the cut.

## Scope boundary

In scope:
- A **headless-driveable** Workspace smoke run covering **launch, render, input, resize, close, teardown**.
- **CI-runnable.**
- **Exact-generation assertions** (a smoke check that passed against the wrong generation is not a pass).

Out of scope:
- Live-proof invariants (A3/A4 own I2–I5; B3 is coverage-equivalence, not invariant proof).
- M2 provider policy — the smoke drives the neutral spine, not vendor CLIs.

## Definition of done (numbered acceptance criteria)

Each criterion restates the HARD PRINCIPLES (external research drives; no legacy shims; production-grade; **project-agnostic**; paired SPEC + doc-cleanup; **LIVE PROOF to close**).

1. **Baseline frozen before deletion.** The legacy harness's scenario list is enumerated as a *derived* completeness claim, not asserted — every legacy `SMOKE-<n>` check is classified against the replacement. This baseline is the removal gate's citation table; it must be frozen before STORY-002 deletes the legacy smoke. (Anchor: `workspace/docs/b3-smoke-coverage-mapping.md` — all 81 legacy checks classified.)

2. **Replacement green on the new spine.** The smoke run is green driving sessiond + HiveTerminalKit, covering **at least** the legacy scenario list (launch, render, input, resize, close, teardown). Anchors: driver `scripts/b3-smoke.sh`; in-process half `workspace/Tests/HiveTerminalKitTests/B3SmokeTests.swift`, deliberately mirroring the legacy outer/in-process split because the most valuable legacy checks are made from *outside* the app.

3. **Exact-generation assertions.** The smoke asserts against the exact session generation, not merely "a terminal responded."

4. **CI status stated honestly.** The legacy smoke is **not wired to CI** (`b3-smoke-coverage-mapping.md:17` — it appears in no Makefile target, no `package.json` script, no workflow), which is *why* a citation table, not a red pipeline, is the removal gate's evidence. B3's own CI status — real hosted runner vs local `make`/hand-invoked — is stated explicitly in the evidence rather than implied.

5. **Re-run on the post-cut tree.** B3 **re-runs on the post-deletion tree** after the atomic cut; it cannot finally close before the cut regardless of its pre-cut green state.

6. **Paired doc-cleanup.** The coverage-mapping table is kept truthful as gaps close.

## Live-proof requirements

- The smoke drives a **live** sessiond + HiveTerminalKit stack (launch → render → input → resize → close → teardown), not a mocked transport.
- Completeness against the legacy baseline is **derived** (extract every `SMOKE-<n>` and classify), not asserted.

## Current completion state (per the DoD audit, `planning/m1-definition-of-done-audit.md` §2 #9 and §4)

- **MET with 4 declared gaps.** The replacement smoke is landed and green (`b3-smoke-coverage-mapping.md`: "the replacement smoke is landed and green"). Declared gaps against *legacy* coverage:
  - **GAP-1** multi-pane
  - **GAP-2** attach retry
  - **GAP-3** mouse forwarding
  - **GAP-4** external scrollback readback
- Issue state: **OPEN** (it cannot close before the cut regardless — criterion 5).

## Open blockers (explicitly named)

1. **Must re-run on the post-cut tree** (criterion 5) — B3 closes only after A2+A3+A4+B1+B2 (full-system harness) and re-runs after the atomic cut. It therefore cannot close before the Removal Gate even when green today.
2. **Four declared coverage gaps** (GAP-1..4 above). These are gaps against *legacy* smoke coverage; the legacy smoke itself was not CI-wired, so they are non-blocking-for-M1 per audit §4, but they must be recorded, not silently dropped.
3. **Shared-machine flake class (#53).** #53 identifies a shared-machine flake in a Gate 9 test and names #9 as related; the new harness inherits that flake class if it runs the same assertion. Track so a flaky red is not read as a real regression at the removal gate.
