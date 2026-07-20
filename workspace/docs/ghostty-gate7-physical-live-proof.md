# M1-B1 Gate 7 — rendering / geometry / GPU: physical-slice live proof

Story: `planning/story-m1-b1-ghosttykit-qualification.md` gate 7 + live-proof
matrix rows F (multi-display geometry/scale) and I (GPU/sleep/occlusion/perf).

Runner: `scripts/qualify-ghostty-gate7-physical.sh`  
Evidence: `raw/qualification/ghostty-b1-gate7-physical/`  
Probe: `workspace/Tests/GhosttyGate7Probe`  
Corpus: `Gate7RenderingTests` (physical multi-display test skipped by default)

Automated renderer/geometry corpus was already landed (`7ba111e6`, `655c9c1c`,
`e6d5413c`). This package attaches the **automatable physical-slice** artifacts
and leaves **human dual-display + sleep/wake** as explicit PENDING slots.

## Pin / binding

Same fail-closed artifact binding as Gate 3:

- all 16 `artifact-manifest.json` source/toolchain fields ==
  `native/toolchain-lock.json`
- macOS library sha256 == manifest record
- three positive controls bite (`missing-manifest`, `tampered-patched-tree`,
  `swapped-library`)

Pinned Ghostty: `73534c4680a809398b396c94ac7f12fcccb7963d`.

## What the automatable pass measures

| Stage / artifact | Claim | Result |
|---|---|---|
| `corpus-gate7.txt` | Gate7RenderingTests (incl. health, sleep *notification*, controlled occlusion, IOSurfaceLayer) | 16 executed, 1 skipped (physical multi-display), 0 failures |
| `main-thread-admission` | AppKit/Metal main-thread proof deferred from Gate 3 row E: create / present / free of a real IOSurface surface on main | derived `pthread_main_np` + `Thread.isMainThread` at call sites (no `onMain` helper); `layerClass` read back from live layer, not a literal |
| `idle` | Idle surface schedules no frames without INVALIDATE | 2s silence, 0 idle draws; contents presented |
| `live-resize` | Geometry from `ghostty_surface_size` after distinct framebuffers | 3 size commits; non-zero rows/cols/cell geometry |
| `occlusion-window-order` | Real NSWindow ordering attempted; host gate when occluded=false | Ordering attempted; on this desktop AppKit did not flip the bit under cover (honest note); controlled-occlusion corpus still covers the host gate |
| `rapid-churn` | 20 **serial** create/use/free cycles, clean teardown | 20/20 complete; concurrent=false; sigkill=false |
| Instruments Time Profiler | Live probe under xctrace | exit 0; probe exit(0); TOC exported |
| Instruments Allocations | Live probe under xctrace (leak/UAF hunting companion) | exit 0; probe exit(0); TOC exported |
| Instruments Energy | Power Profiler **measured negative control** + Activity Monitor positive | non-zero exit + stderr recorded; then Activity Monitor exit 0 |
| Instruments Leaks | Live probe under xctrace | exit 0; probe exit(0); TOC exported |
| `gpu-device-fault-scope.txt` | Honesty scope for device-loss recovery | HOST_CONTRACT green; HARDWARE_FAULT / B2 replacement OPEN |

### Energy template note (measured, not prose-only)

The runner **attempts** `xctrace record --template 'Power Profiler'` once and
writes the real `exit_status` + stdout/stderr into
`instruments-power-energy-summary.txt` as `measured_negative_control`. It
requires a non-zero exit and a macOS-unsupported / iOS-or-iPadOS message; a
surprise exit 0 fails the run. The Mac energy-adjacent **positive** pass is
then **Activity Monitor** in the same summary file. Classic Energy Log is
likewise not a Mac-host standard template.

### Hazards enforced (not papered over)

1. Manual surface creation fills a **process-global backend slot** — concurrent
   creation can null. Churn is serial on main only.
2. **SIGKILL** of a live surface test leaks GPU resources. The probe and
   runner always tear down with `userClose()` / process exit(0); never kill -9.
3. Debug-vs-ReleaseFast sessiond fence is out of band for this pure-renderer
   slice; `engine-fence-note.txt` records the rule for later sessiond-coupled
   runs.

## GPU / device-fault recovery — what is and is not provable

Pinned Ghostty Metal installs its own **IOSurface-backed CALayer**, not a
host-owned `CAMetalLayer`, and exposes **no device-recreation API**.

| Provable now | Not inventable here |
|---|---|
| UNHEALTHY suspends draws; HEALTHY resyncs + one pending frame | In-process MTLDevice recreation |
| Health is surface-scoped | Hardware GPU disconnect event at the Metal stack |
| Host suspension gates (sleep notification, occluded, zero-size, closed) | Full surface replacement without Gate 6/B2 checkpoint orchestration |

Replacement path (Gate 6/B2 ownership): close old admission → create fresh
same-architecture surface → restore sessiond checkpoint → replay from
`through_seq` → reconcile geometry → first fully restored frame.

## Restored prior requirements (still OPEN — not silently narrowed)

| Item | Status |
|---|---|
| Instruments while minimized and after wake | OPEN — human checklist §C / sleep-wake path |
| Address Sanitizer across multi-surface + rapid create/free | OPEN for this package (prior authoring-host ASAN rows exist in the gates 3/7 evidence doc; not re-run here) |

## Human-required rows (still OPEN)

Scripted checklist: `raw/qualification/ghostty-b1-gate7-physical/human-checklist.txt`

| Slot | Status |
|---|---|
| `human-dual-display-inventory.txt` | `STATUS=PENDING_HUMAN` |
| `human-dual-display-transcript.txt` | `STATUS=PENDING_HUMAN` |
| `human-sleep-wake-transcript.txt` | `STATUS=PENDING_HUMAN` |

These cannot be automated on a single-display host and must not be simulated.
Until filled, matrix rows F (real dual-display) and I (real sleep/wake) remain
partially open even though the automatable Instruments / churn / main-thread /
host-contract work is green.

## Hold

**No `hive_land` until queen clears after cross-vendor review.** Human slots
must be filled (or explicitly waived by queen) before the physical F/I rows
are fully green.
