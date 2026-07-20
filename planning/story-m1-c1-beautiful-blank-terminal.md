# M1-C1 — The beautiful blank terminal: visual quality bar

Milestone: M1, track C
Backlog position: after M1-B2.4 (viewer semantics); parallel with M1-B2.5/B2.6; before the STORY-001/STORY-002 Removal Gate
State: design written; **must pass independent cross-vendor design review before landing**. Aesthetic signoff is the user's personally, and closes only after the B2 integrated pane.

## Why

M1's bar is explicitly aesthetic as well as functional. A Hive terminal that renders every byte correctly and still looks like a 2009 X11 widget fails M1. This story defines what "beautiful, modern, and stylish" means for the Hive terminal as a buildable specification — a design language with named decisions, stated rationale, and a legibility floor that can be measured — so that the aesthetic gate is something a reviewer can check rather than something a reviewer can only feel.

It exists as a separate story from the renderer work because the two answer different questions. M1-B2 answers *does the terminal behave correctly*. M1-C1 answers *does it look like something a person wants to live inside for eight hours*. Conflating them lets the second silently lose to the first, which is how every terminal that renders perfectly and looks unloved got that way.

## Sequencing

1. **Styling executes after M1-B2.4.** Exploration — surveys, palette authoring, mockups, reference comparison — may begin immediately and is what this document records. Implementation waits for B2.4 (viewer semantics: bounded scrollback/search, selection/copy, mouse, lifecycle states, GPU/occlusion behavior). The reason is specific, not procedural: B2.4 is the increment that fixes what a *filled and scrolled* terminal does. Cell geometry, selection rendering, cursor behavior, scrollback anchoring, and the lifecycle/failure states are all things this design assigns colors and metrics to. Styling them before B2.4 means restyling them after B2.4.

   The backlog's own edge reads `B2→C1 close (design exploration earlier)`. This story tightens the implementation trigger from "B2" to "B2.4" and leaves the close gated on the full integrated pane, because B2.5 (Workspace/vendor qualification) and B2.6 (accessibility acceptance) do not move the surfaces this design paints. C1 implementation may therefore run in parallel with B2.5/B2.6 rather than queuing behind them.

2. **The renderer story owns the surface; this story owns everything around and composited with it.** M1-B2 supplies the `HiveTerminalView` and the Hive-owned adapter over the pinned manual-I/O engine. C1 does not change transport, input encoding, geometry negotiation, or terminal semantics, and may not weaken a B1 or B2 gate to obtain a visual result.

3. **The engine pin does not move for aesthetics.** Every visual capability this story relies on was verified present in the pinned engine. Where a desirable treatment is not available in the pin, this document says so and specifies the available alternative rather than proposing a pin bump.

4. **No appearance decision overrides a system accessibility setting.** Reduce Transparency, Increase Contrast, and Reduce Motion each have a defined effect on this design, specified below. They are not optional polish.

## What this design layer can and cannot touch

This is the load-bearing section. Every decision downstream depends on it, and it is the part most likely to be assumed wrongly.

### The theming transport is a file, not an API

The terminal renders through the pinned engine, which paints into its own surface. Hive does not own those pixels directly. Hive influences them only through the engine's configuration, and the engine's C configuration interface exposes **no per-key setter**. It offers configuration creation, cloning, loading from a file, loading from default locations, loading recursively, finalizing, and reading back — plus entry points to re-apply an updated configuration to a live application and to a live surface.

Therefore: **the theme system is a Hive-authored configuration file that Hive writes, loads explicitly, and pushes to live surfaces.** There is no property-bag API to design against. Every visual decision in this document that the renderer consumes must be expressible as a line in that file, and a theme change at runtime is a rewrite-and-reload, not a property assignment.

Three consequences follow, and each is a hard rule:

- **Hive never loads the engine's default configuration locations.** Doing so would pull the user's personal terminal configuration into Hive panes. That would make Hive's appearance depend on an unversioned file outside the product, and — more seriously — would make the rendering corpus that M1-B1 and M1-B2 qualify non-deterministic. Hive loads exactly the file it wrote and nothing else.
- **Hive never resolves a theme by name.** Named-theme lookup searches the user's own configuration directory first, then a resources directory belonging to the standalone terminal application, which Hive does not ship — Hive embeds the library, not the application bundle. Name resolution is therefore both unreliable (the corpus is absent) and leaky (the user's directory is consulted). Hive inlines color values into its own generated configuration.
- **A theme is a base layer that explicit settings override.** The engine loads theme content before other configuration for exactly this reason. Hive's generator preserves that precedence: the selected theme supplies the base, and any Hive-level or user-level override is emitted after it.

### What the renderer consumes vs. what must be app chrome

Verified available in the pin, and therefore expressible in the generated configuration: font family (as a repeatable fallback chain), per-style families, font size, OpenType font features, synthetic style control, font variations, macOS stroke thickening and its strength, per-codepoint font mapping, grapheme width method, cell width/height/underline-position adjustment, background and foreground, a 256-entry palette, palette generation, bold color, selection foreground and background, cursor color, cursor text color, cursor opacity, cursor style, cursor blink, a minimum-contrast floor, alpha blending mode, text blending, window padding on both axes, padding balance, padding color behavior, background opacity, background blur, window theme, window colorspace, titlebar background, macOS titlebar style, macOS window shadow, and hide-mouse-while-typing.

**Inert for Hive, despite being present:** the engine's unfocused-split opacity, unfocused-split fill, and split-divider color. These drive the engine's *own* split tree. Hive owns pane layout in AppKit with one manual surface per pane, so the engine never has a split to dim. The unfocused-pane affordance and the divider between panes are therefore Hive chrome, not engine configuration. This is specified in "Focus" below.

