# Cross-vendor review of horst `68927396` (#47 draw-path fix)

**Reviewer:** hulda (wire half; pin `02bb827d` preserved as reference)  
**Subject:** `689273961c493c626d6a9242a8b1511b85fc2161`  
`fix(terminal): bootstrap first visible IOSurface frame`  
**Verdict:** **PASS** — land-ready for #47  

## Design (verified in source)

```swift
// synchronizeOcclusion
let visible = window.occlusionState.contains(.visible) ||
    (!hasCompletedInitialDraw && window.isVisible && !window.isMiniaturized)

// after engine.draw() in scheduled work item
if !self.hasCompletedInitialDraw {
    self.hasCompletedInitialDraw = true
    self.synchronizeOcclusion()  // immediate resync to real bit
}
```

One bootstrap frame only while the window is AppKit-visible and non-miniaturized,
then thrift returns to true occlusion. Composition stack:

```
ef25d41d (main)
aae55865 hattie settle present-anyway
3c52a808 hattie prepareThemeBeforeAttach
68927396 horst bootstrap gate  ← under review
```

## Controls (measured on this machine)

| Check | Result |
|---|---|
| Gate7RenderingTests full | **18 executed, 1 skip (physical multi-display), 0 failures** |
| `testVisibleWindowBootstrapsOneFrameWhenInitialOcclusionStateIsStale` | **PASS** — one bootstrap draw; second invalidate suppressed; real `.visible` releases pending |
| `testMiniaturizedWindowNeverUsesInitialVisibilityBootstrap` | **PASS** — drawCount=0, occlusion stays false |
| `testOcclusionSuppressesDrawAndPresentsOnePendingFrameWhenVisible` | **PASS** — thrift baseline intact |
| `testRealOutputProducesGPUBackedLayerContents` | **PASS** — real Ghostty textures layer |
| `testRenderingStateForwardsScaleDisplayAndOcclusionToEngine` | **PASS** — forwarding still bites |

Horst's three reverse-control holes on `02bb827d` are closed by this design:

1. Second INVALIDATE while real occlusion false → suppressed after bootstrap resync.  
2. `isVisible=false` attach → no bootstrap.  
3. Miniaturized-at-attach → no bootstrap.

## Live GREEN (my hubert recipe, no force)

```text
DEMO_PORT=43119 SHELL=/tmp/hulda-ls-shell make terminal
home: /tmp/hb22-7995
pin binary: workspace/.build/debug/HiveWorkspace @ 68927396
```

Window capture shows full `ls -1` listing, wrapper banner, and login prompt  
(`/tmp/hulda-horst-review-terminal-crop.png`). Pixel check: right-pane  
`light>80 = 2.17%`, `maxlum=235` (matches my prior GREEN density; hattie blank  
was ~0.77% / maxlum 164). No harness forced the occlusion bit.

## Stuck-state attack (my recovery clause)

My `02bb827d` recovery was: `highWater > 0 && drawScheduledCount == 0` force  
engine-visible and allow present even when truly hidden/minimized.

Under `68927396` that force is **unnecessary for the measured #47 blank**:

- Default `appliedOcclusionVisible == nil` already leaves `canPresent` open.  
- When the window is `isVisible && !isMiniaturized` with a stale occlusion bit,  
  bootstrap sets engine visible **before/with** first draw, then resyncs.  
- Live hubert recipe proves content + texture without permanent force.  
- True hidden/minimized correctly refuse bootstrap — the three failures  
  horst found on my pin.

**Unreachable as a permanent #47 blank** under his bootstrap on the CLI attach  
path we both used: attach follows geometry-ready after the window is ordered  
front; `viewDidMoveToWindow` / occlusion sync run before journal.

**Non-blocking residual:** if `isVisible` flipped true *after* attach without  
any later `synchronizeOcclusion` call, bootstrap could miss. Not observed on  
the hubert recipe; not a land blocker.

## My `testOccludedAttachWithContentPresentsOneFrame`

Not present on this pin. Its scenario (content while AppKit occlusion lacks  
`.visible`) is covered by  
`testVisibleWindowBootstrapsOneFrameWhenInitialOcclusionStateIsStale` with a  
stricter thrift guarantee (post-draw resync). No need to port the recovery test.

## Instrumentation `f0fe8663`

Diagnostic NSLogs at processOutput / invalidate / draw-gate. Useful for the  
hunt; not required for the fix. **Optional separate land** if desired; does  
not block #47. Prefer not to ship verbose production NSLogs without a debug  
flag.

## Composition with hattie

Settle present-anyway + pre-attach theme are parents of `68927396`. Theme  
does **not** force occlusion (correct). Settle schedules draw; bootstrap  
admits one frame. Clean stack.

## Verdict

**PASS** — land `68927396` (and its hattie parents if not already on main) for  
#47. My `02bb827d` stays preserved as reference only; do not land it.  
After land: pivot to #40 claimRelease as previously assigned.
