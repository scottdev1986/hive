---
name: hive-worktree-lifecycle
description: Decide how Hive worktrees, preserved refs, and salvage refs are handled without losing unmerged work. Use when hive_kill, reconciliation, or a stewardship decision inventory reports worktree residue.
---

# Worktree Lifecycle Decisions

Hive treats unfinished work as evidence to preserve, not clutter to remove. Use this when a kill result, reconciliation notice, or stewardship inventory needs a decision.

## Non-negotiable invariants

- A stranded-work row is recorded before its worktree can be released. That row holds the agent name, branch, path, and measured residue so a replacement agent cannot reuse an identity that still names undecided work.
- A newly observed worktree is in a settling window. Do not interpret its temporary state as orphaned; wait for a later sweep.
- Teardown is a ladder: measure once; if the result is unknown, keep it; if work remains, record it and preserve its branch; capture dirty WIP under a salvage ref when possible; only then honor an explicit request to remove the worktree. Hive never turns a failed measurement into “clean.”
- Reconciliation may act only on provably lossless residue: a registered worktree that is settled, not live or explicitly preserved, not foreign-owned, assessable, clean, and merged. It can release a clean orphan or merged terminal residue. It must keep unregistered paths, failed assessments, foreign-instance work, and any unmerged or dirty work. No sweep auto-deletes unmerged work.

## Reading `hive_kill`

- `removed`: the requested release happened; no further worktree action.
- `preserved-stranded`: unmerged commits or dirty files (or an unmeasurable state) were kept. Follow `resolve`: spawn an integrator to inspect and land the named branch, including `refs/hive-salvage/<branch>` when supplied; only an explicit `discardWork` chooses destruction instead.
- `kept-clean`: there was no residue, but no release was requested. Use the supplied `removeWorktree=true` resolve to release it.
- `absent`: the agent had neither a worktree nor a branch.

`refs/hive-preserved/<branch>` protects the branch tip. `refs/hive-salvage/<branch>` captures uncommitted WIP separately, so an integrator can recover both committed and dirty work.

## Stewardship refs are owner decisions

Use `hive_salvage` to list, keep, or release preserved and salvage refs. It works even when no agent row remains. `keep` records the decision without changing the tip; `release` is the only deletion path for these refs. A `preservedAt: null` value means Hive does not know the ref’s historical preservation time, not that it is safe or new.

The stale-ref inventory is digest-deduped and reports refs older than the settling threshold, plus refs with missing or invalid `preservedAt`; it deletes nothing. For each line, decide and record ownership: send an integrator when `unmerged` or `dirty` work needs assessment or landing; release only after you can account for the ref and accept its removal; keep when retention remains intentional. Never delete merely because the inventory arrived.

## Integrate or release

Spawn an integrator for `preserved-stranded`, a stranded-branch notice, conflicting work, or any uncertainty about WIP. Release a clean worktree only after its explicit clean outcome, and a stewardship ref only with `hive_salvage release` after an owner decision. Queens do not merge, inspect, or delete worker worktrees themselves.
