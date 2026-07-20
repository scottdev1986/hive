# M1-A4 — Close, reconnect, and containment live-proof

Milestone: M1, track A. GitHub issue #6.
Origin: `planning/backlog-outline.md:38` (one-line card), promoted to a story doc under approval-package digest ruling **P3** (2026-07-20). This doc refines the issue body; it invents no new scope.
Status: RATIFIED for execution — user approval granted 2026-07-20 (backlog-outline.md ratified header + digest ruling P1), scoped to `main@0b604f6e`.

## Why

A4 proves the terminal's lifecycle-containment invariants:

- **I2 — a live terminal is always user-known.** Close/quit terminates the *exact generation* with positive readback; renderer loss yields bounded replay and **never a hidden survivor**. A terminal the user believes is closed leaves no reachable process tree behind, and a terminal the user believes is live is genuinely live.
- **I5 — stale locator is a typed error.** A locator that names a generation that no longer exists returns a typed error, never a false-live answer or a silent null.

## Scope boundary

In scope:
- **Visibility lease** — a live pane holds a renewable visibility lease; the session is known-live only while the lease holds.
- **Renderer crash → bounded replay** — killing the renderer yields a bounded, byte-identical replay on reconnect, not loss and not a hidden survivor.
- **Workspace quit → verified termination of every provider process tree** — quitting the Workspace terminates the exact generation and every descendant process, proven by `ps` readback (zero survivors), not absence-of-error.
- **Stale locator → typed error (I5).**

Out of scope:
- Input arbitration (that is A3/I3/I4).
- M2 provider policy — the child process trees are neutral fixtures/shells, not vendor CLIs.
- Aesthetic/rendering correctness (B2/C1).

## Definition of done (numbered acceptance criteria)

Each criterion restates the HARD PRINCIPLES (external research drives; external citations; no legacy shims; production-grade; **project-agnostic**; paired SPEC + doc-cleanup; **LIVE PROOF to close**).

1. **(I2) Kill-renderer drill — live, real child tree.** Kill the renderer on a live session with a real child process tree; the session reconnects; replay is **byte-identical within the bounded window**; `ps` shows **zero survivors** and no hidden second copy.

2. **(I2) Kill-Workspace drill — verified whole-tree termination.** Quit/kill the Workspace on a live session; **every provider process tree is terminated** (exact generation, positive readback); `ps`-verified **zero survivors**. This is the faithful production-shutdown handshake, daemon-self-owned — see Blocker 1.

3. **(I2) Kill-broker drill — no fabricated exit, bounded replay.** Kill the broker on a live session; the outcome is a typed loss/bounded replay, never a fabricated exit and never a leaked child.

4. **Bounded window is stated.** The replay window bound is either a spec value or a per-run measurement, and the reference capture that "byte-identical" is measured against is named. (Digest #6 AC-THIN: neither is currently pinned.)

5. **(I5) Stale locator returns a typed error — own proof line.** A stale/expired locator returns a typed error. This appears in Scope but is **absent from the issue's one-sentence acceptance**, so it gets its own explicit proof line here rather than riding on the kill drills.

6. **Paired doc-cleanup.** The close/reconnect/containment contract is documented behaviorally (no file paths/line numbers), and the a4 manifests are kept truthful.

## Live-proof requirements

- All three kill drills run on **live sessions with real child process trees**, terminated for real and read back with `ps` (per memory: fake process tables never reparent; a reap message is not a completion report).
- Zero-survivors is a **positive `ps` readback**, not absence-of-error.
- Replay is **byte-identical** against a named reference capture within the stated bounded window.

## Current completion state (per the DoD audit, `planning/m1-definition-of-done-audit.md` §3 B9)

- **3 of 4 cells green.** The reconnect-replay, exact-close, and non-Hive-project cells are recorded:
  - `raw/qualification/hive-b25-production-pane/manifests/a4-reconnect-replay.json`
  - `raw/qualification/hive-b25-production-pane/manifests/a4-exact-close.json`
  - `raw/qualification/hive-b25-production-pane/manifests/a4-non-hive-project.json`
- The **quit cell is not green**: `raw/qualification/hive-b25-production-pane/manifests/a4-quit.json` records `"ok": false`, `"status": "COMPOSED-NOW/FAITHFUL-PENDING-UNLOCK"`, `"requiresUnlockedProductionStack": true`.
- Issue state: **OPEN**.

## Open blockers (explicitly named)

1. **Quit cell — two blockers, different classes** (audit §3 B9):
   - **Harness entanglement (agent-doable).** The b22 driver hosts the daemon **in-process**, so its app-quit path "cannot measure the daemon-self-owned production shutdown handshake" (`a4-quit.json` → `faithfulPending.reason`; diagnostic `raw/qualification/hive-b25-production-pane/matrix/diagnostic-a4-quit-harness-entanglement.txt`). An out-of-process daemon harness is the prerequisite.
   - **Unlocked GUI session (USER-ONLY).** The faithful quit run requires the unlocked production Workspace stack; an agent shell returns nulls. This is the single highest-leverage human-evidence-session item (audit §6).
2. **Bounded window and reference capture are unpinned** (criterion 4) — digest #6 AC-THIN.
3. **Gating.** A4 needs A2 + B2 (Workspace visibility/reconnect/quit proof requires the integrated pane); host-only crash proofs may run earlier. A2 and B2.0–B2.4 are landed.
