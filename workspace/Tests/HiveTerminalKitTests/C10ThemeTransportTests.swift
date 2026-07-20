import AppKit
import CoreImage
import Darwin
import HiveGhosttyC
import IOSurface
import XCTest
@testable import HiveTerminalKit

@MainActor
final class C10ThemeTransportTests: XCTestCase {
    func testLiveFullThemePushKeepsTheExistingSurfaceAndApp() throws {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        defer { surface.free() }
        let surfaceHandle = try XCTUnwrap(surface.surfaceHandle)
        let appOwner = try XCTUnwrap(surface.appOwner)
        var operations: [(String, GhosttyOperationPhase)] = []
        surface.operationObserver = { operations.append(($0, $1)) }

        XCTAssertTrue(surface.applyHiveConfiguration(theme: .hiveDark))
        XCTAssertFalse(surface.applyHiveConfiguration(theme: .hiveDark))
        XCTAssertTrue(surface.applyHiveConfiguration(theme: proofTheme))

        XCTAssertEqual(surface.surfaceHandle, surfaceHandle)
        XCTAssertTrue(surface.appOwner === appOwner)
        XCTAssertEqual(
            operations.filter { $0.0 == "surfaceUpdateConfig" }.map(\.1),
            [.begin, .end, .begin, .end]
        )
    }

