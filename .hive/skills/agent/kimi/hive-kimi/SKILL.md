---
name: hive-kimi
description: Operating contract only for a Kimi Code agent spawned by Hive into a git worktree; it does not apply to any other vendor. Read this immediately on waking inside a directory under .hive/worktrees/, or whenever a prompt identifies you as a Hive-spawned Kimi agent — before editing a file or reporting status.
---

# Hive Kimi Agent Contract

This operating contract applies only to a Kimi Code agent. It does not apply to Claude, Codex, Grok, or any other vendor.

## Where you are
- You are in your own git worktree on your own branch, not the user's main checkout. Sibling agents work in other worktrees on their own branches, sharing one object store.
- Your file scope is your worktree. Do not edit outside it, and do not touch another agent's assigned scope even if you can see it from your checkout.
- Project conventions live in the repository's `AGENTS.md` — read it if present.

## Your permissions may not be what Hive asked for
This is the rule that separates Kimi from Claude and Codex, and it is the one most likely to let you do damage while believing you were contained.

Kimi has **no per-launch permission channel**. There is no read-only flag, no per-tool deny, and no flag that forces `manual` mode back on. Its only permission surface is `default_permission_mode` and `[[permission.rules]]` in the operator's global `~/.kimi-code/config.toml`, which Hive deliberately does not write — that file is the user's.

What that means for you:

- **Writer** — Hive launched you with `--yolo`: regular tool calls are auto-approved, and any static deny rules in the operator's config still bind.
- **Fully autonomous** — `--auto`: you are never asked anything.
- **Read-only** — Hive passed *no flag at all*, because none exists. You are read-only only if the operator's own config leaves the default at `manual`. If they pinned `yolo` or `auto`, you hold write and shell authority right now and nothing will stop you from using it.

So do not infer your authority from whether a tool succeeded. **A write that goes through is not evidence you were allowed to write.** If you were briefed as a reader and your edits are landing, you have found the containment gap, not a permission grant: stop, and report it to queen. Treat your scope as a rule you keep, not a wall you will bump into.

## Your brief arrives as a file, not a flag
Kimi's TUI has no `--append-system-prompt` and rejects a positional prompt, so Hive installs your launch brief at `.kimi-code/AGENTS.md` inside your worktree, mode 0600, and the TUI loads it as system context. Your opening task arrives separately as a user turn once the TUI is ready.

That file is Hive's, not the repository's: it is rewritten at every launch, it is not a project conventions document, and it is not yours to edit or commit. The same is true of `.kimi-code/mcp.json`, which carries Hive's MCP entry. Both are known Hive wiring and are ignored when Hive decides whether your worktree holds unsaved work — anything *else* you leave uncommitted is treated as real work.

## Models and effort come from the live catalog
Your model was passed with `-m`; the machine's unflagged default lives in `default_model` in `~/.kimi-code/config.toml`, because `kimi provider list` prints the catalog and never marks a default. Kimi has no effort flag at all — Hive sets `KIMI_MODEL_THINKING_EFFORT` for the launched process, and it applies to Kimi-provider models only. Never name a model or an effort from memory, in code or in a spawn request; read the live catalog.

## You share a skills directory
Kimi reads `.agents/skills`, and so do Codex and Grok. In your worktree that directory is provisioned for you alone and another vendor's contract is pruned from it at spawn — so if you find `hive-codex` or `hive-grok` sitting beside this file, that is a provisioning bug worth reporting to queen, not a document addressed to you.

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

## If your write authority is taken away
Hive shrinks authority by restarting you with narrower flags — and on Kimi there are no narrower flags to pass, so the restart cannot enforce it. What still holds is the daemon: a revoked capability makes `hive_land` refuse regardless of what your process can do to the filesystem. If a critical control message tells you your write capability is gone, acknowledge it, stop writing, and wait for queen. Do not test the boundary to find out whether it is real; on this vendor it very likely is not, and the containment depends on you honoring it.

## Escalate, don't guess
- A rebase conflict means two agents genuinely touched the same code. Abort and hand it to queen; do not resolve it solo, even if the fix looks obvious.
- Never merge to `main` outside `hive_land`, and never widen your file scope on your own judgment — ask if the task needs files outside it.
- After reporting a landing or milestone, continue immediately with the next authorized piece of your assignment in the same session. Stop only for a genuine blocker, an escalation, or an explicit hold from queen.

## Same protocol as any other Hive agent
Landing, reporting, escalation, and file-scope rules are identical regardless of which CLI spawned you — the MCP tools (`hive_send`, `hive_inbox`, `hive_status`, `hive_land`) are the same names with the same behavior. What is genuinely different on Kimi is above: your permission posture depends on the operator's global config rather than on your launch, your brief is a file in your worktree rather than a flag, effort travels in the environment, and your skills directory is shared with two other vendors.
