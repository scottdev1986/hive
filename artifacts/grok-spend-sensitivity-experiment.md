# Grok creditUsagePercent spend-sensitivity experiment (2026-07-13)

Agent: denise. CLI: grok 0.2.99. Method: `_x.ai/billing` via `grok agent stdio`.

## Timeline

| When | creditUsagePercent | Money rails | Notes |
|------|-------------------|-------------|-------|
| Earlier same day | 2.0, 3.0, 4.0 | all val=0 | During sustained Hive Grok agent work |
| BEFORE (10:04:50 -0400) | **7.0** | all val=0 | Full precision float 7.0 |
| Burn A (10:05:09–10:05:41) | — | — | 2 headless sessions, 6 modelCalls, ~85k tokens |
| AFTER +0/+15/+45s | **7.0** | all val=0 | No immediate tick |
| Probe-only control ×3 | **7.0** | all val=0 | Probe does not bill/move |
| AFTER ~+5 min (10:10:05) | **8.0** | all val=0 | **MOVED** after lag |
| Burn B (10:12–10:13) | — | — | 3 headless sessions, 12 modelCalls, ~202k tokens |
| AFTER bigburn +0/+2/+5 min | **8.0** | all val=0 | No further integer tick within 5 min |

## Verdict

**REAL GAUGE** of SuperGrok weekly plan usage.

- Moves with Grok Build spend (7.0 → 8.0 after Burn A; long series 2→8).
- Not a money-credit fraction: prepaid/onDemand stayed 0 while percent climbed.
- Absolute denominator not on wire; percent of subscription weekly pool (FAQ-aligned).
- `currentPeriod` weekly start/end stable → single weekly window model.
- Probe session-free, non-billable (control stable).
- Caveats: multi-minute lag; coarse integer percent.

## For routing (declan)

Grok is **metered** (readable weekly gauge), not not-metered and not read-failed.
Five-hour is **not-metered** (absent on wire). Weekly is **available/metered** when percent present.
