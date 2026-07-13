# Hive Workspace Design System

| Field | Value |
| --- | --- |
| Status | Live — tokens and components shipped in `workspace/Sources/HiveWorkspace/DesignSystem/` |
| Author | clinton (built with the Model Control Center, its reference implementation) |
| Date | 2026-07-12 |
| Audience | Every agent styling any Hive Workspace surface: terminal panes, agent feed, attention queue, headers, status indicators, window chrome, settings |

This is the one visual language for the Workspace app. The Model Control
Center (`Settings/`) is its reference implementation — when in doubt, copy
what that screen does. If you need a token or component this system lacks,
extend the system (and this doc); do not invent a private one, or the app
becomes five apps.

## Where things live

```
workspace/Sources/HiveWorkspace/
├── Theme.swift                    ← pre-existing: status/dot colors, legacy fonts, reduceMotion
├── DesignSystem/
│   ├── ThemeTokens.swift          ← THE TOKENS (extends Theme; start here)
│   └── Components/
│       ├── CardView.swift         ← raised card + InsetPanelView (nested well)
│       ├── CapsuleBadge.swift     ← the one way to name a state
│       ├── UsageMeterView.swift   ← percent meter with honest unknown/stale
│       └── ProviderMarkView.swift ← vendor marks (official, template-tinted)
├── PaneFocusRingView.swift        ← the canonical focus treatment
└── Settings/                      ← the MCC: reference implementation
```

## Principles

1. **System semantic colors only.** `labelColor`, `secondaryLabelColor`,
   `controlAccentColor`, `separatorColor`, the `system*` family — or a dynamic
   derivative built with `Theme.dynamic(_:light:dark:)`. Never a hex pair.
   This is what makes light/dark, the user's accent color, and Increase
   Contrast free.
2. **Native controls, native metrics.** `NSSwitch`, `NSPopUpButton`,
   `NSButton`, system focus rings, ≥ 28 pt hit targets
   (`Theme.Metric.controlMinHeight`). The Workspace is a Mac app, not a web
   page in a window.
3. **No fixed-pixel layouts.** Auto Layout with real hugging/compression
   priorities; long identifiers truncate with a tail (`toolTip` carries the
   full string); wide layouts define what happens when they get narrow.
4. **States are never color alone.** Every colored state carries a symbol or
   words (`CapsuleBadge` enforces this). Opacity alone is not a state either —
   dimmed content gets a caption saying why.
5. **Honest data display.** A missing reading renders as a visibly distinct
   unknown (dotted rule, "Usage unknown", the measured reason) — never as a
   zero, never as an empty bar. `UsageMeterView` has no code path that draws a
   determinate bar for missing data. Keep it that way everywhere numbers
   appear.
6. **Motion is subtle and optional.** Durations from `Theme.Motion`; check
   `Theme.reduceMotion` first; an instant change beats a janky tween.

## Tokens

### Spacing — `Theme.Space`

| Token | pt | Use |
| --- | --- | --- |
| `xs` | 4 | inside a row: icon ↔ label, dot ↔ text |
| `s` | 8 | between related controls; dense-chrome padding (terminal pane headers) |
| `m` | 12 | between rows |
| `l` | 16 | card / panel padding |
| `xl` | 24 | between cards / sections |
| `page` | 32 | page margins |

Dense surfaces (pane headers, status rows, feed lines) live on `xs`/`s`.
Content surfaces live on `m`/`l`. Page composition lives on `xl`/`page`.

### Type — `Theme.Font`

| Token | Spec | Use |
| --- | --- | --- |
| `largeTitle` | 22 semibold | page title, one per window |
| `title` | 15 semibold | card / group titles (provider name) |
| `headline` | 13 semibold | row-group and pane headers |
| `body` | 13 | primary content |
| `callout` | 12 | secondary metadata beside body |
| `caption` | 11 | fine print: ages, reasons, captions |
| `sectionLabel` | 11 semibold + 0.6 kern, uppercased | column/section labels |
| `badge` | 10.5 medium | chip text |
| `monoBody` | 12 mono | identifiers, paths |
| `monoCaption` | 11 mono | identifiers in dense rows (model ids) |
| `monoDigits` | 11 mono-digit medium | numbers that update in place — no jitter |

