import HiveGhosttyC
import XCTest
@testable import HiveTerminalKit

/// C1.2 F1 — does the engine ACCEPT the selected font, or did we only prove the
/// generated string differed?
///
/// The reviewer's finding: the live-font test asserted the push returned true
/// and then read back `background`, a theme property that does not change across
/// a font switch. If the engine had rejected `font-family`, every assertion in
/// it still passed.
///
/// Reading `font-family` back is not an option — it is `RepeatableString`
/// (vendor `Config.zig:168`), a plain struct over an ArrayList that is neither
/// packed nor `cval`-bearing (`Config.zig:5983`), so `ghostty_config_get`'s
/// struct branch returns false. The getter DOES return C strings for *enum*
/// keys, so "it can return strings" is true and useless — it depends entirely on
/// the field's Zig type.
///
/// Acceptance is therefore proven through the engine's diagnostics channel.
@MainActor
final class C12FontAcceptanceTests: XCTestCase {
    /// `ghostty_config_*` needs the global `ghostty_init` that only the surface
    /// factory performs — a bare config call segfaults. Holding one surface for
    /// the test's lifetime satisfies that, matching the in-tree pattern.
    private var surface: GhosttyManualSurface!

    override func setUpWithError() throws {
        try super.setUpWithError()
        surface = try GhosttyBridgeFactory.makeManualSurfaceForConfigurationTesting(
            contents: HiveTerminalConfiguration.contents(headless: true)
        )
    }

    override func tearDownWithError() throws {
        surface?.free()
        surface = nil
        try super.tearDownWithError()
    }

    /// The negative control, and the only reason a zero-count assertion means
    /// anything: a channel that always reads zero passes forever.
    func testDiagnosticsChannelReportsAMalformedFontValue() {
        let malformed = HiveTerminalConfiguration.contents(headless: true)
            .replacingOccurrences(of: "font-size = 13", with: "font-size = notanumber")

        XCTAssertThrowsError(
            try GhosttyBridgeFactory.makeExplicitConfiguration(contents: malformed),
            "the engine must report a malformed font value"
        ) { error in
            guard case GhosttyBridgeFactory.FactoryError.invalidConfig(let count) = error else {
                return XCTFail("expected invalidConfig, got \(error)")
            }
            XCTAssertGreaterThan(count, 0)
        }
    }

    /// Every selectable font is accepted by the engine's own parser.
    func testSelectedFontIsAcceptedByTheEngineParser() throws {
        for font in HiveTerminalFont.allCases {
            let config = try GhosttyBridgeFactory.makeExplicitConfiguration(
                contents: HiveTerminalConfiguration.contents(font: font, headless: true)
            )
            defer { ghostty_config_free(config) }
            XCTAssertEqual(
                ghostty_config_diagnostics_count(config), 0,
                "\(font.rawValue) must produce no diagnostics"
            )
        }
    }

    /// The ceiling of the acceptance proof, measured rather than assumed:
    /// `font-family` takes any string, so a name matching no installed face is
    /// not a parse error. Zero diagnostics proves the KEY was accepted — never
    /// that the family resolves to a real face, and never that rendered glyphs
    /// changed face, which stays a production-window observation.
    func testAnUnresolvableFamilyNameIsStillAcceptedByTheParser() throws {
        let config = try GhosttyBridgeFactory.makeExplicitConfiguration(
            contents: HiveTerminalConfiguration.contents(headless: true)
                + "font-family = ThisFamilyIsNotInstalledAnywhere\n"
        )
        defer { ghostty_config_free(config) }
        XCTAssertEqual(
            ghostty_config_diagnostics_count(config), 0,
            "a syntactically valid family name parses even when no such face exists"
        )
    }

    /// The live push refuses a configuration the engine rejects, so a push that
    /// returns true already implies zero diagnostics. Nothing pinned that
    /// before: a refactor could have dropped the guard and gone unnoticed.
    func testLivePushRefusesAConfigurationTheEngineRejects() {
        XCTAssertTrue(surface.applyHiveConfiguration(theme: .hiveDark, font: .embedded))

        let rejected = HiveTerminalTheme(
            identifier: "malformed",
            configurationLines: ["font-size = notanumber"]
        )
        XCTAssertFalse(
            surface.applyHiveConfiguration(theme: rejected, font: .embedded),
            "a configuration the engine rejects must not be reported as pushed"
        )
        XCTAssertTrue(
            surface.applyHiveConfiguration(theme: .hiveLight, font: .systemMonospaced),
            "positive control: a valid configuration still pushes after a refusal"
        )
    }
}
