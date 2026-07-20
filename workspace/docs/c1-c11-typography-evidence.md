# C1.1 typography and cell-metrics evidence

Recorded 2026-07-20 EDT on macOS 26.3.1 (25D2128), Apple silicon.

## Runtime and source identity

- Ghostty source pin: `73534c4680a809398b396c94ac7f12fcccb7963d`.
- Ghostty declared version: `1.3.2-dev`.
- Hive patch-series SHA-256: `ddeaf79284f0072f29d69dbf6580fd8f58eba98ceff11525f83f91f03f6e09e0`.
- Pinned JetBrains Mono variable resource SHA-256: `662a196d58f1183bf2d77428b6d5283fe3f45161ab021bea4036bc98e5cac016`.
- Pinned Symbols Nerd Font resource SHA-256: `71db104aa66567d0efe0b98758f9dfc1895573a453fe85fb53d1c38544a55106`.

The pinned engine appends its embedded unpatched JetBrains Mono variable faces only after completing configured styles, explicitly making the built-in faces fallbacks to configured families. It then appends the separate `symbols_nerd_font` resource. The similarly named patched JetBrains Mono Nerd Font is declared only below the source's “ONLY used for testing” boundary.

## Default face and the negative control

Hive emits no `font-family`, per-style family, style, weight, or width adjustment by default. On this clean machine, Core Text reports zero installed descriptors for both `JetBrains Mono` and `JetBrains Mono Nerd Font`, while Menlo reports four.

The real production-created Ghostty surface resolves its primary face as:

```text
family:     JetBrains Mono
PostScript: JetBrainsMono-Regular
size:       13 pt
weight:     400 default on a 100...800 variable axis
```

Six runtime `CTFont` table hashes match the pinned embedded variable resource:

| Table | SHA-256 |
| --- | --- |
| `head` | `bc49d6fc4a60cfd060a08ae9f61ec6f60c9c1a1aa47dbb65f0b5e33a8a34e4cf` |
| `name` | `9993a1bafaccd678a27a6ca2aa4991aea747561c30eafcea37017f54cc83398c` |
| `fvar` | `d7fed7a655ccd91c69b0a5e55dd3965216df651575bf732e6cd25b6a80577eb1` |
| `OS/2` | `c0116b65d074e53577507f890fb26eef8adc9bdb682ef92f03630b374799b236` |
| `cmap` | `c3e6cb37e8ca43259c92e6fbc103f1bcb6a0a08f95e1b4888067ce68fdb9f793` |
| `glyf` | `3d4f108e9b5ec2be132c8671262dc88f306af086071d59442ce19fba08c3374c` |

The negative control prepends `font-family = Menlo` to the same generated file. The real engine then resolves `Menlo` as primary and its `glyf` table no longer matches the embedded resource. Mutating production's default generator to select system monospace makes the embedded-face proof fail with 11 family, axis, and table mismatches.

## Shaping, weight, and metrics

The generated policy emits `font-size = 13`, `font-feature = -calt`, `font-thicken = false`, `font-thicken-strength = 255`, and `adjust-cell-height = 8%`. It emits no manual tracking or light weight and leaves `font-shaping-break` absent, preserving the engine's default cursor-aware shaping break.

The renderer proof uses one instrumented production surface and a live full-config update, avoiding cross-surface raster nondeterminism:

- With the cursor away from `!= != !=`, changing only `-calt` to `calt` changes the thresholded IOSurface glyph mask. An identical-config update leaves that mask unchanged.
- With the cursor placed over `!=`, the same feature change adds no pixel delta beyond the identical-config cursor redraw. The semantic grid retains the exact `!=` bytes and never contains `≠` in every case.
- Enabling thickening at strength zero changes the rendered `Hive` mask from the disabled state, proving zero is the lightest enabled strength rather than an alias for disabled.
- Against the same 800×480 surface, the unadjusted grid measures 8×17 pixels per cell and the shipped 8% height adjustment measures 8×18. Width remains unchanged.

Deleting `font-feature = -calt`, `font-thicken = false`, or `adjust-cell-height = 8%` independently makes its consuming proof fail. These are renderer/geometry checks, not generated-file assertions alone.

## Labelled system option boundary

The generator exposes `System Monospaced` as the non-default option. At this OS bump, `NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)` reports the private family `.AppleSystemUIFontMonospaced`; Core Text finds that family, and the real Ghostty surface resolves it when the option is selected.

The selector is intentionally deferred to C1.2 together with the paired-theme Appearance Settings surface, persistence, and live pane reconfiguration. C1.1's reviewed boundary is the labelled generator option plus its engine-resolution and bump-time private-name proof.

## Vendor glyph fixtures and real rendered capture

Pending the authenticated raw byte transcripts and real production-pane captures from B2.5 row K. C1.1 will use only glyphs that the live Claude, Codex, and Grok status/trust UIs actually emitted; no synthetic vendor fixture is admissible.

## Test transcript

Before the vendor-glyph proof is added, the focused C1.1 suite exits 0 with 6 tests and 0 failures. The complete Swift suite exits 0 with 473 tests executed, 11 skipped, and 0 failures.
