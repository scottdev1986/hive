# sessiond queen restart proof

Status: designed, not yet executed. This procedure cannot prove the host swap
from a queen that was itself launched on tmux. Every result cell starts
unchecked and must be run after a restart from one immutable candidate.

## Ruling and gate

`HIVE_ORCHESTRATOR_HOST=sessiond` is the restart-proof opt-in. The absent or
empty setting still selects tmux. Issue #114 gates changing that default;
removing the tmux implementation remains separate work in #1/#2.

The acceptance decision requires every communication row below, the visibility
lease checks, and the scroll row to pass on the same candidate. A unit test, a
successful input call, or a screen redraw is not a live pass:

- queued means durable but not handed to the provider;
- injected means sessiond returned the `INPUT_SUBMIT` receipt;
- applied requires a later queen turn boundary;
- process death requires exact post-state, not a successful signal call; and
- a manual or prompt-only run has the reduced assurance described in
  [Pre-release acceptance testing](../release/acceptance-testing.md).

## Measured history boundary

The root renderer retains 48 MiB of terminal state. At 80 columns by 24 rows,
the fixed 80,000-line measurement corpus retained 71,727 rows in total and
71,703 history rows after restore through both the headless engine and
GhosttyKit. The payload was 50,015,739 bytes. These are corpus measurements,
not a line guarantee: wrapping, geometry, grapheme width, attributes, and
images change the row count per byte.

The journal and checkpoint bridge preserve continuity across detach and
reattach, but they do not add another visible-history tier. Post-reattach
history is capped by the renderer's 48 MiB terminal-state budget. The measured
fixed-width corpus exceeds tmux's configured 50,000-logical-line history, but
any live root that restores materially less than that tmux baseline fails the
default-swap gate. See
[sessiond scrollback measurement](../terminal/sessiond-scrollback-measurement.md)
for the reproducible corpus and checkpoint evidence. Issue #114 owns the
checkpoint producer/consumer ceiling and must be green before the default
changes.

## Test-owned restart setup

Run this as an extension of the isolated development-fleet procedure in
[Pre-release acceptance testing](../release/acceptance-testing.md). Use its
immutable candidate, `RUN_ID`, ownership manifest, action journal, process and
filesystem watchers, production baseline, exact-identity cleanup, and final
attestation rules. Do not run it against the continuously serving instance.

In addition to that procedure's variables, record:

```sh
PROOF_HOST=sessiond
PROOF_ROOT_RECIPIENT=queen
PROOF_ROOT_VISIBILITY_ID=root
export HIVE_ORCHESTRATOR_HOST="$PROOF_HOST"
launchctl setenv HIVE_ORCHESTRATOR_HOST "$PROOF_HOST"
test "$(launchctl getenv HIVE_ORCHESTRATOR_HOST)" = "$PROOF_HOST"
```

The shell setting reaches the daemon. The `launchctl` setting is separately
required because LaunchServices does not inherit the launching shell's
environment. Add `launchctl unsetenv HIVE_ORCHESTRATOR_HOST` to the run's traps
before launching Workspace, and verify the variable is absent during final
cleanup. A restart after it is unset returns to the tmux default.

For the genuine quota-envelope cell, place this test-only overlay in the
isolated instance's `quota.toml` before daemon start. Replace `claude` with the
enabled provider the disposable proof agent will actually use. This creates a
real, cheaply crossed manual pool; it must never be installed in the serving
instance.

```toml
discovery = false
warningRemainingPct = 1
criticalRemainingPct = 1
reserveFiveHourPct = 0
reserveWeeklyPct = 0

[[limits]]
provider = "claude"
account = "restart-proof"
pool = "restart-proof"
models = ["*"]
fiveHourAllowance = 100
weeklyAllowance = 100
```

Launch the isolated candidate through its public provider command. Do not use
`make run`. The first root binding is written before host creation so
Workspace can publish its visibility. Wait for the completed binding rather
than inferring readiness from a pane:

