# #68 acceptance failure #2 (2026-07-21 ~00:07–00:15Z): findings and fixes

Follow-up to LIVE-PROOF-FAILURE-FIX.md. The 20:04:46 daemon (carrying
`56624f07` + `b6c5f2da`) ran the acceptance live — **tmux-hosted this run**
(no Workspace → sessiond admission closed → agents and queen in tmux on
socket `hive-adc6ff7499`), so both failures are in the tmux paths, not the
sessiond viewer wire.

## Defect 1 — paste lands, submit doesn't (queen→james `6f803c96`)

Timeline from the events table: james's own turn ended 00:07:30.135; the
queued message flushed at that boundary and pasted at :30.213; a turn-start
appeared at :30.316. Delivery's turn-start verification credited that
turn-start and marked `injected` — but it was james's own next work turn
(:30.316 → :42.342 → :42.446 → :47.263, a busy multi-turn sequence), not the
paste submitting. The pasted text sat in the composer until the user's manual
Enter (~:45). Two distinct holes:

1. **The trailing Enter can be swallowed** (consumed as an editor newline, or
   sent before the vendor composer is ready) — the observed manual-Enter
   dependence.
2. **Turn-start verification cannot attribute a turn to the paste** — a
   boundary-flush racing the agent's own next turn false-positives. (Residual:
   see below.)

**Fixes** (`src/daemon/delivery.ts`):
- When no turn starts inside the confirm window, ONE bare Enter re-press
  (empty paste, submit only) and a second confirm window. A composer holding
  our paste submits it; an empty composer ignores it.
- Still no turn → queued, with the cause on the row
  (`deliveryDiagnostic: "tmux paste not submitted: …"`).
- A redelivery after a recorded paste failure clears the composer first
  (idle recipient, so nothing in-flight is cancelled) — without this the wake
  sweep's re-paste would stack a second copy on the first and eventually
  submit garbled doubles.

**Residual (documented, not fixed):** attribution. A turn that starts right
after the paste is credited to it; an agent whose own turns are back-to-back
can still false-positive the confirm. Decisive attribution needs the vendor
to say what prompt started the turn (e.g. a UserPromptSubmit-style hook
carrying the prompt text into the turn-start event) — recommended for full
#16. `reconcileInjected`'s applied-confirmation shares the same limit.

## Defect 2 — the root wake delivered 0 of 4 queued queen messages, silently

Live elimination (probes against the still-running tmux server, post-mortem
DB reads):

- The full production wake object graph (BunTmuxSender → TmuxSessionHost →
  TmuxAdapter → paste+Enter, OrchestratorRootDelivery) **works** against a
  scratch orchestrator session on a scratch home — envelope pasted, injected.
- The exact production sender also works against a scratch session **on the
  live socket** (`hive-adc6ff7499`).
- `hive-orchestrator-adc6ff7499` passes target validation; the session-lock
  was not wedged (`orchestratorInbox` took the same lock and succeeded at
  00:09:10); no composer lease ever existed this run (tmux mode has no
  Workspace, the only lease writer); recipient canonicalization is correct
  (`to === "queen"` gates the wake, rows store canonical `queen`).
- Queen's pane scrollback (captured live, 2000 lines) contains **no wake
  envelope at all** — the paste never happened; the failure precedes tmux.
- The daemon died before I got to it (lifecycle files cleaned ~00:13Z), and
  its stderr was /dev/null — the initiating error is not recoverable
  post-mortem. Again.

**The structural defect found:** `wakeOrchestrator`'s loop had no per-message
isolation. Any throw for the FIRST queued message rejected the whole loop,
`send()`'s `.catch(() => undefined)` buried it, and every message behind the
head was never attempted — one poisoned envelope starves the queue for the
run, producing exactly 0/N-with-no-trace. (Repo memory has this exact lesson:
"sweep loops without per-item isolation — one throw skips the rest.")

**Fixes** (`src/daemon/delivery.ts`):
- Per-message isolation in `wakeOrchestrator`: a failing message records
  `root wake failed: <error>` on its own row and the loop continues.
- `deliverRoot` records every non-delivery cause on the row: composer leased,
  no live root protocol, transport error (with the caught message — the blind
  `.catch(() => false)` is gone), and unconfirmed delivery.
- `hive_send`'s queued note for root recipients now says what queued means
  ("queen was not woken… deliveryDiagnostic records why… do not re-send") —
  the bare `queued` is what made james re-send his ack.

Whatever threw first on 2026-07-21, the next run's stuck row will carry its
name. If nothing throws next run, the wake will simply work — it does in
every in-tree and live-socket configuration tested here.

### CONFIRMED LIVE (2026-07-21 ~00:38–00:43Z), and fixed

The diagnostics did their job on the very next run: the stuck rows read
`root wake failed: tmux load-buffer failed: error connecting to
<repo>/.dev/tmux/tmux-501/hive-<suffix> (No such file or directory)`.

Root cause: **a tmux socket-path split**. `make run`'s DEV_ENV exported
`TMUX_TMPDIR=.dev/tmux` to the DAEMON only, while the orchestrator session
is created by the launcher in the USER's shell (default `/tmp/tmux-$UID`)
— so every daemon-side root-wake client dialed an empty directory while
queen's server listened elsewhere. Agent traffic was unaffected because this
run's agents were sessiond-hosted (the viewer wire — which also confirms the
`b6c5f2da` inject fix works hands-off in production: queued → injected →
applied in ~2s with nobody at the keyboard).

Fixes:
- `Makefile`: `TMUX_TMPDIR` removed from DEV_ENV — the per-instance socket
  NAME (`-L hive-<suffix>`) already carries the isolation; a directory
  override only splits the daemon from the launcher-created server. `clean`
  now tries the kill-server in both socket dirs (pre-fix and current runs).
- `wakeIdleRecipients` now retries undelivered ROOT messages on the
  maintenance tick — the root has no agents row, so a wake that failed at
  send time previously had NO retry ticker at all.
- Live heal without a restart: the running daemon's baked env was bridged
  with a socket-file symlink
  (`.dev/tmux/tmux-501/hive-<suffix> → /private/tmp/tmux-501/hive-<suffix>`;
  tmux rejects a symlinked socket *directory* but follows a symlinked socket
  *file*). The stuck row flipped queued → injected at 00:43:23Z on the next
  trigger. The symlink is superseded by the Makefile fix at the next
  restart and is removed by any `make clean`.

## Instrument notes

- macOS `nc -z -U` reports "refused" against working UDS sockets (inherited
  note; still true).
- The daemon's stdout/stderr go to /dev/null in production. Two acceptance
  runs have now died on that. Anything that matters must land on a row.

## For the next acceptance run (ACs restated)

1. Idle agent, `hive_send` normal from queen → `applied` with the agent's
   turn starting on the message, zero human keystrokes.
2. Queen idle, agent's `hive_send` to queen → wake envelope injected, queen
   acts unprompted.
3. Token round trip queen → agent → queen under 1+2.
4. The proof MUST positively state no human touched any pane (the previous
   "pass" silently depended on a manual Enter). If any message sticks in
   `queued`, read `deliveryDiagnostic`/`deliveryDiagnosticAt` off the row —
   that is the diagnosis surface all of this exists to provide.
