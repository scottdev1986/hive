import Foundation

/// The generated Ghostty configuration for Hive-owned terminal surfaces.
/// Theme lines stay first so the later product and security policy wins.
enum HiveTerminalConfiguration {
    static let horizontalPaddingPoints = 10
    static let verticalPaddingPoints = 8

    private static let darkThemeLines = [
        "# Hive C1 dark theme. Colors are inline; no user theme lookup occurs.",
        "background = 0f1117",
        "foreground = e6eaf2",
        "palette = 0=626b7e",
        "palette = 1=ff6b7a",
        "palette = 2=75d39a",
        "palette = 3=e6c978",
        "palette = 4=7aa9ff",
        "palette = 5=c89bff",
        "palette = 6=67d9e8",
        "palette = 7=dde3ec",
        "palette = 8=8d95a7",
        "palette = 9=ff8894",
        "palette = 10=8be3ab",
        "palette = 11=f0d98b",
        "palette = 12=96bbff",
        "palette = 13=d8b6ff",
        "palette = 14=82e3ee",
        "palette = 15=f8fafd",
        "palette-generate = false",
        "bold-color = bright",
        "cursor-color = cell-foreground",
        "cursor-text = cell-background",
        "selection-background = cell-foreground",
        "selection-foreground = cell-background",
    ]

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
        "# Hive owns every app/window/pane action and denies terminal clipboard OSC.",
        "keybind = clear",
        "clipboard-read = deny",
        "clipboard-write = deny",
    ]

    static func contents(headless: Bool = false) -> String {
        var lines = darkThemeLines + overrideLines
        if headless { lines.append("window-vsync = false") }
        return lines.joined(separator: "\n") + "\n"
    }

    static func write(to url: URL, headless: Bool = false) throws {
        try Data(contents(headless: headless).utf8).write(to: url, options: .atomic)
    }

    @discardableResult
    static func writeProcessFile(headless: Bool = false) throws -> URL {
        let suffix = headless ? "test" : "manual"
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(
                "hive-ghostty-\(suffix)-config-\(ProcessInfo.processInfo.processIdentifier).conf")
        try write(to: url, headless: headless)
        return url
    }
}
