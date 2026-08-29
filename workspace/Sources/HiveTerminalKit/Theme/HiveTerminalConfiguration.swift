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
}

/// Colors parsed from a Hive Ghostty theme file. Contrast tests measure this parse so a hex that is not in the file cannot be reported as a pass.
struct HiveTerminalPalette: Equatable, Sendable {
    /// ANSI slots conventionally used for de-emphasis. They carry the 3:1 floor rather than 4.5:1; every other slot carries 4.5:1.
    static let deEmphasisIndices: Set<Int> = [0, 8]

    let background: String
    let foreground: String
    let ansi: [String]

    static func parse(_ contents: String) -> HiveTerminalPalette? {
        var background: String?
        var foreground: String?
        var ansi = Array(repeating: Optional<String>.none, count: 16)
        for raw in contents.split(whereSeparator: \.isNewline) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }
            let parts = line.split(separator: "=", maxSplits: 2).map {
                $0.trimmingCharacters(in: .whitespaces)
            }
            func hex(_ value: String) -> String {
                value.hasPrefix("#") ? String(value.dropFirst()) : value
            }
            if parts.count == 2, parts[0] == "background" {
                background = hex(parts[1])
            } else if parts.count == 2, parts[0] == "foreground" {
                foreground = hex(parts[1])
            } else if parts.count == 3, parts[0] == "palette", let index = Int(parts[1]),
                      (0..<16).contains(index)
            {
                ansi[index] = hex(parts[2])
            }
        }
        guard let background, let foreground else { return nil }
        let slots = ansi.compactMap { $0 }
        guard slots.count == 16 else { return nil }
        return HiveTerminalPalette(background: background, foreground: foreground, ansi: slots)
    }
}

struct HiveTerminalTheme: Equatable, Sendable {
    let identifier: String

    var url: URL { HiveTerminalConfiguration.resourceURL(identifier) }

    var configurationLines: [String] {
        (try? String(contentsOf: url, encoding: .utf8))?
            .split(whereSeparator: \.isNewline)
            .map(String.init) ?? []
    }

    var palette: HiveTerminalPalette? {
        guard let contents = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        return HiveTerminalPalette.parse(contents)
    }

    static let hiveDark = HiveTerminalTheme(identifier: "hive-dark")
    static let hiveLight = HiveTerminalTheme(identifier: "hive-light")
    static let hiveDarkHighContrast = HiveTerminalTheme(identifier: "hive-dark-high-contrast")
    static let hiveLightHighContrast = HiveTerminalTheme(identifier: "hive-light-high-contrast")

    static let firstPartyPairs: [(base: HiveTerminalTheme, increasedContrast: HiveTerminalTheme)] = [
        (hiveDark, hiveDarkHighContrast),
        (hiveLight, hiveLightHighContrast),
    ]
}

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

enum HiveTerminalConfiguration {
    static let horizontalPaddingPoints = 10
    static let verticalPaddingPoints = 8
    static let scrollbackLimitBytes = 48 * 1024 * 1024

    static func liveLogFingerprint(theme: HiveTerminalTheme) -> String {
        let background = theme.palette?.background ?? "custom"
        return "background=\(background) font-size=13"
            + " padding=\(horizontalPaddingPoints)x\(verticalPaddingPoints)"
    }

    static func resourceURL(_ name: String) -> URL {
        guard let url = Bundle.module.url(
            forResource: name,
            withExtension: "conf",
            subdirectory: "GhosttyConfig"
        ) else {
            preconditionFailure("missing GhosttyConfig/\(name).conf")
        }
        return url
    }

    static var productURL: URL { resourceURL("hive") }
    static var systemFontURL: URL { resourceURL("hive-font-system") }
    static var headlessURL: URL { resourceURL("hive-headless") }

    static func configurationFiles(
        theme: HiveTerminalTheme,
        font: HiveTerminalFont,
        headless: Bool
    ) -> [URL] {
        var urls = [theme.url, productURL]
        if font == .systemMonospaced { urls.append(systemFontURL) }
        if headless { urls.append(headlessURL) }
        return urls
    }
}