```sh
sqlite3 -readonly "$I_HOME/hive.db" <<'SQL'
  SELECT json_object(
    'locator', json(locatorJson),
    'createEvidence', json(createEvidenceJson),
    'terminationAudit',
      CASE WHEN terminationAuditJson IS NULL
        THEN NULL ELSE json(terminationAuditJson) END)
  FROM terminal_host_bindings
  WHERE json_extract(locatorJson, '$.subject.kind') = 'root'
  ORDER BY locatorGeneration DESC
  LIMIT 1;
SQL
```

The preflight passes only when the returned locator has the manifest's exact
`instanceId`, `subject.kind: "root"`, `hostKind: "sessiond"`, generation 1,
a nonempty `engineBuildId`, non-null `createEvidence`, and a null termination
audit. Record its session id and generation as `R0`. From queen, call
`hive_terminal_observe` for that exact session id and generation with
`include: "metadata"` and `maxRows: 1`. Require the same locator, positive
geometry, a decimal output sequence, `text: null`, and no scope or subject
error. This is the positive control for reading later negative states.

Read the manifest-recorded tmux socket with `has-session` for the exact legacy
queen session. It must be absent. Prove the tmux reader first against a known
live socket/session from the read-only baseline; if the isolated instance has
no tmux server at all, record both that positive control and the exact test
socket's absent-server result. The provider root recorded in
`createEvidence.verifiedProviderRoot` must instead belong to the exact sessiond
binding. Do not accept "no tmux process found" until the positive-control
inventory proves the command is reading the correct instance socket.

## Evidence record

For each cell retain the UTC interval, action-journal rows, screenshots or
screen recording, exact root locator before and after, full message or approval
ids, and the raw structured result. Use one unique token per action. Never
reuse an id between cells.

| Cell | Result | Required durable evidence |
| --- | --- | --- |
| Host | [ ] | exact sessiond root locator and capture; exact legacy tmux queen absent |
| A — user prompt | [ ] | composer marker; working then idle boundary; exact answer token |
| B1 — idle agent mail | [ ] | send id; injected then applied; exact envelope at queen |
| B2 — mid-turn agent mail | [ ] | tool-boundary injection; no cancellation; later applied |
| C1 — stranded work | [ ] | `hive-lifecycle` message and preserved ref; nothing deleted |
| C2 — reap notice | [ ] | warning, verified clean reap, and readable `hive-lifecycle` message |
| C3 — quota alert | [ ] | real `hive-quota` critical message from the test pool |
| D — approval | [ ] | pending id and full description; decision; vendor continuation |
| E1 — active human draft | [ ] | unchanged draft; queued/injected/applied ladder on one message id |
| E2 — orphan/undeliverable | [ ] | queued while view is gone; orphan recovery; exactly-once application |
| F1 — provider crash | [ ] | old process absent; generation increment; queued mail applied |
| F2 — feed stall | [ ] | same generation remains live beyond 15 s; no expiry audit |
| F3 — source death/expiry | [ ] | expiry audit; restart generation; queued mail applied |
| S — scrolling | [ ] | wheel/momentum, anchored output, follow-bottom, keys, reattach history |

Any missing cell is `NOT RUN` or `BLOCKED`, never pass.

## A — visible user prompt to queen

1. Focus the root pane and paste `A-$RUN_ID` as one editing action, without
   Enter. Require `$I_HOME/runtime/composers/queen.typing` to exist before any
   submit.
2. Send Enter as a separate event after the paste-coalescing interval. Require
   the marker to clear only after its grace interval.
3. Require the structured root status to move to `working`, queen to answer
   with the exact token, and the later turn boundary to return status to
   `idle`.

The visible terminal, structured status, and provider boundary must agree. Do
not use tmux injection or capture as a substitute for the user action.

## B — agent mail wakes queen

### B1: idle

With queen at an observed idle boundary, have one live proof agent call
`hive_send` to queen with `B-IDLE-$RUN_ID`. Record the returned message id and
state. Queen must begin a fresh turn from the injected envelope, name the exact
token and sender, and call `hive_read_message` only if the bounded envelope
requires it. A later read of the same id must show `state: "applied"` and
non-null `injectedAt` and `appliedAt` in order.

