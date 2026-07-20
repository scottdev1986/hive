# B2.5.2 A4 evidence pin — independent cross-vendor review (harper, Claude)

**Subject:** horatio (Codex), branch `hive/horatio-m1-item-6-hard-b2-5-production`
**Reviewed tip:** `6c09eda69f24e60f815a88a5e7f92546d36b562c` (code commit `82d63f920d4e33eae79d162643bca4f87c6bdcf8`)
**Tip correction:** review opened against `5c06c85f`; horatio steered to `6c09eda6` mid-review.
`5c06c85f` is an ancestor of `6c09eda6`, and the delta is evidence-only (no script or
source change), so findings taken against the earlier tip carry forward unchanged.

**VERDICT: PASS.** Queen may clear the land. The 100-MiB leg is out of this pin's scope.

Every A4 row carries its claim, the pin reproduces end-to-end on an independent
stack, and the concurrent-quit cell is honestly bounded rather than overclaimed.
Five non-blocking findings are recorded below; none of them falsify a claim.

## Method

Verified from `git archive 6c09eda6` into a clean scratch tree, plus a full
independent live re-run in a detached worktree at the pin (`/tmp/hb25rev`) with a
`cp -Rc` warm native cache and `make ghostty` / `make native` staging.

Independent corroboration worth naming: my locally staged engine reported
checkpoint engine build id `0d9070c47bab025ff394278906697ab5728fcc66668503f96e12bf0c62f0f300`,
which is byte-identical to the `engineBuildId` recorded in every locator in his
manifests. His sessions demonstrably ran on the lock-pinned engine.

