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
        let reading = try renderedTransition(
            initialConfiguration: disabled,
            updatedConfiguration: enabled,
            bytes: Data("!= != !=\r\n".utf8)
        )
        let cursor = try renderedTransition(
            initialConfiguration: disabled,
            updatedConfiguration: enabled,
            bytes: Data("!=\u{1b}[2D".utf8)
        )
        let readingControl = try renderedTransition(
            initialConfiguration: disabled,
            updatedConfiguration: disabled,
            bytes: Data("!= != !=\r\n".utf8)
        )
        let cursorControl = try renderedTransition(
            initialConfiguration: disabled,
            updatedConfiguration: disabled,
            bytes: Data("!=\u{1b}[2D".utf8)
        )
        XCTAssertEqual(
            readingControl.before.digest,
            readingControl.after.digest,
            "positive control: an identical config push must leave reading pixels unchanged"
        )
        XCTAssertNotEqual(
            reading.before.digest,
            reading.after.digest,
            "positive control: enabling calt must change the rendered reading case"
        )
        XCTAssertEqual(
            pixelDelta(cursor.before, cursor.after),
            pixelDelta(cursorControl.before, cursorControl.after),
            "with the cursor over the pair, calt must add no raster change beyond the control redraw"
        )
        for text in [reading.text, cursor.text] {
            XCTAssertTrue(text.contains("!="))
            XCTAssertFalse(text.contains("≠"), "the semantic grid must preserve the original bytes")
        }
    }

    func testThickeningEnabledAtZeroIsDistinctFromDisabled() throws {
        let disabled = typographyConfiguration(ligatures: false, thickening: false, strength: 0)
        let enabled = typographyConfiguration(ligatures: false, thickening: true, strength: 0)
        let transition = try renderedTransition(
            initialConfiguration: disabled,
            updatedConfiguration: enabled,
            bytes: Data("Hive".utf8)
        )
        XCTAssertNotEqual(
            transition.before.digest,
            transition.after.digest,
            "strength zero is the lightest thickening, not the disabled state"
        )
    }

    func testAuthenticClaudeStatusGlyphRendersThroughSystemFallback() throws {
        // Exact UTF-8 for U+273B from B2.5's authenticated Claude/sessiond
        // journal de645b1efe5142b18f7fdf7fc0a43aedab71ac579d4ce0aeffef2cd3965e5675.
        let fixture = Data([0xE2, 0x9C, 0xBB])
        XCTAssertEqual(
            SHA256.hash(data: fixture).map { String(format: "%02x", $0) }.joined(),
            "864f614027fbe51470df6eb3d3cc781780d5247e2de1009c895bf62cb337a558"
        )

        let proof = try renderedFallbackFrames(fixture: fixture)
        XCTAssertEqual(proof.text.unicodeScalars.first?.value, 0x273B)
        XCTAssertEqual(glyph(for: 0x273B, in: proof.primaryFont), 0)
        XCTAssertEqual(systemFallbackFamily(for: "\u{273B}", primary: proof.primaryFont), "Menlo")
        XCTAssertNotEqual(proof.fixture.digest, proof.blank.digest)
        XCTAssertNotEqual(proof.fixture.digest, proof.replacement.digest)
    }

    func testSymbolsNerdFallbackRendersItsSyntheticMechanismProbe() throws {
        // U+F115 is a Nerd Font folder glyph. It is deliberately synthetic:
        // authentic vendor status glyphs use discovered system fallbacks.
        let fixture = Data([0xEF, 0x84, 0x95])
        XCTAssertEqual(
            SHA256.hash(data: fixture).map { String(format: "%02x", $0) }.joined(),
            "245fba77c41b263eb6a7cf8e4a5ae92d78a429ac57c3d4e7475524d8ca6f0d3a"
        )
        XCTAssertEqual(systemDescriptorCount(family: "Symbols Nerd Font"), 0)

        let proof = try renderedFallbackFrames(fixture: fixture)
        XCTAssertEqual(proof.text.unicodeScalars.first?.value, 0xF115)
        XCTAssertEqual(glyph(for: 0xF115, in: proof.primaryFont), 0)
        XCTAssertEqual(
            systemFallbackFamily(for: "\u{F115}", primary: proof.primaryFont),
            ".LastResort"
        )
        XCTAssertNotEqual(proof.fixture.digest, proof.blank.digest)
        XCTAssertNotEqual(proof.fixture.digest, proof.replacement.digest)
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

    private func glyph(for codepoint: UniChar, in font: CTFont) -> CGGlyph {
        var character = codepoint
        var glyph: CGGlyph = 0
        _ = CTFontGetGlyphsForCharacters(font, &character, &glyph, 1)
        return glyph
    }

    private func systemFallbackFamily(for text: String, primary: CTFont) -> String {
        let fallback = CTFontCreateForString(
            primary,
            text as CFString,
            CFRange(location: 0, length: (text as NSString).length)
        )
        return CTFontCopyFamilyName(fallback) as String
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

    private func renderedTransition(
        initialConfiguration: String,
        updatedConfiguration: String,
        bytes: Data
    ) throws -> (before: RenderedFrame, after: RenderedFrame, text: String) {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForConfigurationTesting(
            contents: initialConfiguration
        )
        defer { surface.free() }
        let terminal = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 800, height: 480),
            engine: surface
        )
        _ = terminal
        surface.setOcclusion(true)
        XCTAssertEqual(surface.processOutput(bytes: bytes, streamSeq: 0), .success)
        let layer = try XCTUnwrap(surface.hostView?.layer)
        let before = try renderedFrame(surface: surface, layer: layer)

        let handle = try XCTUnwrap(surface.surfaceHandle)
        let config = try GhosttyBridgeFactory.makeExplicitConfiguration(contents: updatedConfiguration)
        defer { ghostty_config_free(config) }
        ghostty_surface_update_config(handle, config)
        let after = try renderedFrame(surface: surface, layer: layer)

        return (before, after, try XCTUnwrap(surface.semanticSnapshot()).text)
    }

    private func renderedFrame(
        surface: GhosttyManualSurface,
        layer: CALayer
    ) throws -> RenderedFrame {
        for _ in 0 ..< 10 {
            surface.draw()
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        var previous = try captureRenderedFrame(layer: layer)
        for _ in 0 ..< 10 {
            surface.draw()
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
            let current = try captureRenderedFrame(layer: layer)
            if current.digest == previous.digest { return current }
            previous = current
        }
        return previous
    }

    private func captureRenderedFrame(layer: CALayer) throws -> RenderedFrame {
        let ioSurface = try XCTUnwrap(layer.contents as? IOSurface)
        let image = CIImage(ioSurface: ioSurface)
        let width = Int(image.extent.width)
        let height = Int(image.extent.height)
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let colorSpace = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
        CIContext().render(
            image,
            toBitmap: &pixels,
            rowBytes: width * 4,
            bounds: image.extent,
            format: .RGBA8,
            colorSpace: colorSpace
        )
        var mask = Data(capacity: width * height)
        for index in stride(from: 0, to: pixels.count, by: 4) {
            mask.append(max(pixels[index], pixels[index + 1], pixels[index + 2]) > 64 ? 1 : 0)
        }
        return RenderedFrame(
            digest: SHA256.hash(data: mask).map { String(format: "%02x", $0) }.joined(),
            pixels: mask
        )
    }

    private func renderedFallbackFrames(
        fixture: Data
    ) throws -> (
        fixture: RenderedFrame,
        replacement: RenderedFrame,
        blank: RenderedFrame,
        text: String,
        primaryFont: CTFont
    ) {
        let configuration = HiveTerminalConfiguration.contents(headless: true)
            .replacingOccurrences(of: "cursor-opacity = 1", with: "cursor-opacity = 0")
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForConfigurationTesting(
            contents: configuration
        )
        defer { surface.free() }
        let terminal = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 800, height: 480),
            engine: surface
        )
        _ = terminal
        surface.setOcclusion(true)
        let layer = try XCTUnwrap(surface.hostView?.layer)

        var sequence: UInt64 = 0
        XCTAssertEqual(surface.processOutput(bytes: fixture, streamSeq: sequence), .success)
        sequence += UInt64(fixture.count)
        let text = try XCTUnwrap(surface.semanticSnapshot()).text
        let fixtureFrame = try renderedFrame(surface: surface, layer: layer)

        let erase = Data("\r ".utf8)
        XCTAssertEqual(surface.processOutput(bytes: erase, streamSeq: sequence), .success)
        sequence += UInt64(erase.count)
        let blankFrame = try renderedFrame(surface: surface, layer: layer)

        let replacement = Data("\r\u{FFFD}".utf8)
        XCTAssertEqual(surface.processOutput(bytes: replacement, streamSeq: sequence), .success)
        let replacementFrame = try renderedFrame(surface: surface, layer: layer)

        return (
            fixtureFrame,
            replacementFrame,
            blankFrame,
            text,
            try primaryFont(surface)
        )
    }

    private func pixelDelta(_ lhs: RenderedFrame, _ rhs: RenderedFrame) -> Data {
        Data(zip(lhs.pixels, rhs.pixels).map { $0 == $1 ? 0 : 1 })
    }

    private struct RenderedFrame {
        let digest: String
        let pixels: Data
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