### B2: mid-turn tool boundary

Give queen a visible prompt containing `B-MID-TURN-$RUN_ID` that requires at
least two harmless read-only tool calls. While the first tool call is in
flight, have the proof agent send a `steer` message containing
`B-MID-ENVELOPE-$RUN_ID`.

The send may initially report queued. It must be injected at the next queen
tool boundary without cancelling or replacing the in-flight turn. Queen must
name both tokens, continue the original task, and reach a normal turn end. The
same message id must then be applied. A send result alone, or queen mentioning
only the original prompt, fails this cell.

## C — daemon-origin lifecycle and quota envelopes

These are real daemon events, not agent prose impersonating a subsystem.

### C1: stranded work

Use a disposable writer whose path and branch are in the ownership manifest.
Have it commit one test-owned marker that is deliberately not on main, then
call `hive_kill` without `discardWork`. Require the kill result and the later
`hive-lifecycle` envelope to name the branch and `refs/hive-preserved/...`, say
`PRESERVED`, and say that nothing was deleted. Prove the ref and commit exist.
Remove them only through the manifest-owned cleanup after the evidence is
sealed.

### C2: reap notice

Set the isolated `config.toml` lifecycle to `idleReap = true` and
`idleReapMinutes = 1` before launch. Use a second disposable agent that ends at
idle with a clean worktree, no unmerged commit, and no queued mail. Require the
warning to reach that agent first. Only after it is applied may the daemon reap
the session. Queen must then receive the readable `hive-lifecycle` envelope
`Reaped <name>: idle ... with a clean worktree and nothing unmerged.` Exact
process and slot post-state must be absent/baseline; a message without a reap
does not pass.

### C3: quota alert

First call `hive_quota_status` and record the `restart-proof` pool as the
positive control. Spawn one disposable agent on the provider named by the
test-only pool. Its real reservation crosses the configured critical threshold
and must produce a durable message from `hive-quota` to queen containing
`Hive quota critical`, the provider/pool, remaining amount, and reset evidence.
Queen must read the envelope and report its confidence and routing impact. A
handwritten quota message or only a status read fails the cell.

## D — queen approval round trip

Switch the isolated instance to the Workspace's sandboxed autonomy setting,
wait for the feed to confirm it, then spawn a disposable agent. Use a harmless
command that the selected vendor genuinely routes to its permission surface;
for example, the Codex
fixture-equivalent read-only request is a `curl` to `https://example.com` with
output discarded. Do not manufacture an approval row. If the provider
auto-allows the command, choose another harmless read-only request that
actually raises the prompt and record the first attempt as not applicable.

Require the agent status to become `awaiting-approval`. Queen calls
`hive_approvals` and records the pending id, `kind: "tool-permission"`, and the
full untruncated command description. Queen then calls `hive_approve` for that
exact id. The result must be `resolved`; the vendor prompt must visibly leave,
the exact command must run once, and the agent must return to working and then
idle. The agent's later `hive-approvals` resolution envelope is the final
positive control that the decision crossed back over the terminal bridge.
Restore and re-confirm the run's prior autonomy setting before the next cell.

## E — delivery honesty under human input ownership

### E1: an active root draft

Type `E-DRAFT-$RUN_ID` in the root without submitting. Record the visible bytes
and the `queen.typing` marker. Have the proof agent send
`E-WAKE-$RUN_ID` to queen.

The send must return one durable message id in `queued` state. The draft must
remain byte-for-byte unchanged, must not submit, and no queen turn may start.
The queued row must not have `injectedAt` or `appliedAt`. Cancel the draft with
the provider's real cancellation input, or submit it deliberately. The same
message id must then progress to `injected` only after sessiond returns the
`INPUT_SUBMIT` receipt. During queen's resulting turn, a read of that id must
still show injected rather than falsely applied. After queen's later boundary,
the id must be applied exactly once.

### E2: orphaned claim and temporarily undeliverable root

