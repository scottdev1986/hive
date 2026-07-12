# Hive Workspace — Visual Audit & Fresh Look-and-Feel Direction

> **Design proposal for future work:** This document describes a proposed re-skin direction, not the current app. Its three bug findings—buried status border, contradictory status legends, and unknown status rendering as healthy—were implemented in `6b286e0`. Read this proposal alongside [`docs/architecture/hive-workspace-design-system.md`](../architecture/hive-workspace-design-system.md), the system on which any re-skin must build.

| Field | Value |
| --- | --- |
| Status | Design proposal (read-only investigation). **No product code.** |
| Author | cole (Hive writer agent) |
| Date | 2026-07-12 |
| Scope | Entire Workspace AppKit app (`workspace/`) — every visual surface that exists today, plus what a coherent refresh requires |
| Stack | Native macOS AppKit, Swift 5.10 / SPM, macOS 14+. **Zero SwiftUI. Zero HTML/CSS/JS.** Layout = `NSView` + Auto Layout. Theming = `NSAppearance`. Terminals = SwiftTerm **1.11.2 pinned** (do not bump; 1.12 Metal breaks universal release builds). |
| Quality bar | Beautiful, modern, responsive — ChatGPT/Claude *settings* polish as the bar for chrome and panels; **macOS HIG** as the bar for the whole app. This must feel like a Mac app, not a web page in a window. |
| Design-system owner | **clinton** (Model Control Center / settings screen). This doc **does not invent a competing system**. It says what the rest of the app needs from the system clinton is building, and how each surface should look once it lands. Governing settings spec: [`docs/architecture/model-control-center-settings-ui.md`](../architecture/model-control-center-settings-ui.md). Blueprint visual law: [`docs/architecture/hive-workspace-blueprint.md`](../architecture/hive-workspace-blueprint.md) (“Hyprland inspires behavior; the visual language is macOS HIG”). |
| Code measured | `workspace/Sources/HiveWorkspace/*` (~AppKit shell) + `WorkspaceCore` (status/layout math). ~3,700 lines of Swift in those trees. |

---

## Verdict up front (be honest)

**The app’s real problem is not that it is ugly. It is that several of its designed decorations are invisible, and the rest of the chrome is unfinished native rather than wrong.**

What already works and should be *kept*:

- Blueprint principle is correct: **HIG materials, system fonts, SF Symbols, semantic colors**. Do not pivot to a Hyprland-skinned tiling aesthetic. That was rejected in the blueprint for good reasons (appearance adaptation, accessibility, familiarity).
- Pane architecture is sound: header + terminal content + separate focus and status signals + accessibility actions on one command model.
- Focus is now honest: `PaneFocusRingView` follows the real first responder and key-window state (chris, `964a265`).
- Feed honesty is mostly right in the model: unknown words → gray dots; feed-lost → disconnected; silent feeds must not look healthy (see `ProjectState`, `FeedStatusMap`, `AppDelegate.announceFeedFailure`).

What is actually broken or incomplete:

1. **The status border has never been visible** — same buried-layer class as the old focus ring. Confirmed in source today.
2. **Two competing colour legends** (border vs header dot) teach the user two different “green means X” stories.
3. **No design system** — only a thin `Theme.swift`. Hardcoded metrics are scattered; panels are bare AppKit defaults.
4. **Attention / Projects / placeholder / feed-failure** are functional but sparse; empty and reconnecting states are mostly missing as *UI*.
5. **Settings does not exist yet** (clinton). When it lands, it will be the first polished surface — the rest of the app must meet it, not fight it.

**Fresh look-and-feel, stated as a product sentence:**

> A dense, calm Mac tool: system materials and quiet chrome so the *terminals* stay primary; status readable at a glance across a pane grid without hue alone; focus obvious; unknown never looks like healthy; settings-quality panels for anything that is not a terminal.

If “fresh” is read as “web-dashboard cards, heavy glass, decorative gradients, custom typefaces” — **reject that**. It conflicts with the HIG decision and with a tool that is 90% vendor TUIs.

---

## Part 1 — Audit every surface

Inventory is from the code that ships. Surfaces that do not exist yet are called out as **absent**, not audited as ugly.

### Surface map (what the app actually has)

```
┌─ NSApplication ──────────────────────────────────────────────────────┐
│  Main menu bar (MainMenuBuilder)                                      │
│  About panel (system)                                                 │
│  Critical NSAlert (feed permanently dead)                             │
│                                                                        │
│  ┌─ Project window (WorkspaceWindow / ProjectWindowController) ─────┐ │
│  │  title = project folder name · subtitle = "Hive Workspace"        │ │
│  │  NSVisualEffectView material .underWindowBackground               │ │
│  │  10pt inset around LayoutContainerView                            │ │
│  │  ┌─ PaneView ┐  gap 8  ┌─ PaneView ┐                               │ │
│  │  │ header 30 │         │ header 30 │  … master/satellite tree     │ │
│  │  │ ───────── │         │ ───────── │                               │ │
│  │  │ SwiftTerm │         │ SwiftTerm │                               │ │
│  │  └───────────┘         └───────────┘                               │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│  NSPanel "Attention" (AttentionCenter) — utility, floating            │
│  NSPanel "Projects"  (ProjectSwitcherController) — utility, floating  │
│  Placeholder window (no --project) — plain stack of labels            │
└────────────────────────────────────────────────────────────────────────┘

ABSENT today (do not invent chrome for them in this audit as if they ship):
  · Settings / Model Control Center (clinton)
  · Toolbar / sidebar / tab bar
  · Splitter drag handles (layout is tree-driven, not user-draggable)
  · Dock badge / menu-bar extra / notifications center integration
  · In-pane agent feed UI (feed is a subprocess; “agent feed” is not a view)
```

