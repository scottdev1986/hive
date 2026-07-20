# M1 — real definition-of-done and critical path

Derived 2026-07-20 by `ingrid` from the story docs' own acceptance criteria, verified against **local main at `925fc7ce`** (never `origin/main` — origin lags ~15 commits because `hive_land` does not push).

Method: a "gate N" commit proves LANDING, not gate CLOSURE. Every row below was checked against the gate's own stated acceptance criteria and against whether its named evidence artifact actually exists in main's tree. Issue state and board Status were read as independent signals; neither was treated as evidence.

---

## 1. Verdict

**Roughly half of M1's engineering exit criteria are met, and none of its six human gates are.** Of ~20 gate-level items, 11 are genuinely evidenced, 6 are open engineering, and 6 are user-owed and unagentable. The atomic cut — M1's actual terminating event — has not started: 84 tracked files under `src/` and 11 under `workspace/Sources/` still reference tmux, and SwiftTerm is still declared, resolved, imported, and executing a live `tmux attach-session` path.

M1 is **not** near done. The tracker overstates it in seven places, all optimistic.

---

## 2. The tracker is wrong in seven places, not two

The two known errors (A3 recorded DONE, X1/X2 recorded NOT STARTED) are real. Five more of the same class were found:

> **CORRECTION — 2026-07-20.** Three rows of the table below have since moved and no longer describe the tracker's state. **#34** and **#3** (recorded here as CLOSED/Done) have been **reopened**. **#4** (recorded here as "LANDED, UNEVIDENCED") is now **evidenced**: retroactive acceptance record `8bfa4c50` and the user clause-5 waiver + closure `b168589a`. This corrects the three rows only. §1's verdict is unchanged and is **not** softened by this note — the tracker errors it describes were real when written, and the substantive M1 findings (half of the engineering criteria met, zero of six human gates) still hold. See `planning/2026-07-20-board-planning-repo-reconciliation.md` §2 fix 10.

| Item | Issue state | Board | Actual, per the doc's own acceptance |
|---|---|---|---|
| #34 M1-A0 | CLOSED | Done | **OPEN.** `docs/contracts/terminal-host-v1.md:3` says outright "Real-session verification is intentionally incomplete." Freeze-test cases B and C are still `test.failing` in `test/terminal-host-freeze/pending-a1.test.ts`; the struct shapes they require are absent from `native/sessiond/src/pty_host.zig`. DoD 3 (non-Hive consumer demo) has no artifact. `bun test` reports "3 pass" only because Bun scores xfails as expected-failures. |
| #3 M1-A1 | CLOSED | Done | **OPEN by its own status line.** `planning/story-m1-a1-sessiond-qualification.md:3`: "Native neutral create, the remaining frozen control plane, attach streaming, visibility renewal, crash/adoption, and bounded replay qualification **remain open**." |
| #4 M1-A2 | CLOSED | Done | **LANDED, UNEVIDENCED.** Code is real and wired. No acceptance record, evidence artifact, or closure review for A2 exists anywhere on main. Also built against a *shape*-frozen contract, while A0 DoD 4 required freeze first. |
| #8 M1-B2 | CLOSED | Done | **PARTIAL.** B2.0–B2.4 genuinely met. B2.5 OPEN, B2.6 PENDING_HUMAN, DoD-7 (third-vendor clean-machine reproduction) has no artifact. |
| #9 M1-B3 | CLOSED | Done | **MET with 4 declared gaps** (GAP-1 multi-pane, GAP-2 attach retry, GAP-3 mouse forwarding, GAP-4 external scrollback readback). Also: B3 must be **re-run on the post-cut tree**, so it cannot close before the cut regardless. |

Root cause of at least one is already tracked: **#55** — `fix #2` in a docs commit body silently closed STORY-002. That mechanism is still live and will do it again.

---

## 3. BLOCKING — ordered by what unblocks the most

