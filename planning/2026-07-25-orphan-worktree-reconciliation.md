# Orphaned worktree reconciliation — measured 2026-07-25

## Result

The live cleanup removed four fully merged, non-live worktrees after explicit
approval: `david`, `maya`, `john`, and `proof-opencode`. Each registration,
directory, merged branch, and branch-owner ref is gone. John's historical dead
agent row remains, with its worktree and branch fields cleared.

The preservation-ref inventory started at 68. Nineteen refs pointed only to
commits already reachable from `main` and were removed. Forty-nine refs remain;
they protect 154 commits not reachable from `main` and are listed below.

After cleanup, disk, Git, and the live store agree on four worktrees: `henry`,
`isla`, `jack`, and `lucas`. All four have live agent rows.

## Cause

**live:** the deployed daemon identifies itself as build `1495d735`. Its
`assessStrandedWork` wiring list recognizes only `.grok/config.toml`.
Consequently a no-op Kimi agent appears to hold two dirty files and a no-op
OpenCode agent appears to hold one. The deployed daemon preserved those
worktrees rather than deleting apparent work.

**test:** current source includes every exact provider config path, derives the
shipped-skill paths for all five providers, and recognizes the owned Grok hook
by content. The five-provider fixture runs each real `prepareSpawn`, provisions
its shipped skills, and observes zero stranded paths. Removing `opencode.json`
from the allowlist makes the clean-orphan regression test fail as
`stranded-work`, proving that the test detects the original failure class.

**vendor:** no vendor process is needed to establish this filesystem
classification. The provider config writers run in the test; the vendor CLIs do
not.

The worktree-scoped Git exclusion introduced in `1852699b` was reverted in
`4f423c31`. Current source has no `core.excludesFile`,
`extensions.worktreeConfig`, or `hive-exclude` writer. That mechanism was net
unsafe because it could hide real work from the check that authorizes deletion.

## Removal paths

- Failed spawn: assesses stranded work and removes only a clean worktree.
- Idle reap: assesses, warns, and calls `killAgentTeardown` with
  `removeWorktree: true`.
- MCP `hive_kill`: removal is optional and defaults off.
- HTTP/pane kill, provider `dead` hook, `hive_mark_dead`, quota-timeout
  teardown, shutdown/kill-all, and crash recovery: close or preserve the agent
  but do not request worktree removal.
- Before this change, no maintenance path reconciled disk, Git registrations,
  and the agent store.
- `git worktree prune` is not run. The adapter removes one proven stale
  registration instead. Global prune can erase another Hive instance's
  temporarily unavailable worktree, so the targeted boundary is retained.

## Implemented rule

The existing maintenance sweep now classifies every registered Hive worktree:

- a live owning row: keep;
- a closed owning row with an explicit failure/preservation reason: keep;
- another Hive instance's owned branch: keep;
- unmerged commits or unrecognized dirty paths: keep and report;
- no live/preserved owner, fully merged, and clean after exact Hive artifacts
  are discounted: remove;
- a disk path with no Git registration: keep and report for inspection.

It also compare-and-deletes preservation refs whose measured tip is already
reachable from `main`. A concurrent ref update makes deletion fail rather than
erasing the new tip. Refs with any unmerged commits remain and are reported.

The user explicitly overrode the conservative machine rule for
`proof-opencode`: its user-skill symlink did not need committing, so it was
removed manually. The automatic sweep intentionally would not remove it.
Treating arbitrary skill symlinks as Hive wiring would recreate the unsafe
visibility hole.

## What was over-engineered and what was missing

The reverted per-worktree Git exclusion was over-engineered and unsafe. The
targeted missing-registration removal, instance-owner refs, exact artifact
allowlist, and compare-and-delete ref operation each preserve a demonstrated
safety boundary and remain justified.

What was missing was one reconciliation pass in existing maintenance and a
lossless lifecycle for merged preservation refs. No service, scheduler, state
machine, global prune, expiry policy, or force path is needed.

## Name reuse and visibility

Registered worktrees and `hive/<name>-…` branches already block name reuse.
Explicit names fail with a collision; automatic selection blocks that name and
tries another. A database reservation serializes concurrent spawns. One gap
surfaced: an unregistered disk entry was invisible to allocation and could make
`git worktree add` fail after a name was selected. The existing unavailable-name
check now includes directory entries under `.hive/worktrees`.