Start a fresh root draft `E-ORPHAN-$RUN_ID`. Arrange a proof agent's one-shot,
bounded send for five seconds later, then `SIGKILL` only the manifest-owned
Workspace process. This intentionally abandons the renderer claim and leaves
the composer marker; do not kill the daemon or sessiond. The agent sends
`E-ORPHAN-WAKE-$RUN_ID` before the 15-second visibility lease expires. Require
that message to remain queued and the stale draft never to become a turn.

Relaunch the same candidate and instance immediately, still opted into
sessiond. It must reattach generation `R0`, not invent another live root. The
new Workspace clears the dead process's marker. Require the same message id to
become injected from an `INPUT_SUBMIT` receipt and applied once at a queen
boundary, while the abandoned draft is never submitted. The root delivery
adapter currently returns the receipt decision but not sessiond's optional
orphan-recovery detail, so do not fabricate that diagnostic; the exact-id
queued → injected → applied sequence and absence of a draft turn are the live
evidence. If the old lease expires before reattach, record this cell as failed
and run the deterministic expiry case F3; do not relabel a new-generation
recovery as an orphan-discard pass.

## F — root crash, stall, expiry, and recovery

### F1: provider crash with the supervisor alive

Keep at least one proof agent live. Start a root draft so a message from that
agent is durably queued, then capture the root binding and its
`createEvidence.verifiedProviderRoot` PID/start token. Re-measure that exact
identity immediately before signaling it; abort on any mismatch. Terminate
only that test-owned provider process, never sessiond, the daemon, or a PID
selected by name.

Require the old provider process to be absent and root generation `R0` to reach
`exited`. Because a live agent remains, the local supervisor must announce the
exit, request recovery reports, and start generation `R1 = R0 + 1` with a
recovery brief. Workspace must detach `R0` before rendering `R1`. Cancel the
old human draft in the new renderer; the already-queued message must then be
injected and applied exactly once. The new root must not duplicate or restart
the agent's work.

### F2: a stalled feed is not a fleet kill switch

Identify the exact manifest-owned `workspace-feed` child while leaving its
Workspace source process alive. `SIGSTOP` only that child for more than 15
seconds, with a trap that sends `SIGCONT`. The daemon's five-second renewal
clock must continue renewing the last accepted exact inventory because the
source PID and start token still verify.

After the pause, require the same root generation and provider PID/start token,
a successful exact metadata observation, no termination audit, and a working
user prompt. Resume the feed and require snapshots to recover. Root death,
generation change, or silent loss is a failure even if relaunch later works.

### F3: a dead visibility source fails closed, loudly, and recoverably

Run this destructive isolated-fleet cell last. Queue one uniquely identified
root message behind an active human draft, seal its queued row, then kill the
exact manifest-owned Workspace source and do not relaunch it until after the
15-second lease. The daemon must withhold renewal once the source PID/start
token no longer verifies. Sessiond must terminate the old root host.

Require the exact old binding to gain a termination audit with
`origin: "visibility-expiry"` only after inspection proves an expired lease and
dead vendor process. The queued message must remain queued and unchanged; no
stage may be skipped. Restart the same candidate with the opt-in still set.
Require a new root generation, a visible recovery/startup explanation, and the
same message id injected then applied once after the stale composer marker is
cleared. The expiry may take the disposable agent hosts down too; their
recoverable state and worktrees must remain accounted for. A root that dies
without the audit, does not return on restart, or loses the queued row fails.

## S — root scrolling and reattach history

1. Produce at least 20 screens of uniquely numbered, harmless root output.
   Record top, middle, and bottom tokens.
2. Use a trackpad or wheel to move upward through several screens, including a
   momentum gesture whose viewport continues after finger release. Require the
   older tokens to be reachable.
3. While anchored above the bottom, have an agent inject
   `S-ENVELOPE-$RUN_ID`. Continue scrolling during and after the injection.
   The viewport must not jump; the `New Output ↓` affordance must appear; the
   envelope must still reach queen.
