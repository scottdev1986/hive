import AppKit

/// THE HIVE WORKSPACE DESIGN SYSTEM — tokens.
///
/// This file, the components beside it in `DesignSystem/Components/`, and the
/// rules in `docs/architecture/hive-workspace-design-system.md` are the one
/// visual language for the whole app: settings, terminal pane chrome, the
/// agent feed, the attention queue, headers, and status indicators alike.
/// Build new surfaces from these tokens; do not invent parallel ones.
///
/// Ground rules (the doc has the full versions):
/// - System semantic colors and dynamic derivatives only — light/dark, the
///   user's accent color, and Increase Contrast come for free. No hex that
///   works in one appearance.
/// - Spacing, radii, and type come from the scales below, never ad-hoc.
/// - Focus is the system's: `keyboardFocusIndicatorColor` (see
///   `PaneFocusRingView`, the canonical focus treatment).
/// - Motion is subtle, fast, and always behind `Theme.reduceMotion`.
/// - States are never color alone: pair every colored state with a symbol or
///   words (see `CapsuleBadge`).
/// - Honest data display: a missing reading renders as a distinct unknown
///   treatment (see `UsageMeterView`), never as zero.
extension Theme {

    // MARK: Spacing scale (pt)

    /// One spacing scale for every surface. Dense chrome (terminal pane
    /// headers, status rows) uses xs/s; content surfaces use m/l; page-level
    /// composition uses xl/page.
    enum Space {
        /// Hairline gaps inside a row (icon ↔ label, dot ↔ text).
        static let xs: CGFloat = 4
        /// Between related controls; dense-chrome padding.
        static let s: CGFloat = 8
        /// Between rows.
        static let m: CGFloat = 12
        /// Card / panel padding.
        static let l: CGFloat = 16
        /// Between cards / sections.
        static let xl: CGFloat = 24
        /// Page margins.
        static let page: CGFloat = 32
    }

    // MARK: Metrics

    enum Metric {
        /// Cards and floating panels.
        static let cardCornerRadius: CGFloat = 10
        /// Insets nested inside a card.
        static let insetCornerRadius: CGFloat = 8
        /// Small chips and badges.
        static let badgeCornerRadius: CGFloat = 5
        static let meterTrackHeight: CGFloat = 6
        /// Vendor mark in a card header.
        static let markSize: CGFloat = 20
        /// Vendor mark in a dense row.
        static let chainMarkSize: CGFloat = 16
        /// Minimum hit target (HIG).
        static let controlMinHeight: CGFloat = 28
        /// Below this content width, two-column pages stack into one.
        static let twoColumnBreakpoint: CGFloat = 860
        /// The narrowest content width the settings design supports; windows
        /// enforce it rather than rendering broken.
        static let minContentWidth: CGFloat = 540
    }

    // MARK: Motion

    /// Subtle, purposeful, and always optional: check `Theme.reduceMotion`
    /// before animating, and prefer an instant change over a janky tween.
    enum Motion {
        /// Hover/selection feedback.
        static let quick: TimeInterval = 0.12
        /// Disclosure, reflow, and other structural changes.
        static let standard: TimeInterval = 0.22
    }

    // MARK: Type ramp

