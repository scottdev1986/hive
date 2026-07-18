# M1-B1 Gates 3 & 7 — cross-vendor review (eamon, Claude/Opus 4.8)

Author under review: dominic (Codex/gpt-5.6-sol). Reviewed at FROZEN pin
`7ba111e6346b4ffd005f2019eff5bb3f0d11b3f2`. HEAD confirmed unmoved in both
dominic's worktree and the reviewer's pristine detached checkout at the start
and end of review. No file under review was edited on dominic's branch.

**VERDICT: NO-LAND** — for the author's own documented physical-hardware hold
(F/I matrix rows), plus one test-discrimination gap (F1). The reviewed *logic*
is correct on every axis I could verify by build and run; this is not a
rejection of the design.

## Reproduction method

Pristine detached worktree at the pin in scratch; `workspace/Vendor/
GhosttyKit.xcframework` cloned from dominic's build output and hash-verified
identical (`b5685986…e922fd7`). All exit codes read directly, never through a
pipe.

| Check | Claimed | Reproduced | Real exit |
|---|---|---|---|
| `swift build --build-tests` | green | green | **0** |
| Focused Gate3/7/link corpus | 42 exec, 41 pass, 1 skip | 42 exec, 41 pass, 1 skip, 0 fail | **0** |
| TSan (5 Gate classes) | "35 passed", no race | 37 exec, 1 skip, 0 race reports | **0** |
| ASan (5 Gate classes) | "35 passed", no report | 37 exec, 1 skip, 0 address reports | **0** |

Sanitizer *executed* counts are 37, not the doc's 35 — cosmetic drift in the
evidence table, not a discrepancy in outcome. Worth correcting for accuracy.

## Gate 3 — threading / event loop / lifetime: VERIFIED

- **Exactly-once process-global `ghostty_init`.** `ensureGlobalInitializedOnMain`
  (ManualSurface.swift:946) is main-queue-confined via `dispatchPrecondition`
  and guarded by `globalInitialized`. It is process-once, not per-surface.
- **Single tick site.** `grep` confirms the module's only real
  `ghostty_app_tick` call is inside `scheduleTick`'s deferred main-queue
  closure (ManualSurface.swift:540). The always-defer rationale (re-entrancy
  via `App.Mailbox.push` invoking `wakeup_cb` synchronously on the pushing
  thread) is correct and matches the pinned macOS app's own behavior.
- **Copy-before-return.** `handleWrite`/`handleEvent` copy under an admitted
  refcount scope and defer host delivery to main; no host code and no Ghostty
  re-entry inside the C callback.
- **Free ordering.** `free()` → `beginTeardown` → unregister → nil handle →
  `ghostty_surface_free` → release app owner (`ghostty_app_free` then
  `ghostty_config_free`). Surface-before-app-before-config is correct.
- **No callback after free.** `enter()` checks admission and increments under
  one lock; deferred deliveries re-check `acceptingCallbacks` and self-drop.

## Gate 7 — rendering / geometry / GPU: VERIFIED

- **Real layer, not a fabricated `CAMetalLayer`.** `ghosttyRenderingLayer` is
  `renderHostView?.layer` — the layer pinned Ghostty installs itself. Matches
  verified repo memory `ghostty-renderer-uses-iosurfacelayer-no-device-recreation-api`.
  No unused CAMetalLayer was added to satisfy a type name.
- **Ghostty-reported geometry only.** Rows/columns/pixel/cell all come from
  `ghostty_surface_size` (ManualSurface.swift:341). No font-based or
  pixel-division fallback exists in the module.
- **One draw path.** The module's only `ghostty_surface_draw` call site is
  ManualSurface.swift:355, reached solely through the coalesced INVALIDATE
  path. `draw(_:)` is inert.
- **Suspension gating.** `canPresentGhosttyFrame` covers closed, unhealthy,
  suspended, zero-size, and occluded; recovery presents at most one pending frame.
- **Device recreation correctly NOT invented locally** — deferred to
  Gate 6/B2 checkpoint orchestration, consistent with the pinned engine
  exposing no device-recreation API.