---

### 1.1 Pane chrome — `PaneView`

**What it is.** One tile: rounded card containing header bar + separator + `TerminalPaneView`. Owned by `ProjectWindowController`; frames come from `LayoutTree` solver.

**What it looks like today (from code):**

| Element | Source | Today |
| --- | --- | --- |
| Outer radius | `PaneView.setup` | `layer.cornerRadius = 10`; background `masksToBounds = true` at 10 |
| Background | `NSVisualEffectView` | material `.contentBackground`, blending `.withinWindow`, state `.active` |
| Header height | constraint | **30 pt** fixed |
| Header stack | `NSStackView` | horizontal, spacing **6**, leading 10 / trailing 8 |
| Title | `NSTextField` | `Theme.headerFont` (13 semibold), `.labelColor`, middle truncation |
| Detail | `NSTextField` | `Theme.captionFont` (11), `.secondaryLabelColor`, tail truncation; content = `tool · model · feedStatus · ctx N%` |
| Status icon | `NSImageView` 14×14 | SF Symbol from `Theme.statusSymbol`; **tint from `Theme.dotColor(activity)`** (not border colour) |
| Failure badge | SF Symbol | `exclamationmark.circle.fill`, `.systemRed`, hidden unless `.failed(false)` |
| Promote / close | `NSButton` | unbordered, `.accessoryBarAction`, SF Symbols |
| Header separator | `NSBox` `.separator` | full width under header |
| Status border | `CAShapeLayer` on **`PaneView.layer`** | stroke 2 pt, rounded path inset 1, dash `[6,4]` when disconnected; colour from `Theme.statusColor` |
| Focus ring | `PaneFocusRingView` **last subview** | drawn in `draw(_:)`, not a sublayer; see §1.2 |
| Header focus tint | `headerView.layer.backgroundColor` | accent @ 0.28 active / secondaryLabel @ 0.12 inactive; re-resolved on appearance change |
| Waiting pulse | `CABasicAnimation` on **status border opacity** | 3 cycles × 0.7 s; skipped under Reduce Motion |

**What is wrong:**

1. **BURIED STATUS BORDER (confirmed invisible today).**  
   ```
   PaneView (wantsLayer)
     ├─ layer.sublayers: [statusBorderLayer]   ← painted UNDER subview layers
     ├─ backgroundView (NSVisualEffectView, opaque material fill)
     │    ├─ headerView, separator, contentView
     └─ focusRing (sibling overlay — fixed for focus)
   ```
   Chris fixed the focus ring in `964a265` by moving it to an overlay `NSView`. He left the status border as `layer?.addSublayer(statusBorderLayer)`. That is the **same bug class**. The status border, the dashed disconnected treatment, and the waiting **pulse animation** (which animates that layer’s opacity) are all effectively **never seen**. Users have been reading status from the **14 pt header dot and the detail string only**.

2. **Dual colour systems for one agent.** Border (`PaneStatus`) and dot (`AgentActivity`) disagree by design and by palette:

   | Raw feed word | Border (`statusColor`) | Dot (`dotColor`) |
   | --- | --- | --- |
   | working | blue (running) | **green** |
   | idle | blue (running) | **yellow** |
   | spawning | blue | blue |
   | awaiting-approval / stuck / control-paused | orange | **red** |
   | done | green | **purple** |
   | failed | red | **orange** |
   | dead / unknown / feed-lost | gray (dashed) | gray |

   Theme comments document the *dot* legend (green working, yellow idle, red needs-you…). Blueprint § “State and attention” documents the *border* legend (blue running, amber waiting, green completed…). **Neither is wrong alone; together they are inconsistent.** In a grid of eight panes, the user cannot learn one colour language.

3. **Hardcoded radii/insets** (`10`, `30`, `6`, `14`) live in the view, not in `Theme`. Clinton’s settings work will grow `Theme`; pane metrics should join it, not stay magic numbers.

4. **Header density is mostly fine** for a terminal tool. Compression priority design (dot + name last; detail yields; buttons detach) is good — keep it.

5. **CGColor snapshot for header tint** is handled correctly via `performAsCurrentDrawingAppearance` + `viewDidChangeEffectiveAppearance`. Not a bug. Pattern to reuse when any layer colour remains.

**Verdict:** Highest-impact fix surface. Not a “reskin” until the border is an overlay like the focus ring.

---

### 1.2 Focus ring — `PaneFocusRingView` + `PaneFocusRing`

**What it is.** Active/inactive keyboard-ownership indicator. Geometry constants in `PaneFocusRing`; drawing in overlay view; indicator enum from `WorkspaceCore` (`none` / `active` / `inactive`).

**Today:**

| State | Stroke | Width |
| --- | --- | --- |
| none | (no draw) | — |
| active | `.keyboardFocusIndicatorColor` | 3 (5 if Increase Contrast) |
| inactive (pane holds FR, window not key) | `.secondaryLabelColor` | 2 |

