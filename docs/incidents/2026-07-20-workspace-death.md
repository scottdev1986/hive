# The 02:35 Workspace death that did not happen

Investigation of an "unattended Workspace GUI death at ~02:35 on 2026-07-20",
recorded as a confirmed anomaly in the M1-finish campaign record.

**Verdict: the premise is wrong twice over.** No Workspace instance of the
user's died at 02:35, and the agent rows believed lost were never lost.

## Timeline (all 2026-07-20, from the unified log unless noted)

| Time | Event | Source |
|---|---|---|
| 00:30–03:21 | 22 distinct `HiveWorkspace` processes, each living 9s–2m16s, each ending in a clean in-app `-[NSApplication terminate:]` | `log show --predicate 'process == "HiveWorkspace"'`, per-PID first/last |
| 02:34:26.210 | pid 19864 launches — `binary_path=/Users/scottkellar/Projects/hive/.hive/worktrees/**horatio**/workspace/.build/arm64-apple-macosx/debug/HiveWorkspace` | tccd AUTHREQ_ATTRIBUTION msgID=19864.1 |
| 02:34:55.765 | `[com.apple.AppKit:Application] terminate:` — in-process, no Apple Event | pid 19864 |
| 02:34:55.766 | `applicationShouldTerminate: NSTerminateLater` | pid 19864 |
| 02:36:32.344 | pid 19864 exit handler — 97s of orderly teardown | pid 19864 |
| 02:32 / 02:34 / 02:37 / 02:43 … 03:59 | installed-app (`versions/0.0.37`) child spawns continue **without a gap** | attributions to `dev.hive.workspace` |
| 06:44:03, 06:44:14 | user running `hive` CLI; xcodebuild and WebStorm active — user is awake | kernel DYLD unnest lines for `hive[13545]`, `hive[13566]` |
| 06:46:47 | last child spawn attributed to the installed 0.0.37 app | attributions |
| 06:47:06 | last write to overnight daemon DB `run-bc65ab00` | file mtime |
| 07:19:06 | new instance DB `run-aa0938c5` + `HiveWorkspace` pid 1561 — the restart | mtime + unified log |

## What actually died at 02:35

Agent **horatio's** debug build, running as a test/probe instance out of their
worktree. It quit *itself*: a full AppKit teardown sequence (`terminate:` →
`applicationShouldTerminate: NSTerminateLater` → exit handler). A signal death
cannot produce that sequence — SIGKILL leaves no AppKit chatter at all.

The user's Workspace was the *responsible ancestor* of that process, which is
why the installed 0.0.37 path appears in the attribution. It kept spawning
children continuously across 02:35 and for another four hours.

## Suspects

| # | Suspect | Verdict | Deciding evidence |
|---|---|---|---|
| 1 | #49 `make clean` argv-mentioner sweep | **RULED OUT** (twice) | `Makefile` now prints `found mentioners, not killing:` — the sweep no longer kills mentioners. It is also scoped to `$(DEV)`, which never matches `~/.local/share/hive/versions/0.0.37`. And there is no 02:35 death to explain. |
| 2 | #52 hive-stop / GUI lifecycle mismatch | **RULED OUT** for 02:35 | The app self-terminated through its own `AppDelegate`; no `hive stop` sits near either boundary in `.zsh_history`. |
| 3 | Daemon crash taking the GUI with it | **RULED OUT** for 02:35 | Daemon instance DB `run-bc65ab00` kept being written until 06:47:06 — four hours after the alleged event. At the 06:47 boundary the app stopped first (06:46:47) and the daemon 19s later, consistent with one external kill hitting both. |
| 4 | Genuine app crash (exception/OOM/signal) | **RULED OUT** | Zero crash reports for `HiveWorkspace` or `hive` in `~/Library/Logs/DiagnosticReports` across 00:00–08:00 — only `xctest` reports from agent test runs. Plus the clean AppKit teardown. |

## The end of the user's session (~06:47)

Most likely the user's own shell line, `.zsh_history:1063`:

```
pkill -9 -f b22-live-attach-proof; pkill -9 -f hive-sessiond; pkill -9 -f HiveWorkspace
```

It sits exactly 7 commands before the end of history, followed by the restart
sequence (`hive`, `cd Projects/hive`, `claude --resume`, `hive`), and the app
does restart at 07:19:06.

**Confidence: moderate, not high.** `EXTENDED_HISTORY` is off, so that ordering
is positional, not clocked. The pkill's wall-clock time is **unreachable**.

## The "lost" agent rows were never lost

`hattie` and `helena` are present in the overnight instance DB:

```
$ sqlite3 ~/.hive/instances/run-bc65ab00-*/hive.db 'select name,status from agents'
… hattie|dead … helena|dead …
```

The morning restart minted a *new* instance (`run-aa0938c5`) holding only the
new i-cohort (`ike`, `iris`, `isla`, `ivan`). Reading the current instance DB
and finding no `hattie` is reading the wrong database, not data loss.

## Unreachable, stated plainly

