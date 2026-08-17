import AppKit

/// THE HIVE WORKSPACE DESIGN SYSTEM — tokens. `Theme.Chrome` is the Split Horizon mockup palette from `docs/design/split-horizon-transition.html`. A Workspace screen that does not use these colors is unfinished. Spacing and type stay on the scales below. States are never color alone (`CapsuleBadge`). Missing readings stay visibly unknown (`UsageMeterView`).
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

    /// Split Horizon mockup colors. Values are the prototype's `--app-*` tokens.
    enum Chrome {
        static let bg = mockup(0x091117)
        static let top = mockup(0x111A20)
        static let sidebar = mockup(0x0E171C)
        static let panel = mockup(0x101B22)
        static let panel2 = mockup(0x172630)
        static let navActive = mockup(0x1B3039)
        static let navHover = mockup(0x17272E)
        static let line = mockup(0x263A45)
        static let buttonFill = mockup(0x19272E)
        static let buttonBorder = mockup(0x3B4E58)
        static let text = mockup(0xEDF4F7)
        static let muted = mockup(0x8599A4)
        static let faint = mockup(0x536873)
        static let accent = mockup(0x73D8E8)
        static let accentInk = mockup(0x071216)
        static let green = mockup(0x69D49F)
        static let yellow = mockup(0xEFB161)
        static let red = mockup(0xEC7770)
        static let violet = mockup(0xC1A0DD)

        static func mockup(_ hex: Int, alpha: CGFloat = 1) -> NSColor {
            NSColor(
                srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: alpha)
        }
    }

    /// A named dynamic color resolved per effective appearance. Dark values come from the mockup; light is a readable counterpart, not a reason to drop the mockup in dark.
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
        dark: { Chrome.panel2 })
    static let insetFill = dynamic(
        "hdsInsetFill",
        light: { NSColor.labelColor.withAlphaComponent(0.045) },
        dark: { Chrome.panel })
    static let cardStroke = dynamic(
        "hdsCardStroke",
        light: { NSColor.separatorColor },
        dark: { Chrome.line })

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
