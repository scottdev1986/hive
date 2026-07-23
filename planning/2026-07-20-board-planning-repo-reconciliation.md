# Three-way reconciliation — board × planning/ × repo

Audited 2026-07-20 by `david`. Board/issue snapshot: queen's pre-fetch (57 items). Repo verified against **local main at `07a09e93`** (never `origin/main` — `hive_land` does not push).

Method: board Status and issue state read as independent axes; neither treated as evidence. Every "Done"/CLOSED row was checked for a landed artifact in main's tree, per `#55` (prose numbering silently closed `#2`) and the gate-commits-are-not-gate-closure rule. Planning-doc references are section-level, not line-level, because these files move.

---

## 1. Reconciliation table

| # | Board | Issue | Planning-doc reference | Repo evidence | Verdict |
|---|---|---|---|---|---|
| 1 | Backlog | OPEN | `story-001-gut-tmux.md` | 84 tracked files under `src/` still reference tmux | **BOARD-STALE** (pairing) |
| 2 | In progress | OPEN | `story-002-remove-agent-tui.md` | SwiftTerm `exact: "1.11.2"` live in `workspace/Package.swift`; `attach-session` exec live in `ProjectWindowController.swift`; 11 tmux files under `workspace/Sources/` | ALIGNED |
| 3 | Ready | OPEN | `story-m1-a1-sessiond-qualification.md` (status line: qualification "remain open") | — | ALIGNED |
| 4 | Done | CLOSED | `a2-acceptance-record.md`; DoD line in `backlog-outline.md` M1 Track A | `8bfa4c50` retroactive acceptance, `b168589a` user clause-5 waiver + closure | ALIGNED |
| 5 | In progress | OPEN | *no A3 story doc* (only cross-refs in `story-m1-b2-…`) | input acceptance matrix series `3421e67b`…`b1553543` | ALIGNED (doc gap, §3) |
| 6 | Backlog | OPEN | *no A4 story doc* | `cf53e94a`, `5c06c85f` live A4 qualification; `6c09eda6` holds faithful app-quit for unlock | **BOARD-STALE** |
| 7 | In progress | OPEN | `story-m1-b1-ghosttykit-qualification.md` | gate 7/8/9 series | ALIGNED |
| 8 | In progress | OPEN | `story-m1-b2-hive-terminal-view.md` | B2.0–B2.4 landed; B2.5 open (`7387364e`), B2.6 pending human | ALIGNED |
| 9 | Backlog | OPEN | `m1-definition-of-done-audit.md` §2 | `fd6e0985` replacement smoke landed + `875a58df`, `33d7d8a5`, `c2e2d151` | **BOARD-STALE** |
| 10 | In progress | OPEN | `story-m1-c1-beautiful-blank-terminal.md` | C1.0–C1.2 landed; **C1.3 IN FLIGHT** (maya integrating `hive/hazelton-…-c1-3-…`) | **IN-FLIGHT — not judged** |
| 11 | Backlog | OPEN | **none** — one line in `backlog-outline.md` M1 Track C + I9 | `.github/workflows/release.yml` (unattested for this cut) | ALIGNED (spec too thin, §3) |
| 12–14 | Backlog | OPEN | `backlog-outline.md` M2 S2.1/S2.2 | — | **DOC-STALE** (superseded by #38) |
| 15 | Backlog | OPEN | `backlog-outline.md` M2 S2.3 | — | ALIGNED |
| 16 | Backlog | OPEN | `backlog-outline.md` M2 S2.4 | — | ALIGNED |
| 17 | Backlog | OPEN | `backlog-outline.md` M2 S2.5 | — | ALIGNED |
| 18–22 | Backlog | OPEN | `backlog-outline.md` M3 S3.1–S3.5 | — | ALIGNED |
| 23–28 | Backlog | OPEN | `backlog-outline.md` M4 S4.1–S4.6 | — | ALIGNED |
| 29–33 | Backlog | OPEN | `backlog-outline.md` M5 (S5.x families, unenumerated) | — | ALIGNED (vague, §3) |
| 34 | Ready | OPEN | `story-m1-a0-terminal-host-contract.md` | freeze tests B/C still `test.failing` in `test/terminal-host-freeze/pending-a1.test.ts` | ALIGNED |
| 36 | Backlog | OPEN | **board-only scope** | — | ALIGNED (outline DOC-STALE, §2) |
| 37 | Backlog | OPEN | **board-only scope** | `adc5df1b` daemon owns broker lifecycle; `8592225e`/`9fd29e3f` ownership + ready-proof | **BOARD-STALE** (partial) |
| 38 | Backlog | OPEN | **board-only scope** — supersedes outline S2.1/S2.2 | `07a09e93` lands #38's queen-`gh`-permission requirement | **BOARD-STALE** |
| 39 | Done | CLOSED | — | `025f75b6` OPOST\|ONLCR after cfmakeraw; `07c95328` before/after screenshots | ALIGNED |
| 40 | Done | CLOSED | — | `660540a8` merge of claim-lifecycle fix; `b8276cff`, `b4834ad4` | ALIGNED |
| 41 | Done | CLOSED | — | `16908cc1` unreachable broker = dead session; discharged live in `ed59a6b1` | ALIGNED |
| 42 | Done | CLOSED | — | `fbc66848` `make build`/`make run` canonical | ALIGNED |
| 43 | Done | CLOSED | — | `adc5df1b` (same commit as #37 — see §2) | ALIGNED |
| 44 | Done | CLOSED | — | `916f17a3`, `29a69614`, `68cbbeb4` | ALIGNED |
| 45 | Ready | OPEN | **board-only scope** (is itself the debt register) | two items discharged `ed59a6b1`, `0fc26a6c` | ALIGNED |
| 46 | Backlog | OPEN | **board-only scope** | — | ALIGNED |
| 47 | Done | CLOSED | — | `4ab8a45d` first visible IOSurface frame; `56907f63` review PASS | ALIGNED |
| 48 | Backlog | OPEN | **board-only scope** | — | ALIGNED |
| 49 | Done | CLOSED | — | `68cbbeb4`, `da9307a1`, `4f222211` | ALIGNED |
| 50 | Backlog | OPEN | **board-only scope** | — | ALIGNED |
| 51 | Done | CLOSED | — | `c79a1f3f` short per-checkout HIVE_HOME | ALIGNED |
| 52 | Backlog | OPEN | **board-only scope** | — | ALIGNED |
| 53 | Backlog | OPEN | **board-only scope** | — | ALIGNED |
| 54 | Backlog | OPEN | **board-only scope** | — | ALIGNED |
| 55 | Backlog | OPEN | **board-only scope** | — | ALIGNED (process fix unlanded) |
| 56 | Backlog | OPEN | **board-only scope** | — | ALIGNED |
| 57 | Backlog | OPEN | `2026-07-20-resume-liveness-verification-debt.md` | `9ebd0268` + `4a7ed9db` fix a **different** defect (the debt doc says so explicitly) | ALIGNED — mis-read hazard, §2 |
| — | — | — | — | `7aba5ead` PROJECT default; `cf2b4aa5` spend accounting | **UNTRACKED** |

**No PHANTOM-DONE rows survived verification.** Every Done/CLOSED item has a landed artifact. The four wrongly-closed issues the DoD audit found (`#34`, `#3`, `#8`, `#9`) have already been reopened; `#4` was legitimately closed by a retroactive acceptance record after the audit was written.

---

## 2. Concrete fixes

**Move columns**

1. **#6 (M1-A4): Backlog → In progress.** Live A4 qualification landed at `cf53e94a`/`5c06c85f`; only the faithful app-quit leg is held for an unlocked GUI session (`6c09eda6`).
2. **#9 (M1-B3): Backlog → In progress.** The replacement smoke harness landed at `fd6e0985`. It stays open because B3 must re-run on the post-cut tree — but "Backlog" reads as not-started, which is false.
3. **#37 (broker lifecycle): Backlog → In progress.** Daemon-owned lifecycle landed (`adc5df1b`); the residual is supervision exhaustion, which is `#50`.
4. **#1 (STORY-001): Backlog → In progress**, matching #2. STORY-002's own text ratifies an **atomic** merge train with STORY-001; two different columns for one atomic cut is a tracking contradiction, not a scheduling fact. (Alternative, equally consistent: move #2 back to Backlog — neither has started. Pick one; do not leave them split.)
5. **#38: Backlog → In progress** *or* split out the landed part. `07a09e93` landed #38's queen-`gh`-permission requirement while the card reads not-started.

**Close / reopen**

6. **Nothing to reopen.** The reopen sweep implied by the DoD audit's ambiguity #1 has already been executed correctly.
7. **Nothing to close.** In particular, **do not close #57 on `9ebd0268`** — see fix 10.

**Planning-doc edits**

8. **`backlog-outline.md` M2 section — superseded banner.** Header still reads `PLAN STATUS: FINALIZED 2026-07-17`, and S2.1 still specifies "per-vendor, 3 stories" as the spine. Issue #38 replaces that with a single agnostic spine under which #12/#13/#14 become proof targets, and adds two agents (Kimi Code, opencode) the outline never names. Add a banner at S2.1/S2.2: *superseded by #38 (2026-07-18); the per-vendor fork is exactly what the agnostic requirement replaces.* FINALIZED is a drafting state, not an immunity.
9. **`backlog-outline.md` M1 Track B — B1 matrix ownership.** The outline states B1 owns live-proof matrix A–K. Cells J/K/I/G-live were split to **#36** by queen's direction 2026-07-17. Note the split inline, or #36 reads as duplicate scope.
10. **`m1-definition-of-done-audit.md` §2 — stale on two rows.** Its table records `#34` and `#3` as CLOSED/Done and `#4` as "LANDED, UNEVIDENCED." All three have moved: #34/#3 reopened, #4 evidenced by `8bfa4c50` + `b168589a`. Add a dated correction note; the §1 verdict (half of engineering criteria, zero of six human gates) still holds and should not be softened.
11. **`2026-07-20-resume-liveness-verification-debt.md` — strengthen the disclaimer.** It correctly says #57 is a different defect, but the commit pair `9ebd0268`/`4a7ed9db` sits directly above #57 in the log with matching vocabulary. Given `#55`, that is one careless commit body away from silently closing #57. Recommend an explicit "**#57 remains open**" line in the doc *and* in #57's body.

---

## 3. Backlog refinement candidates

| Item | Problem | Recommendation |
|---|---|---|
| **#11 M1-C2** | Whole spec is one outline line + I9. Unknown whether "signed, notarized" means a fresh per-cut attestation or the existing release workflow; "clean machine" is undefined (audit ambiguities #5, #6). | Not actionable as written. Write a C2 story doc, or get the two user rulings first. Blocks M1 exit. |
| **#5 M1-A3, #6 M1-A4** | Only M1 stories with no `story-*.md`. Their DoD lives in one outline line each, yet both carry live-proof invariants (I3/I4, I2). | Promote acceptance criteria into story docs; A3's row 2b currently rests on a source-level argument, not a behavioral proof. |
| **#29–#33 M5** | Five cards whose entire spec is "one gate story per ledger row family." Row families are named but rows are not enumerated anywhere in `planning/`. | Defer refinement until M4-H5 freezes the projections — but say so on the cards, so they are not mistaken for actionable. |
| **#12, #13, #14** | Now proof targets under #38's spine, not independent stories, but their bodies still describe standalone per-vendor spawn pipelines. | Retitle as proof targets and add "blocked by #38", or fold into #38 as checklist rows. |
| **#37 / #50** | Same family (broker supervision), split across two cards; the DoD audit deferred both with identical justification. | Merge #50 into #37, or make #50 an explicit sub-item. Two cards for one residual invites double-tracking. |
| **#43 vs #37** | `adc5df1b` is cited as the landed evidence for **both**. #43 is CLOSED/Done, #37 is OPEN/Backlog. | Not a defect, but state the boundary on #37: "#43 landed daemon ownership; #37 owns crash recovery, adoption, and install/upgrade." |
| **#36** | "Status: created 2026-07-17, **unscoped for execution**." Blocked on B2 for K; J/I/G-live have no owner. | Real dependency, but it gates the Removal Gate via row K. Needs an owner assigned now, not at gate time. |
| **#46, #53** | Developer-velocity / test-harness hygiene, correctly deferred past M1 — but sitting in the same Backlog column as M3/M4/M5 milestone stories. | Label as `infra`/`test-debt` so milestone Backlog stays readable. |
| **#48** | "even in healthy runs" — the audit flags it as blocking-by-contamination if it perturbs a live-proof capture. | Not vague, but its blocking status is conditional and unrecorded. Add the caveat to the card. |

---

## 4. Standing observation

The board's most systematic error is **columns lagging landings**: #6, #9, #37, and #38 all have landed work while reading Backlog. There is no error in the other direction — nothing claims Done without evidence. The tracker's bias has inverted since the DoD audit: it now *understates* engineering progress while the audit's core verdict (the atomic cut has not started; zero of six human gates are met) remains exactly true.
