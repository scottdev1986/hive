# Workspace UI Design System

Updated: 2026-07-14
Source: Hive source tree, 2026-07-14

## Summary

One visual language for the Workspace app: system semantic colors, native controls, honest states. This article records the rules and the hard-won AppKit invariants — the token *values* live in `workspace/Sources/HiveWorkspace/DesignSystem/ThemeTokens.swift` and are deliberately not restated here, because a copy of them would only rot.

## Where the system lives, and what this doc owns

`ThemeTokens.swift` defines `Theme.Space`, `Theme.Metric`, `Theme.Font`, and `Theme.Motion`. Read the values there. The Model Control Center (`workspace/Sources/HiveWorkspace/Settings/`) is the reference implementation: when in doubt, copy what that screen does. If you need a token or component the system lacks, **extend the system, do not invent a private one** — otherwise the app becomes five apps.

What this doc owns is everything the code cannot say: why a rule exists, and which plausible-looking implementation is silently wrong.

## Principles

1. **System semantic colors only.** `labelColor`, `controlAccentColor`, `separatorColor`, the `system*` family, or a dynamic derivative via `Theme.dynamic(_:light:dark:)`. **Never a hex pair.** This is what makes light/dark, the user's accent color, and Increase Contrast free rather than a project.
2. **Native controls, native metrics.** `NSSwitch`, `NSPopUpButton`, system focus rings, ≥ 28 pt hit targets. The Workspace is a Mac app, not a web page in a window.
3. **No fixed-pixel layouts.** Auto Layout with real hugging and compression priorities. Long identifiers truncate with a tail; the `toolTip` carries the full string. A wide layout must define what happens when it gets narrow.
4. **States are never color alone.** Every colored state carries a symbol or words (`CapsuleBadge` enforces this). Opacity alone is not a state either — dimmed content gets a caption saying *why*.
5. **Honest data display.** A missing reading renders as a visibly distinct unknown, never as a zero and never as an empty bar. There is no code path that draws a determinate bar for missing data. Keep it that way everywhere numbers appear.
6. **Motion is subtle and optional.** Durations from `Theme.Motion`; check `Theme.reduceMotion` first. An instant change beats a janky tween.
7. **Terminal pixels are vendor-owned; the chrome around them is the job.** SwiftTerm plus the child TUI own every pixel inside a pane. Do not retheme a vendor's TUI from outside — its colors are its product. At most: outer pane chrome, and a non-interactive placeholder *before* first attach.

## The AppKit invariants

These three cost real incidents. They are not stylistic preferences.

### Use an overlay view, never a sublayer

**AppKit paints a view's `layer` and its sublayers *beneath* the layers of that view's own subviews.** A decoration added with `parent.layer.addSublayer(...)` while an opaque subview — especially an `NSVisualEffectView` background — covers the bounds is **invisible**. Not dim. Not subtle. Absent.

The pane focus ring and the pane status border were both designed, both built, both reviewed, and neither had ever appeared on screen. The fix is a sibling **NSView** added last, hit-test transparent, drawing in `draw(_:)`: `PaneFocusRingView.swift` and `PaneStatusBorderView.swift`, both held as siblings by `workspace/Sources/HiveWorkspace/PaneView.swift:20-21`. Drawing in `draw(_:)` with semantic `NSColor`s also means light/dark and accent changes come free — AppKit resolves them against the view's effective appearance on every redraw. Both views observe `systemColorsDidChangeNotification`.

The historical warning survives in the code at `workspace/Sources/HiveWorkspace/PaneFocusRingView.swift:8`. **Before shipping any decoration, look at it.** A design that has never been seen is not a design.

### A truncating label can resize the window

**A label whose compression resistance is ≥ `NSLayoutPriorityWindowSizeStayPut` (500) grows the WINDOW instead of truncating.** The AppKit default is **750**. So a perfectly ordinary "this long model id truncates with a tooltip" label, left at its defaults, silently instructed the layout pass to widen the window to fit — and the settings window opened absurdly wide (thousands of points, past the screen).

