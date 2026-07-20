import Foundation

public enum HiveTerminalFont: String, CaseIterable, Sendable {
    case embedded
    case systemMonospaced

    public var displayName: String {
        switch self {
        case .embedded: "JetBrains Mono (Built In)"
        case .systemMonospaced: "System Monospaced"
        }
    }

    var configurationLines: [String] {
        switch self {
        case .embedded: []
        case .systemMonospaced: ["font-family = .AppleSystemUIFontMonospaced"]
        }
    }
}

/// The authored colors of a first-party Hive theme.
///
/// This is the single source for both the emitted configuration and the
/// measured contrast table: the generator below derives every `background`,
/// `foreground`, and `palette` line from these values, so a color that is not
/// measured cannot reach the engine and a color that is not shipped cannot be
/// measured.
struct HiveTerminalPalette: Equatable, Sendable {
    /// ANSI slots conventionally used for de-emphasis. They carry the 3:1 floor
    /// rather than 4.5:1; every other slot carries 4.5:1.
    static let deEmphasisIndices: Set<Int> = [0, 8]

    let background: String
    let foreground: String
    /// Exactly the ANSI 16. Indices 16-255 stay at the engine's standard values
    /// because hosted programs hardcode the standard 256-color cube.
    let ansi: [String]

    var configurationLines: [String] {
        ["background = \(background)", "foreground = \(foreground)"]
            + ansi.enumerated().map { "palette = \($0.offset)=\($0.element)" }
    }
}

struct HiveTerminalTheme: Equatable, Sendable {
    let identifier: String
    let configurationLines: [String]
    /// The authored colors, when this theme is a first-party paired theme.
    /// Raw-line themes used as test fixtures carry none.
    let palette: HiveTerminalPalette?

    init(identifier: String, configurationLines: [String]) {
        self.identifier = identifier
        self.configurationLines = configurationLines
        self.palette = nil
    }

    /// Cursor and selection resolve against the cell beneath them rather than
    /// from authored hex, which removes the invisible-cursor-on-one-theme bug
    /// class. `bold-color` is emitted; its deprecated alias never is.
    init(identifier: String, comment: String, palette: HiveTerminalPalette) {
        self.identifier = identifier
        self.palette = palette
        self.configurationLines = ["# \(comment)"] + palette.configurationLines + [
            "palette-generate = false",
            "bold-color = bright",
            "cursor-color = cell-foreground",
            "cursor-text = cell-background",
            "selection-background = cell-foreground",
            "selection-foreground = cell-background",
        ]
    }

    static let hiveDark = HiveTerminalTheme(
        identifier: "hive-dark",
        comment: "Hive C1 dark theme. Colors are inline; no user theme lookup occurs.",
        palette: HiveTerminalPalette(
            background: "0f1117",
            foreground: "e6eaf2",
            ansi: [
                "626b7e", "ff6b7a", "75d39a", "e6c978", "7aa9ff", "c89bff", "67d9e8", "dde3ec",
                "8d95a7", "ff8894", "8be3ab", "f0d98b", "96bbff", "d8b6ff", "82e3ee", "f8fafd",
            ]
        )
    )

    /// The light mode is a real design rather than an inverted dark one, but it
    /// is authored against the dark mode: each slot keeps its hue family and
    /// takes the lightness that its own background demands.
    static let hiveLight = HiveTerminalTheme(
        identifier: "hive-light",
        comment: "Hive C1 light theme. Colors are inline; no user theme lookup occurs.",
        palette: HiveTerminalPalette(
            background: "f7f9fc",
            foreground: "1a1e26",
            ansi: [
                "6c7488", "c0263c", "1f7a4d", "8a6a00", "1e5fd0", "8b3fd0", "0f6f80", "3a4150",
                "858da0", "a81d33", "166740", "6f5500", "1a4fae", "7431b3", "0c5b6a", "232833",
            ]
        )
    )

    /// Increased-contrast variants. Apple warns that Increase Contrast in Dark
    /// Mode can *reduce* dark-on-dark contrast, so these are verified to raise
    /// every entry's measured ratio against their base rather than assumed to.
    static let hiveDarkHighContrast = HiveTerminalTheme(
        identifier: "hive-dark-high-contrast",
        comment: "Hive C1 dark theme, increased-contrast variant.",
        palette: HiveTerminalPalette(
            background: "000000",
            foreground: "ffffff",
            ansi: [
                "8e97ab", "ff9aa5", "8fe8b0", "f2d98c", "9dc0ff", "dcb6ff", "8ceaf7", "eef2f8",
                "b3bacb", "ffb8c0", "aef0c6", "f8e6ad", "bcd3ff", "e9cfff", "aef2fb", "ffffff",
            ]
        )
    )

