# Ghostty manual surface — Gates 3 and 7 qualification evidence

Status: implementation and automated live-engine corpus green on the authoring
host. Automatable physical-slice evidence is attached at
`raw/qualification/ghostty-b1-gate7-physical/` (runner
`scripts/qualify-ghostty-gate7-physical.sh`, prose
`workspace/docs/ghostty-gate7-physical-live-proof.md`): Instruments (Time
Profiler, Allocations, Activity Monitor energy-adjacent, Leaks), serial rapid
churn, occlusion window-ordering attempt, AppKit/Metal main-thread admission,
and GPU-fault honesty scope. Human dual-display Retina/non-Retina drag and
real sleep/wake remain OPEN (`STATUS=PENDING_HUMAN` slots). This document
deliberately does not turn a simulated notification or a one-display machine
into dual-display or sleep proof.

## Primary-source contract

The pinned Ghostty macOS surface wrapper makes its surface API main-actor
isolated, and its wakeup callback always enqueues an app tick on the main queue:
[Surface wrapper](https://raw.githubusercontent.com/ghostty-org/ghostty/73534c4680a809398b396c94ac7f12fcccb7963d/macos/Sources/Ghostty/Ghostty.Surface.swift),
[app wakeup](https://raw.githubusercontent.com/ghostty-org/ghostty/73534c4680a809398b396c94ac7f12fcccb7963d/macos/Sources/Ghostty/Ghostty.App.swift).
Apple likewise restricts event handling and the main event loop to the main
thread in its [Cocoa thread-safety summary](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/Multithreading/ThreadSafetySummary/ThreadSafetySummary.html).

`ghostty_init` is process-global, not per surface. The pinned implementation
unconditionally initializes `global.state`, whose definition says only one may
exist at a time: [C entry](https://raw.githubusercontent.com/ghostty-org/ghostty/73534c4680a809398b396c94ac7f12fcccb7963d/src/main_c.zig),
[global state](https://raw.githubusercontent.com/ghostty-org/ghostty/73534c4680a809398b396c94ac7f12fcccb7963d/src/global.zig).
The bridge therefore initializes it once on the main operation domain and
checks the result. The snapshot's per-surface call and “idempotent” comment were
incorrect; ThreadSanitizer made the resulting repeated global initialization
observable.

For rendering, Apple defines a `CAMetalLayer` drawable size in physical pixels,
normally derived from bounds times content scale:
[drawableSize](https://developer.apple.com/tutorials/data/documentation/quartzcore/cametallayer/drawablesize.json).
That is the pixel-size semantic reference, not the layer type in the pinned
engine. Ghostty's Metal renderer installs its own IOSurface-backed `CALayer` on
the supplied `NSView`:
[pinned Metal renderer](https://raw.githubusercontent.com/ghostty-org/ghostty/73534c4680a809398b396c94ac7f12fcccb7963d/src/renderer/Metal.zig).
Gate 7 therefore qualifies the real IOSurface layer, backing-pixel surface
size, layer `contentsScale`, and display-link ID. It does not add an unused
`CAMetalLayer` merely to satisfy a type name.

AppKit emits a screen-change notification when a window moves between screens,
and workspace wake notifications are delivered through the workspace
notification center:
[screen change](https://developer.apple.com/tutorials/data/documentation/appkit/nswindow/didchangescreennotification.json),
[wake](https://developer.apple.com/tutorials/data/documentation/appkit/nsworkspace/didwakenotification.json).

## Gate 3 frozen behavior

- All AppKit, Metal, Ghostty app, and Ghostty surface entry points are admitted
  to the main queue. There is no second Swift operation lock that can invert
  against Ghostty's renderer mutex.
- Output and checkpoint restore are the only off-main ingress. Each forces an
  independent byte copy before synchronously entering the main operation
  domain. Native ordered-output classification, ledger commit, parser effects,
  and replies remain one renderer-mutex transaction.
- Native write, event, and renderer-health callbacks copy only. They never
  call `main.sync`, free, draw, restore, or re-enter Ghostty. Host delivery is
  deferred to main after the C callback returns.
- Free closes callback admission, waits for an active copy callback, removes
  the surface from health routing, serializes after any admitted operation,
  frees the surface, then releases/frees app and config in that order. Queued
  callback deliveries self-drop after admission closes.
- A wakeup always enqueues `ghostty_app_tick`; a tick already in flight
  completes before app free, and no queued tick observes an app after free.
- Multiple manual surfaces may coexist; callbacks and renderer health remain
  surface-scoped, and freeing one does not affect another. The current factory
  retains one app owner per surface. Process-global Ghostty initialization
  happens exactly once; rapid surface create/free does not reinitialize it.

Main admission is an API/lifetime guarantee, not a claim that all native
semantic-state mutation occurs on the main thread. A manual surface still
starts Ghostty's renderer and termio workers. The termio worker applies queued
resize, clear, viewport-scroll, and prompt-jump messages under
`renderer_state.mutex`, while the renderer worker may scroll the viewport to
the bottom during frame-state extraction:
[surface/thread startup](https://raw.githubusercontent.com/ghostty-org/ghostty/73534c4680a809398b396c94ac7f12fcccb7963d/src/Surface.zig),
[termio worker](https://raw.githubusercontent.com/ghostty-org/ghostty/73534c4680a809398b396c94ac7f12fcccb7963d/src/termio/Thread.zig),
[termio mutations](https://raw.githubusercontent.com/ghostty-org/ghostty/73534c4680a809398b396c94ac7f12fcccb7963d/src/termio/Termio.zig),
[renderer viewport mutation](https://raw.githubusercontent.com/ghostty-org/ghostty/73534c4680a809398b396c94ac7f12fcccb7963d/src/renderer/generic.zig).
The stock text and selection reads each take a separate renderer-mutex critical
section, IME point releases that mutex between cursor and geometry reads, and
surface size is not covered by the same critical section:
[embedded C API](https://raw.githubusercontent.com/ghostty-org/ghostty/73534c4680a809398b396c94ac7f12fcccb7963d/src/apprt/embedded.zig),
[IME calculation](https://raw.githubusercontent.com/ghostty-org/ghostty/73534c4680a809398b396c94ac7f12fcccb7963d/src/Surface.zig).
Consequently, several stock calls made synchronously in one `@MainActor` turn
do **not** form one immutable semantic snapshot: a native worker may mutate
between them. Gate 10 must use a native atomic-snapshot operation if it needs
that stronger consistency; a Swift-only generation cannot certify it.

## Gate 7 frozen behavior

- Surface creation starts at neutral 1× only when no window scale exists.
  Window attachment, backing-property change, and screen move all reapply the
  actual x/y content scale, physical framebuffer size, display ID, IOSurface
  layer scale, and occlusion.
- Every distinct nonzero live-resize framebuffer reaches Ghostty immediately.
  Only the outbound host resize frame is quiescence-coalesced. Zero/minimized
  geometry cancels that pending frame and never commits stale pixels.
- Rows, columns, pixel size, and cell size come only from
  `ghostty_surface_size` after resize. There is no font-based or pixel-division
  fallback.
- INVALIDATE is the only call path to `ghostty_surface_draw`. Requests
  coalesce to one main-queue item. `NSView.draw(_:)` never calls Ghostty.
  Zero-size, sleeping, occluded, closed, and renderer-unhealthy views retain at
  most one pending frame and submit none; visibility or HEALTHY recovery
  presents that one frame.
- Sleep is observed on `NSWorkspace.shared.notificationCenter`, suspends draw,
  and marks the surface occluded. Wake reapplies scale/display/size/occlusion,
  calls refresh once, and permits one pending frame.
- Renderer HEALTHY/UNHEALTHY actions are routed by target surface without a C
  call from inside the action callback. UNHEALTHY suspends submission; HEALTHY
  resynchronizes and refreshes.

True device-loss replacement is intentionally above this view. The agreed
Gate 6/B2 order is: close old-surface admission; create a fresh same-architecture
surface; atomically restore sessiond's last exported checkpoint; replay
sessiond's retained output from the checkpoint `through_seq`; reconcile the
real current geometry/config after restore; then draw the first fully restored
frame. The dying app surface has no checkpoint-export API, and a failed restore
must leave the fresh initial state invisible rather than draw partial state.

## Combined Gate 2/3 integration hold

`Gate6SurfaceRestoreTests/testEveryLibVtAuthoredSplitRestoresIntoRealSurface`
(the 187 checkpoint split snapshots) is an explicit `XCTSkip` in the combined
tree. It passes on unmodified main under synchronous callback delivery. Gate 3
requires the test to pump deferred main-queue delivery: without that pump the
reply snapshots are empty, while adding the pump exposes a latent Gate 6 native
checkpoint use-after-move during the queued app tick. Gate 6 owns both the
checkpoint fix and re-enabling/proving this corpus under async delivery.

## Recorded authoring-host runs (2026-07-18)

Host: Apple M4 Max, macOS 26.3.1 (25D2128), Xcode 26.6 (17F113), Swift
6.3.3. `system_profiler SPDisplaysDataType -json` reported one online built-in
Retina display: 3456×2234 physical pixels, 1728×1117 logical points at 120 Hz.

| Run | Result |
|---|---|
| Combined unfiltered package bundle (arm64 `swift test`; x86_64 universal `xctest` under Rosetta) | each architecture executed 307 tests; 2 explicit skips, 0 failures |
| Combined `swift build --build-tests`, arm64 and x86_64 | both exit 0 |
| Combined unfiltered TSan bundle, arm64 and x86_64 (`report_thread_leaks=0`, `halt_on_error=1`) | each architecture executed 307 tests; 2 explicit skips, 0 failures; no data-race report |
| Combined unfiltered ASan bundle, arm64 and x86_64 (`halt_on_error=1`) | each architecture executed 307 tests; 2 explicit skips, 0 failures; no address-safety report |
| Focused unsanitized Gate 3/7/link corpus after fixes | 42 tests executed; 41 passed, 1 physical-hardware test skipped, 0 failures |
| Raw ThreadSanitizer rapid-create run before fix | repeated process-global-init thread warnings, including one per rapid create; this run caught the false idempotence assumption |
| Raw ThreadSanitizer rapid-create run after fix | 4 tests passed; warnings reduced to one process-lifetime GlobalState thread at xctest exit |
| `TSAN_OPTIONS=report_thread_leaks=0:halt_on_error=1 swift test --sanitize=thread --filter 'AppWakeupLifecycleTests\|CallbackDisciplineTests\|Gate3ConcurrentCreationTests\|Gate3OperationDomainTests\|Gate7RenderingTests'` | 37 tests executed; 36 passed, 1 physical-hardware test skipped; no data-race report |
| Targeted ThreadSanitizer callback-copy/free and output/free races after the final callback counter fix | 2 tests passed; no data-race report |
| `ASAN_OPTIONS=halt_on_error=1 swift test --sanitize=address --filter 'AppWakeupLifecycleTests\|CallbackDisciplineTests\|Gate3ConcurrentCreationTests\|Gate3OperationDomainTests\|Gate7RenderingTests'` | 37 tests executed; 36 passed, 1 physical-hardware test skipped; no address-safety report |
| Targeted AddressSanitizer callback-copy/free and two-surface health routing after the final callback counter fix | 2 tests passed; no address-safety report |
| ASAN leak detection | unavailable: Apple's sanitizer aborted with “detect_leaks is not supported on this platform”; this is not recorded as leak proof |

The single remaining raw-TSAN exit warning belongs to Ghostty's process-global
state, which has no public deinitializer. It is not multiplied by surface
create/free after the fix, but it remains an Instruments review item rather
than being suppressed into a leak pass.

## Frozen-pin physical review hold

### Automatable slice — GREEN (attached)

Runner: `scripts/qualify-ghostty-gate7-physical.sh`  
Evidence: `raw/qualification/ghostty-b1-gate7-physical/`  
Prose: `workspace/docs/ghostty-gate7-physical-live-proof.md`

| Item | Slot / artifact | Status |
|---|---|---|
| Gate7RenderingTests corpus | `corpus-gate7.txt` | GREEN (16 exec, 1 physical skip, 0 fail) |
| AppKit/Metal main-thread (Gate 3 row E handoff) | `main-thread-admission.txt` | GREEN |
| Idle / live-resize / serial rapid-churn | protocol + `rapid-churn.txt` | GREEN (20 serial cycles; no SIGKILL) |
| Occlusion via window ordering | `occlusion-window-ordering.txt` | ATTEMPTED (AppKit bit did not flip on this desktop; controlled-occlusion corpus still covers host gate) |
| Instruments Time Profiler | `instruments-time-profiler-summary.txt` | GREEN (probe exit 0 under xctrace) |
| Instruments Allocations | `instruments-allocations-summary.txt` | GREEN |
| Instruments Energy (Mac) | `instruments-power-energy-summary.txt` | GREEN via **Activity Monitor** — Power Profiler is iOS/iPadOS-only on this Xcode (measured) |
| Instruments Leaks | `instruments-leaks-summary.txt` | GREEN |
| GPU/device-fault recovery | `gpu-device-fault-scope.txt` | HOST_CONTRACT GREEN; HARDWARE_FAULT / B2 replacement OPEN (no device-recreation API; IOSurfaceLayer not CAMetalLayer) |
| Debug↔ReleaseFast fence note | `engine-fence-note.txt` | recorded (sessiond-coupled runs only) |

### Human-required slice — OPEN

Scripted checklist (exact steps + capture slots):
`raw/qualification/ghostty-b1-gate7-physical/human-checklist.txt`

On a Mac with one Retina and one non-Retina display, run:

```sh
cd workspace
HIVE_GHOSTTY_GATE7_PHYSICAL=1 \
HIVE_GHOSTTY_GATE7_PHYSICAL_SLEEP=1 \
swift test --filter Gate7RenderingTests/testPhysicalMonitorScaleAndSleepWakeQualification
```

The opt-in test opens the real Ghostty view and fails unless a reviewer moves
it to a different display ID and scale within the prompt window. It asserts
backing pixel size, reported geometry, and two seconds of idle frame silence,
then waits for a real sleep/wake transition. Default CI skips this test instead
of manufacturing the missing hardware state.

| Human slot | Capture |
|---|---|
| `human-dual-display-inventory.txt` | `system_profiler SPDisplaysDataType` with two online non-mirrored displays of different scale |
| `human-dual-display-transcript.txt` | full opt-in swift test transcript after successful drag |
| `human-sleep-wake-transcript.txt` | full opt-in transcript with `PHYSICAL_SLEEP=1` after real sleep/wake |

Until the human slots no longer say `STATUS=PENDING_HUMAN`, dual-display and
real-sleep rows of the physical F/I matrix are **not fully green**. HOLD for
cross-vendor review — do not land until queen clears.
