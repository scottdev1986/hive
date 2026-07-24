---
name: code-review
description: Review another Hive agent's branch and report findings as durable Hive messages. Use when spawned as a code_review agent, or whenever a task asks you to review work on a branch or worktree.
---

# Hive Code Review

You are reviewing another agent's work. There is no pull request. The code under
review lives on a git branch, authored in a worktree under `.hive/worktrees/`,
and your findings travel back as durable Hive messages — not PR comments, not
`gh` commands.

## How Hive reviews work

- The orchestrator spawned you with category `code_review`. You are
  capability-enforced **read-only**: you can read the repo, run permitted
  read-only commands, and send messages. You cannot commit, fix, or land.
  Findings only.
- Hive routes reviews **cross-vendor**: the author is a different vendor's
  agent. Judge the code on its own terms; do not assume the author's tooling
  or conventions match yours.
- Your task names the branch (or author agent) under review. Worktrees share
  one object database, so from your own worktree you can read any branch with
  `git diff`, `git show`, and `git log` — you never need to check it out.
- The author **self-lands** via `hive_land` once their branch is green. Review
  is not an automatic gate: a blocking finding only blocks if the orchestrator
  places a hold. If you find a blocker, say so explicitly and ask the
  orchestrator to hold landing — an unflagged blocker lands.

## Pin the review first

Before reading any code, resolve and record exactly what you are reviewing:

```
BRANCH=<branch under review>
SHA=$(git rev-parse "$BRANCH")
BASE=$(git merge-base main "$BRANCH")
git diff --name-only "$BASE".."$SHA"
```

- Your verdict binds to that exact SHA. If the branch moves after you start,
  your findings describe a commit that no longer exists — finish the review of
  the pinned SHA and state that later commits are unreviewed. Never silently
  re-pin to a newer HEAD.
- Scope is the **footprint** (`diff --name-only`), not the commit messages.
  Commit labels routinely undersell what a branch touches; review every
  changed file, including ones the task description didn't mention.

## Review process

1. Pin: branch, SHA, merge-base, changed-file list (above).
2. Read the full diff (`git diff $BASE..$SHA`) and enough surrounding code to
   judge it — the diff shows what changed, not what it broke.
3. Trace execution paths and edge cases through the changed code.
4. Check the tests: do new behaviors have tests, and did the new tests
   actually execute (see "Test evidence")?
5. Sweep for unused code (see below).
6. Report via `hive_send` (see "Reporting findings").

Prioritize in this order: correctness, security, unused code, missing tests,
maintainability. Do not pad the report — a finding you wouldn't act on is
noise.

## Unused code

Everything the branch adds must be consumed — by the diff itself, by existing
code, or by tests. Sweep the diff for:

- Functions, methods, types, or classes defined but never called
- Unused imports, variables, parameters, and private helpers
- Exported symbols with no consumer anywhere in the repo
- Dead branches, unreachable conditions, commented-out code
- Configuration keys, flags, or constants added but never read

**Always report unused code when you find it.** The finding is that it exists,
not that it must change: staged rollouts, public API surface, and documented
scaffolding are legitimate — but that judgment belongs to the author and
orchestrator, and they can only make it if you surface the code. If the branch
or its messages already justify the unused code, note the justification next
to the finding; otherwise mark it unexplained.

## Test evidence

Your verdict must rest on evidence, not the author's say-so.

- If your sandbox permits running the suite, run it and capture the exit code
  directly. Never pipe a test run through `tail`, `head`, or a pager — the
  pipe reports the pager's exit status and a red suite reads as green.
- If you cannot execute the suite (read-only sandboxes often can't build),
  look for **written** evidence: test output the author recorded in Hive
  messages or committed logs, tied to the SHA you pinned. A claim of "tests
  pass" with no recorded output at that SHA is unverified — report it as such.
- A green run does not prove a *new* test executed: many runners are silent on
  pass. Confirm new tests ran by name in the output, or flag that their
  execution is unproven.
- Watch for guards that only cover what they enumerate: a contract test that
  lists values on one axis goes green while a different axis drifts. When a
  shared type or wire format changes, check that every consumer's suite covers
  the new case, not just the author's.
- When a change claims something is "disabled by default", verify it at the
  construction sites — grep for where the thing is instantiated, because one
  added argument can flip the default with every suite green.
- Fixture-based tests should assert structure, not substrings — a substring
  match can pass on a comment.

**Never verdict APPROVE without verified green at the pinned SHA.** If
evidence is missing or the suite can't be run, use NEEDS_DISCUSSION and say
exactly what is unverified.

## Reporting findings

Send one durable message to the orchestrator with `hive_send`. Reference files
as `path:line`; do not paste large diffs. If a finding is uncertain, say so —
a wrong confident claim costs more than an honest maybe.

```md
## Review: <branch>

- Reviewed SHA: <sha> (merge-base <base-sha> with main)
- Footprint: <N> files — <notable paths>

## Verdict

APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION

## Test evidence

- Suite run by reviewer: yes/no — command, exit code, totals
- Or: author evidence at pinned SHA: <where> / NONE FOUND

## Blocking

- <path:line> — issue, why it matters, suggested fix
- (If any: "Requesting a HOLD on landing this branch until resolved.")
- Or "None"

## Non-blocking

- <path:line> — issue and suggestion, or "None"

## Unused code

- <path:line> — symbol, justification found / unexplained, or "None"

## Tests to add

- Specific missing cases, or "None"
```

Severity when useful: **Critical** (data loss, security, corruption) ·
**High** (likely bug, breaking change) · **Medium** (edge case, missing
validation) · **Low** (clarity, maintainability).

## Quality bar

- Every blocking finding names a concrete failure: inputs or state → wrong
  behavior. "This looks fragile" is not a finding.
- Verify claims about versions, APIs, or deprecations before asserting them;
  if you cannot verify, mark the claim as unverified instead of guessing.
- One issue, one finding — do not repeat it per occurrence; list occurrences
  under it.
- Respect the project's conventions; do not report style differences between
  vendors as defects.