**Available, and available by default:** cursor-aware shaping breaks. The pin exposes a font-shaping-break setting whose `cursor` option is **enabled by default** — the engine already breaks shaping runs under the cursor so that text editing sees individual characters rather than a ligature. This is the same treatment other terminals expose as a ligature toggle, and it is on before we configure anything. The design keeps it on and reasons about ligatures with it in hand, rather than treating it as unavailable.

**Governed by neither:** a vendor TUI's own truecolor output. A 24-bit color escape carries a literal color and does not index the palette, so any application emitting truecolor bypasses the theme entirely. The panes host third-party coding-agent TUIs that do exactly this. **The theme therefore governs indexed color and Hive's chrome; it does not govern what a vendor TUI paints in truecolor, and this document does not promise that it does.** This restates an existing Workspace principle — do not retheme a vendor's TUI, its colors are its product — as a capability fact rather than only a courtesy.

## Design

### The design language, stated once

**Quiet, dense, native, and honest.** The terminal is the content and everything else recedes. Chrome earns its pixels or it is removed. Focus is communicated by attenuating what is not focused rather than by decorating what is. Color carries meaning only where meaning exists, and never carries meaning alone. Nothing animates that a person reads.

The single external principle this borrows most heavily is the pinned engine's own stated goal — to look, feel, and behave the way an application is expected to behave in its desktop environment, without trading that for speed or features. On macOS that is a testable constraint, not a slogan: system appearance, system accent, system accessibility settings, platform text rendering, platform materials, platform metrics.

### Typography

**Grid font: whatever the pinned engine already embeds — reached by configuring no font family at all — at 13 pt, with no backup chain.**

Rationale, in order of how load-bearing each point is:

- **Hive configures no font family at all by default, and that is the whole decision.** The engine adds configured families first and then adds its own embedded faces as *fallbacks* behind them — the intent is explicit in the engine, which completes the configured styles before appending the built-in ones precisely so the built-ins sit behind whatever the user configured. Emitting no family therefore leaves the embedded faces as the effective grid font, with no name resolution performed and nothing to get wrong on a machine that has no extra fonts installed. A family name is emitted **only** when a user explicitly picks a font.

  This is not a stylistic preference; naming the embedded font would actively break it. **The production build embeds the official *unpatched* variable JetBrains Mono, plus a separate symbols-only Nerd Font as its own fallback face.** The Nerd Font-*patched* JetBrains Mono files also present in the engine tree are test fixtures and are not what production loads. So a chain naming "JetBrains Mono Nerd Font" matches nothing; worse, a chain that also lists Menlo as a backup would resolve Menlo — a configured family always outranks an embedded fallback — and the terminal would silently render in the wrong face while appearing to have a considered font stack. A direct probe of the system font collection on a clean machine returns **zero** descriptors for both "JetBrains Mono" and "JetBrains Mono Nerd Font" and four for "Menlo," which is exactly how that failure would play out. Naming no family avoids the trap entirely and gets the symbols fallback for free.

- **A system-provided monospaced face is offered as an explicit option, but is not the default.** An earlier draft of this document claimed such an option was structurally impossible. That was wrong, and the correction matters because it was a decision-shaping error. The literal "SF Mono" is genuinely unavailable — it resolves to zero descriptors, and its license permits use solely in conjunction with Apple-branded applications, which Hive is not. But the *system* monospaced family is a different object and **is** reachable by the same collection lookup the engine performs: querying it returns twelve descriptors, all carrying monospaced traits, with no fallback substitution.

  It is nevertheless not the default, for a stated reason rather than an assumed one: the family is a dot-prefixed private name, Apple's guidance is to reach system fonts through the API rather than by name, and a private name carries no stability promise across OS releases. Offering it is reasonable; depending on it is not. It ships as a labelled option whose resolution is re-verified at every engine and OS bump, and the embedded face remains the default.
- **13 pt matches two independent defaults.** It is the engine's own macOS default, and it is the macOS system default text size (with a documented 10 pt floor). Convergence is the argument; the engine's own source calls its choice "purely subjective," and there is **no controlled study of terminal font size against sustained-reading fatigue on high-DPI displays**. Every circulating "minimum 14 px" figure traces to opinion, not evidence. This document ships 13 pt because two defaults agree, makes it trivially adjustable, and declines to dress the number up as research.
- **x-height carries small sizes more than point size does.** JetBrains Mono's stated design goal is a maximized lowercase height, which is why it holds at 12–13 pt.
- **No Menlo or Monaco backup chain is emitted.** They are preinstalled and name-resolvable, which is why the earlier draft reached for them — but as a *configured* family either one outranks the embedded face and becomes the primary. The embedded faces are already the backstop, and they are a better one. If a user names a font that does not resolve, the engine falls through to the embedded faces on its own; that is the desired behaviour and it requires no chain from us.

**Ligatures: off by default, user-switchable, disabled via the OpenType contextual-alternates feature.**

The general ligature argument is genuinely unsettled — **no peer-reviewed study measures an effect on code reading in either direction**, and any accessibility claim for ligatures is unsupported (the adjacent and better-studied question of dyslexia-specific typefaces comes out negative). This design does not rest on either.