Legacy `Theme.bodyFont` / `monoFont` / `headerFont` / `captionFont` map to
`body` / `monoBody` / `headline` / `caption`; prefer the ramp in new code.

### Surfaces — elevation story

Three levels, in order: `windowBackgroundColor` (the page) → `Theme.cardFill`
(raised card, `Metric.cardCornerRadius` 10, hairline `Theme.cardStroke`) →
`Theme.insetFill` (a muted well inside a card, radius 8). Use `CardView` and
`InsetPanelView` rather than hand-painting these. A dashed stroke
(`CardView.dashed`) marks an unavailable resource — visibly different without
relying on color.

### Badges — `CapsuleBadge`

Four styles: `.neutral` (calm facts: "Paid overflow off"), `.info` (deliberate
can't-measure or awaiting-consent states: "Off by default"), `.warning` (needs
attention: "Stale reading", "Near limit", provider off), `.critical`
("Critically low", "Plan limit reached"). Symbol + words always.

### Distribution language (Tasks)

Chains are capability + preference, not a strict walk: work spreads across a
category's models by remaining capacity; rank ("Preferred", "2nd") sets
preference and breaks ties. Copy must never say "fallback order" or imply the
top model always runs — and never an ensemble: one model per task.

### Meters — `UsageMeterView`

Percent + reset time only — no vendor publishes an absolute allowance, so
absolute counts are fiction. Three render states: measured (fill; 0% means
measured zero), stale (last percent, desaturated, with its age), unknown
(dotted rule, no track at all). Near-limit coloring comes from *remaining*
fraction thresholds, not a hardcoded used-percent.

### Status colors

Pane status and agent activity dots keep their existing semantics in
`Theme.swift` (`statusColor(for:)`, `dotColor(for:)`) — the README documents
the legend. Status dots pair with the symbol set in `statusSymbol(for:)`.

### Focus

The system focus color, always: `keyboardFocusIndicatorColor` for the ring,
via the pattern in `PaneFocusRingView` — an overlay *view* (never a sublayer,
which paints under opaque subviews), `hitTest` nil, redrawn on
`systemColorsDidChange` and appearance change.

### Motion — `Theme.Motion`

`quick` (0.12 s) for hover/selection feedback; `standard` (0.22 s) for
disclosure and structural reflow, driven by
`NSAnimationContext.runAnimationGroup` with `allowsImplicitAnimation` and a
`window?.layoutIfNeeded()` — see the provider card's expand/collapse. Always
gate on `Theme.reduceMotion`.

### Iconography

SF Symbols, weight `.medium`/`.semibold`, sized to the text they accompany
(9–12 pt in chrome). Vendor marks are official assets only, bundled under
`Resources/VendorMarks/`, rendered as template images tinted `labelColor`
(`ProviderMarkView`); a missing mark falls back to an SF Symbol plus the text
name — never a broken frame, and never a hand-drawn approximation.

## Responsive rules

- Two-column pages collapse to one below
  `Theme.Metric.twoColumnBreakpoint` (860 pt of content width); windows
  enforce `Metric.minContentWidth` (540 pt + margins) instead of rendering
  broken.
- Pages scroll in one `NSScrollView` with a flipped document view; nothing
  nests scroll views.
- Every long label truncates (`byTruncatingTail`) with the full string in
  `toolTip`.

## Threading rule (part of "responsive")

Any `hive` CLI subprocess read runs off the main thread
(`ModelControlDataSource` is the pattern: background queue, main-queue
callbacks, `dispatchPrecondition` guarding the subprocess call). Controls
respond instantly to clicks from local state; reconciliation follows. A slow
or dead read renders a visible loading/failed state — never a frozen window,
never a stale number wearing a fresh label.

## Accessibility

- Every interactive element gets `setAccessibilityLabel` with real words
  (the MCC's copy catalog `MCCCopy` shows the tone).
- Hit targets ≥ 28 pt; full keyboard access works because the controls are
  native.
- States survive Increase Contrast and color-blindness because they are
  words + symbols, not tints.
