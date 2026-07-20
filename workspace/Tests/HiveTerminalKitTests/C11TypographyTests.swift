import AppKit
import CoreImage
import CoreText
import CryptoKit
import HiveGhosttyC
import IOSurface
import XCTest
@testable import HiveTerminalKit

@MainActor
final class C11TypographyTests: XCTestCase {
    func testDefaultTypographyContractAndCellHeightAdjustment() throws {
        let contents = HiveTerminalConfiguration.contents(headless: true)
        XCTAssertFalse(contents.contains("font-family"))
        XCTAssertFalse(contents.contains("font-style"))
        XCTAssertFalse(contents.contains("font-weight"))
        XCTAssertFalse(contents.contains("font-shaping-break"))
        XCTAssertFalse(contents.contains("adjust-cell-width"))
        XCTAssertTrue(contents.contains("font-size = 13\n"))
        XCTAssertTrue(contents.contains("font-feature = -calt\n"))
        XCTAssertTrue(contents.contains("font-thicken = false\n"))
        XCTAssertTrue(contents.contains("font-thicken-strength = 255\n"))
        XCTAssertTrue(contents.contains("adjust-cell-height = 8%\n"))

        let adjusted = try GhosttyBridgeFactory.makeManualSurfaceForConfigurationTesting(
            contents: contents
        )
        defer { adjusted.free() }
        let unadjusted = try GhosttyBridgeFactory.makeManualSurfaceForConfigurationTesting(
            contents: contents.replacingOccurrences(
                of: "adjust-cell-height = 8%",
                with: "adjust-cell-height = 0%"
            )
        )
        defer { unadjusted.free() }

        let adjustedSize = try XCTUnwrap(adjusted.reportedSize())
        let unadjustedSize = try XCTUnwrap(unadjusted.reportedSize())
        XCTAssertEqual(adjustedSize.cellWidthPx, unadjustedSize.cellWidthPx)
        XCTAssertGreaterThan(adjustedSize.cellHeightPx, unadjustedSize.cellHeightPx)
    }

    func testDefaultResolvesThePinnedEmbeddedVariableFaceWithoutSystemLookup() throws {
        XCTAssertEqual(systemDescriptorCount(family: "JetBrains Mono"), 0)
        XCTAssertEqual(systemDescriptorCount(family: "JetBrains Mono Nerd Font"), 0)

        let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        defer { surface.free() }
        let font = try primaryFont(surface)

        XCTAssertEqual(CTFontCopyFamilyName(font) as String, "JetBrains Mono")
        XCTAssertEqual(CTFontCopyPostScriptName(font) as String, "JetBrainsMono-Regular")
        XCTAssertEqual(CTFontGetSize(font), 13, accuracy: 0.01)
        XCTAssertFalse(CTFontGetSymbolicTraits(font).contains(.traitBold))
        let weightAxis = try XCTUnwrap(
            (CTFontCopyVariationAxes(font) as? [[CFString: Any]])?.first {
                ($0[kCTFontVariationAxisNameKey] as? String) == "Weight"
            }
        )
        XCTAssertEqual(weightAxis[kCTFontVariationAxisMinimumValueKey] as? Double, 100)
        XCTAssertEqual(weightAxis[kCTFontVariationAxisDefaultValueKey] as? Double, 400)
        XCTAssertEqual(weightAxis[kCTFontVariationAxisMaximumValueKey] as? Double, 800)
        for (tag, digest) in embeddedVariableTableDigests {
            XCTAssertEqual(try tableDigest(font, tag: tag), digest, "embedded table mismatch: \(tag)")
        }
    }

    func testConfiguredMenloPreemptsTheEmbeddedFace() throws {
        XCTAssertEqual(systemDescriptorCount(family: "JetBrains Mono"), 0)
        XCTAssertGreaterThan(systemDescriptorCount(family: "Menlo"), 0)
        let contents = "font-family = Menlo\n" + HiveTerminalConfiguration.contents(headless: true)
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForConfigurationTesting(contents: contents)
        defer { surface.free() }

        let font = try primaryFont(surface)
        XCTAssertEqual(CTFontCopyFamilyName(font) as String, "Menlo")
        XCTAssertNotEqual(try tableDigest(font, tag: "glyf"), embeddedVariableTableDigests["glyf"])
    }

    func testLabelledSystemMonospacedOptionResolvesItsPrivateFamily() throws {
        let systemFamily = try XCTUnwrap(
            NSFont.monospacedSystemFont(ofSize: 13, weight: .regular).familyName
        )
        XCTAssertEqual(systemFamily, ".AppleSystemUIFontMonospaced")
        XCTAssertEqual(HiveTerminalFont.systemMonospaced.displayName, "System Monospaced")
        XCTAssertGreaterThan(systemDescriptorCount(family: systemFamily), 0)

        let surface = try GhosttyBridgeFactory.makeManualSurfaceForConfigurationTesting(
            contents: HiveTerminalConfiguration.contents(font: .systemMonospaced, headless: true)
        )
        defer { surface.free() }
        XCTAssertEqual(CTFontCopyFamilyName(try primaryFont(surface)) as String, systemFamily)
    }

