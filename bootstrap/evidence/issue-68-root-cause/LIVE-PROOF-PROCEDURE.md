# Issue #68 — LIVE-PROOF procedure (operator-run, scheduled window)

**Author:** liam (writer) · **Date:** 2026-07-20 · Successor to noah's ROOT-CAUSE.md.

This proves the interim #16 slice end-to-end **against a running daemon**. The
author (a writer agent) cannot run it: it requires a daemon **rebuild + restart**,
and restart **reaps the whole fleet** — including the author. Queen or the user
runs it at a scheduled window. Every step names the surface to *read* for the
state, never an ACT taken as proof of a STATE (protocol §4).

## What is being proved

A message sent to an **idle sessiond-hosted agent** with **no human poll** is now
**injected** into that agent's terminal over the neutral viewer-attach wire
(automation claim → `INPUT_SUBMIT`), the TUI **renders and submits** it, and the
daemon later marks it **applied** from the agent's own turn boundary — never a
fabricated `applied`, and a held human claim is never stolen.

Before this slice the same send stayed **queued** forever (ROOT-CAUSE.md, live
table: `queen→james queued`, `hive-lifecycle→zoe queued`).

## Preconditions

- An all-sessiond instance (agents launched `hostKind: "sessiond"`, `tool:
  claude`); `tmux ls` shows no server. This is the environment #68 was filed in.
- A clean checkout of `main` carrying this slice (merge SHA in liam's completion
  report).

## Procedure

1. **Rebuild the daemon** with the slice:
   ```
   make build
   ```
   (`build: toolchain ghosttykit sessiond` — the TS daemon is bundled; the Zig
   engine is unchanged by this slice and need not be rebuilt, but a full `make
   build` is the safe operator default.)

2. **Restart the daemon.** This reaps the current fleet. Use the operator's
   normal daemon restart. After restart, confirm the daemon is live and that the
   `MessageDelivery` was constructed with the sessiond injector (production
   wiring in `src/daemon/server.ts`, fed by `terminalHost: sessiond` from
   `src/cli/daemon.ts`).

3. **Spawn one idle agent.** Spawn a single `claude` agent (`hostKind:
   sessiond`). Let it reach an **idle** prompt state and **stop touching it** —
   no human keystrokes, no `hive_inbox` poll on its behalf. Record its name
   (`<AGENT>`) and confirm idle:
   ```
   hive_status                         # <AGENT> status == "idle"
   ```

4. **Send with no human poll.** From queen (or any sender), send a normal
   message and record the returned id (`<MSGID>`):
   ```
   hive_send from=queen to=<AGENT> body="LIVE-PROOF #68: reply 'ack 68' and stop."
   ```
   Do **not** poll the agent's inbox. Do **not** paste anything into its pane.

5. **Read `injected` from the record** (not from the send call's optimistic
   return). Query the instance DB directly:
   ```
   sqlite3 "$HIVE_HOME"/run-*/hive.db \
     "SELECT id,state,deliveredAt FROM messages WHERE id='<MSGID>';"
   ```
   **Expected:** `state = injected`, `deliveredAt` non-null. (Pre-slice this row
   would read `state = queued`, `deliveredAt = NULL`.)

6. **Read the render from the terminal** (the ACT-bucket "watched it render"
   evidence). Observe `<AGENT>`'s terminal surface:
   ```
   hive_terminal_observe agent=<AGENT>
   ```
   **Expected:** the injected message text is present in the pane and the agent
   has **started a turn** (it is now working on the reply, not sitting idle).
   This is the proof the paste was *accepted and submitted*, not merely written.

7. **Read `applied` after reconciliation.** The maintenance tick runs
   `reconcileInjected()` (`src/daemon/server.ts`), which promotes `injected →
   applied` once the agent's own turn boundary is recorded. After the agent has
   taken a turn (its `ack 68` reply, or any tool call), re-query:
   ```
   sqlite3 "$HIVE_HOME"/run-*/hive.db \
     "SELECT id,state FROM messages WHERE id='<MSGID>';"
   ```
   **Expected:** `state = applied` — measured from the agent's boundary, never
   fabricated at inject time.

## Negative controls (honesty)

- **Never-steal.** While a human holds the input claim (open the agent's
  terminal in Workspace and start typing in its composer), repeat step 4. The
  automation claim is **denied** by the arbiter; `injectIdle` returns null; the
  row stays `state = queued`. Read it in the DB — it must **not** flip to
  `injected`. Releasing the human claim and waiting one maintenance tick
  (`wakeIdleRecipients`) then injects it.
- **No fabricated applied.** Between steps 5 and 7 the row must read `injected`,
  **not** `applied`. If it ever reads `applied` before the agent takes a turn,
  that is a fabrication bug — stop and report.
- **Failure stays queued.** If the host is unreachable (e.g. `host.sock`
  refused), the daemon logs "could not inject … leaving it queued" and the row
  stays `queued`. No crash, no false `injected`.

## Scope note

This slice covers **daemon → idle sessiond agent** delivery (the documented
stuck case). It does **not** cover the sessiond **root (queen) wake**: there is
no tracked sessiond root `SessionLocator`/geometry in the codebase today (the
root is tmux-only; only agents carry `sessionLocator`). The sessiond root
protocol is deferred to full #16 alongside root-session lifecycle — see liam's
completion report to queen.