It rests on a terminal-specific argument that is sound: a ligated `!=` becomes visually indistinguishable from the real U+2260 codepoint, and **the user's entire job in a terminal is knowing exactly which bytes are on screen.** Ligature substitution is also context-blind — it considers character order only — so it is occasionally semantically wrong. Another terminal's own documentation concedes the narrower point that ligatures are good for code editing but not for other terminal applications, because a multi-cell glyph fights a fixed-cell grid.

**The cursor-aware compromise is available here — it is the engine's default — and it is deliberately not treated as sufficient.** An earlier draft claimed this treatment did not exist in the pin; it does, and it is on. The reason it does not change the default is a matter of where the risk actually lives. Breaking shaping under the cursor solves the *editing* case: the character you are about to modify is shown as itself. It does nothing for the *reading* case, and a terminal is overwhelmingly a reading surface — most of what is on screen is emitted output that no cursor will ever visit, and that is exactly where mistaking a rendered `≠` for a literal one is unrecoverable, because there is nothing to move the cursor onto to disambiguate.

So: ligatures off by default via the contextual-alternates feature, **and the cursor shaping break left enabled regardless**, so that a user who turns ligatures on still gets the editing-case protection for free. Two independent mitigations, the stronger one as the default.

**Weight, tracking, and thickening:**

- **No light weights anywhere**, in grid or chrome. Apple's guidance is explicit; at terminal sizes it is not close.
- **Tracking is not adjusted in the grid.** Letter-spacing in a fixed grid widens the *cell*, not the gap, which changes columns-per-window — a user-visible consequence with no prose-typography analogue. Cell width adjustment is treated as near-untouchable.
- **In AppKit chrome, tracking is left to the system.** The system font dynamically adjusts tracking at every point size; manual tracking is needed only for mockups or custom fonts. The system's own curve pivots at 12 pt — looser below, tighter above — which is a better answer than a hand-picked constant.
- **Stroke thickening: available, default off, offered as an enable flag plus a strength — never as a single slider.** macOS removed subpixel antialiasing by default years ago, which is why terminal text reads thinner than it once did; thickening is a compositing/gamma compensation for that, not a weight change, and light-on-dark text is where it is missed. Two cautions: whether the old system-wide smoothing default still does anything on current macOS is unverified and widely reported inert, so nothing here depends on it; and in this engine **a thickening strength of zero means the lightest thickening, not none**. A single 0–255 control would therefore lie to a user who expects zero to mean off. Enable flag plus strength.

**Line height: a modest positive cell-height adjustment, chosen by eye at the signoff, not by importing a ratio.**

The only hard number in this area is the WCAG text-spacing criterion's 1.5× line height — but that is an *adaptability* requirement: content must survive a user applying it, not default to it. In a terminal, vertical density is the point, and 1.5 would be absurd. Our real obligation is that the grid survives an increased cell height without breaking. The engine's cell-height adjustment takes integer or percentage deltas, centers the font vertically in the cell, and adjusts powerline glyphs along with it so status lines stay aligned. The widely-repeated "120% line spacing improves accuracy 20%" figure has no traceable primary study and is not cited here.

### Color and theming

**Hive ships a small number of first-party paired themes — one dark, one light — authored together and measured, rather than adopting a community theme.**

The reasoning is that no major theme system verifiably guarantees contrast. The engine's several-hundred bundled themes are an ungated weekly sync from a community color-scheme collection. Solarized is the only surveyed system with a rigorous stated method (designed in CIELAB, with symmetric lightness across its light and dark modes so perceived contrast survives the switch) — and its explicit goal is *reduced* brightness contrast for comfort, which is the opposite of a legibility target. Catppuccin's own style guide makes no contrast claim at all; a widely-repeated assertion that it targets WCAG AAA is not in the primary source and is not repeated here. "Ship a popular theme" is not an accessibility answer.

Solarized's *method* is worth copying even though its ratios are not: author the light and dark modes together with symmetric lightness relationships, so switching appearance preserves perceived contrast rather than producing two unrelated designs.

**What a Hive theme defines:**

| Field | Notes |
|---|---|
| `background`, `foreground` | The base pair. Measured (below). |
| `palette` indices 0–15 | The ANSI 16. The only indices Hive authors. |
| `cursor-color`, `cursor-text` | Specified **symbolically**, not as hex — see below. |
| `selection-background`, `selection-foreground` | Specified **symbolically**. |
| `bold-color` | Explicit. This option absorbed the older bold-is-bright setting in a prior engine release. The old name **does** still parse in this pin, as a deprecated compatibility alias that rewrites to this option — so specifying it would work and would be wrong. Hive emits `bold-color` and never the alias. |

**Indices 16–255 are left at the engine's standard values, and palette generation stays off.** This is deliberate and follows the engine's own documented rationale for that default: many programs hardcode assumptions about the standard 256-color cube. The panes host exactly such programs. Regenerating the cube to match a Hive palette would make Hive prettier in the abstract and wrong in the specific case that matters.

**Cursor and selection colors are symbolic, not hex.** The pin supports resolving these against the cell beneath them rather than against a fixed value. This removes an entire bug class — the invisible cursor that appears only on one theme over one background — and it is what the engine's own defaults do. A second, independent terminal converged on the identical primitive, which is good evidence it is the right one. Hive uses it and does not author cursor hexes.

**Contrast targets: WCAG 2.x, and explicitly not APCA.**

WCAG 2.2 is the only normative contrast standard. WCAG 3.0 remains a Working Draft that contains **no normative contrast algorithm and no mention of APCA** — visual contrast was removed from that draft in 2023. Apple's own accessibility guidance cites WCAG AA (4.5:1 up to 17 pt; 3:1 at 18 pt or bold), and Apple's dark-mode guidance asks for 4.5:1 minimum and **7:1 for small text specifically**.

