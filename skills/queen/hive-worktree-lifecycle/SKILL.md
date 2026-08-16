---
name: hive-worktree-lifecycle
description: Decide how Hive worktrees, preserved refs, and salvage refs are handled without losing unmerged work. Use when hive_kill, reconciliation, or a stewardship decision inventory reports worktree residue.
---

# Worktree Lifecycle Decisions

Hive treats unfinished work as evidence to preserve, not clutter to remove. Use this when a kill result, settlement-debt update, or stewardship inventory needs attention.

## Non-negotiable invariants

- Worktrees and hive branches must match live agents. Extra trees or branches are settlement cases, not leftover clutter to ignore.
- One Git-backed settlement case owns the agent generation, worktree, branch, preserved ref, and salvage ref as a bundle. It survives daemon or database replacement.
- Automatic release requires a self-validating proof: exact identity and ownership, proven process absence, no Git operation in progress, a complete tracked/staged/untracked/ignored inventory, exact content accounting, and the same result on the read immediately before mutation.
- Unknown, missing, malformed, or contradictory measurements are `measurement-blocked`, never clean. Cleanup pauses for that case without blocking spawns or unrelated work.
- Every open case names a state, owner, and either a next action or watched trigger. `parked` also has a review time; it never means keep forever without review.
- A caller cannot waive the proof. Destruction of measured residue requires a separate user-minted decision bound to the exact case revision, evidence digest, paths, refs, and OIDs. A queen may execute that decision but cannot mint it.

## Reading `hive_kill`

- `removed`: the requested release happened; no further worktree action.
- `preserved-stranded`: unmerged commits, dirty files, or an unmeasurable state were kept. Follow `resolve`: spawn an integrator to inspect and land the named branch, including `refs/hive-salvage/<branch>` when supplied. Only a user-bound settlement decision can discard it.
- `kept-clean`: no residue was observed, but the exact release proof did not complete. Let the settlement sweep retry after the named condition changes.
- `absent`: the agent had neither a worktree nor a branch.

`refs/hive-preserved/<branch>` protects the branch tip. `refs/hive-salvage/<branch>` captures uncommitted WIP separately, so an integrator can recover both committed and dirty work.

## Read and advance cases

Use `hive_settlement_list` for the pull-based, actionable case inventory. The workspace and collapsing mail topic carry one aggregate debt line; unchanged sweeps send nothing. A `needs-integration` case needs an integrator. A `blocked` case names its dependency and watcher. An `owner-decision` case is the only place to ask for product judgment.

Use `hive_salvage` to list, park, or proof-release preserved and salvage refs when no agent row remains. `keep` parks the bundle with a review time. `release` succeeds only when the service reproduces exact accounting; an ambiguous salvage ref remains `needs-integration`.

If the user intentionally chooses destruction, they mint `hive_settlement_decide` with the current case ID, revision, evidence digest, reason, and expiry. A user or queen then calls `hive_settlement_execute` with that decision ID. Any intervening case, content, path, branch, ref, or OID change invalidates it.

## Integrate or release

Spawn an integrator for `preserved-stranded`, `needs-integration`, conflicting work, or any uncertainty about WIP. Let the service release exact-safe bundles automatically. Queens do not merge or inspect worker worktrees themselves and never turn their own judgment into destructive authority.
