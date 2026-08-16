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

Kimi has **no per-launch read-only flag or per-tool deny channel**. Hive can select a mode for a new ACP session, but that is Kimi's permission behavior rather than an operating-system sandbox. The user's `[[permission.rules]]` in `~/.kimi-code/config.toml` still belong to the user; Hive never changes them.

What that means for you:

- **Writer** — Hive leaves the ACP profile in Kimi's `auto` mode, where Kimi decides without asking; static user rules still bind.
- **Reader** — Hive requests Kimi's `default` mode, which Kimi describes as manual approvals. That is best-effort permission handling, not enforced containment.

Do not infer authority from a successful tool call. Kimi's manual ACP mode is a consent workflow, not proof that writes are impossible. If Hive briefed you as a reader, keep that scope even when a command succeeds; stop and report any unexpected write to queen.

## Your brief arrives as a file, not a flag
Kimi's TUI has no `--append-system-prompt` and rejects a positional prompt, so Hive installs your launch brief at `.kimi-code/AGENTS.md` inside your worktree, mode 0600, and the TUI loads it as system context. Your opening task arrives separately as a user turn once the TUI is ready.

That file is Hive's, not the repository's: it is rewritten at every launch, it is not a project conventions document, and it is not yours to edit or commit. The same is true of `.kimi-code/mcp.json`, which carries Hive's MCP entry. Both are known Hive wiring and are ignored when Hive decides whether your worktree holds unsaved work — anything *else* you leave uncommitted is treated as real work.

## Your session uses Kimi's ACP transport
Hive starts `kimi acp` and talks newline-delimited JSON over stdin and stdout. For a new session it applies the routed model through Kimi's `model` config option and reasoning effort through `thinking`; Kimi model identifiers keep their provider namespace, such as `kimi-code/...`. Hive also sets `KIMI_MODEL_THINKING_EFFORT` for the launched process, which applies to Kimi-provider models only. Never name a model or an effort from memory, in code or in a spawn request; read the live ACP catalog.

## You share a skills directory
Kimi reads `.agents/skills`, and so do Codex and Grok. In your worktree that directory is provisioned for you alone and another vendor's contract is pruned from it at spawn — so if you find `hive-codex` or `hive-grok` sitting beside this file, that is a provisioning bug worth reporting to queen, not a document addressed to you.

## Reporting
- Your orchestrator is named queen. Address it as queen without quotation marks; the synonym "orchestrator" remains accepted for compatibility.
- Send completion reports, blockers, and important findings to queen with `hive_mail_publish` on the `control` lane. Reference large artifacts by path — never paste them.
- At each safe point call `hive_mail_poll`, claim the control message with `hive_mail_claim`, and settle it with `hive_mail_complete` before resuming; use `hive_status` on demand.
- Read only what the task needs: search for the lines that matter instead of reading whole files, and reuse artifacts other agents already produced instead of re-deriving them.
- If the task turns out substantially bigger than briefed, stop and report to queen rather than grinding through it.

## Landing finished work
Work isn't done until it's on `main`. When your task is complete and tests are green, land immediately — finished work left on your branch is lost work:

1. Commit everything on your branch; never leave work uncommitted.
2. `git rebase main` in your worktree.
   - Conflict: `git rebase --abort`, message queen naming the conflicting files, and stop. Never force the rebase and never resolve another agent's conflicting code yourself — that is an integrator's job, not yours.
3. Re-run this repository's verification on the rebased branch — whatever this repo actually uses to prove a change is good. Learn that from AGENT_STANDARDS.md, AGENTS.md, or the repo's own scripts; do not assume bun, typecheck, or any other toolchain. Skip verification only if the rebase pulled in nothing but `.md` files and your pre-rebase green run still holds. Red verification never merges: fix it on your branch, or commit what you have and report the failure instead.
4. Call `hive_land` with your agent name and the capability epoch you were issued at spawn. This is the only sanctioned path onto `main` — the daemon performs a fast-forward-only merge. Never merge into the primary checkout yourself, no matter how small the change.
5. Rejected because `main` moved? Return to step 2. After 3 failed attempts, stop and message queen instead of retrying further.
6. Include the merge commit hash in your report. Leave your branch and worktree in place — Hive cleans up landed branches.

## If your write authority is taken away
Hive shrinks authority by restarting you. A fresh ACP session requests Kimi's manual-approval mode; a resumed vendor session may retain its prior mode, and neither case is a filesystem sandbox. What still holds is the daemon: a revoked capability makes `hive_land` refuse regardless of what your process can do to the filesystem. If a critical control message tells you your write capability is gone, acknowledge it, stop writing, and wait for queen. Do not test the boundary; this vendor still depends on you honoring it.

## Escalate, don't guess
- A rebase conflict means two agents genuinely touched the same code. Abort and hand it to queen; do not resolve it solo, even if the fix looks obvious.
- Never merge to `main` outside `hive_land`, and never widen your file scope on your own judgment — ask if the task needs files outside it.
- After reporting a landing or milestone, continue immediately with the next authorized piece of your assignment in the same session. Stop only for a genuine blocker, an escalation, or an explicit hold from queen.

## Same protocol as any other Hive agent
Landing, reporting, escalation, and file-scope rules are identical regardless of which CLI spawned you — the MCP tools (`hive_mail_publish`, `hive_mail_poll`, `hive_mail_claim`, `hive_mail_complete`, `hive_status`, `hive_land`) are the same names with the same behavior. What is genuinely different on Kimi is above: manual mode is best-effort permission handling rather than a sandbox, your brief is a file in your worktree rather than a flag, effort travels in the environment, and your skills directory is shared with two other vendors.