    static let hiveLightHighContrast = HiveTerminalTheme(
        identifier: "hive-light-high-contrast",
        comment: "Hive C1 light theme, increased-contrast variant.",
        palette: HiveTerminalPalette(
            background: "ffffff",
            foreground: "000000",
            ansi: [
                "5a6274", "96001e", "0b5c33", "5c4700", "0b3f96", "5f1f96", "064a58", "2b3040",
                "6e7688", "8a0b26", "074d2a", "4a3800", "07338a", "4e128a", "033d4a", "15181f",
            ]
        )
    )

    /// The four first-party themes, paired base-to-increased-contrast.
    static let firstPartyPairs: [(base: HiveTerminalTheme, increasedContrast: HiveTerminalTheme)] = [
        (hiveDark, hiveDarkHighContrast),
        (hiveLight, hiveLightHighContrast),
    ]
}

/// Which terminal theme the user has chosen.
///
/// This is a *content* choice, not an app-appearance override: Hive follows the
/// system appearance unconditionally for chrome, and `.system` keeps the
/// terminal theme matching it. Pinning a dark terminal theme inside a light
/// appearance is long-standing terminal-profile convention and says nothing
/// about the app's appearance, so no app-appearance setting is offered.
public enum HiveTerminalThemeSelection: String, CaseIterable, Sendable {
    case system
    case dark
    case light

    public var displayName: String {
        switch self {
        case .system: "Match System Appearance"
        case .dark: "Hive Dark"
        case .light: "Hive Light"
        }
    }
}

public enum HiveTerminalAppearance: Sendable {
    case dark
    case light
}

extension HiveTerminalTheme {
    /// Resolves the theme actually pushed to a surface. Increase Contrast
    /// selects the increased-contrast variant of whichever mode won.
    static func resolve(
        selection: HiveTerminalThemeSelection,
        appearance: HiveTerminalAppearance,
        increasedContrast: Bool
    ) -> HiveTerminalTheme {
        let wantsDark: Bool
        switch selection {
        case .system: wantsDark = appearance == .dark
        case .dark: wantsDark = true
        case .light: wantsDark = false
        }
        if wantsDark {
            return increasedContrast ? .hiveDarkHighContrast : .hiveDark
        }
        return increasedContrast ? .hiveLightHighContrast : .hiveLight
    }
}

/// The generated Ghostty configuration for Hive-owned terminal surfaces.
/// Theme lines stay first so the later product and security policy wins.
enum HiveTerminalConfiguration {
    static let horizontalPaddingPoints = 10
    static let verticalPaddingPoints = 8
    static let scrollbackLimitBytes = 48 * 1024 * 1024
    /// Derived from the theme actually being pushed. A constant background here
    /// would report the dark value while a light theme was on the wire.
    static func liveLogFingerprint(theme: HiveTerminalTheme) -> String {
        let background = theme.palette?.background ?? "custom"
        return "background=\(background) font-size=13"
            + " padding=\(horizontalPaddingPoints)x\(verticalPaddingPoints)"
    }

    private static let overrideLines = [
        "# Hive typography and pane metrics.",
        "font-size = 13",
        "font-feature = -calt",
        "font-thicken = false",
        "font-thicken-strength = 255",
        "adjust-cell-height = 8%",
        "minimum-contrast = 1.1",
        "window-padding-x = \(horizontalPaddingPoints)",
        "window-padding-y = \(verticalPaddingPoints)",
        "window-padding-balance = true",
        "window-padding-color = extend",
        "background-opacity = 1",
        "background-blur = false",
        "cursor-style = block",
        "cursor-opacity = 1",
        "mouse-hide-while-typing = true",
        "# Viewer state is retained only to this product-owned memory bound.",
        "scrollback-limit = \(scrollbackLimitBytes)",
        "# Hive owns every app/window/pane action and denies terminal clipboard OSC.",
        "keybind = clear",
        "copy-on-select = false",
        "clipboard-read = deny",
        "clipboard-write = deny",
    ]

    static func contents(
        theme: HiveTerminalTheme = .hiveDark,
        font: HiveTerminalFont = .embedded,
        headless: Bool = false
    ) -> String {
        var lines = theme.configurationLines + font.configurationLines + overrideLines
        if headless { lines.append("window-vsync = false") }
        return lines.joined(separator: "\n") + "\n"
    }

    static func write(
        to url: URL,
        theme: HiveTerminalTheme = .hiveDark,
        font: HiveTerminalFont = .embedded,
        headless: Bool = false
    ) throws {
        try Data(contents(theme: theme, font: font, headless: headless).utf8)
            .write(to: url, options: .atomic)
    }

    @discardableResult
    static func writeProcessFile(
        theme: HiveTerminalTheme = .hiveDark,
        font: HiveTerminalFont = .embedded,
        headless: Bool = false
    ) throws -> URL {
        let suffix = headless ? "test" : "manual"
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(
                "hive-ghostty-\(suffix)-config-\(ProcessInfo.processInfo.processIdentifier).conf")
        try write(to: url, theme: theme, font: font, headless: headless)
        return url
    }
}
