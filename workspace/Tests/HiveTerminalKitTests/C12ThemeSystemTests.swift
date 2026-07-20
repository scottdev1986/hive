import XCTest
@testable import HiveTerminalKit

/// C1.2 — the paired first-party theme system.
///
/// Every ratio here is measured from the palette the generator actually emits,
/// never from a table restated in the test. The binding test below is what makes
/// that true: it proves each measured color reaches the generated configuration.
final class C12ThemeSystemTests: XCTestCase {
    private var firstParty: [HiveTerminalTheme] {
        [.hiveDark, .hiveLight, .hiveDarkHighContrast, .hiveLightHighContrast]
    }

    // MARK: - The instrument

    /// A lenient hex parser reports a typo'd palette entry as a confident pass,
    /// so the parser is proven to reject before any ratio is trusted.
    func testMalformedHexIsRejectedRatherThanTruncated() throws {
        for malformed in ["6e footer", "07insert", "fff", "", "zzzzzz", "0f11170", "0f111"] {
            XCTAssertThrowsError(
                try WCAGContrast.relativeLuminance(malformed),
                "malformed hex \(malformed) must not parse"
            ) { error in
                XCTAssertEqual(error as? WCAGContrast.ColorError, .malformedHex(malformed))
            }
        }
        // Positive control: the instrument still measures valid input, and
        // reproduces the published WCAG reference values.
        XCTAssertEqual(try WCAGContrast.ratio("000000", "ffffff"), 21, accuracy: 0.01)
        XCTAssertEqual(try WCAGContrast.ratio("777777", "ffffff"), 4.48, accuracy: 0.01)
        XCTAssertEqual(try WCAGContrast.ratio("767676", "ffffff"), 4.54, accuracy: 0.01)
        XCTAssertEqual(try WCAGContrast.ratio("0000ff", "ffffff"), 8.59, accuracy: 0.01)
    }

    // MARK: - The measured contrast table

    func testEveryFirstPartyThemeMeetsItsMeasuredContrastFloors() throws {
        var table: [String] = []
        for theme in firstParty {
            let palette = try XCTUnwrap(theme.palette, "\(theme.identifier) must be authored")
            table.append("\n\(theme.identifier)  background=\(palette.background)")

            let foreground = try WCAGContrast.ratio(palette.foreground, palette.background)
            table.append(String(format: "  foreground %@  %.2f:1 (>= 7)", palette.foreground, foreground))
            XCTAssertGreaterThanOrEqual(
                foreground, 7,
                "\(theme.identifier) foreground must clear Apple's 7:1 small-text target"
            )

            XCTAssertEqual(palette.ansi.count, 16, "Hive authors exactly ANSI 0-15")
            for (index, entry) in palette.ansi.enumerated() {
                let ratio = try WCAGContrast.ratio(entry, palette.background)
                let floor = HiveTerminalPalette.deEmphasisIndices.contains(index) ? 3.0 : 4.5
                table.append(String(format: "  palette %2d %@  %.2f:1 (>= %.1f)", index, entry, ratio, floor))
                XCTAssertGreaterThanOrEqual(
                    ratio, floor,
                    "\(theme.identifier) palette \(index) (\(entry)) is below its \(floor):1 floor"
                )
            }
        }
        print("C1.2 measured contrast table\n" + table.joined(separator: "\n"))
    }

    /// Apple warns that Increase Contrast in Dark Mode can *reduce* contrast
    /// between dark text and dark backgrounds. That is verified in exactly that
    /// combination rather than assumed, for both pairs.
    func testIncreasedContrastVariantsNeverReduceContrast() throws {
        for pair in HiveTerminalTheme.firstPartyPairs {
            let base = try XCTUnwrap(pair.base.palette)
            let high = try XCTUnwrap(pair.increasedContrast.palette)

            let baseForeground = try WCAGContrast.ratio(base.foreground, base.background)
            let highForeground = try WCAGContrast.ratio(high.foreground, high.background)
            XCTAssertGreaterThanOrEqual(
                highForeground, baseForeground,
                "\(pair.increasedContrast.identifier) foreground reduced contrast"
            )

            for index in 0..<16 {
                let baseRatio = try WCAGContrast.ratio(base.ansi[index], base.background)
                let highRatio = try WCAGContrast.ratio(high.ansi[index], high.background)
                XCTAssertGreaterThanOrEqual(
                    highRatio, baseRatio,
                    "\(pair.increasedContrast.identifier) palette \(index) reduced contrast"
                )
            }
        }
    }

    // MARK: - The measured colors are the shipped colors

    /// Without this, `palette` and `configurationLines` could drift and the
    /// measured table above would describe colors no surface ever receives.
    func testMeasuredPaletteIsTheEmittedConfiguration() throws {
        for theme in firstParty {
            let palette = try XCTUnwrap(theme.palette)
            let lines = theme.configurationLines
            XCTAssertTrue(
                lines.contains("background = \(palette.background)"),
                "\(theme.identifier) must emit the measured background"
            )
            XCTAssertTrue(
                lines.contains("foreground = \(palette.foreground)"),
                "\(theme.identifier) must emit the measured foreground"
            )
            for (index, entry) in palette.ansi.enumerated() {
                XCTAssertTrue(
                    lines.contains("palette = \(index)=\(entry)"),
                    "\(theme.identifier) must emit the measured palette \(index)"
                )
            }
        }
    }

