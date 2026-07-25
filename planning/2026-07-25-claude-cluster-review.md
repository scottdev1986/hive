# Claude cluster: independent cross-vendor review

Reviewed the landed changes on `main`, not the review worktree. The code-bearing
SHAs examined were `f12b8f17`, `a9b4f6f1`, `d0673318`, `a1ac09ad`,
`6e9c222c`, `f58f1314`, `e057de9e`, `7a9644af`, `0e605e8b`,
`1a0c9708`, `0200ed51`, `aa5093ca`, `f1e7c312`, `cf396aa0`,
`0d755c42`, `0bee9072`, `d9b16e02`, `84e58da4`, and `f5a82770`.

## Findings

### High — a different vendor's skill link can be classified as Hive wiring and deleted

`src/adapters/skills.ts:163-171`, landed `0d755c42`; consumed by
`src/adapters/worktrees.ts:606-610`.

`stagedSkillLinks` combines every vendor into one map keyed only by the native
path. Codex, Grok, and Kimi all use `.agents/skills`, but
`assessStrandedWork` receives no vendor identity. Consequently, a link that
matches (for example) a current Grok-only skill is accepted as Hive wiring in
a Codex worktree too.

Failure scenario: the primary checkout contains
`.hive/skills/grok/review/SKILL.md`; a Codex agent creates the untracked
`.agents/skills/review` symlink to that source as part of its work. The map
contains that path from the Grok iteration, so `isStagedSkillLink` returns
true and the stranded-work check reports `dirtyFiles: []`. A failed-launch,
idle-reap, or orphan-reconciliation cleanup then calls `git worktree remove
--force` and deletes the Codex worktree, including the agent's untracked link.
The guard reports a clean worktree when it contains agent-created work.

### Medium — vendor buckets with the same skill name leave clean worktrees permanently stranded

`src/adapters/skills.ts:163-171`, landed `0d755c42`; consumed by
`src/adapters/worktrees.ts:644-662`.

The same destination-only `Map` overwrites earlier entries while iterating
`CAPABILITY_PROVIDERS`. With both
`.hive/skills/codex/review/SKILL.md` and
`.hive/skills/kimi/review/SKILL.md`, the final map entry for
`.agents/skills/review` is Kimi's source. A clean Codex worktree correctly
contains a link to the Codex source, but the cleanup check compares it with
the Kimi source, calls it dirty, and refuses to reap it. The checked-in test
uses distinct bucket skill names, so this collision cannot fail there.

### Medium — removing a source skill after spawn makes Hive's own link look like agent work

`src/adapters/skills.ts:163-171`, landed `0d755c42`; consumed by
`src/adapters/worktrees.ts:601-610`.

The cleanup classifier reconstructs links from the *current* primary/global
skill directories instead of the set that was staged into the particular
worktree. If a user removes or renames `.hive/skills/review` after a clean
agent was spawned, its existing `.agents/skills/review` symlink has no map
entry. `isStagedSkillLink` returns false, so the worktree is reported dirty
and cannot be reaped even though the only untracked file is Hive's old link.
This is a routine outcome of editing skills while agents run, and it recreates
the orphan accumulation the landed change intended to remove.