Corner radius **10** (must match pane). `hitTest` returns nil (clicks pass through). Listens to `systemColorsDidChangeNotification` and effective appearance.

**What is wrong:** Little. This is the **correct** pattern. Radius is duplicated with `PaneView` (risk of drift). Header tint alphas (0.28 / 0.12) are strong in dark mode and may wash out the title row on accent-coloured systems — tune, don’t replace.

**Verdict:** Build on this. Do not replace with a sublayer.

---

### 1.3 Terminal content — `TerminalPaneView` + SwiftTerm 1.11.2

**What it is.** Full-bleed `LocalProcessTerminalView` inside the pane. Master runs `hive workspace-orchestrator`; agents run `tmux attach-session`. Mouse reporting rules differ (orchestrator suppresses reporting; agents allow). Scroll coalescing for tmux copy-mode on non-reporting panes.

**Today:** No Hive chrome inside the terminal. No custom palette, no custom font override in app code — SwiftTerm + child TUI own pixels. Environment sets `TERM=xterm-256color`.

**What is wrong (visual only):**

- When the child has not yet spawned (`pendingLaunch` until `commitCellGeometry` with width/height > 40), the pane shows an **empty black/default terminal void** with no loading copy. Acceptable if short; ugly if feed/layout stalls.
- Child exit leaves whatever the terminal last drew; status honesty is only in the header (and the invisible border).
- **No Hive-owned error overlay** for “tmux session gone” vs “agent dead” — feed owns disconnected; terminal may show a shell error line. That split is product-correct; do not paper over it with a fake transcript.

**Risk flag:** Any change to SwiftTerm version, Metal backend, cell metrics, or tmux attach command is **high risk**. Visual refresh must **not** retheme the TUI from outside (vendor colours are the product). At most: outer pane chrome, and maybe a non-interactive placeholder *before* first attach.

**Verdict:** Leave terminal pixels alone. Chrome around them is the job.

---

### 1.4 Pane layout / tiling — `LayoutContainerView`, `LayoutTree`, `LayoutAnimator`

**What it is.** Flipped container; deterministic master (left, ratio clamped 0.55–0.60, default **0.58**) + satellite binary tree. Gap **8 pt**. Window content inset **10 pt**. Layout animation **180 ms** ease-in-out cubic; interruptible; Reduce Motion snaps; terminal geometry commits once at settle.

**Today:** No visible splitters, no drop targets, no gutter chrome — pure gap showing the window material through.

**What is wrong:**

- Gap + inset are fine numbers; they are not tokens yet.
- During animation, frames interpolate freely; no shadow/elevation change (good — avoid carnival motion).
- New panes spawn at 0×0 center and grow — intentional; under Reduce Motion they still snap. Fine.
- **No visual master affordance** beyond size (larger left column). Acceptable; optional subtle “Master” caption in header for master pane only would help without colour.

**Verdict:** Behaviour is good. Cosmetic only: tokenise gap/inset; optional master label. Do not add web-style card shadows on every pane.

---

### 1.5 Window chrome — `ProjectWindowController` / `WorkspaceWindow`

**What it is.** Standard titled window 1280×800 default, min 720×480, tabbing disallowed, subtitle `"Hive Workspace"`. Content = `NSVisualEffectView` `.underWindowBackground` / `.behindWindow` / `.followsWindowActiveState`.

**What is wrong:**

- Subtitle is static marketing text — fine, not wrong.
- No toolbar, no traffic-light integration beyond system, no titlebar accessory for attention count — **opportunity**, not a defect.
- When window resigns key, focus rings go inactive (correct); status dots stay vivid (correct if status is global truth).

**Verdict:** Solid native chrome. Optional later: titlebar accessory badge for attention count (native `NSTitlebarAccessoryViewController`), not a custom titlebar.

---

### 1.6 Attention queue — `AttentionCenter`

**What it is.** Floating `NSPanel` 420×320, titled “Attention”, utility + resizable. `NSTableView` style `.inset`, rowHeight **44**, no header. Cells: severity SF Symbol (18×18, `Theme.severityColor`) + title (`headerFont`) + `project · detail` (`captionFont`, secondary). Double-click / selection activates project+pane; **never** clears the item.

**What is wrong:**

- **No empty state.** Zero rows = blank table. A supervision tool with an empty attention queue should say “Nothing needs you” calmly.
- **No loading / stale feed banner.** If the feed is reconnecting or permanently lost, the queue can show last known items or empty without explanation. Feed-lost marks panes disconnected but does not stamp the panel.
- Cells are hand-built every reload (no reuse id) — performance fine at small N; polish is settings-tier grouping, separators, relative time (“2m ago”), keyboard focus ring on rows.
- Severity colours reuse system red/orange/gray/green — OK, but must align with the **unified** status language in Part 2.
- Panel has no visualEffect material on content (plain scroll view) — slightly poorer than Project Switcher’s popover material.

**Verdict:** Safe cosmetic + empty/stale states. Low behaviour risk if activation semantics stay “focus only.”

---

### 1.7 Project switcher — `ProjectSwitcherController`

**What it is.** Floating panel 380×220, titled “Projects”. `NSVisualEffectView` `.popover` + vertical stack of rows: name (14 semibold — **not** `Theme.headerFont`), summary caption, small “Open” button. Failed count tints summary `.systemRed`.

**What it looks like wrong:**