Since terminal text *is* small text, the target is:

- **Foreground on background: ≥ 7:1.** Apple's small-text dark-mode target, met in both the dark and the light theme.
- **Every ANSI palette entry against the theme background: ≥ 4.5:1**, with the deliberate exception of the entries conventionally used for de-emphasis, which must still clear **3:1**. A theme entry below 3:1 against its own background is a defect, not a style.
- **Chrome text and non-text UI indicators: the AA floors** (4.5:1 text, 3:1 non-text/UI).
- Ratios are recorded per entry in the evidence bundle. A measured table is the deliverable, not an assertion that the theme "looks fine."

**A legibility floor is set, and its cost is stated.** The engine's minimum-contrast option enforces a WCAG-defined ratio at render time against arbitrary application-emitted colors — colors no theme author ever saw. It is a genuine safety net and the strongest argument for putting contrast enforcement in the renderer.

It is also blunt, and the honest specification says so: it works by falling back to black or white, so it does not distinguish "accidentally invisible" from "deliberately dim." The engine's own issue tracker records it obscuring intentionally-faint editor UI, and breaking the color swatches in the engine's own theme previewer — content whose entire purpose was to show unadjusted color. **Hive sets a low floor that prevents literally invisible text and does not attempt to mandate readability**, because the higher settings would flatten deliberate dimness in the vendor TUIs that are our actual content. The exact value is chosen at the signoff against the reference terminals; the design constraint is that it is set low, and that its cost is documented where a future reader will find it.

**Color never carries meaning alone.** Roughly 8% of men and 0.5% of women have a color vision deficiency, overwhelmingly red-green. The specific failure is hue-differs-but-luminance-matches — so equal-luminance red against green is the worst possible encoding. Every state in Hive chrome carries a symbol or words in addition to color, and any two states distinguished by color must also differ in luminance. This inherits the existing Workspace rule rather than inventing one.

**Theme selection.** The user picks a theme from Hive's settings surface. Selection writes the generated configuration and pushes it to every live surface; it does not require restarting a session. The set is deliberately small at M1 — the paired first-party dark and light — with the generator structured so additional first-party pairs are data rather than code. Importing arbitrary community themes is out of scope for M1 and noted below.

### Window, pane, and split chrome

The pane is a content surface. Under Apple's current two-layer material model, the floating-glass material is for controls and navigation and is explicitly **not** for the content layer; standard materials are for content backgrounds. The terminal surface is content. **No glass material goes behind or over terminal content.**

Vibrancy carries a second, sharper constraint that decides the view structure: vibrancy is inherited by subviews and **cannot be turned off by them**, it is recommended only in leaf views, and it works best with grayscale content. Terminal output is full-color, arbitrary, and third-party. **The terminal surface therefore must not be a descendant of a vibrancy-enabled view.** The pane's own background material stays a standard opaque content material; vibrancy, where used at all, is confined to leaf chrome outside the surface.

**Metrics.** The pane keeps the existing corner radius and header rhythm rather than inventing a second visual system — but takes them from the design system's tokens instead of restating the numbers locally, which is already recorded as open work in the Workspace design system. Any custom component adjacent to a bar uses a corner radius concentric with that bar's corners.

**Padding is the single highest-leverage aesthetic decision in the terminal, and it is nearly free.** Three engine settings do the work:

- **Symmetric padding on both axes**, in points, so it scales with display DPI. The engine's default of 2 is too tight for a pane that reads as a card; this design opens it.
- **Padding balance on.** The viewport is essentially never an exact multiple of the cell size, and the remainder has to go somewhere. Unbalanced, it lands on one edge and the grid looks subtly misaligned in a way most people feel without diagnosing. Balanced, the remainder is distributed. This is a large part of why the reference terminal reads as "centered."
- **Padding color extends the nearest cell's background.** A full-width colored line — a status bar, a selected row, a vendor TUI's header — bleeds to the pane edge instead of stopping short against a mat. The terminal reads as a surface rather than a canvas floating in a frame. The engine applies documented heuristics that disable extension where it would look wrong (notably against default-background rows and prompt rows), which is the behavior we want; the always-extend variant is not used.

**Splits and dividers.** Hive owns pane layout, so the divider is Hive chrome. Apple's guidance is to prefer the thin 1 pt divider and to set pane minimum sizes such that the divider never appears to vanish. Both are adopted. Panes get a minimum size in cells, not points, so the constraint means something in terminal terms.

**Titlebar and window.** Standard system window appearance; no custom window UI, per Apple's explicit warning that imperfectly replicating system appearance makes an app feel broken. Nothing critical goes in a bottom bar, because users routinely drag a window so its bottom edge is offscreen. If a toolbar carries any command, that command also exists as a menu bar item — toolbars are user-customizable and hideable, so they cannot be a command's only home.

**Background opacity and blur: off by default.** They are available in the pin and are the most-requested terminal decoration, but they cost legibility against arbitrary desktop content, and under Reduce Transparency they must be disabled outright (below). Off by default, available, and never on a path where the user cannot instantly turn it off.

### Focus: the active-pane affordance

This is the one place where a known AppKit hazard, an engine limitation, and the best available design idea all land on the same answer.

**The treatment: focus by attenuation.** The focused pane renders normally; every unfocused pane is dimmed by a uniform semi-transparent overlay. Nothing is added to the focused pane — no glow, no heavy border, no color wash. This reads instantly at any pane count, adds no chrome, and survives both color-blindness and grayscale because it is a luminance difference.

