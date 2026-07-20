# Resume liveness fix — what is proven, and what is owed until 2026-07-26

**Fix:** `fix(recovery): wake a resumed agent before watching it for life`
**Author:** ingo · **Evidence:** prior instance DB `run-bc65ab00-416d-4032-91c1-7937388aa255`
**Companion issue:** #57 (hive's own MCP failing at resume — a *different* defect, not this one)

> **#57 REMAINS OPEN.** Commits `9ebd0268` and `4a7ed9db` fix the resume *liveness* defect described in this doc. They do **not** fix #57, and must never be cited as closing it — they sit directly above #57 in the log with matching vocabulary, which is exactly how `#55` happened. #57's issue body now carries this same guard.

---

## 1. What the fix changes

`src/daemon/recovery.ts`:

1. The continuation notice (`wakeResumedAgent`) is now sent **before** the liveness watch, not after it. A resume restores a conversation but issues no instruction, so the TUI comes back correctly idle; the notice is the only thing that gives it something to do, and the watch can only observe an agent that is doing something.
2. `monitorResume` defers to `watchForProofOfLife` (`src/daemon/readiness.ts`) — the same watch the spawn path already uses — instead of a hand-rolled 10-second stopwatch that accepted only a hook event or a codex rollout write.

## 2. Why no number was the fix

The old probe's two accepted signals, measured against the same night's `events` table:

| Vendor | Signals available at resume | Resumes passed |
|---|---|---|
| claude | fires a `session-start` hook → `lastEventAt` advances | **3 / 3** |
| codex | hook rides hive's MCP; rollout silent until first tool call | **0 / 5** |
| grok | **0 events across all 11 agents**, and no rollout artifact | **0 / 6** |

Grok cannot advance `lastEventAt` at all, so of the two signals the probe accepted it could produce **neither**. Its resume was not unlucky — it was impossible, at any timeout. The probe was calibrated on the one vendor with a hook and inherited by two without one.

There is **no successful codex or grok resume anywhere in the data**, so the 10s window could not have been justified empirically even if a window were the right shape. It is not: `readiness.ts` measured 15s to first output on `gpt-5.6-sol` high, so even a correctly-woken codex resume would have died on a 10s bound.

## 3. What IS verified today (no vendor quota required)

Positive controls run by reverting only `recovery.ts` + `readiness.ts` to the pre-fix commit while keeping the new tests, then restoring from an out-of-band snapshot (byte-identical to the commit, confirmed by an empty `git status`).

| Test | Pre-fix | Post-fix |
|---|---|---|
| resume notice is sent before the watch begins | **RED** — `notice` at index 1, `watch-poll` at index 0 | GREEN |
| a resumed agent proves life by redrawing, no hook and no rollout | **RED** — `marked-dead`, *"no proof of life within 10s … last pane output: esc to interrupt · working 10s"* | GREEN |
| a pane redrawing with no agent process behind it is still death | **RED** | GREEN |

The middle row reproduces the production failure string exactly, on an agent that is visibly working.

The first row is the one that matters for rot: pre-fix, that resume **still succeeded** — the harness proved life by other means — so an outcome-only assertion would have passed against the broken order. Only the sequence assertion catches it.

Full suite: **1650 pass, 0 fail** (`bun test src/`, exit 0). `bunx tsc --noEmit` clean.

## 4. What is NOT verified, and cannot be until the resets

Both pools are at 0% remaining. **Codex resets `2026-07-26T00:00:27Z`; Grok resets `2026-07-26T17:18:56Z`.** A pinned Codex spawn cannot be admitted before then — the account-wide `["*"]` pool gates every model, including the 100%-remaining `codex_bengalfox` spark sub-pool. So none of the below was performed, and no unit test substitutes for any of it:

1. **That a real Grok TUI redraws while working.** The pane-redraw heartbeat is grok's *only* possible liveness signal, and it is measured for the Codex TUI (`readiness.ts`, ~1 Hz over 24 consecutive polls) but **assumed** for Grok. If Grok's TUI does not redraw at ~1 Hz while working, a woken grok resume still dies — at the quiet limit instead of the stopwatch. This is the single largest piece of residual risk.
2. **That the injected notice actually wakes a real resumed TUI.** Delivery reaches the pane via `tmux send-keys` (`delivery.ts:825`), verified in test; that a live resumed Codex/Grok TUI accepts it at its restored prompt and begins a turn is not.
3. **That `launchedProcessAlive` names the right binary on a real resume.** `argv[0]` is `grok` / `codex` in the resume commands, but the Codex app-server path launches `hive codex-app-server-host`; that path is untested here against a live process tree.
4. **End-to-end: that a crashed codex/grok agent now actually resumes.** The whole point, and the thing only a live vendor can show.

## 5. Exact steps to close the debt

**First Codex spawn after `2026-07-26T00:00:27Z`:**

```
# 1. Spawn a codex writer, let it start a turn, then kill its tmux session
#    (simulating the crash) and let the recovery sweep resume it.
tmux kill-session -t hive-<agent>

# 2. Watch the resume, and check the pane redraws while it works:
for i in 1 2 3 4 5; do tmux capture-pane -p -t hive-<agent> | md5; sleep 1; done
#    PASS = the digests differ across polls (heartbeat present).

# 3. Confirm the outcome and the reason string:
sqlite3 ~/.hive/instances/run-<id>/hive.db \
  "SELECT name,status,failureReason FROM agents WHERE name='<agent>';"
#    PASS = status is not 'dead', failureReason is NULL/empty.

# 4. Confirm the agent received the wake and acted on it:
sqlite3 ~/.hive/instances/run-<id>/hive.db \
  "SELECT kind,timestamp FROM events WHERE agentName='<agent>' ORDER BY timestamp DESC LIMIT 5;"
#    PASS = at least one event AFTER the resume timestamp.

# 5. While there, close issue #57's open question:
tmux capture-pane -p -t hive-<agent> | grep -i "MCP startup incomplete"
#    Any hit means hive's own MCP failed — file against #57, NOT against this fix.
```

**First Grok spawn after `2026-07-26T17:18:56Z`:** run the same five steps, and treat **step 2 as the load-bearing one** — grok emits no events at all, so if the digests do *not* differ across polls, the redraw heartbeat is absent for Grok, item 4.1 above is refuted, and this fix does not save grok resumes. In that case grok needs a liveness signal that does not exist yet, and that is a new task, not a tuning change.

Record the result either way. A pass closes items 1–4; a fail on grok step 2 reopens the design question with real data instead of an assumption.