- Today one launch ≈ one project window, so the switcher is often a **single row** — still valuable for the multi-project future the blueprint describes.
- Typography bypasses `Theme` (14 semibold hardcoded).
- No selection highlight row; only a button — less keyboard-native than a table.
- No empty state if `cardProviders` is empty.
- Cards are not really “cards” (no grouped background per row) — just stack rows. Fine for now; MCC-quality would use inset grouped rows.

**Verdict:** Align type + materials with Theme; optional later table. Low risk.

---

### 1.8 Placeholder (no project) — `AppDelegate.showPlaceholderWindow`

**What it is.** 480×200 titled window, vertical stack: “Hive Workspace” 15 semibold + body in `Theme.bodyFont` secondary, explaining `hive` / `hive init`. No material background — contentView is the stack itself (window default fill).

**What is wrong:**

- Visually the thinnest surface: no icon, no material, no primary button (“Open documentation” is optional; **do not** invent a fake project picker that bypasses CLI contract).
- Copy is honest and should stay. Layout margins 30 — fine.
- Should use same page background token as settings/placeholder family so Dock-launch and Settings feel related.

**Verdict:** Light polish only. Keep CLI-first product truth.

---

### 1.9 Feed-failure alert — `AppDelegate.announceFeedFailure`

**What it is.** `NSAlert` critical, once: “Hive lost its status feed” + informative text that agents still run in tmux. Shown after restart budget exhausted (5 attempts, backoff to 15s).

**What is wrong:** Almost nothing for a critical alert — **system alerts are correct** here. Do not replace with a custom toast that can be missed (the 2026-07-12 incident was exactly “looks healthy while blind”).

**Gap:** While *restarting* (before permanent failure), UI does not show “Reconnecting status feed…” — panes may still show last colours until `feedLost` runs on exit. `onExit` → `feedLost` immediately, then restart — good. During successful life, no chrome indicates feed health. Optional quiet titlebar indicator: live / reconnecting / blind.

**Verdict:** Keep NSAlert. Add a quiet reconnecting/blind indicator in window chrome (not a second modal).

---

### 1.10 Menus — `MainMenuBuilder`

**What it is.** App / Edit / Pane / Agents / Workspace / Window. Standard key equivalents. Agents menu reflects autonomy only when `currentAutonomy != nil` (unknown disables items — correct honesty).

**What is wrong:** No Settings… item yet (clinton will add). No visual issues — menus are system-drawn.

**Verdict:** Fine. Settings entry lands with MCC.

---

### 1.11 App icon — `Resources/AppIcon.*`

Present (icns + iconset). Not audited pixel-by-pixel here. Ensure it remains the only brand mark in Dock; in-app prefer SF Symbols + text over large custom illustration.

---

### 1.12 “Agent feed” as a surface

There is **no feed transcript view**. `FeedClient` is a subprocess. Users see feed *effects* on pane headers/status/attention. Do not propose a feed sidebar unless product reopens the superseded transcript decision (blueprint: native TUIs won).

---

### 1.13 Buried-layer bug hunt (chase hard)

**Mechanism:** AppKit paints a view’s `layer` (and its sublayers) **under** the layers of that view’s **subviews**. Any decoration added as `parent.layer.addSublayer(...)` while an opaque subview (especially `NSVisualEffectView`) covers the bounds is **invisible**.

| Site | Kind | Buried? | Notes |
| --- | --- | --- | --- |
| `PaneView.statusBorderLayer` | `CAShapeLayer` on `PaneView.layer` | **YES — invisible today** | Pulse animates this layer → pulse also invisible |
| Old focus ring (pre-`964a265`) | `CAShapeLayer` on `PaneView.layer` | Was yes; **fixed** | Replaced by `PaneFocusRingView` overlay |
| `PaneFocusRingView` | `draw(_:)` in top sibling | No | Correct pattern |
| `headerView.layer.backgroundColor` | layer bg on header itself | No | Header is the view being filled; subviews are labels/buttons on top of tint — OK |
| `backgroundView.layer.cornerRadius` | mask on VE view | No | Not a decoration under siblings |
| Attention / Switcher / placeholder | no sublayers | No | |
| Terminal / SwiftTerm | own layers | N/A | Do not fight |

**Repo-wide grep of `workspace/Sources` for `addSublayer` / `CAShapeLayer`:** only `statusBorderLayer` remains. **There is no second hidden decoration today** — but the *class* of bug must be a **hard rule in the design system**:

> Never put focus, status, or badge chrome on a parent layer under opaque subviews. Use an overlay `NSView` (see `PaneFocusRingView`) or draw in the topmost non-opaque view.

**Implementation direction for the status border (for whoever implements — not this doc’s code):** mirror focus — e.g. `PaneStatusBorderView: NSView` with `hitTest → nil`, `draw(_:)`, semantic colours, dashed path for disconnected, Increase Contrast wider stroke, optional pulse via view alpha or a short `NSAnimationContext` on the overlay (Reduce Motion → steady). Keep focus ring **outside** status stroke (inset status slightly so active focus does not fully cover status colour — blueprint: “focus ring never overwrites the status border”).

---

### 1.14 Hardcoded colours & metrics inventory

**Colours that are system semantic (good):** `labelColor`, `secondaryLabelColor`, `controlAccentColor`, `keyboardFocusIndicatorColor`, `systemRed/Blue/Green/…` for status, separator `NSBox`.