### B1. Production wiring pane → Row K ×3 · agent-doable (needs vendor quota)
The single largest fan-out in M1. Row K (real Claude Code, Codex, Grok TUIs through the production pane) gates **four** separate closures: B1 DoD-1 (`story-m1-b1:68` — "the A–K matrix green, K on all three vendor TUIs", no carve-out exists), B2 DoD-6, B2.5, and the **Removal Gate** itself (`story-001:16` — "If ANY matrix cell fails, this story cannot execute"). Row K first needs B2.5's production-wiring cell (sessiond agent + HiveTerminalView under a real Workspace), which is OPEN.

⚠️ **Evidence defect:** `raw/qualification/hive-b25-production-pane/EVIDENCE.md:16-18` cites `matrix/row-k-{claude,codex,grok}.txt`. **Those three files do not exist in main's tree.** The table cites placeholders.

⚠️ **Correction:** the "row K capacity-deferred to 2026-07-26 due to Grok" framing is **unsourced**. The 2026-07-26 date appears on main only in two *C1* documents (`hive-terminal-c12-cross-vendor-review-hollis2.md:10`, `c1-c11-typography-evidence.md:76`). No B1/B2/B2.5 doc, and not #36, ties row K to that date. The quota exhaustion is real and would plausibly block row K — but the linkage was never recorded. Effort: unknown.

### B2. The atomic cut — STORY-001 + STORY-002 · agent-doable
84 tracked `src/` files (40 non-test, 44 test) plus 11 `workspace/Sources/` files carry tmux. The four "delete entirely" targets are fully intact: `src/adapters/tmux.ts`, `src/daemon/session-host/tmux-host.ts`, `src/daemon/tmux-sessions.ts`, tmux minting in `locators.ts`. SwiftTerm is at `workspace/Package.swift:31,:73`, `Package.resolved:14-20`, `TerminalPaneView.swift:2`, with a live exec at `:88` and a live `TmuxScrollController` at `:29`.

Gated by: the full vendor matrix (above), and executes as **ONE atomic merge train** — `story-001:18`: "the full vendor matrix is re-run on the post-deletion tree before the cut lands. **Two separately-green PRs are NOT acceptable.**" Effort: unknown; footprint measured above.

### B3. Pre-cut drain · USER-ONLY (must run from the bootstrap build)
`story-001:43`: the OLD/bootstrap build performs the drain BEFORE the cut; "the cut is refused while any legacy session or process survives; **emptiness is positively proven** (live tmux server query + process-table readback, not absence-of-error)". No agent on the new tree can discharge this.

### B4. A0 freeze closure · agent-doable
Turn `pending-a1.test.ts` cases B and C green (adopt the frozen shapes in `pty_host.zig`), then build the non-Hive consumer demo. A0 is the contract A2 was supposed to be built against, so this is foundational debt, not polish.

### B5. A1 remaining qualification · agent-doable
Six areas open by the doc's own words (§2 above). Partly superseded since — `719c8e36` landed the frozen LIST/INSPECT/TERMINATE handlers but the story doc was never updated.

### B6. A3 live-proof rows · agent-doable (harness)
Six of fifteen rows in `hive-terminal-b23-acceptance-matrix.md` — 4 (Kitty), 7/7b (paste), 8/8b/8c (mouse) — have never had bytes traverse sessiond or a PTY. `:116-119` pins the ruling: a `RECORDED (encoder)` row "is NOT sufficient for B2.3/A3 STORY closure." Needs a mode-emitting PTY child; DECSET cannot be injected via `processOutput`. Row 9 (Retina resize) is held on hector's resize landing.

*Note:* the A3 absorption into B2.3 was **by design, queen-adjudicated** (`story-m1-b2:20`), not accidental. The I3/I4 invariant core is in better shape than the story — row 2 is genuinely live-PTY. But row 2b (no automation-timeout steal) is a *source-level structural argument*, not a timing test.

### B7. C1.3 + C1.4 · NOT STARTED, agent-doable code / user-only captures
Zero commits, zero evidence for either. C1.4 additionally inherited C1.2's deferred Increase-Contrast-in-Dark-Mode clause (see §5). Both gate C1.5, which gates M1.