    func testLiveThemePushPreservesCopyOnSelectOverrideAtTheEngine() throws {
        var clipboardWrites: [[GhosttyClipboardContent]] = []
        let clipboard = GhosttyClipboardContext(
            read: { _ in nil },
            write: { _, content in clipboardWrites.append(content) }
        )
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForConfigurationTesting(
            contents: HiveTerminalConfiguration.contents(headless: true),
            clipboardContext: clipboard
        )
        defer { surface.free() }
        let terminal = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 800, height: 480),
            engine: surface
        )
        XCTAssertEqual(surface.processOutput(bytes: Data("theme selection".utf8), streamSeq: 0), .success)
        surface.setOcclusion(true)
        assertRGB(try renderedBackground(surface, matching: [0x0f, 0x11, 0x17]), [0x0f, 0x11, 0x17])

        XCTAssertTrue(surface.applyHiveConfiguration(theme: proofTheme))
        assertRGB(try renderedBackground(surface, matching: [0x18, 0x20, 0x30]), [0x18, 0x20, 0x30])
        terminal.selectAll(nil)
        drainMain(until: { surface.semanticSnapshot()?.selection != nil })
        drainMain(for: 0.1)

        XCTAssertNotNil(surface.semanticSnapshot()?.selection, "positive control: selection must exist")
        XCTAssertTrue(
            clipboardWrites.isEmpty,
            "the product override after the pushed theme must keep copy-on-select disabled"
        )

        var unoverriddenWrites: [[GhosttyClipboardContent]] = []
        let unoverriddenClipboard = GhosttyClipboardContext(
            read: { _ in nil },
            write: { _, content in unoverriddenWrites.append(content) }
        )
        let unoverridden = try GhosttyBridgeFactory.makeManualSurfaceForConfigurationTesting(
            contents: HiveTerminalConfiguration.contents(headless: true),
            clipboardContext: unoverriddenClipboard
        )
        defer { unoverridden.free() }
        let unoverriddenTerminal = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 800, height: 480),
            engine: unoverridden
        )
        XCTAssertEqual(
            unoverridden.processOutput(bytes: Data("theme selection".utf8), streamSeq: 0),
            .success
        )
        try applyWithoutProductOverrides(proofTheme, to: unoverridden)
        unoverriddenTerminal.selectAll(nil)
        drainMain(until: { !unoverriddenWrites.isEmpty })

        XCTAssertFalse(
            unoverriddenWrites.isEmpty,
            "negative control: the same live theme without the product override must copy on selection"
        )
    }

    func testHostileDefaultConfigIsLoadableButCannotAffectHiveExplicitConfig() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let xdg = root.appendingPathComponent("xdg", isDirectory: true)
        let home = root.appendingPathComponent("home", isDirectory: true)
        let ghosttyDirectory = xdg.appendingPathComponent("ghostty", isDirectory: true)
        try FileManager.default.createDirectory(at: ghosttyDirectory, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try Data("background = 010203\nfont-family = Menlo\n".utf8).write(
            to: ghosttyDirectory.appendingPathComponent("config.ghostty"),
            options: .atomic
        )
        defer { try? FileManager.default.removeItem(at: root) }

        try withEnvironment(["HOME": home.path, "XDG_CONFIG_HOME": xdg.path]) {
            let hiveSurface = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
            defer { hiveSurface.free() }
            let hiveConfig = try XCTUnwrap(hiveSurface.appOwner?.config)
            XCTAssertEqual(try configColor(hiveConfig, key: "background"), [0x0f, 0x11, 0x17])

            let defaults = try XCTUnwrap(ghostty_config_new())
            defer { ghostty_config_free(defaults) }
            ghostty_config_load_default_files(defaults)
            ghostty_config_finalize(defaults)
            XCTAssertEqual(
                try configColor(defaults, key: "background"),
                [0x01, 0x02, 0x03],
                "positive control: the planted user config must be visible to the loader Hive refuses"
            )
        }
    }

    private var proofTheme: HiveTerminalTheme {
        HiveTerminalTheme(
            identifier: "c10-proof",
            configurationLines: [
                "# C1.0 full-theme live-push proof.",
                "background = 182030",
                "foreground = f4f7ff",
                "palette = 0=6f7890",
                "palette = 1=ff7f8c",
                "palette = 2=82dda4",
                "palette = 3=edd48a",
                "palette = 4=8ab5ff",
                "palette = 5=d2a9ff",
                "palette = 6=75e0ed",
                "palette = 7=e5eaf2",
                "palette = 8=99a1b2",
                "palette = 9=ff99a3",
                "palette = 10=99e9b5",
                "palette = 11=f4df9d",
                "palette = 12=a5c5ff",
                "palette = 13=e0c3ff",
                "palette = 14=91e9f2",
                "palette = 15=ffffff",
                "palette-generate = false",
                "bold-color = bright",
                "cursor-color = cell-foreground",
                "cursor-text = cell-background",
                "selection-background = cell-foreground",
                "selection-foreground = cell-background",
                "copy-on-select = true",
            ]
        )
    }

    private func configColor(_ config: ghostty_config_t, key: String) throws -> [UInt8] {
        var color = ghostty_config_color_s(r: 0, g: 0, b: 0)
        let found = key.withCString { keyPointer in
            ghostty_config_get(config, &color, keyPointer, UInt(key.utf8.count))
        }
        XCTAssertTrue(found, "missing config key \(key)")
        return [color.r, color.g, color.b]
    }

    private func renderedBackground(
        _ surface: GhosttyManualSurface,
        matching expected: [UInt8]
    ) throws -> [UInt8] {
        let layer = try XCTUnwrap(surface.hostView?.layer)
        let context = CIContext()
        let deadline = Date().addingTimeInterval(2)
        var lastPixel: [UInt8]?
        repeat {
            surface.draw()
            drainMain(for: 0.01)
            if let ioSurface = layer.contents as? IOSurface {
                let image = CIImage(ioSurface: ioSurface)
                if let cgImage = context.createCGImage(image, from: image.extent),
                   let color = NSBitmapImageRep(cgImage: cgImage).colorAt(x: 3, y: 3),
                   let converted = color.usingColorSpace(.sRGB)
                {
                    let pixel = [converted.redComponent, converted.greenComponent, converted.blueComponent]
                        .map { UInt8(($0 * 255).rounded()) }
                    lastPixel = pixel
                    if zip(pixel, expected).allSatisfy({ abs(Int($0) - Int($1)) <= 2 }) {
                        return pixel
                    }
                }
            }
        } while Date() < deadline
        guard let lastPixel else { throw RenderingError.missingBackgroundPixel }
        return lastPixel
    }

    private func assertRGB(
        _ actual: [UInt8],
        _ expected: [UInt8],
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(actual.count, expected.count, file: file, line: line)
        for (actualChannel, expectedChannel) in zip(actual, expected) {
            XCTAssertEqual(actualChannel, expectedChannel, accuracy: 2, file: file, line: line)
        }
    }

    private func applyWithoutProductOverrides(
        _ theme: HiveTerminalTheme,
        to surface: GhosttyManualSurface
    ) throws {
        let config = try GhosttyBridgeFactory.makeExplicitConfiguration(
            contents: theme.configurationLines.joined(separator: "\n") + "\n"
        )
        defer { ghostty_config_free(config) }
        ghostty_surface_update_config(try XCTUnwrap(surface.surfaceHandle), config)
    }

    private func withEnvironment<T>(
        _ values: [String: String],
        body: () throws -> T
    ) throws -> T {
        let prior = values.keys.reduce(into: [String: String?]()) {
            $0[$1] = ProcessInfo.processInfo.environment[$1]
        }
        for (key, value) in values { setenv(key, value, 1) }
        defer {
            for (key, value) in prior {
                if let value { setenv(key, value, 1) } else { unsetenv(key) }
            }
        }
        return try body()
    }

    private func drainMain(for duration: TimeInterval) {
        RunLoop.main.run(until: Date().addingTimeInterval(duration))
    }

    private func drainMain(until condition: () -> Bool) {
        let deadline = Date().addingTimeInterval(2)
        while !condition(), Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
    }

    private enum RenderingError: Error {
        case missingBackgroundPixel
    }
}