**Colours / alphas that need Theme tokens (not hex — semantic with documented alpha):**

- Header focus tint: accent **0.28**, secondary **0.12**
- Acknowledged completed/done: green/purple **0.35** alpha
- Default status icon seed `.systemBlue` before first `update`

**Hardcoded metrics to centralise in Theme (clinton-facing request list):**

| Token candidate | Value today | Used by |
| --- | --- | --- |
| `paneCornerRadius` | 10 | PaneView, PaneFocusRing, status path |
| `paneHeaderHeight` | 30 | PaneView |
| `paneHeaderSpacing` | 6 | PaneView |
| `paneHeaderLeading/Trailing` | 10 / 8 | PaneView |
| `statusIconSize` | 14 | PaneView |
| `statusBorderWidth` | 2 | PaneView (invisible) |
| `focusRingWidthActive/Inactive` | 3 / 2 (5 contrast) | PaneFocusRing |
| `layoutGap` | 8 | LayoutMetrics |
| `windowContentInset` | 10 | ProjectWindowController |
| `layoutAnimationDuration` | 0.18 | LayoutTransition |
| `attentionRowHeight` | 44 | AttentionCenter |
| Fonts | 11 / 12 mono / 13 / 13 semibold / 14 / 15 | Theme + outliers |

No raw sRGB hex found in HiveWorkspace sources — **good**. Failure mode is **layer ordering** and **legend inconsistency**, not “#1a1a1a only works in dark.”

---

### 1.15 Empty / loading / error / unknown (honest states)

| Condition | Model behaviour today | Visual today | Gap |
| --- | --- | --- | --- |
| Orchestrator before first feed | `feedStatus: "unknown"`, status `.running` | Gray **dot**, blue **border** (invisible) | Border should also read unknown/disconnected-not-alarm — today border claims “running” while dot says unknown (**known inconsistency**, documented in `ProjectState` comments for the old “running” seed) |
| Unknown feed word | activity `.unknown`, paneStatus defaults `.running` | Gray dot, blue border | Border should not claim healthy blue for unknown words |
| Feed process exit | `markFeedLost` → disconnected + feedStatus unknown | Gray dashed border (**invisible**), gray dots | Border must be visible; optional window badge “Status unavailable” |
| Feed restarting | restart loop | Same as feed-lost until snapshot | Quiet “Reconnecting…” |
| Feed permanently dead | NSAlert once | Modal | Keep |
| Agent done/failed grace | 2 s `PaneCloseGrace` | Final colours then remove | OK if border visible |
| Attention empty | empty table | Blank | Need empty copy |
| Projects empty | empty stack | Blank | Need empty copy |
| Terminal pre-spawn | black/empty term | Void | Optional “Starting…” only if >~300 ms |
| Usage silence (Claude quota) | N/A in pane UI | Settings-only (MCC) | Follow MCC §2.2 — never zero bar |

**Hard product rule (align with MCC):** **Unknown must never render as zero or as healthy.** For panes: unknown ≠ blue “running” border. Prefer gray + `questionmark.circle` / `bolt.horizontal` symbol continuity.

---

## Part 2 — Fresh look-and-feel (coherent language)

Expressed in **AppKit terms**. Targets **clinton’s Theme extension**, not a second design system file tree.

### 2.1 Relationship to clinton’s system

MCC already rules:

- Extend `Theme.swift` — do not fork.
- System materials, semantic colours, light & dark first-class.
- Reduce Motion / Increase Contrast / Reduce Transparency respected.
- Measure-or-unknown honesty for meters.

**This audit adds the rest-of-app contract** that Theme must also own:

```
Theme (single module surface)
├── Type ramp          (below)
├── Spacing scale      (below)
├── Materials          (window / pane / panel / settings page)
├── Status language    (ONE legend for border + dot + attention)
├── Focus tokens       (already half there in PaneFocusRing)
├── Feedback tokens    (danger / warning / unknown / info — shared with MCC badges)
└── Motion tokens      (layout 180 ms, pulse bound, reduce-motion gates)
```

Clinton implements MCC meters/cards using the same Status/Feedback tokens so a “critical” quota badge and a “failed” pane are the same red meaning.

---

### 2.2 Surface / elevation model

| Level | Role | Material / fill | Examples |
| --- | --- | --- | --- |
| **L0 Window** | Desktop backdrop | `NSVisualEffectView` `.underWindowBackground`, blending `.behindWindow`, state `.followsWindowActiveState` | Project window (already) |
| **L1 Pane** | Work surface (terminal host) | `.contentBackground` within window, corner radius token, **no drop shadow** | PaneView |
| **L2 Chrome** | Header strip on pane | Same material as pane; optional focus tint (alpha token); separator `separatorColor` via `NSBox` | Pane header |
| **L3 Panel** | Transient utility | `.popover` or `.sidebar` material; standard `NSPanel` utility chrome | Attention, Projects |
| **L4 Settings page** | Dedicated configuration | MCC: grouped inset cards on `windowBackgroundColor` | clinton MCC |
| **L5 Overlay chrome** | Focus + status rings | **Non-opaque overlay NSViews**, hit-test transparent | PaneFocusRingView, future PaneStatusBorderView |
| **Alert** | Blocking honesty | System `NSAlert` | Feed death |

**Not in the model:** floating shadows under panes, neon borders, glass stacked three deep, custom window traffic lights.

