import AppKit

// ThemeTokens.swift
//
// Defines the one visual vocabulary shared by the Workspace shell and its
// screens. The dark palette is deliberately blue-black rather than neutral
// system gray, while every token still resolves through the active appearance.

extension Theme {

    enum Space {
        static let xs: CGFloat = 4
        static let s: CGFloat = 8
        static let m: CGFloat = 12
        static let l: CGFloat = 16
        static let xl: CGFloat = 20
        static let page: CGFloat = 22
    }

    enum Metric {
        static let sidebarWidth: CGFloat = 187
        static let topBarHeight: CGFloat = 60
        static let cardCornerRadius: CGFloat = 9
        static let insetCornerRadius: CGFloat = 8
        static let badgeCornerRadius: CGFloat = 6
        static let meterTrackHeight: CGFloat = 5
        static let markSize: CGFloat = 20
        static let chainMarkSize: CGFloat = 16
        static let controlMinHeight: CGFloat = 26
        static let minContentWidth: CGFloat = 540
    }

    enum Motion {
        static let standard: TimeInterval = 0.18
    }

    enum Font {
        static let largeTitle = NSFont.systemFont(ofSize: 22, weight: .bold)
        static let title = NSFont.systemFont(ofSize: 14, weight: .semibold)
        static let headline = NSFont.systemFont(ofSize: 12, weight: .semibold)
        static let body = NSFont.systemFont(ofSize: 12)
        static let callout = NSFont.systemFont(ofSize: 11)
        static let caption = NSFont.systemFont(ofSize: 10)
        static let sectionLabel = NSFont.systemFont(ofSize: 9, weight: .semibold)
        static let badge = NSFont.systemFont(ofSize: 9.5, weight: .semibold)
        static let micro = NSFont.monospacedSystemFont(ofSize: 8, weight: .medium)
        static let monoBody = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        static let monoCaption = NSFont.monospacedSystemFont(ofSize: 9.5, weight: .regular)
        static let monoDigits = NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .semibold)
    }

    static func dynamic(
        _ name: String,
        light: @escaping () -> NSColor,
        dark: @escaping () -> NSColor
    ) -> NSColor {
        NSColor(name: NSColor.Name(name)) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark() : light()
        }
    }

    private static func rgb(
        _ red: Int, _ green: Int, _ blue: Int, alpha: CGFloat = 1
    ) -> NSColor {
        NSColor(
            srgbRed: CGFloat(red) / 255,
            green: CGFloat(green) / 255,
            blue: CGFloat(blue) / 255,
            alpha: alpha)
    }

    static let workspaceBackground = dynamic(
        "hdsWorkspaceBackground",
        light: { rgb(244, 248, 249) },
        dark: { rgb(5, 15, 21) })
    static let shellChromeFill = dynamic(
        "hdsShellChromeFill",
        light: { rgb(250, 252, 252) },
        dark: { rgb(14, 27, 34) })
    static let sidebarFill = dynamic(
        "hdsSidebarFill",
        light: { rgb(238, 244, 246) },
        dark: { rgb(12, 25, 32) })
    static let cardFill = dynamic(
        "hdsCardFill",
        light: { rgb(255, 255, 255) },
        dark: { rgb(15, 32, 40) })
    static let insetFill = dynamic(
        "hdsInsetFill",
        light: { rgb(239, 245, 247) },
        dark: { rgb(11, 28, 35) })
    static let cardStroke = dynamic(
        "hdsCardStroke",
        light: { rgb(193, 209, 215) },
        dark: { rgb(39, 68, 78) })
    static let strongStroke = dynamic(
        "hdsStrongStroke",
        light: { rgb(145, 170, 180) },
        dark: { rgb(54, 91, 103) })

    static let primaryText = dynamic(
        "hdsPrimaryText",
        light: { rgb(18, 33, 39) },
        dark: { rgb(237, 245, 247) })
    static let secondaryText = dynamic(
        "hdsSecondaryText",
        light: { rgb(72, 94, 103) },
        dark: { rgb(157, 179, 189) })
    static let tertiaryText = dynamic(
        "hdsTertiaryText",
        light: { rgb(101, 123, 132) },
        dark: { rgb(98, 126, 138) })

    static let accent = dynamic(
        "hdsAccent",
        light: { rgb(18, 139, 158) },
        dark: { rgb(99, 214, 229) })
    static let accentFill = dynamic(
        "hdsAccentFill",
        light: { rgb(213, 241, 245) },
        dark: { rgb(22, 55, 65) })
    static let positive = dynamic(
        "hdsPositive",
        light: { rgb(25, 137, 87) },
        dark: { rgb(96, 216, 156) })
    static let warning = dynamic(
        "hdsWarning",
        light: { rgb(170, 105, 9) },
        dark: { rgb(241, 180, 76) })
    static let critical = dynamic(
        "hdsCritical",
        light: { rgb(190, 47, 57) },
        dark: { rgb(255, 107, 114) })

    static let meterTrack = dynamic(
        "hdsMeterTrack",
        light: { rgb(211, 222, 226) },
        dark: { rgb(35, 58, 67) })
    static let meterFillHealthy = accent
    static let meterFillWarning = warning
    static let meterFillCritical = critical
    static let meterUnknownHatch = dynamic(
        "hdsMeterUnknownHatch",
        light: { rgb(128, 150, 159, alpha: 0.55) },
        dark: { rgb(112, 137, 147, alpha: 0.55) })

    static let positiveBadgeFill = dynamic(
        "hdsPositiveBadgeFill",
        light: { rgb(218, 243, 229) },
        dark: { rgb(15, 54, 37) })
    static let warningBadgeFill = dynamic(
        "hdsWarningBadgeFill",
        light: { rgb(251, 238, 211) },
        dark: { rgb(48, 38, 21) })
    static let criticalBadgeFill = dynamic(
        "hdsCriticalBadgeFill",
        light: { rgb(251, 225, 227) },
        dark: { rgb(53, 24, 28) })
    static let infoBadgeFill = accentFill
    static let neutralBadgeFill = dynamic(
        "hdsNeutralBadgeFill",
        light: { rgb(230, 237, 240) },
        dark: { rgb(28, 48, 57) })

    static let disabledContentAlpha: CGFloat = 0.55
}