The existing lifecycle delivery channel is the cheap visibility surface. The
reconciliation sends one deduplicated, per-boot report naming each nontrivial
worktree rule and counts/names of removed and retained preservation refs.
Adding a second operator surface or a new status subsystem is not justified.

Recent communication work improves only idle-reap eligibility: provider events
and telemetry make idle state and `lastEventAt` more attributable, while
delivery reconciliation prevents reaping an agent with pending traffic. It
does not remove worktrees, reconcile disk/Git/store, classify artifacts,
revisit refs, or prune metadata. Because the deployed build predates it, its
live benefit to this incident is zero.

## Preserved refs retained

| Ref suffix | Commits not on `main` |
|---|---:|
| `duncan-gate10-groundwork` | 1 |
| `hazelton-c13` | 1 |
| `helena-production-sessiond-lifecycle` | 1 |
| `hive/amber-implement-the-missing-producti` | 1 |
| `hive/anna-advance-github-issue-6-m1-a4-c` | 1 |
| `hive/boris-independent-audit-fix-of-the-m` | 1 |
| `hive/chris-m1-b1-remainder-increment-3-pi` | 1 |
| `hive/deborah-cross-vendor-review-build-capa` | 1 |
| `hive/devon-category-code-review-cross-ven` | 1 |
| `hive/duncan-category-complex-coding-m1-b1` | 1 |
| `hive/james-implement-the-remaining-half-o` | 1 |
| `hive/lucas-github-issue-95-resume-path-co` | 1 |
| `hive/lucas-three-planning-deliverables-fr` | 1 |
| `hive/priya-github-issue-95-resume-path-co` | 1 |
| `hive/sam-verification-tripwire-for-the` | 1 |
| `hive/sarah-complete-github-issue-34-m1-a0` | 1 |
| `hive/zoe-complete-github-issue-34-m1-a0` | 1 |
| `sam-70-stop-gate-tripwire` | 1 |
| `gate6-pin-d7a9104f` | 14 |
| `b25-production-pane-david-5b448217` | 2 |
| `harold-detached-973f41cc` | 2 |
| `hattie-continue-a-crashed-agent-s-wor` | 2 |
| `hive/chiara-m1-a2-cp-native-ops-the-termin` | 2 |
| `hive/dexter-category-code-review-delta-cro` | 2 |
| `hive/geoff-fix-the-hive-terminal-it-is-vi` | 2 |
| `geoff-dirty-snapshot` | 3 |
| `harvey-residual-nits-hardening` | 3 |
| `hive/candace-story-m1-a2-cp-frozen-control` | 3 |
| `hive/clinton-m1-a2-cp-native-ops-terminate` | 3 |
| `hive/david-m1-b2-github-issue-8-wire-hive` | 3 |
| `hive/hazelton-m1-item-4-c1-3-the-chrome-focu` | 3 |
| `hive/helga-fix-two-review-blockers-on-the` | 3 |
| `hive/lucas-hold-do-not-hive-land-your-bra` | 3 |
| `b25-production-pane-pre-rebase-42e74c55` | 4 |
| `hive/john-integrator-finish-a-killed-int` | 4 |
| `hive/maya-integrator-land-the-stranded-c` | 4 |
| `hive/nina-integrator-land-the-c1-3-chrom` | 4 |
| `horace-detached-fac2db0b` | 4 |
| `hulda-occlusion-reference-02bb827d` | 4 |
| `b25-production-pane-first-rebase-0aa486b3` | 5 |
| `harvey-followup-1005-1015` | 5 |
| `hive/calvin-implement-gate-6-option-d-user` | 5 |
| `hive/chester-m1-b1-gate-6-option-d-finalize` | 5 |
| `hive/cindy-m1-b1-gate-6-option-d-finalize` | 5 |
| `b25-production-pane-second-rebase-a1f73119` | 6 |
| `hive/camila-story-m1-a2-respawn-sessiond-h` | 7 |
| `hive/crystal-m1-a2-production-sessionhost-b` | 7 |
| `hive/james-m1-b2-b2-5-continuation-github` | 8 |
| `gate6-pre-rebase-backup` | 9 |