**Reduce Transparency:** when `NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency`, swap VE materials for solid `windowBackgroundColor` / `controlBackgroundColor` (same branch MCC needs).

---

### 2.3 Type ramp

| Token | Font | Size / weight | Use |
| --- | --- | --- | --- |
| `caption` | system | 11 regular | Pane detail, attention detail, helper copy |
| `body` | system | 13 regular | Placeholder body, settings body, panel prose |
| `callout` | system | 13 medium | Settings row labels, attention title if not semibold |
| `header` | system | 13 **semibold** | Pane agent name, attention title |
| `title3` | system | 15 semibold | Placeholder title, settings section |
| `title2` | system | 17 semibold | Settings page title (MCC) |
| `mono` | monospaced system | 12 regular | Future debug; not pane headers (headers stay proportional) |

**Remove outliers:** Project switcher 14 semibold → `header` or `title3` consistently. Do not invent a display face.

**Dense terminal header** keeps 13/11; **settings** may use more breathing room (MCC already) — same tokens, different spacing, not different fonts.

---

### 2.4 Semantic colour — what colour *means*

Colour is **status and attention**, not decoration.

| Meaning | Colour family | Where allowed | Where forbidden |
| --- | --- | --- | --- |
| **Focus / keyboard** | accent / `keyboardFocusIndicatorColor` | Focus ring, header tint, settings focus | Never as agent-health |
| **Working (healthy progress)** | green | Status border + dot | Not for “selected” |
| **Idle (alive, not busy)** | yellow / orange-soft | Dot + border secondary cue | Not for warnings that need action |
| **Needs you** | orange (waiting) / red (failed or needsUser) — see unified legend | Border, dot, attention icon, failure badge | Not idle |
| **Spawning / starting** | blue | Dot + border | Not “selected pane” (accent does that) |
| **Done** | purple (or green if you collapse — pick one; recommend **purple** so done ≠ working green) | Border + dot | — |
| **Failed** | red | Border, badge, attention | — |
| **Unknown / disconnected / no signal** | gray + dashed / hollow symbol | Border, dot, window badge | **Never solid green/blue** |
| **Danger (destructive autonomy, spend)** | red / orange badges | Agents menu context, MCC spend | Pane chrome only if agent failed |
| **Separators / chrome** | `separatorColor`, label colours | Structure | No rainbow chrome |

**Accent colour** is for **human focus**, never for **agent state**. That separation already exists in the blueprint; keep it sacred.

---

### 2.5 Unified status language (replace dual legends)

**One legend. Border and dot agree. Attention icons agree.**

| Activity / state | Border | Dot symbol | Dot/border colour | Non-colour cues |
| --- | --- | --- | --- | --- |
| working | solid | `circle.fill` | **green** | steady |
| idle | solid | `circle.fill` | **yellow** | steady |
| spawning | solid | `circle.fill` | **blue** | optional slow opacity pulse on dot only (Reduce Motion: steady) |
| needs user (approval / stuck / paused) | solid | `hourglass.circle.fill` or `hand.raised.fill` | **orange** | bounded pulse on **status overlay**; attention queue entry |
| failed | solid | `exclamationmark.circle.fill` | **red** | failure badge always until ack |
| done (unacked) | solid | `checkmark.circle.fill` | **purple** | attention entry |
| done (acked) | solid dimmed | same | purple @ ~0.35 | no attention |
| unknown / unrecognized word | **dashed** | `questionmark.circle` | **gray** | never blue “running” |
| disconnected / feed lost / dead | **dashed** | `bolt.horizontal.circle.fill` | **gray** | window-level “Status unavailable” when feed-wide |

**Mapping change for implementers:**  
`Theme.statusColor(for: PaneStatus)` and `Theme.dotColor(for: AgentActivity)` must share one table keyed by the finer activity (or border derives from activity). `FeedStatusMap.paneStatus` today maps unknown → `.running` — **that is a honesty bug for chrome**. Prefer `.disconnected` or a new `.unknown` pane status for unrecognized words and pre-feed orchestrator, while **not** treating unknown as an alarm in the attention queue.

**Accessibility:** every state differs by **(1) symbol shape, (2) solid vs dashed border, (3) optional badge, (4) colour**. Increase Contrast: thicker border (match focus ring’s 5 pt path). Colour-blind: dashed + symbol carry the load.

**At-a-glance grid (ASCII mockup):**

```
┌─────────────────────────────┐  ┌─────────────────────────────┐
│ ● cole    claude · working  │  │ ● dana    codex · idle      │
│   ctx 42%                   │  │   ctx 11%                   │
│╔═══════════════════════════╗│  │─────────────────────────────│
│║ (green solid border)      ║│  │ (yellow solid border)       │
│║  terminal…                ║│  │  terminal…                  │
└─────────────────────────────┘  └─────────────────────────────┘
  ● = green                        ● = yellow

┌─────────────────────────────┐  ┌ - - - - - - - - - - - - - - ┐
│ ● eric  awaiting-approval   │  │ ○ root   unknown            │
│ ⚠                     [×]   │  │                             │
│╔═══════════════════════════╗│  │ (gray DASHED border)        │
│║ (orange solid + pulse)    ║│  │  terminal still live        │
└─────────────────────────────┘  └ - - - - - - - - - - - - - - ┘
  ● = orange · hourglass            ○ = gray · questionmark

Focus (active key window) — accent ring OUTSIDE status:
  ╔═════════════════════════════╗  ← accent focus ring (3–5 pt)
  ║ ┌─────────────────────────┐ ║  ← status colour (2–3 pt)
  ║ │ header…                 │ ║
  ║ │ terminal…               │ ║
  ║ └─────────────────────────┘ ║
  ╚═════════════════════════════╝
```