The engine implements exactly this treatment for its own splits, at 0.7 opacity, by rendering a semi-transparent rectangle over the unfocused split. That value is a reasonable starting point and is confirmed at the signoff. But **the engine's split settings are inert here** — Hive owns layout, so the engine never sees a split to dim. Hive implements the same idea itself.

**And it must be an overlay `NSView`, never a `CALayer` sublayer.** AppKit paints a view's layer and its sublayers *beneath* the layers of that view's own subviews. A dimming layer added as a sublayer while an opaque content view covers the bounds is not dim or subtle — it is absent. This is not hypothetical: the pane focus ring and the pane status border were each designed, built, and reviewed in this codebase, and neither had ever appeared on screen. The existing fix — sibling overlay views added last, hit-test transparent, drawing with semantic colors so light/dark and accent changes resolve for free on every redraw — is the pattern this affordance follows without exception.

The pleasing part is that the hazard-mandated mechanism and the engine's own mechanism are the same thing: a semi-transparent rectangle drawn over the content. There is no tension to resolve.

**A focused pane additionally carries the system focus indicator color** on its border, resolved semantically rather than hardcoded, for users who need an additive cue as well as a subtractive one. Two channels, one state.

**Status remains one legend.** Pane status color, symbol, and border style continue to come from the single existing status table. A second table is a correctness bug, not a style choice — two tables drift and eventually show a green dot beside a red border, asking the user to adjudicate. Dashed continues to mean "we cannot see it."

### Motion

**Where motion is used:** pane open and close, and the focus attenuation transition. Both are short opacity or geometry changes on chrome. Durations come from the existing motion tokens rather than new constants.

**Where motion is prohibited, absolutely:** text and scrolling. Terminal output is not animated, scroll position is not eased, and the cursor's own blink is the engine's, governed by terminal semantics and configuration — not by Hive chrome animation. A person reading output is doing the one task that motion most reliably ruins.

Apple's guidance supports the restraint directly: add motion purposefully, avoid animating frequent UI interactions because the system already animates standard elements subtly, and let people cancel motion rather than wait through it.

**Under Reduce Motion**, Apple's concrete checklist applies: tighten springs, replace positional transitions with fades, avoid animating depth changes, and — directly relevant here — **avoid animating into and out of blurs**. Since the focus transition is an opacity change rather than a blur or a positional move, it degrades to an instant state change cleanly. An instant change beats a janky tween, which is already the Workspace rule.

### Light, dark, and system appearance

**Hive follows the system appearance. It does not offer an app-appearance setting.**

Apple is unusually blunt here: avoid an app-specific appearance setting, because it makes users adjust more than one setting to get what they want and — worse — makes them think the app is broken when it ignores their systemwide choice. Users can also select Auto, which switches while the app is running, so appearance changes must be handled live rather than at launch.

The mechanism is available end to end. The engine's theme setting accepts a paired light and dark value in a single field, and the host can drive the surface's color scheme directly. Hive resolves the effective appearance from `NSAppearance`, drives the surface color scheme from it, and re-pushes the generated configuration on appearance changes. Chrome colors are semantic system colors that resolve themselves on every redraw, so chrome needs no appearance branching at all.

**The distinction that makes this coherent:** *appearance* is a system-level property that Hive follows without exception. A *terminal theme* is content color, and pinning a dark terminal theme inside a light-appearance app is a long-standing terminal convention (profiles in the reference terminals do exactly this) that says nothing about the app's appearance. Hive therefore follows the system for chrome and appearance always, defaults the terminal theme to the matching mode, and permits pinning the terminal theme alone. That is not an app-appearance override.

**Both modes are authored regardless**, since Apple now asks for light and dark colors even from single-appearance apps to support material adaptivity. And the light theme is a real design, not an inverted dark one — dark mode colors are not inversions. There is genuine evidence behind bothering: light mode measurably outperforms dark for normal vision, **and the advantage grows as font size shrinks**, which is precisely the terminal case; dark mode meanwhile helps users with cataract or light sensitivity. Neither default serves everyone, which is why both ship.

**Desktop tinting** is respected: when the user's accent is graphite, macOS tints window backgrounds from the desktop picture, and components with a visible background pick that up if they carry some transparency in their neutral state. Hive allows this on neutral chrome only — never on a colored state, where it would make a semantic color fluctuate as the desktop changes.

### The accessibility floor

Three system settings have defined, non-optional effects. Each is observed live via the workspace accessibility-options change notification, not read once at launch.

| Setting | Required effect |
|---|---|
| **Reduce Transparency** | Background opacity snaps to fully opaque and background blur is disabled, in the generated configuration and in chrome. Apple's wording is direct: don't use semitransparent backgrounds; use only opaque windows. |
| **Increase Contrast** | The theme switches to its increased-contrast variant. Every custom color needs a light variant, a dark variant, and an increased-contrast option for each. Apple specifically warns that Increase Contrast in Dark Mode can *reduce* contrast between dark text and dark backgrounds, so the dark theme's high-contrast variant is verified in that exact combination rather than assumed. |
| **Reduce Motion** | Focus and pane transitions become instant. No positional or depth animation, no animated blur. |

Additionally, **`NO_COLOR` is honored** as the community-standard signal for suppressing color output where Hive itself emits color.

## Layout sketch

Two focused-state sketches. Dimensions are illustrative; tokens govern the built values.

