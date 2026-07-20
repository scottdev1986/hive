# M1-A3 — Input arbiter live-proof: one ordered write path, human priority

Milestone: M1, track A. GitHub issue #5.
Origin: `planning/backlog-outline.md:37` (one-line card), promoted to a story doc under approval-package digest ruling **P3** (2026-07-20). This doc refines the issue body; it invents no new scope — every requirement below is promoted from the issue, the backlog line, or the M1 definition-of-done audit.
Status: RATIFIED for execution — user approval granted 2026-07-20 (backlog-outline.md ratified header + digest ruling P1), scoped to `main@0b604f6e`.

## Why

A3 proves the two input invariants of the new terminal spine:

- **I3 — one ordered write path.** `hive-sessiond` is the *only* writer of the PTY master. Human keystrokes, paste, IME composition and mouse-report bytes, and any automated delivery, all converge into a single ordered arbiter; nothing writes the master out-of-band.
- **I4 — human priority, synchronously acquired.** The human input claim is acquired *synchronously* and never times out into automation: while a human claim is held, automated writes are blocked, and no automation byte lands inside a human composition.

These are terminal-concurrency semantics, not Hive policy (A0 P0-10). Key-to-byte encoding stays renderer-side; A3 proves the arbiter, not the keymap.

## Scope boundary

In scope:
- Input-claim semantics across **typing, paste, IME composition, and mouse-report bytes**.
- Automated delivery **blocked while a human claim is active**.
- A **bounded reconnect window** on disconnect (the claim is not silently abandoned or silently stolen when a writer disconnects).

Out of scope (named so it is not silently absorbed):
- Renderer-side key/mouse encoding (B1/B2 own the encoder corpus).
- M2 provider policy — A3 exercises the arbiter with a neutral fixture and/or a shell child, not a vendor CLI.
- Close/quit/containment (that is A4/I2).

A3 was **absorbed into B2.3 by design** — a queen-adjudicated decision (`planning/story-m1-b2-hive-terminal-view.md:20`), not accidental drift. The acceptance evidence therefore lives in the B2.3 corpus (`workspace/docs/hive-terminal-b23-acceptance-matrix.md`); A3 closure is read from that matrix under the ruling below.

## Definition of done (numbered acceptance criteria)

Each criterion restates the HARD PRINCIPLES that apply (external research drives; external citations; no legacy shims; production-grade; **project-agnostic** — works on any repo/stack; paired SPEC + doc-cleanup, docs describe behavior not file paths; **LIVE PROOF to close**).

1. **(I3) Single ordered write path — live.** Prove that sessiond is the sole PTY-master writer and that all input sources enter one ordered arbiter. Evidence: bytes traverse sessiond and a real PTY (not an encoder-only record); each receipt is attributable to exactly one input transaction. *Mutation control required:* asserting the wrong pipeline stage must turn the live submissions RED (the b23 matrix already does this — asserting `queued` instead of `written-to-terminal` turns all five live submissions RED, `hive-terminal-b23-acceptance-matrix.md:116-119`).

2. **(I4) Human claim acquired synchronously.** The human input claim is acquired synchronously on human input; it is never released by an automation timeout. This is the invariant, and it needs a **behavioral timing proof, not a source-level argument** (see Blocker 2).

3. **(I4) No automation write inside a human composition.** Live interleaving drill: a human types while automation delivers concurrently; byte order and claim transitions are recorded and correct; **no automation write lands inside a human composition**. The "composition" boundary must be defined in the evidence (IME marked-text range vs any keystroke burst) so the assertion is falsifiable.

4. **Full input-class coverage, live.** Each in-scope input class — typing, paste (bracketed), IME composition, mouse-report — has at least one row where bytes actually traverse sessiond and a PTY. A `RECORDED (encoder)` row is **not sufficient for A3/B2.3 story closure** (b23 matrix ruling, `:116-119`): an encoder record certifies the normalizer, not the transport.

5. **Bounded reconnect window.** On writer disconnect, the human claim survives for a bounded, stated window; automation cannot steal the claim inside that window; the bound is a spec value or a per-run measurement, stated either way.

6. **Paired doc-cleanup.** The arbiter's behavioral contract is documented (behavior/contracts only, no file paths/line numbers), and the b23 matrix's A3 mapping is kept truthful as rows go live.

## Live-proof requirements

- Bytes must traverse **sessiond + a real PTY**; encoder-only rows do not close A3 (criterion 4).
- The interleaving drill is a **live** human-vs-automation race with recorded byte order and claim transitions, plus a negative control (a mutation that makes the drill go RED).
- The no-timeout-steal claim (I4) requires a behavioral timing observation against the live arbiter — a source read that "no timer exists" is explicitly ruled insufficient.

## Current completion state (per the DoD audit, `planning/m1-definition-of-done-audit.md` §3 B6 and §5 Q7)

- The **I3/I4 core is in better shape than the story text** suggests. Row 2 of the b23 matrix is genuinely live-PTY; live traversal is recorded for rows **3 (keys), 5 (dead key), 6 (CJK IME), 11 (no-duplicate-input)** plus the plain-text positive control (`hive-terminal-b23-acceptance-matrix.md:121-122`).
- Evidence anchor: `workspace/docs/hive-terminal-b23-acceptance-matrix.md`; driver `scripts/b23-acceptance-matrix.sh`.
- Issue state: **OPEN**. No independent A3 completion record exists outside the B2.3 corpus.

## Open blockers (explicitly named)

1. **Six matrix rows have never been live.** Rows **4 (Kitty keyboard), 7/7b (paste), 8/8b/8c (mouse)** — six of fifteen — have never had bytes traverse sessiond or a PTY; they are `RECORDED (encoder)` only, which the `:116-119` ruling says does not close A3. Discharging them needs a **mode-emitting PTY child**: DECSET (e.g. Kitty/mouse modes) cannot be injected via `processOutput`, so the child must request the mode itself.
2. **Row 2b — no automation-timeout steal — is a source-level argument, not a proof.** The current record reasons from `input_arbiter.zig` having no timer that could release a human claim, which "would pass identically against an arbiter with no automation path whatsoever" (audit §5 Q7). Per the P3 ruling this is **insufficient**: row 2b needs a behavioral timing proof against the live arbiter (criterion 2), not a structural argument.
3. **Row 9 (Retina resize) is held** on the resize landing (hector), per audit §3 B6.
4. **Gating.** A3 closes only after A2 (production arbiter proof); A2 is landed, so this blocker is discharged, but the R3 addendum sequencing stands on record.