### B8. C2 packaging · agent-doable except clean-machine acceptance
The signing/notarization/universal-build machinery genuinely exists (`src/release/build.ts`, `sign.ts`, `.github/workflows/release.yml`) but predates the rebuild and **no commit or artifact references C2 as a gate**. Structurally cannot close before the cut: `backlog-outline.md:52` — "clean-machine acceptance closes only on the cut tree", and C2 is **re-run after** the cut.

### B9. A4 faithful app-quit · USER-ONLY
3 of 4 cells green. The quit cell is `manifests/a4-quit.json` `"ok": false`, `"requiresUnlockedProductionStack": true`. Two blockers, different classes: the in-process-daemon harness entanglement is agent-doable; the unlocked GUI session is not.

### B10. B1 Gate 4 notarization · USER-ONLY
`foundation/notarization-status.txt` = `notarization_submission=blocked_missing_MACOS_NOTARY_credentials`. Needs Apple notary credentials. (Path-independence — 22,256 absolute path refs in the static archive — is separately agent-doable.)

### B11–B15. The human evidence batch · USER-ONLY
All six need a human at real hardware on an unlocked GUI session, and **most can be discharged in one sitting**:
- **B2.6 / matrix row J** — live VoiceOver + Accessibility Inspector. `hive-terminal-b26-accessibility.md:51`: "Real `NSAccessibility.post` coverage is human-only." Machine slice closed `4db42977`; this cannot be automated by design.
- **Gate 7 / matrix rows F, I** — dual-display Retina↔non-Retina inventory + transcript, sleep/wake transcript, Instruments minimized/after-wake. All `PENDING_HUMAN`.
- **Gate 9 manual runbook** — `ghostty-b1-actions/manual-acceptance.md` is a 10-probe runbook with **no recorded run**. No transcript exists on main.
- **#45 live resize-and-type** — "cannot be satisfied by an automated run." Its origin defect #47 is now CLOSED, so this is unblocked and ready.
- **STORY-001 DoD 2 / STORY-002 DoD 2** — independent reproduction by a second operator, with screen capture.
- **C1.5 aesthetic signoff** — see below.

### B16. C1.5 aesthetic signoff · USER-ONLY, hard gate, terminal
`story-m1-c1:276`: "The user personally signs off the aesthetic bar against the reference terminals (Ghostty app, Terminal.app, iTerm2) — **a hard gate, no engineer proxy**." Ratified as Q5 (`backlog-outline.md:116`) and folded into M1's exit at `:24`. No signoff record, no side-by-side captures, no C1.5 artifact of any kind exists. Closes only **after** the B2 integrated pane and depends on C1.3+C1.4, neither started. The only agent-doable part is assembling the comparison bundle for the user to rule on.

---

## 4. NON-BLOCKING — deferrable past M1, with the line that says so

| Item | Justification |
|---|---|
| **#37** broker lifecycle/supervision | Titled "deferred from M1-A2"; A2's stated DoD (`backlog-outline.md:36`) covers "server, delivery, teardown, recovery" — not broker supervision. Board: Backlog. |
| **#38** agent-agnostic spawn spine | Explicitly M2. `backlog-outline.md:28`: "M2 owns provider launch profiles, silent beliefs, approval semantics." |
| **#46** worktree GhosttyKit cold-build | Developer-velocity infra. Appears in no M1 story's acceptance criteria. |
| **#48** visibility publish HTTP 409 loop | Not named in any M1 gate. Caveat: "even in healthy runs" — if it perturbs a live-proof capture it becomes blocking-by-contamination. |
| **#50** brokerless daemon after supervision exhaustion | Same family as #37, same deferral. |
| **#52** teardown leaves Workspace GUI running | *Conditionally* non-blocking. B2.1b's teardown gate is MET; but if this manifests during the A4 faithful-quit run it will contaminate that evidence. |
| **#53** Gate9 OSC52 pasteboard flake | Test-harness hygiene. Gate 9's automated half is MET; the flake is in the instrument, not the claim. |
| **#54** B2.4 native Zig suite unrun | Labelled "B2.4 debt", blocked on the fleet Zig-runner stall (see memory: `zig build test` deadlocks in runner IPC, #54). B2.4 closed AUTOMATED_PASS without it. |
| **#55** prose numbering closes issues | Process defect, not a product gate. **But it caused one of the two known tracker errors** — fixing it is cheap and prevents recurrence. |
| **B3 GAP-1..4** | Declared gaps against *legacy* smoke coverage; `b3-smoke-coverage-mapping.md:17` notes the legacy smoke is not wired to CI at all. |

