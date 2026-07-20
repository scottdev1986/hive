# #40 live claim drop-reattach (43119)

## Setup
- Port 43119, `SHELL=/tmp/hulda-ls-shell`, home `/tmp/hb22-b45d` (and re-runs)
- Binary: sessiond ReleaseFast with onViewerDetached + claim resume; Workspace debug with releaseClaimBestEffort
- Opt-in: `HIVE_B22_PROOF_HOME=… HIVE_B22_REAL_SHELL=1 swift test --filter LiveHostAttachTests/testLiveClaimUncleanDropThenHumanResumeTypes`

## GREEN (2026-07-19)
Log `/tmp/hulda-claim-live-green2.log` / final run:

```
hive claim: granted token=claim_f46ee… viewer=claim-drop-a-706811
# unclean transportA.close() — no CLAIM_RELEASE
hive claim: granted token=claim_6e221… viewer=claim-drop-b-706811
# INPUT APPLIED written-to-terminal for viewer-b
Test Case …testLiveClaimUncleanDropThenHumanResumeTypes passed
```

## Never-steal (unit)
session_host test asserts automation denied while HUMAN_ORPHANED; concurrent second claim denied while active_claim held.

## Unit suite
sessiond 199/199; AttachInputTests release cancel frame GREEN.
