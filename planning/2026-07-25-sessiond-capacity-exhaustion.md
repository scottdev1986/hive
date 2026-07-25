# sessiond capacity exhaustion — handoff for an outside agent

**Date:** 2026-07-25
**Status:** open, unfixed, fleet-blocking
**Author:** queen (orchestrator). Everything below is either measured in this session or explicitly labelled as inference.

---

## 1. Symptom

`sessiond` refuses new session launches with `CAPACITY_EXCEEDED` after a session of normal agent spawning and killing. Once it starts, it does not recover on its own, and agents cannot be respawned or resumed.

Verbatim error, returned on six separate resume attempts within 40 seconds:

```
could not be recovered safely: resume launch failed: sessiond CAPACITY_EXCEEDED: capacity_exceeded;
teardown could not be verified: sessiond locator has no terminal-host binding in this Hive instance.
Hive preserved the agent record, worktree, quota reservation, and queued messages;
retry cleanup or recovery explicitly after verifying process state.
```

Note the **second clause** — it is a separate failure from the first and may be the more informative one: Hive could not verify teardown because *the sessiond locator has no terminal-host binding in this Hive instance*. If Hive cannot bind to a session to tear it down, it plausibly cannot free that session's slot either.

---

## 2. Measured timeline (2026-07-25)

| Time (UTC) | Event |
|---|---|
| 19:50 | 6 agents spawned. Fleet healthy. |
| 19:56–20:26 | 5 more agents spawned over time. Peak ≈ 11 concurrent. |
| 20:20 | `alex` vendor process confirmed dead → **auto-resume succeeded**, agent completed its task normally. |
| 20:22 | `sarah` vendor process confirmed dead → **resume FAILED**: "no sign of life for 12s (screen never redrew, no hook event, no tool activity)". Not a capacity error at this point. |
| 20:21–20:45 | 10 agents killed via `hive_kill` (maya, suite, opencode-shell, amber-assess, cluster-verify, nina, david, leo, kimi-probe, alex). Each kill reported 3–4 processes terminated with `survivors: []`. |
| 20:47–20:53 | 6 new agents spawned (lena, noah, omar, priya, liam, emma). |
| 20:53–20:55 | All 6 report `Wake path check failed: <name>'s sessiond vendor process is confirmed dead`. |
| 20:53–20:56 | All 6 **auto-resumed successfully** (new sessions, conversations restored). |
| 20:57:16–20:57:55 | All 6 crash again; every resume now fails with `CAPACITY_EXCEEDED`. Unrecoverable. |

Only agents that were *already running* before the exhaustion survived (sam, james, anna, zoe, john).

---

## 3. What is known about the code

Reported previously and worth re-verifying rather than trusting:

- `Registry.occupiedSlots` **skips `.exited` sessions**. This was fixed on 2026-07-22 in commit `78012bce` on `main`.
- The known-unverified leg, recorded as an open thread before today: **whether a real-host terminate readback actually reaches `.exited` on the wire, or whether that has only ever been demonstrated under `FakeHost`.**

Today's evidence is consistent with that leg being broken, but does not prove it.

---

## 4. Hypotheses, in the order I would test them

**H1 — Killed sessions never reach `.exited`, so slots leak on every kill.**
`occupiedSlots` skipping `.exited` is only effective if terminated real-host sessions actually transition to `.exited`. If a killed session lands in some other terminal state (or none), it keeps occupying a slot forever. 10 kills preceded the exhaustion. *This is the primary suspect and matches the previously-recorded unverified leg exactly.*

**H2 — Crash-then-resume leaks a slot per cycle.**
Each of the six agents crashed, was resumed into a **new** session, then crashed again. If resume allocates a new slot without releasing the crashed session's slot, every crash-resume cycle consumes an extra slot. The six agents went through 2 cycles each — 12 potential leaked slots in four minutes, which fits the timing tightly.

**H3 — Orphaned locators cannot be torn down at all.**
The error says teardown could not be verified because *the locator has no terminal-host binding in this Hive instance*. If a session's locator loses its binding, Hive may have no route to release it. This would make the leak unrecoverable without a daemon restart, which matches the observed behavior.

**H4 — Genuine OS resource exhaustion, with `CAPACITY_EXCEEDED` as a downstream symptom.**
A baseline captured earlier today (`planning/2026-07-25-daemon-resource-curve.md`) measured **6 live agents → 44 recursive children, 624 numeric FDs, ~4.74 GiB tree RSS**; the daemon alone was 29 FDs / ~713 MiB. Extrapolating to 11 agents gives roughly 8–9 GiB and ~1,100 FDs. If the real limit is FDs, memory, or process count, then the capacity counter may be innocent and the crashes are the primary event. **The crashes preceded the capacity errors**, which is a point in favor of this hypothesis and against treating it as purely a counting bug. A recorder exists at `scripts/record-daemon-resources.sh`.

H1/H2/H3 and H4 are not mutually exclusive — resource pressure could cause the crashes while a counting leak makes them unrecoverable.

---

## 5. What the fix must achieve

1. A killed or crashed agent **reliably frees its sessiond slot**, proven against a **real host**, not only `FakeHost`. The existing proof is the thing under suspicion, so a test that passes under `FakeHost` is not evidence.
2. Capacity does not decrease monotonically across a session of spawns and kills. After N spawns and N kills, available capacity should equal the starting value.
3. If a slot genuinely cannot be released (H3), that is **reported loudly** rather than silently consuming capacity.

## 6. What the fix must NOT do

- **Do not simply raise the capacity limit.** If slots leak, a higher ceiling only delays the wall and hides the defect.
- **Do not build a reaper/supervisor/health-check subsystem.** YAGNI is a hard standing rule in this repo. If the bug is a missing state transition, the fix is that transition.
- Do not remove or weaken the `occupiedSlots` `.exited` skip from `78012bce` — it is correct as far as it goes; the question is whether sessions reach `.exited`.

## 7. Verification bar

The repo standard is **mutation-proved tests**: revert the fix, watch the test fail, restore it, watch it pass, and report both results. A test whose baseline is derived from the same source it validates proves nothing — a real recurring pitfall here. Because the suspected defect is precisely "works under the fake, not under the real host", the decisive test must exercise a **real** host process.

## 8. Pointers

- `native/sessiond/` — `Registry`, `occupiedSlots`, `session_host.zig`
- Commit `78012bce` (the `.exited` skip)
- `docs/daemon/agent-teardown.md`, `docs/daemon/multi-instance.md`, `docs/contracts/terminal-host-v1.md`
- `docs/incidents/2026-07-20-workspace-death.md` — prior incident, may describe the same failure
- `planning/2026-07-25-daemon-resource-curve.md` + `scripts/record-daemon-resources.sh` — resource baseline and recorder

**Caution on documentation:** this repo's design docs state intent in the same voice as measured fact. Verify every doc claim against code and against a live measurement before building on it.

## 9. Immediate operational workaround

Restart the daemon to reset capacity. Until this is fixed, treat a `hive_kill` as **not** freeing a slot, and keep concurrent agents modest rather than spawning to a perceived ceiling.