## Gate-10 atomicity analysis: ACCURATE

Verified all three claims against the pinned Ghostty tree
(`73534c4680a809398b396c94ac7f12fcccb7963d`):

1. `ghostty_surface_read_selection` and `ghostty_surface_read_text`
   (`src/apprt/embedded.zig`) each take their **own** `renderer_state.mutex`
   lock with `defer` unlock — two consecutive Swift calls are two separate
   critical sections.
2. `imePoint` (`src/Surface.zig:2104`) unlocks at line 2108, **then** reads
   `self.size.cell.width` / `self.size.padding` — geometry is read outside the
   mutex, exactly as claimed.
3. `ghostty_surface_size` (`embedded.zig:2063`) takes **no lock at all**.

The conclusion — that several stock reads in one `@MainActor` turn do not form
one immutable semantic snapshot, and that Gate 10 needs a native atomic-snapshot
operation — is correct and correctly scoped.

## Honesty audit: PASSES

The physical two-display / sleep / GPU-fault / Instruments rows are honestly
labeled not-green and pending. The skipped test is a genuine `XCTSkip`
("requires interactive multi-display qualification hardware"), not a
fabricated pass. The doc declines to record the ASan leak run as leak proof
because Apple's `detect_leaks` is unsupported, and declines to suppress the
residual process-global TSan thread. The evidence doc states plainly that the
branch must not land until the physical artifacts are attached. This is the
standard the project asks for.

## Positive controls (proving the corpus discriminates)

| # | Mutation | Result |
|---|---|---|
| PC1 | Removed the `globalInitialized` guard | **RED**, exit 1 — "single process-global state must never be reinitialized per surface" (14 inits vs 1) |
| PC2 | Made `draw(_:)` call `engine.draw()` | **RED**, exit 1 — 5 failures incl. explicit double-draw, occlusion, sleep guards |
| PC3 | Deleted the in-flight-callback wait in `beginTeardown` | **GREEN** — see F1 |

Tree restored after every control; all three source hashes re-verified against
the pristine pin blobs and `git status` clean.

## F1 — the teardown wait is load-bearing but unguarded (fix before land)

`BridgeCallbackContext.beginTeardown` blocks on
`while activeCallbacks > 0 { condition.wait() }`. This is the single mechanism
preventing `ghostty_surface_free` from running while a native worker is still
inside a callback copy — the core of Gate 3's "no callback after free" claim.

Deleting those three lines leaves the **full 42-test corpus green (exit 0) and
TSan green with zero warnings (exit 0)**.

`testSurfaceFreeWaitsForCallbackCopyAlreadyInFlight`
(CallbackDisciplineTests.swift:128) is named for the ordering but asserts only
`XCTAssertNil(surface.surfaceHandle)` and `deliveries == 0`. Both hold whether
or not free waited: the deferred delivery re-checks `acceptingCallbacks` and
drops on its own. The test measures *that delivery dropped* (an act) as a proxy
for *that free waited* (the state) — and the fault it is named for cannot
surface in its setup, because the byte buffer is test-owned and the context is
retained by the test's own `surface` variable.

Consequence for the evidence doc: the cited "targeted ThreadSanitizer
callback-copy/free … 2 tests passed" row does not discriminate on this
guarantee, so it overclaims as evidence for the wait.

**Production code is correct as written** — this is a coverage gap, not a live
defect. Suggested closure: assert the ordering directly, e.g. record a
timestamp/sequence when the copy observer returns and when `free()` returns and
assert the copy completes first, so deleting the wait turns the test red.

## What still blocks land

1. The author's own hold: two-display inventory + opt-in transcript,
   Instruments idle/resize/minimized/occluded/wake evidence, Allocations/ASan
   across multi-surface and rapid create/free, and a real GPU-fault or
   hardware-disconnect run. Gate 7 explicitly requires these; they are pending
   hardware, not pending work.
2. F1 above.
3. Cosmetic: correct the 35 → 37 sanitizer executed counts.

Neither 1 nor 2 impugns the logic. On the axes verifiable by build and run at
this pin, Gates 3 and 7 are sound.