- **NSLog visibility.** A positive control for NSLog-originated lines from *any*
  `HiveWorkspace` instance returned empty. So "no feed-failure message in the
  log" is **unreachable**, not evidence of absence — the feed-failure self-quit
  path (`AppDelegate.swift:257 terminateAfterFeedFailure`) cannot be ruled out
  for the 06:47 event.
  **Resolved 2026-07-20 — see below. The call above was right: the channel was
  redacted, and the reason it returned empty is now measured.**
- **Exact pkill wall-clock.** No timestamped shell history.

## Follow-up: feed-failure is now positively ruled out

The unreachability above was called correctly, and it has since been closed —
but from the opposite direction than expected. Not by finding the missing log
line: by proving the suspect path **cannot produce the observed outcome**.

**Why the channel was blind.** `NSLog` reaches the unified log with an empty
subsystem, an empty category, and an `eventMessage` of `<private>` — the text
is redacted. No `log show` predicate can match or read it. The positive control
was therefore reading a channel that structurally cannot answer, which is
exactly what "unreachable, not absent" meant. (A second, independent trap: `log`
is a shell builtin in zsh and shadows `/usr/bin/log`, so an unqualified
`log show --predicate` fails with `too many arguments` rather than returning
results.)

**Why feed-failure could not have caused either death.**
`terminateAfterFeedFailure` does not terminate the app — it **hangs** it. The
feed-restart path runs inside a `DispatchQueue.main.asyncAfter` block; from
inside that block it calls `NSApp.terminate(nil)`; `applicationShouldTerminate`
returns `.terminateLater`; AppKit spins a nested event loop in
`-[NSApplication _shouldTerminate]`. The reply is then delivered via
`DispatchQueue.main.async` — which can never run, because the main *dispatch*
queue is already inside `_dispatch_main_queue_drain` and is not reentrant. A
nested AppKit event loop pumps events, not the main dispatch queue.

Reproduced twice against real launches: a stub `hive` touched a marker file, so
`hive stop` demonstrably ran and exited 0, yet the process stayed alive at 0%
CPU with no reply and no exit. `sample(1)` shows the full stack. Every route
into that path is inside a main-queue block — `FeedClient.onExit` is itself
dispatched through `DispatchQueue.main.async` — so the hang is unconditional
for a non-`--smoke` instance, not a race. One branch escapes it: a `--smoke`
instance also owns a feed (`startFeed()` at `AppDelegate.swift:146` runs before
the smoke branch at `:148`), but its `applicationShouldTerminate` replies
`.terminateNow` (the guard at `:402`), so a feed-failure quit there **exits
cleanly, with a full orderly teardown and no hang** — and can never reply
`NSTerminateLater`.

Both the 02:35 and the ~06:47 processes **exited**. The rule-out therefore
rests on more than "feed-failure always hangs" — it holds per event, on the
branch each process could occupy. 02:35 exited through a full, orderly AppKit
teardown **that included the `NSTerminateLater` reply**: a non-smoke
feed-failure quit hangs before any reply, and a smoke feed-failure quit exits
but replies `.terminateNow` — neither branch can produce that teardown. The
~06:47 process was the user's installed app, which never runs `--smoke`, so
the hang applies unconditionally to it and its exit cannot be a feed-failure
self-quit. So `terminateAfterFeedFailure` is **ruled out** for both events —
positively, on mechanism, not merely unproven.

Cmd-Q is unaffected and still quits normally: it enters `terminate:` from the
event loop, so the main queue is free and the reply lands.

The hang is a real defect, filed separately. It is deliberately **not** fixed as
part of the instrumentation work — changing termination behavior needs its own
scoped task and review.

## Instrumentation that would settle this next time

1. `setopt EXTENDED_HISTORY` in the user's zsh config — would have clocked the
   pkill immediately.
2. ~~Emit the **quit reason** from every terminate path via `os_log` under a
   stable subsystem/category (`dev.hive.workspace` / `lifecycle`)~~ — **done**,
   `workspace/Sources/HiveWorkspace/TerminationLog.swift`. Read it back with:

   ```
   /usr/bin/log show --last 1h \
     --predicate 'subsystem == "dev.hive.workspace"' --style compact
   ```

   Line shape: `hive-terminate phase=<p> reason=<r> detail=<d>`. Reasons:
   `feed-failure`, `last-window-closed`, `user-quit`, `apple-event-quit`,
   `smoke-invalid-invocation`, `smoke-finished`. Phases separate the decision
   from the outcome, because a `.terminateLater` reply resolves later — or is
   cancelled and the app never exits at all.

   **Absence is now evidence.** Every in-app route to exit records a line
   first, so a process that vanishes with *no* `hive-terminate` line was killed
   from outside (a signal, a `pkill`, a crash) rather than quitting itself.
   Pair any query with a negative control — a subsystem that does not exist
   returns a bare header — so an empty result is proven to mean absence.
   One suppression to know: **a losing writer is silent.** The reason is
   first-write-wins, so a feed failure arriving while another quit is already
   pending emits no `feed-failure` line at all. Attribution of the exit stays
   correct, but an absent `feed-failure` line means "did not decide the quit",
   not "did not occur".
3. Give agent worktree debug builds a distinct process or bundle name, so a
   test instance can never be mistaken for the user's Workspace in the log.
