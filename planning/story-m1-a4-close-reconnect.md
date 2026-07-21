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

## Current completion state

Updated 2026-07-21 after the kill-drill matrix ran live. Every cell below ran in
its own isolated Hive home with its own daemon and broker; none touched the
production instance.

- **Green cells** — reconnect-replay, exact-close, non-Hive-project (recorded
  earlier), plus **kill-renderer** and **kill-broker**, newly proven:
  - `manifests/a4-reconnect-replay.json`, `a4-exact-close.json`, `a4-non-hive-project.json`
  - `manifests/a4-renderer-kill.json` — criterion 1. The renderer is a separate
    process, SIGKILLed for real; the provider tree is read back live from `ps`
    after its death; the same generation reconnects and replays byte-identically
    against a named, hashed reference capture; the post-teardown `ps` readback
    shows every captured pid absent.
  - `manifests/a4-broker-kill.json` — criterion 3. Broker SIGKILLed; attach and
    visibility renewal both fail with the typed broker-unavailable error; no
    fabricated clean exit; zero survivors.
- **Criterion 4 (bounded window) is now pinned and measured.** The upper edge is
  the spec journal capacity (§18). The lower edge is measured rather than
  asserted: a replay slice refuses an `afterSeq` below the journal's retained
  start, so a reconnect served at `afterSeq` 0 proves the retained range still
  begins at 0. The reference capture the byte-identity is measured against is
  named and hashed in the manifest.
- **Criterion 5 (stale locator, I5) is NOT green** —
  `manifests/a4-stale-locator.json` records `"ok": false`,
  `"status": "I5-TYPED-STALE-REFUSAL-GAP"`. See Blocker 2.
- **The quit cell is not green**: `manifests/a4-quit.json` records `"ok": false`,
  `"status": "COMPOSED-NOW/FAITHFUL-PENDING-UNLOCK"`,
  `"requiresUnlockedProductionStack": true`.
- Issue state: **OPEN**.

## Open blockers (explicitly named)

1. **Quit cell — two blockers, different classes** (audit §3 B9):
   - **Harness entanglement (agent-doable).** The b22 driver hosts the daemon **in-process**, so its app-quit path "cannot measure the daemon-self-owned production shutdown handshake" (`a4-quit.json` → `faithfulPending.reason`; diagnostic `raw/qualification/hive-b25-production-pane/matrix/diagnostic-a4-quit-harness-entanglement.txt`). An out-of-process daemon harness is the prerequisite.
   - **Unlocked GUI session (USER-ONLY).** The faithful quit run requires the unlocked production Workspace stack; an agent shell returns nulls. This is the single highest-leverage human-evidence-session item (audit §6).
2. **Stale locator does not answer as I5 requires** (criterion 5) — measured
   2026-07-21, not inferred. After the exact generation is terminated and read
   back absent from `ps`, the identical locator string produces:
   - **attach** — a refusal, but one that says only that the outcome could not
     be verified. It fails closed, which is the half that matters most, but it
     never says the generation is gone. "I could not determine" and "no, that
     is dead" are different answers, and I5 asks for the second.
   - **kill** — a **success**, reporting that the agent was killed and nothing
     was reaped. That is a fabricated result for a generation that no longer
     exists, and it is precisely the false answer the invariant forbids. The
     terminated agent row still carries its old locator, so the daemon's
     locator comparison accepts it as current.

   The same cell attaches with that locator while the session is live, as a
   positive control, so this is a genuine difference in how the two surfaces
   answer and not a malformed request. Closing this reaches past the proof
   harness into daemon kill semantics and into how the session layer distinguishes
   "this generation is gone" from "I cannot tell", which is a cross-language
   contract change and wants its own decision.

3. **~~Bounded window and reference capture are unpinned~~ (criterion 4) —
   RESOLVED 2026-07-21.** The bound is now stated and the reference capture is
   named and hashed; see the completion state above.

4. **Gating.** A4 needs A2 + B2 (Workspace visibility/reconnect/quit proof requires the integrated pane); host-only crash proofs may run earlier. A2 and B2.0–B2.4 are landed.