```text
┌─ Hive — project ─────────────────────────────────[≡]─┐  standard system titlebar,
│                                                       │  no custom window UI
│ ┌──────────────────────┐ ┌──────────────────────────┐ │
│ │ ● agent-a   working  │ │ ○ agent-b   idle         │ │  pane header: status dot +
│ ├──────────────────────┤ ├──────────────────────────┤ │  words + border style,
│ │                      │ │░░░░░░░░░░░░░░░░░░░░░░░░░░│ │  all from ONE legend
│ │  $ claude            │ │░░ $ codex ░░░░░░░░░░░░░░░│ │
│ │  ▊                   │ │░░ ▊ ░░░░░░░░░░░░░░░░░░░░░│ │  ░ = unfocused pane,
│ │                      │ │░░░░░░░░░░░░░░░░░░░░░░░░░░│ │  dimmed by an OVERLAY VIEW
│ │                      │ │░░░░░░░░░░░░░░░░░░░░░░░░░░│ │  (never a sublayer)
│ └──────────────────────┘ └──────────────────────────┘ │
│         ▲                ▲                            │
│         │                └─ 1 pt divider, thin        │
│         └─ focused: normal luminance + system         │
│            focus indicator color on the border        │
└───────────────────────────────────────────────────────┘
```

Inside a single pane, the padding decisions:

```text
┌────────────────────────────────────────────┐ ← pane bounds, existing corner radius
│                                            │
│   ██████████████████████████████████████   │ ← a full-width colored row EXTENDS
│                                            │   to the pane edge (padding color
│   $ some command                           │   follows the nearest cell), so the
│   output line                              │   terminal reads as a surface, not
│   output line                              │   a canvas in a mat
│   ▊                                        │
│                                            │
└────────────────────────────────────────────┘
     ▲                                    ▲
     └── symmetric padding in POINTS ─────┘
         viewport remainder is BALANCED across
         edges, not dumped on one side
```

## Build increments and review pairs

Pairings are proposals; queen may rotate people, but an increment's author vendor and approving reviewer vendor must differ.

| Increment | Depends on | Contract and deliverable | Blocking gate | Proposed author → reviewer |
|---|---|---|---|---|
| C1.0 · Theme transport | M1-B2.4 | The generated-configuration writer and its live push path: Hive authors one configuration, loads exactly that file, never the default locations, never resolves a theme by name, and re-applies to live surfaces. Theme content precedes overrides. | A pane renders under a Hive-generated configuration; a hostile file in the user's own configuration location provably has no effect on any Hive pane; a theme change applies to a live surface without recreating the session. | Codex → Claude |
| C1.1 · Typography and cell metrics | C1.0 | No configured font family by default; size; ligature suppression with the cursor shaping break left on; weight rules; thickening as flag-plus-strength; cell-height adjustment; the system-monospaced face as a labelled option. | **The face actually rendering is identified and proven to be the embedded one — not merely "a monospace font appeared."** On a machine with no extra fonts installed, the resolved face is captured and matched against the embedded variable face, and a negative control proves the failure mode: configuring a Menlo backup chain demonstrably makes Menlo primary. The symbols fallback is proven live by rendering powerline/status glyphs from all three vendor TUIs. A byte-exactness check confirms no ligature substitution; the cursor shaping break is proven still active with ligatures enabled. Thickening at strength zero is proven distinct from thickening disabled. The system-monospaced option is proven to resolve, and its private family name is recorded as a bump-time recheck. | Claude → Grok |
| C1.2 · The theme system | C1.1 | Paired first-party dark and light themes with measured ratios, symbolic cursor/selection, ANSI 0–15 only, standard 16–255, generation off, low contrast floor, increased-contrast variants. | The measured contrast table is recorded per palette entry for both themes and both contrast variants; foreground/background clears 7:1; no entry falls below 3:1; the dark theme's high-contrast variant is verified specifically under Increase Contrast in Dark Mode. **C1.2 discharges the static half only — the variants are authored, measured, and proven to resolve. The live Increase Contrast signal is C1.4's, because the bit is readable solely through `NSWorkspace`, which Gate 9 bars from the kit, and it cannot be recovered from an appearance read at all (`workspace/docs/c1-c12-theme-system-evidence.md:325`). That deferral was independently re-measured and confirmed by cross-vendor review (`workspace/docs/hive-terminal-c12-cross-vendor-review-hollis2.md:95`).** | Grok → Codex |
| C1.3 · Pane chrome, padding, and the focus affordance | C1.2 | Padding and balance and extension, thin divider, cell-based pane minimums, no glass or vibrancy behind terminal content, focus-by-attenuation plus the system focus indicator. | **The affordance is photographed on screen at every pane count before review** — a decoration that has never been seen is not a decoration. Overlay-view construction is demonstrated, and the sublayer construction is demonstrated failing, so the hazard is proven rather than asserted. Terminal content is proven not to descend from a vibrancy-enabled view. | Codex → Claude |
| C1.4 · Appearance, motion, and the accessibility floor | C1.3 | Live system-appearance following, live theme re-push, motion budget, and the three accessibility settings observed via the change notification. | Appearance switching under Auto is demonstrated live mid-session; Reduce Transparency demonstrably forces opacity to opaque and blur off; Increase Contrast switches variants; Reduce Motion makes transitions instant; each is toggled during a live session, not at launch. | Claude → Grok |
| C1.5 · Aesthetic signoff | C1.4; the B2 integrated pane | Side-by-side comparison capture against the reference terminals; the design checklist; the evidence bundle. | The user personally approves. See DoD 8. | Grok records → user signs |

No increment lands on implementation tests alone, and each receives independent cross-vendor review before landing.

## Definition of done

