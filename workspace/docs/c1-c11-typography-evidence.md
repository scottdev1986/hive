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

C1.1 uses only glyphs that the live vendor status/trust UIs actually emitted; no synthetic vendor fixture is admissible. The source is B2.5 row K's authenticated raw byte transcripts and real production-pane captures.

The authenticated Claude/sessiond journal captured before teardown in B2.5 p11 is 8,666 bytes with SHA-256 `c0ff7ee10c6fab47913de59b25f262b68569a517a95b391686241429a19584ad`. Its 16-byte sequence prefix is `000000000000000000000000000021ca`. The consuming test uses the journal's exact three UTF-8 bytes `e2 9c bb` for U+273B (`✻`), independently fixed by slice SHA-256 `864f614027fbe51470df6eb3d3cc781780d5247e2de1009c895bf62cb337a558`. The semantic grid retains U+273B, and the production Ghostty IOSurface draws a glyph distinct from both blank and U+FFFD.

The live bytes exposed a design/evidence mismatch instead of the assumed Nerd-font path. The earlier authenticated diagnostic journal `de645b1efe5142b18f7fdf7fc0a43aedab71ac579d4ce0aeffef2cd3965e5675` contains Claude's U+23FA, U+2722, U+2733, U+273B, and U+2810 status glyphs. Direct Core Text checks against both pinned embedded resources find all five absent from JetBrains Mono and Symbols Nerd Font. For the retained U+273B fixture, the engine's primary face has glyph zero and Core Text resolves the system fallback to Menlo. This row is therefore labelled **system fallback**, never Symbols Nerd Font. The mismatch is retained for the C1.5 design review.

Symbols Nerd Font is proven separately as a **synthetic mechanism proof**, matching its real consumer: user shell content such as icon-bearing prompts. U+F115 is absent from the runtime primary face, no system descriptor named `Symbols Nerd Font` is installed, and Core Text outside Ghostty can resolve only `.LastResort`. The pinned Symbols Nerd resource does contain U+F115 (glyph 2588). Through the production Ghostty surface, the exact UTF-8 probe `ef 84 95` survives in the semantic grid and renders nonblank pixels distinct from U+FFFD. Combined with the pinned source order—embedded Symbols Nerd precedes system discovery—this excludes the primary and system chains and identifies the embedded Symbols Nerd fallback.

| Vendor | Qualification state | C1.1 glyph state |
| --- | --- | --- |
| Claude | One real session approved | Authenticated pre-teardown journal captured; real-window PNG still pending after two screenshot failures |
| Codex | One attempt subject to its 9.5% weekly-capacity gate | Optional corroboration; not a C1.1 blocker |
| Grok | Measured 0% weekly capacity | `CAPACITY-DEFERRED` until the 2026-07-26 reset; no attempt and no fabricated fixture |

The deferred Grok row is a declared follow-up delta after the reset, not a green row and not a reason to block the independently provable C1.1 font-chain behavior.

## Test transcript

With both fallback proofs, the focused C1.1 suite exits 0 with 8 tests and 0 failures. The complete-suite count below will be refreshed after the real-window artifact lands and the branch is rebased for review.