Any soft "fill the available width" constraint must therefore sit **below 500**. The settings reading column is pinned at priority **490** (`workspace/Sources/HiveWorkspace/Settings/SettingsPageController.swift:49-54`), yielding to the hard 720 pt cap so narrow windows get margins and wide windows get a column, never a sprawl. Truncation + `toolTip` is the correct treatment; it just cannot be requested at a priority that outranks the window's right to stay put.

### The SwiftTerm pin is load-bearing

`workspace/Package.swift:20` pins SwiftTerm at **`exact: "1.11.2"`** — the newest release *without* the Metal GPU backend introduced in 1.12.0. Its `Shaders.metal` resource makes the universal release build (`swift build --arch arm64 --arch x86_64`) require the optional Metal toolchain component, which Xcode 26 machines and CI runners often lack or have version-mismatched. **1.12 breaks universal release builds.** The CPU/CoreGraphics renderer is all a TUI multiplexer needs. Do not bump this pin to chase a renderer the product does not use.

The pin has a second consequence worth knowing: 1.11.2 misencodes no-button SGR motion as a button release, which is why the app filters that one packet at the PTY boundary. See [blueprint.md](blueprint.md).

## Honest state: the two rules that were bugs

### One legend, not two

There is exactly **one** status legend. `AgentActivity.appearance` returns a `StatusAppearance(color:symbol:border:)` — the single table at `workspace/Sources/WorkspaceCore/AgentFeed.swift:163-215` — and the AppKit layer renders it through `Theme.statusColor(for:subdued:)` at `workspace/Sources/HiveWorkspace/Theme.swift:9-23`. The `border` is `.solid` or `.dashed`: **dashed means "we cannot see it"** (`disconnected`, `unknown`), so an unreachable agent is distinguishable without relying on color at all.

This replaced a *dual* legend — separate `Theme.dotColor(for:)` and `Theme.statusSymbol(for:)` mappings feeding the header dot while a different mapping fed the border. Two legends is not a style problem, it is a **correctness** problem: two tables drift, and the app then shows a green dot beside a red border and asks the user to adjudicate. Commit 6b286e0 ("make agent status honest and visible") collapsed them. Neither `dotColor` nor `statusSymbol` exists anywhere in `workspace/` today — zero hits. Any doc that names them predates the fix. **A state's color, symbol, and border must come from one place or they will eventually disagree.**

The pane-level counterpart: `PaneStatus.unknown` exists explicitly (`workspace/Sources/WorkspaceCore/Status.swift:8-17`) so an unrecognized feed word can never be silently upgraded to a healthy state. **Unknown never renders as zero or healthy.**

### Meters have four states, not three

`UsageMeterView` renders **four** distinct claims, and the fourth was added because three flattened a real distinction:

- **measured** — a fill. `0%` means a measured zero.
- **stale** — the last percent, desaturated, labelled with its age.
- **unknown** — an *indeterminate* track, no value. "We asked and could not tell."
- **notMetered** — **no track at all** (`workspace/Sources/HiveWorkspace/DesignSystem/Components/UsageMeterView.swift:139-148`; state at `workspace/Sources/WorkspaceCore/ModelControlState.swift:30`).

`.notMetered` exists because *"not metered on this plan"* is a different honesty claim than *"no reading"*. Rendering an absent window as `unknown` blames a probe that answered perfectly: the vendor's plan simply has no such window. The comment in the code is the rule — an indeterminate track "reads as unknown and would blame a probe that answered." **An absence by design must not render as a failure to measure.** (This is the same class of bug as a UI that renders a vendor's missing 5-hour window as a broken reading.)

Near-limit coloring comes from the **remaining** fraction, not a hardcoded used-percent. Meters show percent and reset time only — no vendor publishes an absolute allowance, so absolute counts would be fiction.