1. The theme transport is a Hive-authored configuration file, explicitly loaded and live-pushed. Hive provably never loads the engine's default configuration locations and never resolves a theme by name; a file planted in the user's own configuration location has no observable effect on any Hive pane.
2. **No font family is configured by default, and the face that actually renders is identified as the engine-embedded one** — captured and matched on a machine carrying no additional fonts, with the negative control recorded (a configured backup chain demonstrably preempts the embedded face). The embedded symbols fallback is proven live against all three vendor TUIs' powerline and status glyphs. A family name is emitted only on an explicit user selection. The literal SF Mono is not used, not referenced, and not shippable — it resolves to nothing and its license permits Apple-branded applications only — while the system-provided monospaced family ships as a labelled non-default option whose private family name is re-verified at every engine and OS bump.
3. Ligature substitution is off and byte-exactness is demonstrated, **with the engine's cursor shaping break left enabled** so that a user who turns ligatures on retains the editing-case protection; that break is proven still active in that configuration. Weight, tracking, thickening, and cell-height decisions are implemented as specified, with thickening exposed as an enable flag plus a strength because strength zero is not "off." Hive emits `bold-color` and never its deprecated compatibility alias.
4. Paired first-party dark and light themes exist, authored together with symmetric lightness, each with an increased-contrast variant. A per-entry measured contrast table is recorded for every theme and variant: foreground on background ≥ 7:1, palette entries ≥ 4.5:1 except de-emphasis entries which clear 3:1, chrome at the AA floors. No entry sits below 3:1.
5. Cursor and selection colors resolve symbolically against the cell rather than from authored hex values. ANSI 0–15 are the only indices Hive authors; 16–255 remain standard and palette generation remains off. The minimum-contrast floor is set low, and its documented cost — that it clamps toward black or white and flattens deliberate dimness — is recorded where a future reader will find it.
6. Pane chrome, padding, balance, padding extension, the thin divider, and cell-based pane minimums are implemented. No glass material and no vibrancy sits behind or over terminal content, and terminal content is proven not to descend from a vibrancy-enabled view.
7. **The focus affordance is an overlay view, and it has been seen.** Screen captures at every supported pane count are part of the evidence bundle, and the sublayer construction is demonstrated failing so the hazard is proven rather than asserted. Focus carries both the attenuation of unfocused panes and the system focus indicator on the focused one. Pane status continues to resolve through the single existing status legend; no second legend is introduced.
8. **The user personally signs off the aesthetic bar against the reference terminals (Ghostty app, Terminal.app, iTerm2) — a hard gate, no engineer proxy** (user ruling Q5, 2026-07-17). **Design exploration may start early, but final aesthetic signoff closes only after the B2 integrated pane** (R3 addendum, atlas, adopted). Signoff is recorded against side-by-side captures at the reviewed commit.
9. System appearance is followed live, including a mid-session Auto switch, with no app-appearance setting offered. Reduce Transparency, Increase Contrast, and Reduce Motion each produce their specified effect, each demonstrated by toggling during a live session rather than at launch, each driven by the accessibility-options change notification. `NO_COLOR` is honored where Hive emits color.
10. No rendering artifacts across resize, fullscreen, and display-scale changes, demonstrated live — the pre-existing acceptance criterion for this story, unchanged.
11. The engine pin does not move for any aesthetic result, and no M1-B1 or M1-B2 gate is weakened to obtain one. Swift, TypeScript, and Zig tests and typechecks are green at the reviewed commit.
12. The result is project-agnostic: no Hive-repository, Bun, or fixed-layout assumption in any visual decision, demonstrated on a non-Hive project.
13. Fresh external research drives execution; this document and the current implementation are reference material only. The paired documentation cleanup lands with this story: the Workspace design system's terminal principle is corrected, because "the vendor owns every pixel inside a pane" was written against the previous renderer and is now only partly true — Hive supplies the theme the engine consumes, while vendor truecolor output genuinely remains the vendor's. All implementation documentation is behavioral and contains no code file paths or line-number references.

## External documentation

Research verified live 2026-07-19; execution must recheck these sources and record versions rather than relying on this summary. Where a claim could not be verified live it is marked in the text and is not load-bearing.

**Hive stories** (cited by title, per convention):
- **M1-B2 — Host live vendor TUIs in Workspace with HiveTerminalView:** normative for the surface this story styles — the `HiveTerminalView`, the Hive-owned adapter over the pinned manual-I/O engine, cell geometry from the engine's measured font/grid result, and the B2.4 viewer semantics this story's implementation waits on. C1 consumes that behavior and does not alter it.
- **M1-B1 — Qualify GhosttyKit build chain + the manual-I/O bridge:** the engine pin, patch series, and build identity that fix what visual capability is available. C1 may not move the pin.
- **STORY-002 — Complete removal of agent TUI code:** owns the paired terminal/workspace documentation cleanup at the atomic cut; C1 supplies the corrected terminal-theming principle noted in DoD 13.

**Engine capability** — determined by reading the pinned engine tree directly, not from published docs, because published docs describe a moving upstream:
- Pinned engine configuration surface, theme resolution order, and embedded font resources, as vendored at the M1-B1 pin.
- **Ghostty design philosophy:** https://ghostty.org/docs/about
- **Ghostty configuration reference:** https://ghostty.org/docs/config/reference
- **Ghostty theme feature and light/dark pairing:** https://ghostty.org/docs/features/theme
- **Ghostty embedded default font:** https://ghostty.org/docs/config
- **The minimum-contrast tradeoff, in the engine's own tracker:** https://github.com/ghostty-org/ghostty/issues/1524 and https://github.com/ghostty-org/ghostty/discussions/3869
- **SF Mono licensing, as read from the shipped font by a maintainer:** https://github.com/ghostty-org/ghostty/discussions/9614

