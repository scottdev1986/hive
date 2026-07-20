# Blank pane with full journal (hattie) — first cut

## Symptom (hubert, /tmp/hb22-0fee)
Fresh `make terminal` with known-good ls pre-shell: journal contains CRLF
`ls -1` bytes, visibility renews, Workspace stderr shows only HTTP 409 + C1
theme apply — green terminal pane stays blank for >30s. Separate from OPOST
staircase (journal already correct).

## Root cause (code path)
After attach returns `.firstCorrectFrame`, `HiveTerminalView.prepareFirstCorrectFrame`
defers going live until C1 config geometry settles (`finalizeFirstCorrectFrameWhenConfigurationSettles`).

Two silent failure modes left the pane blank with **no recovery**:

1. **Settle timeout (bfc49d1c fail-closed):** set `rendererFailed("C1 config geometry did not settle")` with **no NSLog**. SessiondPaneTerminal already treated attach as success (outcome was firstCorrectFrame) and started the pump — it does **not** recover from later settle failure.
2. **Guard abort:** if `surfaceState != .attaching` when the deferred settle runs, the function `return`ed with no present and no log — stuck forever.

HTTP 409 is unrelated (harness owns visibility; Workspace publish races).

## Fix
In `HiveTerminalView.finalizeFirstCorrectFrameWhenConfigurationSettles`:
- On settle timeout: **present anyway** with best-known geometry (blank worse than briefly-wrong grid); NSLog reported vs semantic sizes.
- On guard abort when not live: present fallback + NSLog.
- Log initial-resize failures.

## Live proof
Environment on this machine was contaminated by multiple leaked `hive-sessiond serve` processes during re-proof (broker died mid-create). Code fix + unit compile green. Reviewer should re-run clean `make terminal` with exclusive 43117.
