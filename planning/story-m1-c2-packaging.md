# M1-C2 — Packaging: signed, notarized, self-contained, tmux-absent install

Milestone: M1, track C
Backlog position: after B1+A2+B2 (integrated packaging); acceptance closes only on the post-cut tree
Issue: #11
State: spec written 2026-07-20 to close the "not actionable as written" finding in `planning/2026-07-20-board-planning-repo-reconciliation.md` §3. The two blocking ambiguities are resolved by user ruling; recorded below.

## Why

C2's entire prior spec was one line in `backlog-outline.md` M1 Track C plus invariant I9. Two questions in it were unanswerable, and both were load-bearing for whether C2 is agent-doable or user-only (`m1-definition-of-done-audit.md` §5 ambiguities 5 and 6). C2 blocks M1 exit, so an unactionable C2 blocks the milestone.

**User rulings, 2026-07-20:**

1. **"Signed, notarized" means the existing pipeline, not a fresh per-cut attestation.** The `.github/workflows/release.yml` pipeline already performs signing and notarization, and it suffices. Evidence is a **green run of that workflow on the post-cut tree** — not a hand-produced signing/notarization attestation bundle for this particular cut.
2. **"Clean machine" means a tmux-absence check only.** The proof environment is *any* machine on which `tmux` is verifiably absent from `PATH` and the packaged app fully works. It is not a fresh user account and not separate hardware.

## Goal

The Hive dev build ships as a self-contained, signed, notarized universal artifact that a user can install and run to completion on a machine with no tmux — proving the app carries everything it needs and has no residual dependency on the tooling the M1 cut removes.

## Acceptance criteria

1. **Install from the packaged artifact.** The artifact produced by the release pipeline is installed on an environment where `tmux` is verifiably absent from `PATH` — absence measured, not assumed (record the probe and its output, per the negative-control rule: show the probe reporting a positive on a machine that *does* have tmux, so an empty result is known not to be a broken reader).
2. **The app runs the full spine on that environment.** Not a launch-and-quit smoke: the installed app exercises the M1 spine end to end (open the dev build → blank native terminal → create/type/scroll/resize/select/copy/close/reconnect) with no tmux present and no user-installed Ghostty or Zig.
3. **The release workflow is green on the post-cut tree.** `.github/workflows/release.yml` completes successfully on the tree that exists after the STORY-001/STORY-002 atomic cut. The run URL and the resulting artifact identity are recorded as the signing/notarization evidence. Per ruling 1, this run *is* the attestation.
4. **Universality is tested, not asserted (added 2026-07-20 from the approval-session digest).** The packaged app's qualification slice runs on BOTH arm64 and x86_64 — the x86_64 slice explicitly under Rosetta if that is how it is exercised, stated honestly — rather than being inferred from the universal build flags. Record which architecture ran natively and which ran under translation.
5. **Ghostty/Zig absence is probed (added 2026-07-20 from the approval-session digest).** A negative-control criterion proves the clean machine has no user-installed Ghostty or Zig that the app could silently depend on, using the same probe pattern this doc already applies to tmux absence in criterion 1: measure the absence and show the probe reporting a positive on a machine that *does* have Ghostty/Zig, so an empty result is known not to be a broken reader.

Criteria 1 and 2 must be satisfied by the artifact from the run in criterion 3 — not by a locally built app.

## Non-goals (explicit)

These were considered and are **deferred past M1**. They are recorded here so that a later reader does not mistake their absence for an oversight:

- **A fresh user account.** Proving the app works for a user with no pre-existing Hive state, dotfiles, or caches is real coverage, but it is not what I9 asks for and it is not an M1 exit condition.
- **Separate hardware / a genuinely pristine machine.** Same reasoning. The tmux-absence check is the specific dependency M1 needs disproven; a full pristine-machine matrix is broader work.
- **A fresh per-cut signing/notarization attestation.** Superseded by ruling 1.

## Dependencies

- **The atomic cut (#1 / #2, STORY-001 + STORY-002).** C2's acceptance closes only on the post-deletion tree — criterion 3 names it directly, and criteria 1 and 2 are meaningless on a tree that still contains the tmux path. C2 may be *built* earlier; it cannot *close* earlier.
- **Issue #59 — `make terminal` and all testing-only support code removed.** An M1 exit criterion alongside the cut. M1 done means Hive works using only the new terminal (sessiond + HiveTerminalKit), with tmux and the temporary harnesses gone, orchestrator session included. A packaged artifact that still ships or depends on a testing-only support path has not proven what C2 claims to prove.
- Upstream engineering: B1 + A2 + B2 (integrated packaging), per the dependency edges in `backlog-outline.md` M1.
