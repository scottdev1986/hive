import AppKit

/// THE HIVE WORKSPACE DESIGN SYSTEM — tokens. These tokens and the components beside them form the visual language for the whole app: settings, terminal pane chrome, the agent feed, the attention queue, headers, and status indicators alike. Build new surfaces from these tokens; do not invent parallel ones. Ground rules: - System semantic colors and dynamic derivatives only — light/dark, the user's accent color, and Increase Contrast come for free. No hex that works in one appearance. - Spacing, radii, and type come from the scales below, never ad-hoc. - Focus is the system's: `keyboardFocusIndicatorColor` (see `PaneFocusRingView`, the canonical focus treatment). - Motion is subtle, fast, and always behind `Theme.reduceMotion`. - States are never color alone: pair every colored state with a symbol or words (see `CapsuleBadge`). - Honest data display: a missing reading renders as a distinct unknown treatment (see `UsageMeterView`), never as zero.
extension Theme {

    enum Space {
        static let xs: CGFloat = 4
        static let s: CGFloat = 8
        static let m: CGFloat = 12
        static let l: CGFloat = 16
        static let xl: CGFloat = 24
        static let page: CGFloat = 32
    }

    enum Metric {
        static let cardCornerRadius: CGFloat = 10
        static let insetCornerRadius: CGFloat = 8
        static let badgeCornerRadius: CGFloat = 5
        static let meterTrackHeight: CGFloat = 6
        static let markSize: CGFloat = 20
        static let chainMarkSize: CGFloat = 16
        static let controlMinHeight: CGFloat = 28
        /// Below this content width, two-column pages stack into one. The narrowest content width the settings design supports; windows enforce it rather than rendering broken.
        static let minContentWidth: CGFloat = 540
    }

    enum Motion {
        static let standard: TimeInterval = 0.22
    }

    enum Font {
        static let largeTitle = NSFont.systemFont(ofSize: 22, weight: .semibold)
        static let title = NSFont.systemFont(ofSize: 15, weight: .semibold)
        static let headline = NSFont.systemFont(ofSize: 13, weight: .semibold)
        static let body = NSFont.systemFont(ofSize: 13)
        static let callout = NSFont.systemFont(ofSize: 12)
        static let caption = NSFont.systemFont(ofSize: 11)
        static let sectionLabel = NSFont.systemFont(ofSize: 11, weight: .semibold)
        static let badge = NSFont.systemFont(ofSize: 10.5, weight: .medium)
        static let monoBody = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        static let monoCaption = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        /// Numbers that update in place (percentages, counters) — monospaced digits so they do not jitter.
        static let monoDigits = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium)
    }

    /// A named dynamic color resolved per effective appearance — the one sanctioned way to give light and dark different derivations of a semantic color. Never hardcode a hex pair.
    static func dynamic(
        _ name: String,
        light: @escaping () -> NSColor,
        dark: @escaping () -> NSColor
    ) -> NSColor {
        NSColor(name: NSColor.Name(name)) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark() : light()
        }
    }

    static let cardFill = dynamic(
        "hdsCardFill",
        light: { NSColor.controlBackgroundColor },
        dark: { NSColor.white.withAlphaComponent(0.05) })
    static let insetFill = dynamic(
        "hdsInsetFill",
        light: { NSColor.labelColor.withAlphaComponent(0.045) },
        dark: { NSColor.white.withAlphaComponent(0.055) })
    static let cardStroke = dynamic(
        "hdsCardStroke",
        light: { NSColor.separatorColor },
        dark: { NSColor.separatorColor })

    static let meterTrack = dynamic(
        "hdsMeterTrack",
        light: { NSColor.labelColor.withAlphaComponent(0.10) },
        dark: { NSColor.white.withAlphaComponent(0.12) })
    static let meterFillHealthy = NSColor.controlAccentColor
    static let meterFillWarning = NSColor.systemOrange
    static let meterFillCritical = NSColor.systemRed
    /// The unknown state's dotted treatment — visibly not a fill, never a track at 0. Unknown must never look like measured-empty.
    static let meterUnknownHatch = dynamic(
        "hdsMeterUnknownHatch",
        light: { NSColor.secondaryLabelColor.withAlphaComponent(0.4) },
        dark: { NSColor.secondaryLabelColor.withAlphaComponent(0.4) })

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

    static let disabledContentAlpha: CGFloat = 0.55
}
