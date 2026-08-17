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
        static let sidebarWidth: CGFloat = 188
        static let topBarHeight: CGFloat = 59
        static let cardCornerRadius: CGFloat = 10
        static let insetCornerRadius: CGFloat = 8
        static let badgeCornerRadius: CGFloat = 999
        static let buttonCornerRadius: CGFloat = 7
        static let cardInset: CGFloat = 13
        static let meterTrackHeight: CGFloat = 5
        static let markSize: CGFloat = 20
        static let chainMarkSize: CGFloat = 16
        static let controlMinHeight: CGFloat = 28
        static let chromeControlHeight: CGFloat = 30
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
        static let badge = NSFont.monospacedSystemFont(ofSize: 7, weight: .semibold)
        static let micro = NSFont.monospacedSystemFont(ofSize: 8, weight: .medium)
        static let monoBody = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        static let monoCaption = NSFont.monospacedSystemFont(ofSize: 9.5, weight: .regular)
        static let monoDigits = NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .semibold)

        static let chromeBrand = NSFont.systemFont(ofSize: 11, weight: .semibold)
        static let chromeSubtitle = NSFont.monospacedSystemFont(ofSize: 7, weight: .regular)
        static let chromeNav = NSFont.systemFont(ofSize: 8)
        static let chromeGroup = NSFont.monospacedSystemFont(ofSize: 6, weight: .semibold)
        static let chromeProject = NSFont.systemFont(ofSize: 10, weight: .semibold)
        static let chromeMetadata = NSFont.monospacedSystemFont(ofSize: 7, weight: .regular)
        static let chromeControl = NSFont.systemFont(ofSize: 8, weight: .semibold)
        static let screenSubtitle = NSFont.systemFont(ofSize: 8)
        static let sectionTitle = NSFont.systemFont(ofSize: 12, weight: .semibold)
        static let sectionMetadata = NSFont.systemFont(ofSize: 8)
    }

    enum Chrome {
        static let bg = color(0x091117)
        static let top = color(0x111A20)
        static let sidebar = color(0x0E171C)
        static let panel = color(0x101B22)
        static let panel2 = color(0x172630)
        static let navActive = color(0x1B3039)
        static let navHover = color(0x17272E)
        static let line = color(0x263A45)
        static let buttonFill = color(0x19272E)
        static let buttonBorder = color(0x3B4E58)
        static let buttonHoverFill = color(0x223741)
        static let buttonHoverBorder = color(0x58727F)
        static let text = color(0xEDF4F7)
        static let muted = color(0x8599A4)
        static let faint = color(0x536873)
        static let accent = color(0x73D8E8)
        static let accentInk = color(0x071216)
        static let green = color(0x69D49F)
        static let yellow = color(0xEFB161)
        static let red = color(0xEC7770)
        static let violet = color(0xC1A0DD)

        static func color(_ hex: Int, alpha: CGFloat = 1) -> NSColor {
            NSColor(
                srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: alpha)
        }
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
        dark: { Chrome.bg })
    static let shellChromeFill = dynamic(
        "hdsShellChromeFill",
        light: { rgb(250, 252, 252) },
        dark: { Chrome.top })
    static let sidebarFill = dynamic(
        "hdsSidebarFill",
        light: { rgb(238, 244, 246) },
        dark: { Chrome.sidebar })
    static let sidebarContextFill = dynamic(
        "hdsSidebarContextFill",
        light: { rgb(247, 250, 251) },
        dark: { Chrome.color(0x131F25) })
    static let cardFill = dynamic(
        "hdsCardFill",
        light: { rgb(255, 255, 255) },
        dark: { Chrome.panel })
    static let insetFill = dynamic(
        "hdsInsetFill",
        light: { rgb(239, 245, 247) },
        dark: { Chrome.panel2 })
    static let cardStroke = dynamic(
        "hdsCardStroke",
        light: { rgb(193, 209, 215) },
        dark: { Chrome.line })
    static let strongStroke = dynamic(
        "hdsStrongStroke",
        light: { rgb(145, 170, 180) },
        dark: { Chrome.buttonBorder })

    static let primaryText = dynamic(
        "hdsPrimaryText",
        light: { rgb(18, 33, 39) },
        dark: { Chrome.text })
    static let secondaryText = dynamic(
        "hdsSecondaryText",
        light: { rgb(72, 94, 103) },
        dark: { Chrome.muted })
    static let tertiaryText = dynamic(
        "hdsTertiaryText",
        light: { rgb(101, 123, 132) },
        dark: { Chrome.faint })

    static let accent = dynamic(
        "hdsAccent",
        light: { rgb(18, 139, 158) },
        dark: { Chrome.accent })
    static let accentFill = dynamic(
        "hdsAccentFill",
        light: { rgb(213, 241, 245) },
        dark: { Chrome.navActive })
    static let sidebarHoverFill = dynamic(
        "hdsSidebarHoverFill",
        light: { rgb(224, 235, 239) },
        dark: { Chrome.navHover })
    static let accentInk = dynamic(
        "hdsAccentInk",
        light: { rgb(247, 253, 254) },
        dark: { Chrome.accentInk })
    static let positive = dynamic(
        "hdsPositive",
        light: { rgb(25, 137, 87) },
        dark: { Chrome.green })
    static let warning = dynamic(
        "hdsWarning",
        light: { rgb(170, 105, 9) },
        dark: { Chrome.yellow })
    static let critical = dynamic(
        "hdsCritical",
        light: { rgb(190, 47, 57) },
        dark: { Chrome.red })
    static let violet = dynamic(
        "hdsViolet",
        light: { rgb(112, 67, 155) },
        dark: { Chrome.violet })

    static let buttonFill = dynamic(
        "hdsButtonFill",
        light: { rgb(238, 244, 246) },
        dark: { Chrome.buttonFill })
    static let buttonBorder = dynamic(
        "hdsButtonBorder",
        light: { rgb(145, 170, 180) },
        dark: { Chrome.buttonBorder })
    static let buttonHoverFill = dynamic(
        "hdsButtonHoverFill",
        light: { rgb(224, 235, 239) },
        dark: { Chrome.buttonHoverFill })
    static let buttonHoverBorder = dynamic(
        "hdsButtonHoverBorder",
        light: { rgb(112, 146, 158) },
        dark: { Chrome.buttonHoverBorder })
    static let warningButtonBorder = dynamic(
        "hdsWarningButtonBorder",
        light: { rgb(184, 132, 52) },
        dark: { Chrome.color(0x6D552E) })
    static let criticalButtonBorder = dynamic(
        "hdsCriticalButtonBorder",
        light: { rgb(180, 83, 78) },
        dark: { Chrome.color(0x71403E) })
    static let criticalButtonFill = dynamic(
        "hdsCriticalButtonFill",
        light: { rgb(252, 231, 231) },
        dark: { Chrome.color(0x261615) })
    static let positiveBannerBorder = dynamic(
        "hdsPositiveBannerBorder",
        light: { rgb(76, 154, 111) },
        dark: { Chrome.color(0x345E4A) })
    static let criticalBannerBorder = dynamic(
        "hdsCriticalBannerBorder",
        light: { rgb(174, 83, 79) },
        dark: { Chrome.color(0x693E3D) })

    static let meterTrack = dynamic(
        "hdsMeterTrack",
        light: { rgb(211, 222, 226) },
        dark: { Chrome.color(0x26363E) })
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
        dark: { Chrome.color(0x173126) })
    static let warningBadgeFill = dynamic(
        "hdsWarningBadgeFill",
        light: { rgb(251, 238, 211) },
        dark: { Chrome.color(0x2A2116) })
    static let criticalBadgeFill = dynamic(
        "hdsCriticalBadgeFill",
        light: { rgb(251, 225, 227) },
        dark: { Chrome.color(0x2A1818) })
    static let infoBadgeFill = dynamic(
        "hdsInfoBadgeFill",
        light: { rgb(213, 241, 245) },
        dark: { Chrome.color(0x17303A) })
    static let neutralBadgeFill = dynamic(
        "hdsNeutralBadgeFill",
        light: { rgb(230, 237, 240) },
        dark: { Chrome.panel2 })

    static let warningSurface = dynamic(
        "hdsWarningSurface",
        light: { rgb(251, 242, 222) },
        dark: { Chrome.color(0x211D16) })
    static let criticalSurface = dynamic(
        "hdsCriticalSurface",
        light: { rgb(252, 231, 231) },
        dark: { Chrome.color(0x251716) })
    static let positiveSurface = dynamic(
        "hdsPositiveSurface",
        light: { rgb(225, 246, 234) },
        dark: { Chrome.color(0x12241C) })

    static let disabledContentAlpha: CGFloat = 0.55
}
