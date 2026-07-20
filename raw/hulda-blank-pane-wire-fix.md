# Blank pane #47 — wire/settle half (hulda continues hattie)

## Symptom (hubert recipe)

Fresh `make terminal` with known-good `ls -1` pre-shell: journal has CRLF
bytes, semantic grid asserts text, green pane stays blank. Separate from
OPOST staircase (journal already correct).

## Hattie WIP salvaged (already committed on this branch)

1. Settle timeout → present-anyway + NSLog (`4a3f1bf1` cherry-pick of f413c03c)
2. `prepareThemeBeforeAttach` before HOST_ATTACH (`1e2fe9a4` cherry-pick of 963a6f35)

Those removed two blank-makers but were **not** THE blank-maker on this machine.

## Root cause (measured)

`processOutput` → `HiveManual.process` **does** emit `HIVE_GHOSTTY_EVENT_INVALIDATE`
and the view **does** receive it. The host draw gate then blocked forever:

```
processOutput ok n=1 bytes=447
invalidate n=1 gate=occlusion-hidden
draw-gate blocked reason=occlusion-hidden
first-correct-frame … draws=0 gateBlocked=1 occlusion=hidden
```

AppKit reported the window occluded during attach (and the unocclusion
notification never flipped our applied state in time). Two consequences:

1. `canPresentGhosttyFrame` refused all host `scheduleDraw` work → `draws=0`.
2. `engine.setOcclusion(false)` made Ghostty's render thread skip
   `updateFrame`/cell rebuild. Even a host `ghostty_surface_draw` against an
   invisible engine textures only the empty cell buffer (howard's
   background-only IOSurface while the grid still asserts text).

Journal replay (FakeManualSurface / wire attach) worked because the fake
always enqueues invalidate and never goes through the occlusion thrift path.

## Fix

In `HiveTerminalView`:

1. **`prepareThemeBeforeAttach`**: force `engine.setOcclusion(true)` before
   journal replay so processOutput rebuilds cells.
2. **`occlusionAllowsPresent`**: with `highWater > 0` and no successful host
   draw yet, keep the present gate open; re-read live window occlusion if
   applied state is stale.
3. **`synchronizeOcclusion`**: do not thrift-hide the engine while first
   content has not yet drawn (`highWater > 0 && drawScheduledCount == 0`).
4. Instrumentation NSLogs at processOutput / invalidate / draw-gate / first-correct-frame.

Gate 7 thrift preserved: occluded + `highWater == 0` still suppresses draws
(`testOcclusionSuppressesDraw…`). New
`testOccludedAttachWithContentPresentsOneFrame` covers the recovery present.

## Live RED → GREEN (hubert recipe)

Port `43118`, `SHELL=/tmp/hulda-ls-shell`, home `/tmp/hb22-f163`.

**RED (pre-fix instrumentation only):** draws=0, occlusion-hidden,
screenshot indistinguishable from hattie blank.

**GREEN (post-fix):**

```
engine-visible for pre-attach journal
processOutput ok n=1 bytes=447
invalidate … gate=open hw=447
first-correct-frame … occlusion=visible
draw n=1 … layer=IOSurfaceLayer
```

Window capture shows full `ls -1` listing + login prompt (not blank).

Artifacts:

- `raw/hulda-blank-pane-AFTER-fixed.png` — full window
- `raw/hulda-blank-pane-terminal-crop.png` — terminal body with listing
- `raw/hulda-blank-pane-wire-green.stderr.log` — wire counters
- Pixel check vs hattie blank: light>80 pixels 2.15% vs 0.77%, maxlum 235 vs 164

## Scope note for horst (DRAW half)

Wire half is closed for this recipe: invalidate reaches the view, draw runs,
layer shows text. If another blank remains after this lands, it is no longer
"grid has text / no draw scheduled" — re-measure from a clean exclusive port.

## HOLD

Pin on `hive/hulda-continue-crashed-agent-hattie` for cross-vendor review
before land.