4. Exercise Shift+PageUp, Shift+PageDown, Shift+Home, and Shift+End (the
   keyboard's Fn equivalents are acceptable). They are viewer-local and must
   neither acquire an input claim nor send bytes to the provider. Unmodified
   navigation keys remain provider input. A recognized Shift chord is consumed
   even if the engine cannot perform the local action.
5. Use Shift+End or click `New Output ↓`. The indicator must clear, the bottom
   token must be visible, and subsequent output must follow automatically.
6. Detach and reattach Workspace without ending the root provider. Require the
   pre-detach tokens within the retained 48 MiB window, the exact generation,
   and the output sequence to remain continuous. Repeat wheel and keyboard
   navigation after reattach.

For the fixed 80,000-line measurement corpus, the numeric expectation is
71,703 history rows after restore at 80×24. For ordinary root output, record
the actual earliest reachable token and byte/row geometry instead of converting
it into a fake line guarantee. A discontinuity within the budget, an effective
history materially below tmux's 50,000-line baseline, broken momentum, a jump
to bottom on new output, or a Shift chord reaching the provider fails the
default-swap gate.

## Cross-language seam debt

This proof deliberately exercises three duplicated Swift/TypeScript values,
but live agreement is not a compile-time pin:

- the renderer and daemon copies of the 48 MiB scrollback budget;
- the root delivery/visibility key `"root"`; and
- `ProjectState.orchestratorVisibilityID = "root"` and
  `ProjectState.orchestratorRecipient = "queen"` versus the daemon's
  `ROOT_VISIBILITY_ID` and `ORCHESTRATOR_NAME`.

A separate follow-up owns a generated/shared contract or mutation pin for this
class. Until then, locator mismatch, a missing root renderer, or queued mail
after a rename is a hard failure, not evidence that no root exists.

## Implementation disposition

This ledger separates code-closed work from restart evidence and deferrals.

| Item | Disposition |
| --- | --- |
| Exact root locator without an agents row | Code closed; daemon and Workspace tests cover root subject, instance, session, and generation. Host/F cells remain live. |
| Root publish-before-create ordering | Code closed; create waits for the exact Workspace visibility admission, then renews only after create evidence exists. Host/F cells remain live. |
| Root visibility expiry | Code closed as fail-closed termination plus `visibility-expiry` audit; F2/F3 distinguish stalled publisher from dead source live. |
| Queen relaunch | Code closed through the existing supervisor and fresh root generations; F1 remains live. |
| Queued → injected honesty | Code closed; only the sessiond `INPUT_SUBMIT` receipt returns success. B/E/F remain live. |
| Human draft versus wake | Code closed with retain-and-retry coverage for root input. E1/E2 remain live. |
| Root terminal observation | Code closed for exact root bindings. Host preflight remains live. |
| Controller admission/monitor cancellation | Code closed; daemon shutdown aborts both waits. |
| Declined/non-running root delivery | Code closed as retryable false, not a thrown or injected result. |
| Cross-instance root generation reuse | Code closed; only bindings with the current instance id contribute. |
| Session capacity leak and failed-spawn ghosts (#115) | Code closed with atomic failed spawn and more-than-32 spawn/kill baseline coverage. Pre-fix never-bound ghost rows already held by an old daemon are not hot-repairable; restarting into the fixed binary clears them. |
| Checkpoint/resize invariant and aggregate terminal disk budget (#114) | Deferred and default-gating. This proof consumes #114's landed bounds; it does not silently choose a smaller root history. |
| Swift/TypeScript duplicate constants | Deferred to the separately filed pin-work; exercised, not compile-time proved, here. |
| Tmux removal | Deferred to #1/#2. The fallback remains required. |
| Launch-watch failures (#111) | Pre-existing and untouched; no `src/daemon/launch-watch*` file is part of this migration. |

## Default and removal decision

The sessiond default may change only when:

1. issue #114's checkpoint/resize invariant is landed and its exact long-root
   reattach measurement is recorded;
2. every cell in this document passes on one immutable restarted candidate;
3. the root never dies during F2, and F3 is loud and recoverable;
4. the scroll row meets or exceeds the measured tmux baseline; and
5. Bun tests, TypeScript typecheck, and the Workspace tests are green apart
   from separately proved pre-existing failures.

That decision changes only the default. The tmux host stays functional until
#1/#2 remove it under their own evidence.