---

### 2.6 Focus and selection

- **Keep `PaneFocusRingView`.** Status becomes a sibling overlay, not a competitor architecture.
- Active: `keyboardFocusIndicatorColor` + header accent tint.
- Inactive key ownership: secondary label stroke, weaker tint — shape preserved.
- Selection in panels: standard `NSTableView` selection, not custom CSS-like highlights.
- Never encode focus only as header tint (ring is required for spatial grids).

---

### 2.7 Density and rhythm

**Spacing scale (pt):** 2, 4, **6**, **8**, **10**, 12, 16, 24, 30.

| Context | Rhythm |
| --- | --- |
| Between panes | gap **8** (keep) |
| Window edge to tiles | inset **10** (keep) |
| Header internal | 6–10 (keep; name/dot priority rules stay) |
| Panel edge insets | 14 (switcher already) |
| Settings cards | MCC: more air (16–20) — denser tool outside, calmer settings inside |

Whitespace belongs **between** panes (gap showing L0 material), not as huge empty margins inside a 30 pt header. This is a **pro tool**; do not “spacious-UI” the terminal grid.

---

### 2.8 Motion

| Motion | Spec | Reduce Motion |
| --- | --- | --- |
| Layout retarget | 180 ms ease-in-out, interruptible, commit cells once | Instant snap + still one commit |
| Waiting attention pulse | Bounded (~2.1 s), on **status overlay** opacity or line width | Steady orange, no pulse |
| Pane spawn from 0×0 | Current grow-in OK | Snap to final frame |
| Settings disclosure | MCC | Instant |
| Focus ring | No animation required; optional 80 ms fade | Instant |
| Terminal scroll / TUI | Vendor-owned | Do not animate |

**Must not animate:** semantic state transitions that imply work completed (don’t “celebrate” done with confetti); feed-lost; anything that delays status honesty.

---

### 2.9 Light and dark

Both first-class via **semantic colours only** — already the house style.

| Concern | Light | Dark |
| --- | --- | --- |
| Window VE | system material | system material |
| Pane VE | contentBackground | contentBackground |
| Header tint active | accent @ ~0.20–0.28 | accent @ ~0.22–0.30 (tune so label stays `.labelColor` readable) |
| Status green/yellow on dark | system colours (adapt) | same API |
| Dashed gray border | systemGray | systemGray |
| Panels | popover material | popover material |

Do not design dark as invert(light). Do not ship hex pairs.

---

### 2.10 Empty / loading / error mockups

**Attention empty:**

```
┌─ Attention ──────────────────────────┐
│                                       │
│         ✓  Nothing needs you          │
│     Agents will appear here when      │
│     they block, fail, or finish.      │
│                                       │
└───────────────────────────────────────┘
```

**Feed reconnecting (titlebar accessory or pane strip, not modal):**

```
Window title:  my-project
             [ ⟳ Reconnecting status… ]
```

**Feed blind (after alert dismissed, persistent quiet chrome):**

```
[ ⚠ Status feed unavailable — agent state frozen ]
```

**Unknown pane header:**

```
○ orchestrator    unknown
  (gray dashed border; not blue)
```

---

### 2.11 What “beautiful / modern / responsive” means here

| Phrase | Means in this app | Does not mean |
| --- | --- | --- |
| Beautiful | Correct materials, legible type, visible status, calm hierarchy | Illustration-heavy onboarding, skeuomorphic tiles |
| Modern | Current HIG (inset tables, VE materials, SF Symbols) | Web glassmorphism, custom cursors |
| Responsive | Auto Layout compression, panel resize, Increase Contrast, dynamic accent/appearance | CSS breakpoints / fluid type scales |

ChatGPT/Claude **settings** quality → apply to **Attention, Projects, Placeholder, future Settings**. The **terminal grid** stays denser and quieter than a settings page on purpose.

---

## Part 3 — Sequence (impact × risk)

Order work so early wins fix what nobody can see, without risking the pty.

| # | Work | Visual impact | Risk | Notes |
| --- | --- | --- | --- | --- |
| **0** | **Status border overlay** (unbury) + stop dual-legend | **Critical** — reveals designed status for the first time | Medium | Overlay view pattern only; no SwiftTerm; update pulse target; unit-test colours still in WorkspaceCore; smoke still green if selectors stable |
| **1** | **Unify Theme status table** (border = dot = attention) + fix unknown→running | High | Medium | Touches `FeedStatusMap` / `Theme` / possibly attention; behaviour change for unknown chrome — product-correct |
| **2** | **Tokenise metrics into Theme** (radius, gap, fonts, alphas) | Medium (consistency) | Low | Pure refactor if values unchanged; unblocks clinton + rest |
| **3** | Attention panel empty + stale/feed banner + material | Medium | Low | Cosmetic + copy; keep focus-only activation |
| **4** | Project switcher Theme alignment + empty state | Low–medium | Low | |
| **5** | Placeholder material + icon + Theme title token | Low | Low | |
| **6** | Quiet feed health indicator (titlebar accessory) | Medium for trust | Low–medium | Must not steal focus; must not spam |
| **7** | MCC Settings (clinton) | High for settings surfaces | Medium (new feature) | Follow MCC doc; extend Theme |
| **8** | Optional master caption / attention count badge | Low | Low | |
| **9** | Terminal placeholder “Starting…” if spawn slow | Low | **Higher** | Touches TerminalPaneView lifecycle timing — careful; no SwiftTerm fork |
| **🚫** | SwiftTerm bump / Metal / palette override / re-implement TUI chrome | — | **Unacceptable for this refresh** | Pin 1.11.2 |
| **🚫** | Custom non-HIG skin, HTML settings, SwiftUI island without decision | — | Process/architecture | Blueprint forbids visual language drift |

