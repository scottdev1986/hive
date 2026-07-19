import AppKit
import HiveGhosttyC
import XCTest
@testable import HiveTerminalKit

final class HiveTerminalConfigurationTests: XCTestCase {
    func testGeneratedConfigurationKeepsThemeBeforeOverrides() throws {
        let contents = HiveTerminalConfiguration.contents()

        XCTAssertLessThan(
            try XCTUnwrap(contents.range(of: "background = 0f1117")?.lowerBound),
            try XCTUnwrap(contents.range(of: "font-size = 13")?.lowerBound)
        )
        XCTAssertLessThan(
            try XCTUnwrap(contents.range(of: "palette = 15=f8fafd")?.lowerBound),
            try XCTUnwrap(contents.range(of: "keybind = clear")?.lowerBound)
        )
        XCTAssertFalse(contents.contains("font-family"))
        XCTAssertFalse(contents.contains("theme ="))
        XCTAssertFalse(contents.contains("bold-is-bright"))
        XCTAssertFalse(contents.contains("font-shaping-break"))
        XCTAssertEqual(contents.components(separatedBy: "palette = ").count - 1, 16)
    }

    func testGeneratedConfigurationCarriesC1TypographyPaddingAndCursorPolicy() {
        let contents = HiveTerminalConfiguration.contents()

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
        let colors = configurationColors(HiveTerminalConfiguration.contents())
        let background = try XCTUnwrap(colors["background"])
        let foreground = try XCTUnwrap(colors["foreground"])
        XCTAssertGreaterThanOrEqual(contrast(foreground, background), 7)

        for index in 0..<16 {
            let color = try XCTUnwrap(colors["palette.\(index)"])
            let floor = index == 0 ? 3.0 : 4.5
            XCTAssertGreaterThanOrEqual(
                contrast(color, background), floor,
                "ANSI \(index) misses its contrast floor"
            )
        }
    }

    func testWriterProducesByteExactExplicitFile() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let url = directory.appendingPathComponent("terminal.conf")
        try HiveTerminalConfiguration.write(to: url)
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), HiveTerminalConfiguration.contents())
    }

    func testFactoryLoadsGeneratedValuesIntoRealGhosttyConfig() throws {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        defer { surface.free() }
        let config = try XCTUnwrap(surface.appOwner?.config)

        var fontSize: Float = 0
        XCTAssertTrue(getConfigValue(config, key: "font-size", value: &fontSize))
        XCTAssertEqual(fontSize, 13)

        var background = ghostty_config_color_s(r: 0, g: 0, b: 0)
        XCTAssertTrue(getConfigValue(config, key: "background", value: &background))
        XCTAssertEqual([background.r, background.g, background.b], [0x0f, 0x11, 0x17])
    }

    func testRealSurfaceLiveConfigurationUpdateIsIdempotent() throws {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        defer { surface.free() }
        var operations: [(String, GhosttyOperationPhase)] = []
        surface.operationObserver = { operations.append(($0, $1)) }

        surface.applyHiveConfiguration()
        surface.applyHiveConfiguration()

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

    private func configurationColors(_ contents: String) -> [String: UInt32] {
        var result: [String: UInt32] = [:]
        for line in contents.split(separator: "\n") {
            let parts = line.split(separator: "=", maxSplits: 2).map {
                $0.trimmingCharacters(in: .whitespaces)
            }
            if parts.count == 2, parts[0] == "background" || parts[0] == "foreground" {
                result[parts[0]] = UInt32(parts[1], radix: 16)
            } else if parts.count == 3, parts[0] == "palette" {
                result["palette.\(parts[1])"] = UInt32(parts[2], radix: 16)
            }
        }
        return result
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

    private func contrast(_ lhs: UInt32, _ rhs: UInt32) -> Double {
        let pair = [luminance(lhs), luminance(rhs)].sorted()
        return (pair[1] + 0.05) / (pair[0] + 0.05)
    }

    private func luminance(_ color: UInt32) -> Double {
        let channels = [16, 8, 0].map { shift -> Double in
            let value = Double((color >> UInt32(shift)) & 0xff) / 255
            return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
    }
}
