# Independent review: 40c3e72a (dev process name), acead1f8 (TerminationLog), 3ff6139b (incident follow-up)

Reviewer: fable, 2026-07-20. Adversarial pass over the three commits landed for the
2026-07-20 workspace-death incident, with the concurrent-authors intersection as the
primary hunting ground. Verdict up front: **the work is sound and lands cleanly; no
blocking defect found.** Four findings below, ranked; then the verifications that
came back clean, stated so they don't have to be re-derived.

## F1 — Residual (a) materially narrows the rename's premise (assessment, as asked)

The rename closes exactly one masquerade vector: SwiftPM debug output launched via
`make workspace` / `scripts/b22-live-attach-proof.ts` / `scripts/b25-a4-proof.ts`.
The disclosed residual is real and heavy: the `.dev` staged app still runs as
`HiveWorkspace` (measured by the author: 9 distinct pids in one hour; pid 66044 →
`.dev/root/versions/0.0.0/HiveWorkspace.app`). Those instances are agent-adjacent
test traffic and remain name-indistinguishable from the user's installed app —
the next false attribution is more likely to come from that path than the one
just closed. Plainly: **yes, the fix's general premise ("a test instance can
never be mistaken for the user's Workspace by name") is materially reduced by
residual (a).** Its specific premise holds: the vector that caused THIS incident
(a worktree debug build, horatio's) is closed, and the compensating controls —
tccd `binary_path` and the new subsystem lines, which any instance emits — mean
the residual costs an investigator minutes, not the hours the incident cost.
Residual (b) (`swift test` re-creating a bare `HiveWorkspace`) is genuinely
inert: no live launch path references it (verified — the only remaining
`.build/debug/HiveWorkspace` references are the Makefile's intentional
`WORKSPACE_SPM_BIN` and historical evidence transcripts). The staged-app rename
is the follow-up worth scheduling.

## F2 — CONFIRMED: the incident doc's "the hang is unconditional" overstates by one branch

`startFeed()` runs at `AppDelegate.swift:146`, before the smoke branch at `:148`,
so a `--smoke` instance with complete config owns a feed and can reach
`terminateAfterFeedFailure`. For that instance `applicationShouldTerminate`
returns `.terminateNow` (guard at `:402`), so a feed-failure self-quit **exits,
with a full orderly AppKit teardown — it does not hang**. The doc's rule-out
("A feed-failure self-quit cannot produce that") survives anyway, because the
02:35 teardown specifically showed `NSTerminateLater`, which a smoke instance
cannot emit — but the doc rests on that detail without stating it. A future
reader applying "feed-failure hangs, therefore any exited process wasn't
feed-failure" to a smoke harness instance would conclude wrongly. One sentence
in the follow-up section would repair it. The rest of the follow-up is exactly
right: it completes the prior investigator's unreachable-vs-absent call rather
than erasing it, and the NSLog redaction measurement explains WHY her positive
control was blind.

## F3 — CONFIRMED (now closed): the ivy∩iona intersection was never live-verified by either author

The one thing the two-author overlap left unmeasured: does the RENAMED binary
still emit iona's termination lines? ivy's evidence
(`raw/qualification/workspace-dev-process-name/evidence.txt`) contains zero
`hive-terminate` lines — his logged launch (08:15) predates iona's landing
(08:27), and his post-rebase check verified process naming only. I closed it
against ivy's post-rebase binary (built 09:07, contains the TerminationLog
strings): a bare `--smoke` invocation exited 1 through the instrumented path
and the unified log returned

    2026-07-20 09:16:52.251 Df HiveWorkspaceDev[84482] [dev.hive.workspace:lifecycle]
      hive-terminate phase=exiting reason=smoke-invalid-invocation detail=code=1 ...

with a bare header on the negative-control subsystem. The subsystem is a
hardcoded constant (`TerminationLog.swift`, `static let subsystem`), not derived
from the bundle — verified in source, as claimed. **The intersection holds; it
just held unproven until this review.**

## F4 — A losing writer is silent (minor, correct-by-policy)

`noteTerminationReason` (`AppDelegate.swift:381`) records the `.requested` line
only when it wins. A feed failure arriving while a user quit is already pending
emits no `feed-failure` line at all — attribution of the exit stays correct
(the user's quit IS the cause), but "every in-app route to exit records a line"
is really "every route records if it decided first". Fine for the stated
purpose; worth knowing when an expected line is absent.

## Verified clean

- **Termination behavior unchanged; deadlock still live.** Every added statement
  is a `TerminationLog.record` call or a write to the new `terminationReason`
  field; control flow, replies, and the `terminateLater` deadlock mechanism are
  untouched. Logging-only, as claimed.
- **First-write-wins is genuine and tested.** The guard in
  `noteTerminationReason` is the policy;
  `testFeedFailureKeepsItsReasonWhenClosingWindowsTripsLastWindowClosed` drives
  the real cause-then-consequence sequence. Nil-clearing on the cancelled branch
  cannot resurrect a stale reason: the `.resolved` line logs the captured local,
  and every later writer re-derives. (The cancelled branch itself is untested —
  acceptable.)
- **Coverage complete.** Independent enumeration: `exit()` exists only at
  `AppDelegate.swift:97` and `SmokeRunner.swift:285` (the sole exit, inside
  `exitSmoke`; every former smoke exit routes through it); all
  `NSApp.terminate` routes drain through the instrumented delegate methods;
  Cmd-Q/menu quit resolve via the unclaimed fallback. `FeedClient.swift:65` and
  `TerminalPaneView.swift:268` terminate child processes (feed subprocess,
  terminal child), not the app — correctly left alone.
- **Release path unaffected.** No reference to `.build/debug` or the Dev name
  anywhere under `src/release/`; `build.ts` lipos its own release binaries into
  `Contents/MacOS/HiveWorkspace` (`build.ts:242`), `CFBundleExecutable` literal
  unchanged (`:183`); signing and installer read the `.app` bundle;
  `b25-production-pane-proof.ts` deliberately targets the installed app. No
  programmatic `pkill`/`pgrep` by process name exists to be confused by the
  rename.
- **Sessiond RED is pre-existing — with one sharpening.** `test.sh`'s read set
  (native/, vendor/ghostty headers, toolchain scripts) is disjoint from all
  nine files the three commits touched, so `sessiond-real-host-golden` cannot
  be theirs. Nuance: ivy's extraction ran at 8c858f49, which already CONTAINS
  iona's two commits — his experiment exonerates only himself; the
  disjoint-read-set argument is what clears iona too. I did not re-run the
  suite (cold zig cache here); ownership is settled structurally either way.