### Safe cosmetic vs behaviour-touching

| Safe cosmetic | Touches behaviour / perception of state |
| --- | --- |
| Materials, fonts, spacing tokens with same numbers | Unifying colours (unknown no longer blue) |
| Empty-state copy | Status border becoming visible (users will *react* to amber/red they never saw) |
| Panel layout polish | Feed health indicator |
| Header tint alpha tweak | Attention severity if remapped |
| Corner radius tokenisation | Anything in TerminalPaneView / tmux / SwiftTerm |

**Terminal panes are where the user works.** Prefer chrome fixes that never change pty size, mouse reporting, or attach commands. A regression there is worse than an ugly attention row.

---

## Implementer checklist (build without asking cole)

1. Add `PaneStatusBorderView` (name flexible) mirroring `PaneFocusRingView`: overlay, `hitTest nil`, `draw` rounded stroke, dashed for disconnected/unknown, semantic `NSColor`, Increase Contrast width, appearance + system color notifications.
2. Remove `statusBorderLayer` from `PaneView.layer` entirely.
3. Inset status path inside focus path (e.g. status inset 3–4 pt when focus active) so both read.
4. Move waiting pulse to the status overlay view.
5. Collapse `Theme.statusColor` / `dotColor` / `severityColor` onto one activity→style map; document the legend once in README (replace dual docs).
6. Change unknown/default pane chrome away from healthy blue.
7. Export spacing/radius/type tokens on `Theme` for MCC + panels.
8. Attention empty state; optional feed banner.
9. Do not bump SwiftTerm. Do not add SwiftUI. Do not invent hex palettes.
10. Smoke: visible focus still tracks first responder; status changes still update accessibility values; layout commit still once per settle.

---

## Explicit non-goals

- Redesigning vendor Claude/Codex/Grok TUI internals.
- Bringing back Hive-owned semantic transcript as primary pane content.
- Multi-window skin, custom traffic lights, or non-native menus.
- A second design-system package alongside clinton’s Theme work.
- “Fresh” as in consumer social-app aesthetics.

---

## Appendix A — File → surface index

| File | Surfaces |
| --- | --- |
| `PaneView.swift` | Pane chrome, buried status border, header, badges, pulse |
| `PaneFocusRingView.swift` | Focus ring overlay (canonical pattern) |
| `TerminalPaneView.swift` | SwiftTerm host, scroll, spawn |
| `LayoutContainerView.swift` | Container + 180 ms animator |
| `ProjectWindowController.swift` | Window, VE background, insets, focus routing |
| `AttentionCenter.swift` | Attention panel |
| `ProjectSwitcher.swift` | Projects panel |
| `AppDelegate.swift` | Placeholder, feed lifecycle, NSAlert, autonomy menu state |
| `MainMenuBuilder.swift` | Menus |
| `Theme.swift` | Status colours, fonts, reduceMotion |
| `WorkspaceCore/Status.swift` | PaneStatus, StatusMotion |
| `WorkspaceCore/AgentFeed.swift` | Feed map, activity, grace |
| `WorkspaceCore/LayoutTree.swift` | gap, masterRatio |
| `WorkspaceCore/LayoutTransition.swift` | duration 0.18 |
| `WorkspaceCore/Attention.swift` | severity order |
| `WorkspaceCore/ProjectState.swift` | header strings, feed-lost, unknown seed |

## Appendix B — Key evidence (line anchors for reviewers)

- Status border sublayer: `PaneView.swift` — `statusBorderLayer` created, `layer?.addSublayer(statusBorderLayer)`, path in `layout()`, stroke in `update(state:)`, pulse on `statusBorderLayer`.
- Focus ring fix rationale: `PaneFocusRingView.swift` file header comment (CAShapeLayer under VE background).
- Dual legends: `Theme.statusColor` vs `Theme.dotColor`; mapping in `FeedStatusMap`.
- Unknown honesty for dots: `FeedStatusMap.activity` default `.unknown`; orchestrator seed comment in `ProjectState.addOrchestrator`.
- Feed death UX: `AppDelegate.announceFeedFailure`, `scheduleFeedRestart`.
- SwiftTerm pin: `workspace/Package.swift` exact `1.11.2`.
- Blueprint HIG law: `docs/architecture/hive-workspace-blueprint.md` product principles.
- MCC Theme extension rule: `docs/architecture/model-control-center-settings-ui.md` §10–11.

---

*End of audit. Product code: none. Next step for the team: implement sequence #0–#1 on a workspace agent branch; clinton continues Theme growth for MCC against the token list in §2.1 / §1.14.*
