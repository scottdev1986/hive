# #40 live claim drop-reattach (43119)

## Setup
- Port 43119, `SHELL=/tmp/hulda-ls-shell`, home `/tmp/hb22-4908` (rebased re-proof)
- Pin base: rebased onto primary main `48feb497` then tip may move; see git log for exact SHA
- Binary: sessiond ReleaseFast with onViewerDetached + claim resume + operatorResume(kind) by-construction
- Workspace debug with releaseClaimBestEffort + accessibilitySurfaceWillClose on userClose
- Opt-in: `HIVE_B22_PROOF_HOME=/tmp/hb22-4908 HIVE_B22_REAL_SHELL=1 swift test --filter '…'`

## GREEN rebased re-proof (2026-07-20)
Log `/tmp/hulda-claim-reprove-live.log`:

```
hive claim: granted token=claim_ffcd23… viewer=claim-drop-a-176410
# unclean transportA.close() — no CLAIM_RELEASE
hive claim: granted token=claim_f8d932… viewer=claim-drop-b-176410
Test Case …testLiveClaimUncleanDropThenHumanResumeTypes passed (1.260s)
Test Case …testReleaseClaimBestEffortSendsCancelClaimRelease passed
```

## Never-steal (unit, rebased)
- input_arbiter 28/28 including `HUMAN_ORPHANED + non-human operatorResume is denied at the arbiter`
- session_host 39/39 including CLAIM_ACQUIRE lifecycle; automation assert requires denied+HumanOrphaned only
- Logs: `/tmp/hulda-arb-unit.out`, `/tmp/hulda-host-unit.out`

## Hardenings folded (henrietta required)
1. `operatorResume(viewer, claim, kind)` enforces `kind == "human"` inside the arbiter (by-construction).
2. Host automation assert: `state=denied` + diagnostic `HumanOrphaned` (no `unknown`).

## real-host-golden
Still red under concurrent machine load (`AttachLocatorMismatch` cascade) with and without ambient `HIVE_HOME`; documented override requirement in `real-host-golden.zig` + `test.sh`. Not attributed to #40 claim path (locator mismatch is pre-claim attach). Henrietta main-vs-pin comparison is the authority for golden.

## Dropped
`21c2a809` #47 NSLog instrumentation removed from pin per henrietta ruling.