---

## 5. AMBIGUOUS — needs a user ruling

1. **Do the four wrongly-closed issues (#34 A0, #3 A1, #4 A2, #9 B3) get reopened, or was their closure a deliberate scope narrowing?** Each has open acceptance by its own doc. If closure was intentional, the story docs are stale and should be amended; if not, the campaign record is optimistic in four more places. This is the highest-value ruling — everything downstream inherits it.

2. **Was C1.2's Increase-Contrast-in-Dark-Mode clause legitimately moved to C1.4?** The move exists only in commit prose (`4b51c1ed`, "why the Increase Contrast live signal belongs to C1.4"). `story-m1-c1:260` still assigns the clause to C1.2. `1e46a20c` separately records a "method shortfall" against this gate. Ratified scope move, or unreviewed author decision?

3. **Does row K require a full vendor matrix, or would two vendors plus a recorded Grok deferral satisfy M1's exit?** B1 DoD-1 says all three with no carve-out, and #36 lists K as unscoped. If Grok quota does not return 2026-07-26, is M1 blocked, or does a documented deferral close it?

4. **Does A2 need a retroactive acceptance record, or is "the code is wired and B2 runs on it" sufficient evidence?** A2 has no story doc — its entire DoD is one line at `backlog-outline.md:36`. Related: A2 was built against a shape-frozen contract while A0 DoD 4 required freeze first. Is that a real defect or an accepted sequencing shortcut?

5. **What exactly is C2's acceptance?** Its whole spec is one backlog line + I9. Unknown whether "signed, notarized" means a fresh per-cut attestation or the existing `.github/workflows/release.yml` path, and whether the post-cut re-run is a new evidence bundle or a re-execution.

6. **Is "clean machine" a real second machine, or a PATH-sanitized environment?** STORY-001 DoD 2 suggests the latter may suffice; C2/I9 reads like the former. This decides whether C2's acceptance is user-only or agent-doable.

7. **A3 row 2b — is "no automation-timeout steal" satisfied by a source-level argument?** The current record argues from `input_arbiter.zig` having no timer that can release a human claim, reasoning that a timing test "would pass identically against an arbiter with no automation path whatsoever." Defensible, but it is not a behavioral proof of an I4 invariant.

---

## 6. Single highest-leverage next action

**Schedule one human evidence session on an unlocked GUI machine and discharge the ready user-owed batch in a single sitting.**

Five gates are blocked *only* on a human being present, and every one of them is ready now — nothing engineering-side is missing:

- B2.6 VoiceOver + Accessibility Inspector (machine slice closed `4db42977`)
- Gate 7 dual-display + sleep/wake transcripts
- Gate 9 ten-probe manual acceptance runbook
- #45 live resize-and-type (its origin defect #47 is now closed — unblocked)
- A4 faithful app-quit (needs the out-of-process daemon harness first — the one agent-doable prerequisite)

This is the highest leverage for three reasons. These gates are **pure long pole** — no amount of agent work shortens them, and they will otherwise surface at the very end, after the cut, when they are most expensive to fail. They are **cheaply batched** — one session discharges what would otherwise be five separate scheduling events. And they are **independent of vendor quota**, which is the one blocker nobody controls.

Agent work should run in parallel on the B2.5 production-wiring pane, since row K rides on it and row K gates the Removal Gate.

What this action explicitly does *not* unblock: C1.5. The aesthetic signoff depends on C1.3 and C1.4, which have not started, and it closes only after the B2 integrated pane. C1.5 is the true last gate of M1 and cannot be pulled forward.
