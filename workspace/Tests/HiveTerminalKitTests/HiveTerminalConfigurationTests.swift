import AppKit
import GhosttyKit
import XCTest
@testable import HiveTerminalKit

final class HiveTerminalConfigurationTests: XCTestCase {
    func testShippedFilesKeepThemeBeforePaneSettings() throws {
        let contents = try shippedConfig()

        XCTAssertLessThan(
            try XCTUnwrap(contents.range(of: "background = #0e1318")?.lowerBound),
            try XCTUnwrap(contents.range(of: "font-size = 13")?.lowerBound)
        )
        XCTAssertLessThan(
            try XCTUnwrap(contents.range(of: "palette = 15=#e4e8f0")?.lowerBound),
            try XCTUnwrap(contents.range(of: "keybind = clear")?.lowerBound)
        )
        XCTAssertFalse(contents.contains("font-family"))
        XCTAssertFalse(contents.contains("theme ="))
        XCTAssertFalse(contents.contains("bold-is-bright"))
        XCTAssertFalse(contents.contains("font-shaping-break"))
        XCTAssertTrue(contents.contains("clipboard-read = deny"))
        XCTAssertTrue(contents.contains("clipboard-write = deny"))
        XCTAssertEqual(contents.components(separatedBy: "palette = ").count - 1, 16)
    }

    func testPaneConfigCarriesTypographyPaddingAndCursorPolicy() throws {
        let contents = try shippedConfig()

        for line in [
            "font-size = 13",
            "font-feature = -calt",
            "font-thicken = false",
            "font-thicken-strength = 255",
            "adjust-cell-height = 8%",
            "minimum-contrast = 1.1",
            "window-padding-x = 10",
            "window-padding-y = 8",
            "window-padding-balance = true",
            "window-padding-color = extend",
            "cursor-color = cell-foreground",
            "cursor-text = cell-background",
            "cursor-style = block",
            "cursor-opacity = 1",
        ] {
            XCTAssertTrue(contents.contains(line), "missing \(line)")
        }
    }

    func testDarkThemeContrastMeetsC1Floor() throws {
        let palette = try XCTUnwrap(HiveTerminalTheme.hiveDark.palette)
        XCTAssertGreaterThanOrEqual(
            try WCAGContrast.ratio(palette.foreground, palette.background), 7
        )
        for index in 0..<16 {
            let floor = HiveTerminalPalette.deEmphasisIndices.contains(index) ? 3.0 : 4.5
            XCTAssertGreaterThanOrEqual(
                try WCAGContrast.ratio(palette.ansi[index], palette.background), floor,
                "ANSI \(index) misses its contrast floor"
            )
        }
    }

    func testFactoryLoadsShippedValuesIntoRealGhosttyConfig() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("hive-config-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let surface = try GhosttyBridgeFactory.makeOwnedSurfaceForTesting(
            workingDirectory: directory.path
        )
        defer { surface.free() }
        let config = try XCTUnwrap(surface.appOwner?.config)

        var fontSize: Float = 0
        XCTAssertTrue(getConfigValue(config, key: "font-size", value: &fontSize))
        XCTAssertEqual(fontSize, 13)

        var background = ghostty_config_color_s(r: 0, g: 0, b: 0)
        XCTAssertTrue(getConfigValue(config, key: "background", value: &background))
        XCTAssertEqual([background.r, background.g, background.b], [0x0e, 0x13, 0x18])
    }

    func testRealSurfaceLiveConfigurationUpdateIsIdempotent() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("hive-config-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let surface = try GhosttyBridgeFactory.makeOwnedSurfaceForTesting(
            workingDirectory: directory.path
        )
        defer { surface.free() }
        var operations: [(String, GhosttyOperationPhase)] = []
        surface.operationObserver = { operations.append(($0, $1)) }

        XCTAssertTrue(surface.applyHiveConfiguration())
        XCTAssertFalse(surface.applyHiveConfiguration())

        XCTAssertEqual(operations.map(\.0), ["surfaceUpdateConfig", "surfaceUpdateConfig"])
        XCTAssertEqual(operations.map(\.1), [.begin, .end])
    }

    func testEffectiveAppearanceDrivesLiveSurfaceColorScheme() {
        let engine = FakeManualSurface()
        let view = HiveTerminalView(frame: NSRect(x: 0, y: 0, width: 400, height: 240), engine: engine)

        view.appearance = NSAppearance(named: .darkAqua)
        view.viewDidChangeEffectiveAppearance()
        view.appearance = NSAppearance(named: .aqua)
        view.viewDidChangeEffectiveAppearance()

        XCTAssertEqual(Array(engine.colorSchemeCalls.suffix(2)), [.dark, .light])
    }

    private func shippedConfig() throws -> String {
        let urls = HiveTerminalConfiguration.configurationFiles(
            theme: .hiveDark, font: .embedded, headless: false
        )
        return try urls.map { try String(contentsOf: $0, encoding: .utf8) }.joined(separator: "\n")
    }

    private func getConfigValue<T>(
        _ config: ghostty_config_t,
        key: String,
        value: inout T
    ) -> Bool {
        key.withCString { keyPointer in
            withUnsafeMutablePointer(to: &value) { valuePointer in
                ghostty_config_get(config, valuePointer, keyPointer, UInt(key.utf8.count))
            }
        }
    }
}
