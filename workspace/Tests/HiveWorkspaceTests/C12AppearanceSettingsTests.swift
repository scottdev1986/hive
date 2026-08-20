import AppKit
import HiveTerminalKit
import XCTest
@testable import HiveWorkspace

/// C1.2 — the Appearance popover and its writes into HiveAppearancePreferences.
@MainActor
final class C12AppearanceSettingsTests: XCTestCase {
    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "hive.c12.settings.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    private func makeView() -> (AppearanceScreenView, HiveAppearancePreferences) {
        let preferences = HiveAppearancePreferences(
            defaults: defaults, notificationCenter: NotificationCenter())
        return (AppearanceScreenView(preferences: preferences), preferences)
    }

    private func popups(in view: NSView) -> [NSPopUpButton] {
        ((view as? NSPopUpButton).map { [$0] } ?? []) + view.subviews.flatMap(popups)
    }

    func testPageOffersEveryThemeAndFontChoice() {
        let (view, _) = makeView()
        let controls = popups(in: view)
        XCTAssertEqual(controls.count, 2, "one theme selector and one font selector")

        let titles = controls.map { $0.itemTitles }
        XCTAssertTrue(
            titles.contains(HiveTerminalThemeSelection.allCases.map(\.displayName)),
            "the theme selector must offer every selection; got \(titles)"
        )
        XCTAssertTrue(
            titles.contains(HiveTerminalFont.allCases.map(\.displayName)),
            "the font selector must offer every font"
        )
    }

    func testSelectingAThemeWritesThePreference() throws {
        let (view, preferences) = makeView()
        let themePopup = try XCTUnwrap(
            popups(in: view).first {
                $0.itemTitles == HiveTerminalThemeSelection.allCases.map(\.displayName)
            }
        )
        let lightIndex = try XCTUnwrap(
            HiveTerminalThemeSelection.allCases.firstIndex(of: .light))

        XCTAssertEqual(preferences.themeSelection, .system, "precondition")
        themePopup.selectItem(at: lightIndex)
        _ = themePopup.target?.perform(themePopup.action, with: themePopup)

        XCTAssertEqual(preferences.themeSelection, .light)
    }

    func testSelectingAFontWritesThePreference() throws {
        let (view, preferences) = makeView()
        let fontPopup = try XCTUnwrap(
            popups(in: view).first {
                $0.itemTitles == HiveTerminalFont.allCases.map(\.displayName)
            }
        )
        let systemIndex = try XCTUnwrap(
            HiveTerminalFont.allCases.firstIndex(of: .systemMonospaced))

        XCTAssertEqual(preferences.font, .embedded, "precondition")
        fontPopup.selectItem(at: systemIndex)
        _ = fontPopup.target?.perform(fontPopup.action, with: fontPopup)

        XCTAssertEqual(preferences.font, .systemMonospaced)
    }

    func testPageOpensOnTheStoredSelections() throws {
        let seed = HiveAppearancePreferences(
            defaults: defaults, notificationCenter: NotificationCenter())
        seed.themeSelection = .dark
        seed.font = .systemMonospaced

        let (view, _) = makeView()
        let controls = popups(in: view)
        let themePopup = try XCTUnwrap(
            controls.first { $0.itemTitles == HiveTerminalThemeSelection.allCases.map(\.displayName) })
        let fontPopup = try XCTUnwrap(
            controls.first { $0.itemTitles == HiveTerminalFont.allCases.map(\.displayName) })

        XCTAssertEqual(themePopup.titleOfSelectedItem, HiveTerminalThemeSelection.dark.displayName)
        XCTAssertEqual(fontPopup.titleOfSelectedItem, HiveTerminalFont.systemMonospaced.displayName)
    }
}