    func testLigaturesAreDisabledAndCursorShapingBreakRemainsActiveWhenEnabled() throws {
        let disabled = typographyConfiguration(ligatures: false, thickening: false, strength: 255)
        let enabled = typographyConfiguration(ligatures: true, thickening: false, strength: 255)
        let disabledReading = try renderedDigest(configuration: disabled, bytes: Data("!= != !=\r\n".utf8))
        let enabledReading = try renderedDigest(configuration: enabled, bytes: Data("!= != !=\r\n".utf8))
        let disabledCursor = try renderedDigest(configuration: disabled, bytes: Data("!=\u{1b}[2D".utf8))
        let enabledCursor = try renderedDigest(configuration: enabled, bytes: Data("!=\u{1b}[2D".utf8))

        XCTAssertNotEqual(
            disabledReading.digest,
            enabledReading.digest,
            "positive control: enabling calt must change the rendered reading case"
        )
        XCTAssertEqual(
            disabledCursor.digest,
            enabledCursor.digest,
            "the default cursor shaping break must expose the individual bytes even with calt enabled"
        )
        for result in [disabledReading, enabledReading, disabledCursor, enabledCursor] {
            XCTAssertTrue(result.text.contains("!="))
            XCTAssertFalse(result.text.contains("≠"), "the semantic grid must preserve the original bytes")
        }
    }

    func testThickeningEnabledAtZeroIsDistinctFromDisabled() throws {
        let disabled = typographyConfiguration(ligatures: false, thickening: false, strength: 0)
        let enabled = typographyConfiguration(ligatures: false, thickening: true, strength: 0)
        XCTAssertNotEqual(
            try renderedDigest(configuration: disabled, bytes: Data("Hive".utf8)).digest,
            try renderedDigest(configuration: enabled, bytes: Data("Hive".utf8)).digest,
            "strength zero is the lightest thickening, not the disabled state"
        )
    }

    private func primaryFont(_ surface: GhosttyManualSurface) throws -> CTFont {
        let handle = try XCTUnwrap(surface.surfaceHandle)
        let pointer = try XCTUnwrap(ghostty_surface_quicklook_font(handle))
        return Unmanaged<CTFont>.fromOpaque(pointer).takeRetainedValue()
    }

    private func tableDigest(_ font: CTFont, tag: String) throws -> String {
        let value = tag.utf8.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        let data = try XCTUnwrap(CTFontCopyTable(font, CTFontTableTag(value), []))
        return SHA256.hash(data: data as Data).map { String(format: "%02x", $0) }.joined()
    }

    private func systemDescriptorCount(family: String) -> Int {
        let descriptor = CTFontDescriptorCreateWithAttributes(
            [kCTFontFamilyNameAttribute: family] as CFDictionary
        )
        return (CTFontDescriptorCreateMatchingFontDescriptors(descriptor, nil) as? [CTFontDescriptor])?.count ?? 0
    }

    private func typographyConfiguration(
        ligatures: Bool,
        thickening: Bool,
        strength: UInt8
    ) -> String {
        HiveTerminalConfiguration.contents(headless: true)
            .replacingOccurrences(
                of: "font-feature = -calt",
                with: "font-feature = \(ligatures ? "calt" : "-calt")"
            )
            .replacingOccurrences(
                of: "font-thicken = false",
                with: "font-thicken = \(thickening)"
            )
            .replacingOccurrences(
                of: "font-thicken-strength = 255",
                with: "font-thicken-strength = \(strength)"
            )
            .replacingOccurrences(of: "cursor-opacity = 1", with: "cursor-opacity = 0")
    }

    private func renderedDigest(configuration: String, bytes: Data) throws -> (digest: String, text: String) {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForConfigurationTesting(contents: configuration)
        defer { surface.free() }
        let terminal = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 800, height: 480),
            engine: surface
        )
        _ = terminal
        surface.setOcclusion(true)
        XCTAssertEqual(surface.processOutput(bytes: bytes, streamSeq: 0), .success)
        let layer = try XCTUnwrap(surface.hostView?.layer)
        let deadline = Date().addingTimeInterval(2)
        repeat {
            surface.draw()
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        } while layer.contents == nil && Date() < deadline
        let ioSurface = try XCTUnwrap(layer.contents as? IOSurface)
        let image = CIImage(ioSurface: ioSurface)
        let cgImage = try XCTUnwrap(CIContext().createCGImage(image, from: image.extent))
        let data = try XCTUnwrap(cgImage.dataProvider?.data) as Data
        return (
            SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(),
            try XCTUnwrap(surface.semanticSnapshot()).text
        )
    }

    private var embeddedVariableTableDigests: [String: String] {
        [
            "head": "bc49d6fc4a60cfd060a08ae9f61ec6f60c9c1a1aa47dbb65f0b5e33a8a34e4cf",
            "name": "9993a1bafaccd678a27a6ca2aa4991aea747561c30eafcea37017f54cc83398c",
            "fvar": "d7fed7a655ccd91c69b0a5e55dd3965216df651575bf732e6cd25b6a80577eb1",
            "OS/2": "c0116b65d074e53577507f890fb26eef8adc9bdb682ef92f03630b374799b236",
            "cmap": "c3e6cb37e8ca43259c92e6fbc103f1bcb6a0a08f95e1b4888067ce68fdb9f793",
            "glyf": "3d4f108e9b5ec2be132c8671262dc88f306af086071d59442ce19fba08c3374c",
        ]
    }
}