    /// The app-wide ramp. Roles, not places: a terminal pane header and a
    /// settings card header at the same hierarchy level use the same token.
    /// (The legacy top-level constants `bodyFont` / `monoFont` / `headerFont`
    /// / `captionFont` in Theme.swift predate this ramp and map to `body`,
    /// `monoBody`, `headline`, and `caption`.)
    enum Font {
        /// Page titles (one per window).
        static let largeTitle = NSFont.systemFont(ofSize: 22, weight: .semibold)
        /// Card / group titles.
        static let title = NSFont.systemFont(ofSize: 15, weight: .semibold)
        /// Row-group and pane headers.
        static let headline = NSFont.systemFont(ofSize: 13, weight: .semibold)
        /// Primary content.
        static let body = NSFont.systemFont(ofSize: 13)
        /// Secondary metadata beside body text.
        static let callout = NSFont.systemFont(ofSize: 12)
        /// Fine print, captions, ages, reasons.
        static let caption = NSFont.systemFont(ofSize: 11)
        /// Uppercased section labels; pair with +0.6 kern.
        static let sectionLabel = NSFont.systemFont(ofSize: 11, weight: .semibold)
        /// Badge / chip text.
        static let badge = NSFont.systemFont(ofSize: 10.5, weight: .medium)
        /// Identifiers, paths, model ids — content-sized monospace.
        static let monoBody = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        /// Identifiers in dense rows.
        static let monoCaption = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        /// Numbers that update in place (percentages, counters) — monospaced
        /// digits so they do not jitter.
        static let monoDigits = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium)
    }

    // MARK: Dynamic color helper

    /// A named dynamic color resolved per effective appearance — the one
    /// sanctioned way to give light and dark different derivations of a
    /// semantic color. Never hardcode a hex pair.
    static func dynamic(
        _ name: String,
        light: @escaping () -> NSColor,
        dark: @escaping () -> NSColor
    ) -> NSColor {
        NSColor(name: NSColor.Name(name)) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark() : light()
        }
    }

    // MARK: Surfaces (elevation story: window → card → inset)

    /// Level 1: raised content surfaces over `windowBackgroundColor`.
    static let cardFill = dynamic(
        "hdsCardFill",
        light: { NSColor.controlBackgroundColor },
        dark: { NSColor.white.withAlphaComponent(0.05) })
    /// Level 2: a muted well nested inside a card.
    static let insetFill = dynamic(
        "hdsInsetFill",
        light: { NSColor.labelColor.withAlphaComponent(0.045) },
        dark: { NSColor.white.withAlphaComponent(0.055) })
    /// Hairline stroke on raised surfaces.
    static let cardStroke = dynamic(
        "hdsCardStroke",
        light: { NSColor.separatorColor },
        dark: { NSColor.separatorColor })

    // MARK: Meters

    static let meterTrack = dynamic(
        "hdsMeterTrack",
        light: { NSColor.labelColor.withAlphaComponent(0.10) },
        dark: { NSColor.white.withAlphaComponent(0.12) })
    static let meterFillHealthy = NSColor.controlAccentColor
    static let meterFillWarning = NSColor.systemOrange
    static let meterFillCritical = NSColor.systemRed
    /// The unknown state's dotted treatment — visibly not a fill, never a
    /// track at 0. Unknown must never look like measured-empty.
    static let meterUnknownHatch = dynamic(
        "hdsMeterUnknownHatch",
        light: { NSColor.secondaryLabelColor.withAlphaComponent(0.4) },
        dark: { NSColor.secondaryLabelColor.withAlphaComponent(0.4) })

    // MARK: Badge fills

    static let warningBadgeFill = dynamic(
        "hdsWarningBadgeFill",
        light: { NSColor.systemOrange.withAlphaComponent(0.12) },
        dark: { NSColor.systemOrange.withAlphaComponent(0.18) })
    static let criticalBadgeFill = dynamic(
        "hdsCriticalBadgeFill",
        light: { NSColor.systemRed.withAlphaComponent(0.12) },
        dark: { NSColor.systemRed.withAlphaComponent(0.18) })
    static let infoBadgeFill = dynamic(
        "hdsInfoBadgeFill",
        light: { NSColor.systemBlue.withAlphaComponent(0.10) },
        dark: { NSColor.systemBlue.withAlphaComponent(0.16) })
    static let neutralBadgeFill = dynamic(
        "hdsNeutralBadgeFill",
        light: { NSColor.labelColor.withAlphaComponent(0.07) },
        dark: { NSColor.white.withAlphaComponent(0.09) })

    // MARK: Disabled / overridden content

    /// Whole-surface opacity for content that is present but not effective
    /// (a disabled provider's body, an overridden row). Pair with words —
    /// opacity alone is not a state.
    static let disabledContentAlpha: CGFloat = 0.55
}
