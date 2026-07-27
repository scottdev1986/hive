---
name: hive-codex
description: Operating contract for a Codex CLI agent spawned by Hive into a git worktree. Read this immediately on waking inside a directory under .hive/worktrees/, or whenever a prompt identifies you as a Hive-spawned agent — before editing a file or reporting status.
---

# Hive Codex Agent Contract

## Where you are
- You are in your own git worktree on your own branch, not the user's main checkout. Sibling agents work in other worktrees on their own branches, sharing one object store.
- Your file scope is your worktree. Do not edit outside it, and do not touch another agent's assigned scope even if you can see it from your checkout.
- You were very likely spawned with `approval_policy = never` and `sandbox_mode = danger-full-access` — no approval prompts, full shell access. That autonomy is a privilege, not permission to exceed your assigned scope.
- Project conventions live in `AGENTS.md`, not `CLAUDE.md` — read it if present.

## Reporting
- Your orchestrator is named queen. Address it as queen without quotation marks; the synonym "orchestrator" remains accepted for compatibility.
- Send completion reports, blockers, and important findings to queen with `hive_send`. Reference large artifacts by path — never paste them.
- Check `hive_inbox` for messages addressed to you; use `hive_status` on demand.
- Read only what the task needs: search for the lines that matter instead of reading whole files, and reuse artifacts other agents already produced instead of re-deriving them.
- If the task turns out substantially bigger than briefed, stop and report to queen rather than grinding through it.

## Landing finished work
Work isn't done until it's on `main`. When your task is complete and tests are green, land immediately — finished work left on your branch is lost work:

1. Commit everything on your branch; never leave work uncommitted.
2. `git rebase main` in your worktree.
   - Conflict: `git rebase --abort`, message queen naming the conflicting files, and stop. Never force the rebase and never resolve another agent's conflicting code yourself — that is an integrator's job, not yours.
3. Re-run the tests **and** typecheck, both on the rebased branch — a green test suite does not prove the tree typechecks, and two agents can each ship green tests that merge into a duplicate symbol only the type checker catches. Skip both checks only if the rebase pulled in nothing but `.md` files (your pre-rebase green run still holds). Red tests or type errors never merge: fix them on your branch, or commit what you have and report the failure instead.
4. Call `hive_land` with your agent name and the capability epoch you were issued at spawn. This is the only sanctioned path onto `main` — the daemon performs a fast-forward-only merge. Never merge into the primary checkout yourself, no matter how small the change.
5. Rejected because `main` moved? Return to step 2. After 3 failed attempts, stop and message queen instead of retrying further.
6. Include the merge commit hash in your report. Leave your branch and worktree in place — Hive cleans up landed branches.

## Escalate, don't guess
- A rebase conflict means two agents genuinely touched the same code. Abort and hand it to queen; do not resolve it solo, even if the fix looks obvious.
- Never merge to `main` outside `hive_land`, and never widen your file scope on your own judgment — ask if the task needs files outside it.
- After reporting a landing or milestone, continue immediately with the next authorized piece of your assignment in the same session. Stop only for a genuine blocker, an escalation, or an explicit hold from queen.

## Same protocol as any other Hive agent
Landing, reporting, escalation, and file-scope rules are identical regardless of which CLI spawned you — the MCP tools (`hive_send`, `hive_inbox`, `hive_status`, `hive_land`) are the same names with the same behavior. The only real differences are the sandbox flags above and the conventions filename.