## Composition rules

**Surfaces.** Three elevation levels, in order: `windowBackgroundColor` (the page) → `Theme.cardFill` (a raised card with a hairline stroke) → `Theme.insetFill` (a muted well inside a card). Use `CardView` and `InsetPanelView` rather than hand-painting. `CardView.dashed` marks an unavailable resource — the same dashed-means-absent grammar as the status border.

**Badges.** `CapsuleBadge` is the one way to name a state: `.neutral` (calm facts), `.info` (deliberate can't-measure or awaiting-consent), `.warning` (needs attention), `.critical`. Symbol + words, always.

**Focus.** The system focus color, always — `keyboardFocusIndicatorColor`, via the overlay-view pattern above.

**Iconography.** SF Symbols, sized to the text they accompany. Vendor marks are **official assets only**, bundled under `Resources/VendorMarks/` and rendered as template images tinted `labelColor` (`ProviderMarkView`). A missing mark falls back to an SF Symbol plus the text name — never a broken frame, and **never a hand-drawn approximation** of someone else's logo.

**Distribution language (Tasks).** The UI must distinguish the selection modes. Under `choice`, Hive walks the authored category and default chains in order and quota may veto but not reorder a link. Under `auto`, Hive selects among enabled models that fit the category by weighted-fair observed assignments, not by comparing unlike capacity percentages. Never suggest an ensemble — one model runs each task.

**Responsive.** Two-column pages collapse below `Metric.twoColumnBreakpoint`; windows enforce `Metric.minContentWidth` instead of rendering broken. Pages scroll in one `NSScrollView` with a flipped document view; nothing nests scroll views.

**Threading (part of "responsive").** Any `hive` CLI subprocess read runs **off the main thread** — `ModelControlDataSource` is the pattern: background queue, main-queue callbacks, `dispatchPrecondition` guarding the subprocess call. Controls respond instantly from local state; reconciliation follows. A slow or dead read renders a visible loading or failed state — **never a frozen window, and never a stale number wearing a fresh label.**

**Accessibility.** Every interactive element gets a real-words `setAccessibilityLabel`. Hit targets ≥ 28 pt. States survive Increase Contrast and color-blindness because they are words + symbols, not tints.

## Honest open work

The token ramp is still concentrated in the Model Control Center. Pane chrome uses the legacy top-level `Theme` font aliases but does not use `Theme.Space` or `Theme.Metric`. Verified still unbuilt as of 2026-07-14:

- **Pane metrics are not tokenised.** `PaneView.swift` hardcodes `cornerRadius = 10` (:43, :50), `headerStack.spacing = 6` (:95), and a 14 pt status icon (:139-140). These duplicate `Metric.cardCornerRadius` and `Space.xs`/`s` by coincidence, not by reference — they will drift the first time a token moves.
- **Off-ramp fonts in shipped chrome.** The project switcher hardcodes 14-semibold (`workspace/Sources/HiveWorkspace/ProjectSwitcher.swift:66`), a size absent from `Theme.Font`; the placeholder window hardcodes 15-semibold (`workspace/Sources/HiveWorkspace/AppDelegate.swift:413-415`) instead of using the equal-valued `Theme.Font.title` token.
- **The Attention panel has no empty state.** Nothing renders when the queue is clear.
- **No titlebar feed-health indicator.** A feed loss marks every pane disconnected, retries five times, and terminates the Workspace if the feed never returns (`workspace/Sources/HiveWorkspace/AppDelegate.swift:138-197`), but the titlebar itself carries no glanceable retry-health signal.

## See Also

- [Workspace Blueprint](blueprint.md) — panes, feed contract, incidents, and rejected alternatives
- [Model Control Center](../routing/model-control-center.md) — the Settings surface, this system's reference implementation
- [SPEC.md](../../SPEC.md) — the shipping substrate the app renders
