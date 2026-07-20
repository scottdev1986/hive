# #47 blank pane — draw-path RED→GREEN

## Root cause

Fresh CLI-launched Workspace windows can remain visible but inactive. On the
reproduction host, AppKit reported `NSWindow.isVisible == true` and
`isKeyWindow == false`, while `occlusionState.rawValue == 8192` never contained
`.visible`. `HiveTerminalView` forwarded that stale state as
`setOcclusion(false)` and also used it to gate its INVALIDATE draw queue. The
journal reached the real manual surface, but no `ghostty_surface_draw` ran and
the `IOSurfaceLayer` never received contents.

The fix permits one bootstrap frame only while the attached window is visible,
non-miniaturized, and no draw has completed. Immediately after the real draw
returns, the view re-synchronizes the true occlusion state. Fully occluded and
miniaturized windows therefore retain the original draw suppression.

Hattie's two prerequisite commits compose in order with this gate: C1 is
applied before attach, journal replay lands on the themed surface, settle
failure presents anyway, and this change guarantees that presentation is not
permanently rejected by a stale initial occlusion bit.

## Live RED

Post-Hattie tree, `make terminal DEMO_PORT=43128`, home `/tmp/hb22-b65b`:

```text
occlusion ... visible=false windowVisible=true key=false occlusion=8192 layer=IOSurfaceLayer contents=false
app-tick ...
process-output ... range=0..<165
process-output ... range=165..<216
```

There is no draw line and no later visibility transition. The window capture
shows the terminal pane blank. Artifacts:

- `/tmp/horst-window-red.png` — SHA-256 `c05766b685e42915d2cd6fb1fc0d465029d2353f870e5f7285ce152f07495f07`
- `/tmp/hb22-b65b/workspace.stderr.log` — SHA-256 `148d09dd8581caf904464cbeeb7c8800c4335438a5d450c19f90d47a906266b2`

## Live GREEN — exact Hubert wrapper

```sh
SHELL=/tmp/hbt-ls-shell HIVE_DRAW_PATH_TRACE=1 make terminal DEMO_PORT=43131
```

Home `/tmp/hb22-e207`; no test or harness forced the occlusion bit:

```text
occlusion ... visible=true windowVisible=true key=false occlusion=8192 layer=IOSurfaceLayer contents=false
process-output ... range=0..<449
draw-begin ... layer=IOSurfaceLayer contents=true
draw-end ... layer=IOSurfaceLayer contents=true
occlusion ... visible=false windowVisible=true key=false occlusion=8192 layer=IOSurfaceLayer contents=true
process-output ... range=449..<501
```

The capture shows the complete `ls -1` output, wrapper message, and live login
prompt in the terminal pane:

- `/tmp/horst-hubert-exact-green.png` — SHA-256 `29d59c6aae85e95869950923b4e120d871ece054a69d204fc343a7bae1283ae8`
- `/tmp/hb22-e207/workspace.stderr.log` — SHA-256 `9d91869a9415ce501fa52c6775a3d4202a5ddc0f4243557fee0cbbb0b9331838`

Both captures are 2696×1800 window images.

## Automated controls

- `Gate7RenderingTests`: 18 executed, 1 physical-hardware skip, 0 failures.
- New reverse controls prove true occlusion suppresses a second draw after the
  bootstrap and a miniaturized window never bootstraps.
- Mutation control: removing the `!hasCompletedInitialDraw` bound produced
  three failures in the visible-window test (occlusion remained true and a
  second draw escaped).
- `swift test --filter Gate9`: 16 executed, 0 failures; the visibility path
  does not implicate action dispatch or its callback matrix.
- Full `swift test`: 436 executed, 7 opt-in skips, 0 failures.
- `swift build`: clean typecheck/build.