Commands run, with real exit codes (never piped — a pager's status is not the
suite's):

| Command | Exit | Result |
|---|---|---|
| `shasum -a 256 -c .../evidence-sha256.txt` (from archive root) | 0 | 18/18 OK, 0 FAILED |
| `swift test --filter AppDelegateLifecycleTests` | 0 | Executed 16 tests, 0 failures |
| `swift test --filter LiveHostAttachTests` (no proof home) | 0 | **6 tests, 6 skipped** — see F3 |
| `HIVE_B25_A4_PORT=43150 HIVE_B25_EVIDENCE=/tmp/hb25rev-ev bun scripts/b25-a4-proof.ts` | 0 | `B2.5 A4 LIVE PROOF OK` |

`bun run test:sessiond` and `zig build test` were **not** run, per the #54
build-runner IPC deadlock.

## Row verdicts

### 1. Exact pane close — PASS

The attribution control is properly instrumented. `wrongLocatorKill` issues the
mismatched-generation kill, asserts it fails closed, and then calls
`requireWholeTreeAlive(proof)` before returning — so "pane target survived" is a
*measured* readback of the captured tree, not an inference from the refusal
string. The real close then drives `waitTreeAbsent` over the same captured pids,
and `final.survivors: []` is gated by a `state !== "terminated" || survivors?.length !== 0`
throw rather than being a decorative field. Daemon/broker survival is gated on the
driver transcript containing `A4 CLOSE VERIFIED`.

`liveProcesses` carries its own positive control — `processStates` throws if it
cannot see the harness's own pid — so an empty liveness result cannot be a silently
broken reader. That is the right shape.

**Retraction.** I first flagged this control as an unmeasured label, having
mis-attributed the `requireWholeTreeAlive` call sites when reading the grep output
rather than the function body. Reading `wrongLocatorKill` refuted it. The finding
was wrong and is withdrawn; the control is sound.

My re-run reproduced the row independently: session `ses_019f7e58-…`, port 43151,
same four GREEN lines.

### 2. Replay/reconnect + journal fence — PASS

`LiveHostAttachTests.testLiveAttachReplayReconnectAndFence` genuinely executed in
his run (1 test, 1.213s, with a live `RESIZE 80x24 result: applied 80x24` line) and
again in mine (1.308s). Journal evidence is pinned by path, byte count, and sha256.
The wrong-generation attach control is labeled `refused` — which is exactly what the
instrument measured. Correct labeling.

### 3. Live non-Hive project — PASS

The load-bearing conjunction is measured while the session is live: inside
`exactClose`, `requireWholeTreeAlive(proof)` and `assertPlainProject(project)` run
back-to-back at `feedStatus=working`, on a plain `git init` repo with no
`package.json`, Bun lockfile, `.hive`, or Hive source layout.

The planted `package.json` mutation does bite: it is a positive control proving the
plainness predicate is non-vacuous — it flips `assertPlainProject` to throw, and
removal restores it. That is precondition-control done right rather than a defect.
One caveat is recorded as F5: the cell's *own* matrix file re-stamps the session id
after `exactClose` has already terminated that session, so the artifact reads as a
live measurement it did not itself take.

### 4. Composed concurrent quit — PASS, and correctly bounded

The cell reads exactly `COMPOSED-NOW / FAITHFUL-PENDING-UNLOCK` and claims no more
than its composition carries. The three clauses are independently evidenced: the
live sentinel `hive stop` (`killed aria — 4 process(es) reaped`, tree absence,
`survivors: []`), p14's real production Workspace/vendor lifecycle, and the
AppDelegate wait/refusal XCTests — both
`testTerminationWaitsForVerifiedStopBeforeAllowingQuit` and
`testTerminationFailureCancelsQuitAndSurfacesReason` pass in my own run.

The manifest is honest in machine-readable form, not only in prose: `a4-quit.json`
alone among the four A4 manifests carries `"ok": false`, alongside
`"status": "COMPOSED-NOW/FAITHFUL-PENDING-UNLOCK"` and a `faithfulPending` block
naming the blocking condition (`requiresUnlockedProductionStack`), the diagnostic,
and the reason — the b22 driver hosting the daemon in-process. A tool that reads
`ok` gets the right answer without parsing prose. That is a point in the pin's
favour and the correct disposition for a leg that is composed but not yet faithful.

The b22 harness-entanglement limitation is recorded as committed negative evidence
with both failed approaches and their real observed symptoms (attempt 1: visibility
renewal `VERIFICATION_UNKNOWN` then `NOT_FOUND`, no `final.json`, external `hive stop`
required; attempt 2: zombie sessiond host, no `final.json`, driver-owned daemon
surviving to manual SIGINT). The document states plainly that these attempts
**must not** satisfy the faithful row, and pre-commits the acceptance criteria for
the run that will. This is the standard the campaign wants.

## Findings (all non-blocking)

**F1 — `provenance.txt` records a rebased-away `checkout=`.** It reads
`checkout=bf73483aee153f66a8c2f06c171cac0d093f57c4`. That object exists, but it is
*not* an ancestor of the pin: it is an orphaned twin of `cb2b6069` carrying the same
commit message, left behind by a rebase. `git merge-base --is-ancestor bf73483a 6c09eda6`
fails. The `a4_pin=82d63f92` line is correct and *is* an ancestor, and every manifest
records `head` correctly, so nothing downstream is misattributed — but the campaign's
own rule is that provenance records the exact HEAD. Repoint it at `6c09eda6`.

**F2 — queen's ruling survives only as a hand-edit the generator will clobber, and
the clobber flips a machine-readable field.** Every artefact carrying the ruling was
hand-applied at `06:54:30.184Z`, four minutes after the run it annotates, and
`scripts/b25-a4-proof.ts` emits none of it — `grep` for `ok: false`, `status:`, or
`faithfulPending` in the generator returns nothing. The generator writes the quit
manifest with a literal `ok: true`.

So a re-run does not merely soften prose. It would:
- rewrite `matrix/a4-quit.txt` back to `RESULT: A4 concurrent quit + provider-tree teardown GREEN`
  (demonstrated — my re-run produced exactly that), and
- rewrite `manifests/a4-quit.json` with `"ok": true`, dropping the `status` and
  `faithfulPending` blocks entirely.

The second is the sharper risk: `ok` is the field a tool or a later agent reads to
decide whether the leg is done, and a regeneration silently flips it from a correct
`false` to an incorrect `true` while deleting the record of why. The current state
is right; it is the *durability* that is the defect. Encode the pending status in
the generator — key it off the same condition the diagnostic names — or mark both
files as hand-annotated so a regeneration surfaces as a conflict rather than a quiet
revert. This is the one finding I would fix before the next A4 run, not after.

**F3 — `runSwiftTest` gates on exit code alone, so a fully skipped suite reads GREEN.**
`LiveHostAttachTests` is opt-in behind `HIVE_B22_PROOF_HOME`; without it the suite
skips and exits 0. I ran exactly that: `Executed 6 tests, with 6 tests skipped and 0
failures`, exit 0 — which `runSwiftTest` would have accepted as success. No claim in
this pin is affected, because the committed artifacts independently evidence
non-skip (a named test case with a real duration). But the instrument cannot
currently tell "passed" from "never ran". Assert on the `Executed N tests` line with
`N > 0` and zero skips.

**F4 — the sha manifest covers 18 of 42 committed evidence files without declaring
its scope.** The 18 are the load-bearing set (all four A4 cells, the p14 composition
source, provenance, EVIDENCE.md) and the manifest correctly excludes itself. The
uncovered 24 are diagnostics, screenshots, and journal transcripts. A reader running
the self-check sees `18/18 OK` and may take that for whole-directory integrity.
State the covered scope in `EVIDENCE.md`.

**F5 — the non-Hive cell re-stamps a session that is already terminated.**
`a4-non-hive-project.txt` prints `Workspace session=ses_019f7e4a-545a-…` at
`06:50:42`, but `exactClose` terminated that session at `06:50:37` — its own cell
reports `state=terminated, survivors=[]`. The underlying live-on-plain-project fact
is genuine and is measured in the close cell; only this artifact's framing implies it
took the reading itself. Cite the close cell, or take the non-Hive readings before the
trigger fires.

**F6 (nit) — manifests cite XCTest evidence by absolute path** into
`/Users/scottkellar/Projects/hive/.hive/worktrees/horatio/…`. Those paths do not
resolve for another agent or from an archive. Use repo-relative pointers.

## Environment

Lock-blocked legs (pixel/capture) were graded environment-deferred and not chased;
no surface failure was treated as a defect. `hive_ghostty_surface_new_manual_v1 failed`
appears in the lifecycle XCTest log and the suite passes regardless — consistent with
the landed boundary finding that manual-surface config proofs remain valid under lock.

Host: arm64 macOS 26.3.1, Swift 6.3.3, Bun 1.3.14. Ghostty
`73534c4680a809398b396c94ac7f12fcccb7963d`; `native/toolchain-lock.json` byte-identical
between my worktree and the pin.
