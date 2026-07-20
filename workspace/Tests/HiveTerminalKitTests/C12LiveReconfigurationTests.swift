import AppKit
import CoreImage
import HiveGhosttyC
import IOSurface
import XCTest
@testable import HiveTerminalKit

/// C1.2 — a theme change must reach a *running* pane, not only new ones.
///
/// The hazard this measures is recorded in SessiondPaneTerminal: applying a
/// configuration after `processOutput` was observed to wipe the VT, leaving a
/// blank pane with a full journal. Live re-theming is exactly that sequence, so
/// content preservation is measured at the real engine boundary rather than
/// assumed from the fact that the push returned true.
@MainActor
final class C12LiveReconfigurationTests: XCTestCase {
    private let marker = "hive live retheme marker"

    func testLiveThemeChangeRepaintsWithoutWipingPaneContent() throws {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForConfigurationTesting(
            contents: HiveTerminalConfiguration.contents(theme: .hiveDark, headless: true)
        )
        defer { surface.free() }
        surface.setOcclusion(true)

        XCTAssertEqual(surface.processOutput(bytes: Data(marker.utf8), streamSeq: 0), .success)
        drainMain(until: { surface.readScreenText().contains(self.marker) })
        XCTAssertTrue(
            surface.readScreenText().contains(marker),
            "positive control: the pane must hold content before the theme changes"
        )
        assertBackground(surface, isNear: [0x0f, 0x11, 0x17])

        // The live push: dark -> light on the running surface.
        XCTAssertTrue(surface.applyHiveConfiguration(theme: .hiveLight, font: .embedded))

        assertBackground(surface, isNear: [0xf7, 0xf9, 0xfc])
        XCTAssertTrue(
            surface.readScreenText().contains(marker),
            "the live theme change must not wipe the VT (hubert's blank-pane hazard)"
        )
    }

    /// The push is content-keyed, so re-selecting the same theme is a no-op and
    /// a genuine change is not. Without this, a selector would either thrash the
    /// engine on every redraw or silently ignore the user's choice.
    func testRepeatedThemeSelectionPushesOnlyOnRealChange() throws {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForConfigurationTesting(
            contents: HiveTerminalConfiguration.contents(theme: .hiveDark, headless: true)
        )
        defer { surface.free() }
        // The dedup guard starts empty and is only seeded by a push, so the
        // first apply always reaches the engine -- production depends on that,
        // because the pre-attach theme push must happen. Prime it, then measure
        // the dedup itself.
        XCTAssertTrue(surface.applyHiveConfiguration(theme: .hiveDark, font: .embedded))

        var pushes: [GhosttyOperationPhase] = []
        surface.operationObserver = { name, phase in
            if name == "surfaceUpdateConfig" { pushes.append(phase) }
        }

        XCTAssertFalse(
            surface.applyHiveConfiguration(theme: .hiveDark, font: .embedded),
            "re-selecting the running theme must not push"
        )
        XCTAssertTrue(surface.applyHiveConfiguration(theme: .hiveLight, font: .embedded))
        XCTAssertFalse(surface.applyHiveConfiguration(theme: .hiveLight, font: .embedded))
        XCTAssertTrue(surface.applyHiveConfiguration(theme: .hiveLightHighContrast, font: .embedded))

        XCTAssertEqual(pushes, [.begin, .end, .begin, .end])
    }

    /// A font change alone must reach a live surface. Before C1.2 the font never
    /// reached `contents`, so this push did not happen at all.
    func testLiveFontChangeAloneReachesTheEngine() throws {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForConfigurationTesting(
            contents: HiveTerminalConfiguration.contents(theme: .hiveDark, headless: true)
        )
        defer { surface.free() }

        XCTAssertTrue(surface.applyHiveConfiguration(theme: .hiveDark, font: .embedded))
        XCTAssertFalse(
            surface.applyHiveConfiguration(theme: .hiveDark, font: .embedded),
            "positive control: an unchanged theme and font must not push"
        )
        XCTAssertTrue(
            surface.applyHiveConfiguration(theme: .hiveDark, font: .systemMonospaced),
            "a font change with an unchanged theme must still push"
        )
        let config = try XCTUnwrap(surface.appOwner?.config)
        XCTAssertEqual(try configColor(config, key: "background"), [0x0f, 0x11, 0x17])
    }

    /// Every first-party theme must survive a real push, so a selector cannot
    /// offer an option that the engine rejects.
    func testEveryFirstPartyThemePushesToARunningSurface() throws {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForConfigurationTesting(
            contents: HiveTerminalConfiguration.contents(theme: .hiveDark, headless: true)
        )
        defer { surface.free() }
        surface.setOcclusion(true)

        for theme in [
            HiveTerminalTheme.hiveLight, .hiveLightHighContrast, .hiveDarkHighContrast, .hiveDark,
        ] {
            XCTAssertTrue(
                surface.applyHiveConfiguration(theme: theme, font: .embedded),
                "\(theme.identifier) must push to a running surface"
            )
            let palette = try XCTUnwrap(theme.palette)
            assertBackground(surface, isNear: try rgbBytes(palette.background))
        }
    }

    // MARK: - Helpers

    private func assertBackground(
        _ surface: GhosttyManualSurface,
        isNear expected: [UInt8],
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard let layer = surface.hostView?.layer else {
            return XCTFail("no host layer", file: file, line: line)
        }
        let context = CIContext()
        let deadline = Date().addingTimeInterval(3)
        var last: [UInt8]?
        repeat {
            surface.draw()
            drainMain(for: 0.01)
            if let ioSurface = layer.contents as? IOSurface {
                let image = CIImage(ioSurface: ioSurface)
                if let cgImage = context.createCGImage(image, from: image.extent),
                   let color = NSBitmapImageRep(cgImage: cgImage).colorAt(x: 3, y: 3),
                   let srgb = color.usingColorSpace(.sRGB)
                {
                    let pixel = [srgb.redComponent, srgb.greenComponent, srgb.blueComponent]
                        .map { UInt8(($0 * 255).rounded()) }
                    last = pixel
                    if zip(pixel, expected).allSatisfy({ abs(Int($0) - Int($1)) <= 2 }) { return }
                }
            }
        } while Date() < deadline
        XCTFail(
            "background never reached \(expected); last was \(last.map(String.init(describing:)) ?? "none")",
            file: file, line: line
        )
    }

    /// Expected pixel bytes for an authored hex, through the same validated
    /// parser the contrast table uses.
    private func rgbBytes(_ hex: String) throws -> [UInt8] {
        let (r, g, b) = try WCAGContrast.channels(hex)
        return [r, g, b].map { UInt8(($0 * 255).rounded()) }
    }

    private func configColor(_ config: ghostty_config_t, key: String) throws -> [UInt8] {
        var color = ghostty_config_color_s(r: 0, g: 0, b: 0)
        let found = key.withCString {
            ghostty_config_get(config, &color, $0, UInt(key.utf8.count))
        }
        XCTAssertTrue(found, "missing config key \(key)")
        return [color.r, color.g, color.b]
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
}