    // MARK: - Structural rules the design fixes

    func testThemesAuthorOnlyAnsi0Through15AndLeaveGenerationOff() throws {
        for theme in firstParty {
            let lines = theme.configurationLines
            XCTAssertTrue(lines.contains("palette-generate = false"), theme.identifier)
            for index in 16...255 {
                XCTAssertFalse(
                    lines.contains { $0.hasPrefix("palette = \(index)=") },
                    "\(theme.identifier) must leave palette \(index) at the engine standard"
                )
            }
        }
    }

    /// Cursor and selection resolve against the cell beneath them, which removes
    /// the invisible-cursor-on-one-theme bug class. `bold-color` is emitted and
    /// its deprecated compatibility alias never is.
    func testCursorAndSelectionAreSymbolicAndBoldAliasIsNeverEmitted() {
        for theme in firstParty {
            let lines = theme.configurationLines
            XCTAssertTrue(lines.contains("cursor-color = cell-foreground"), theme.identifier)
            XCTAssertTrue(lines.contains("cursor-text = cell-background"), theme.identifier)
            XCTAssertTrue(lines.contains("selection-background = cell-foreground"), theme.identifier)
            XCTAssertTrue(lines.contains("selection-foreground = cell-background"), theme.identifier)
            XCTAssertTrue(lines.contains("bold-color = bright"), theme.identifier)
            XCTAssertFalse(
                lines.contains { $0.hasPrefix("bold-is-bright") },
                "\(theme.identifier) must never emit the deprecated bold alias"
            )
        }
    }

    /// No first-party theme may name a font family: a configured family always
    /// outranks the engine-embedded face (C1.1's negative-Menlo control).
    func testNoThemeConfiguresAFontFamily() {
        for theme in firstParty {
            XCTAssertFalse(
                theme.configurationLines.contains { $0.hasPrefix("font-family") },
                "\(theme.identifier) must configure no font family"
            )
        }
        XCTAssertFalse(
            HiveTerminalConfiguration.contents().contains("font-family"),
            "the default generated configuration must name no font family"
        )
    }

    // MARK: - Resolution

    func testSelectionResolvesAppearanceAndIncreasedContrast() {
        func resolve(
            _ selection: HiveTerminalThemeSelection,
            _ appearance: HiveTerminalAppearance,
            _ increased: Bool
        ) -> String {
            HiveTerminalTheme.resolve(
                selection: selection, appearance: appearance, increasedContrast: increased
            ).identifier
        }

        XCTAssertEqual(resolve(.system, .dark, false), "hive-dark")
        XCTAssertEqual(resolve(.system, .light, false), "hive-light")
        XCTAssertEqual(resolve(.system, .dark, true), "hive-dark-high-contrast")
        XCTAssertEqual(resolve(.system, .light, true), "hive-light-high-contrast")

        // A pinned terminal theme is content, not an app-appearance override:
        // it holds against the opposing system appearance.
        XCTAssertEqual(resolve(.dark, .light, false), "hive-dark")
        XCTAssertEqual(resolve(.light, .dark, false), "hive-light")
        XCTAssertEqual(resolve(.dark, .light, true), "hive-dark-high-contrast")
        XCTAssertEqual(resolve(.light, .dark, true), "hive-light-high-contrast")
    }

    // MARK: - The theme reaches the generated file ahead of the overrides

    /// C1.0's central mutation: the product override must still bite after a
    /// theme that requests the opposite. Order is the mechanism.
    func testThemeIsEmittedBeforeProductOverrides() throws {
        let hostile = HiveTerminalTheme(
            identifier: "hostile",
            configurationLines: ["background = 010203", "copy-on-select = true"]
        )
        let contents = HiveTerminalConfiguration.contents(theme: hostile)
        let themeIndex = try XCTUnwrap(contents.range(of: "copy-on-select = true"))
        let overrideIndex = try XCTUnwrap(contents.range(of: "copy-on-select = false"))
        XCTAssertTrue(
            themeIndex.lowerBound < overrideIndex.lowerBound,
            "the product override must come after the theme so it wins"
        )
    }

    /// C1.1 deferred the font option to C1.2. Before this increment the font
    /// never reached `contents`, so a selection could not reach a live surface.
    func testSelectedFontReachesTheGeneratedConfiguration() {
        XCTAssertFalse(HiveTerminalConfiguration.contents(font: .embedded).contains("font-family"))
        XCTAssertTrue(
            HiveTerminalConfiguration.contents(font: .systemMonospaced)
                .contains("font-family = .AppleSystemUIFontMonospaced"),
            "the selected font must reach the generated configuration"
        )
    }
}