**Apple guidance:**
- **Materials, the two-layer model, and the content-layer prohibition:** https://developer.apple.com/design/human-interface-guidelines/materials
- **NSVisualEffectView vibrancy rules — leaf views, inheritance, grayscale:** https://developer.apple.com/documentation/appkit/nsvisualeffectview
- **Typography, macOS sizes, text styles, tracking table, weight guidance:** https://developer.apple.com/design/human-interface-guidelines/typography
- **Color, semantic colors, accent behavior, and the both-appearances rule:** https://developer.apple.com/design/human-interface-guidelines/color
- **Dark Mode, the no-app-appearance-setting rule, desktop tinting, 7:1 for small text:** https://developer.apple.com/design/human-interface-guidelines/dark-mode
- **Accessibility contrast ratios and the Reduce Motion checklist:** https://developer.apple.com/design/human-interface-guidelines/accessibility
- **Windows and custom-window-UI warning:** https://developer.apple.com/design/human-interface-guidelines/windows
- **Split views and the thin divider:** https://developer.apple.com/design/human-interface-guidelines/split-views
- **Toolbars and the menu-bar-command requirement:** https://developer.apple.com/design/human-interface-guidelines/toolbars
- **Motion:** https://developer.apple.com/design/human-interface-guidelines/motion
- **NSAppearance and adaptive color preference:** https://developer.apple.com/documentation/appkit/nsappearance
- **Reduce Transparency / Increase Contrast / Reduce Motion APIs:** https://developer.apple.com/documentation/appkit/nsworkspace/accessibilitydisplayshouldreducetransparency

**Standards and evidence:**
- **WCAG 2.2 — the normative contrast standard:** https://www.w3.org/TR/WCAG22/
- **WCAG 3.0 Working Draft — no normative contrast algorithm, no APCA:** https://www.w3.org/TR/wcag-3.0/
- **WCAG 2.1 text spacing as an adaptability criterion:** https://www.w3.org/WAI/WCAG21/Understanding/text-spacing.html
- **Truecolor bypasses the palette; COLORTERM detection:** https://github.com/termstandard/colors
- **Indexed ANSI keeps the user's theme authoritative — a CLI accessibility case study:** https://github.blog/engineering/user-experience/building-a-more-accessible-github-cli/
- **Color vision deficiency prevalence:** https://www.colourblindawareness.org/colour-blindness/types-of-colour-blindness/
- **Light vs dark mode reading evidence, including the small-type effect:** https://www.nngroup.com/articles/dark-mode/
- **NO_COLOR:** https://no-color.org/

**Reference terminals, as design comparison and for the signoff:**
- **iTerm2 minimum contrast, presets, transparency, blur:** https://iterm2.com/documentation-preferences-profiles-colors.html
- **Kitty ligature handling and platform text composition:** https://sw.kovidgoyal.net/kitty/conf/
- **Alacritty symbolic cell colors and scope discipline:** https://alacritty.org/config-alacritty.html
- **Warp themes — accent as a first-class theme field:** https://docs.warp.dev/terminal/appearance/custom-themes
- **Solarized — paired-mode method, CIELAB, stated contrast goal:** https://ethanschoonover.com/solarized/
- **base16/base24 semantic palette structure:** https://github.com/tinted-theming/base24
- **The terminal-specific case against ligatures:** https://practicaltypography.com/ligatures-in-programming-fonts-hell-no.html

## Out of scope

- Any change to terminal transport, input encoding, geometry negotiation, scrollback semantics, selection semantics, or accessibility-tree structure. Those are M1-B2's, and this story may not weaken one of its gates for a visual result.
- Moving the engine pin, or adding an engine patch, to obtain a visual capability. Where the pin cannot do something, this document specifies the available alternative instead.
- Restyling vendor TUI truecolor output. It is not reachable through the palette and it is the vendor's product.
- Importing arbitrary community themes, a theme editor, per-pane themes, background images, and user-supplied fonts. The M1 bar is a small set of measured first-party themes; the generator is structured so further first-party pairs are data, but the import surface is not M1.
- Changing the engine's cursor shaping-break default. It is on, it is kept on, and it is not a knob this story exposes.
- Pane topology changes, tab design, Split Horizon, hierarchy UI, and inspector or navigation redesign.
- Any app-specific appearance setting.

## Open decisions

None requiring queen or user adjudication before implementation. The seams that could have been ambiguous are resolved here: the theme transport is a generated file rather than a per-key API; default configuration locations are never loaded and themes are never resolved by name; the terminal grid font is the engine-embedded face reached by configuring no family at all, because a configured family always outranks an embedded fallback and naming one is how you silently render the wrong face; the system-provided monospaced family is reachable and ships as a non-default labelled option, gated on its private family name being re-verified at each bump; ligatures are off on a byte-fidelity argument rather than a productivity claim, with the engine's cursor shaping break left on beneath that choice; contrast targets WCAG 2.x rather than APCA; the unfocused-pane affordance is Hive chrome as an overlay view rather than engine split configuration; and appearance follows the system unconditionally while the terminal theme remains independently pinnable.

Two values are deliberately left to be set by eye at the C1.5 signoff rather than asserted here, because they are aesthetic judgments that reference comparison should settle: the exact unfocused-pane dim level (starting from the engine's own 0.7 for the same treatment) and the exact minimum-contrast floor (constrained to be low, for the documented reason).
