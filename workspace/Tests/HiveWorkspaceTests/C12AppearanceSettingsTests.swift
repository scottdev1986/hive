import AppKit
import HiveTerminalKit
import XCTest
@testable import HiveWorkspace

/// C1.2 — the Appearance settings page and its wiring into the Settings window.
///
/// The window routes sections through nested ternaries that fall through to the
/// Tasks page for anything unrecognised, so "appearance" selecting the right
/// page is asserted rather than assumed.
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

    private func makeController() -> (AppearanceSettingsController, HiveAppearancePreferences) {
        let preferences = HiveAppearancePreferences(
            defaults: defaults, notificationCenter: NotificationCenter())
        let controller = AppearanceSettingsController(
            dataSource: ModelControlDataSource(hivePath: nil, daemonPort: nil),
            preferences: preferences
        )
        // Loading the view runs the base class's own build; calling
        // buildContent() again here would duplicate every control.
        _ = controller.view
        return (controller, preferences)
    }

    private func popups(in view: NSView) -> [NSPopUpButton] {
        ((view as? NSPopUpButton).map { [$0] } ?? []) + view.subviews.flatMap(popups)
    }

    func testPageOffersEveryThemeAndFontChoice() {
        let (controller, _) = makeController()
        let controls = popups(in: controller.view)
        XCTAssertEqual(controls.count, 2, "one theme selector and one font selector")

        let titles = controls.map { $0.itemTitles }
        XCTAssertTrue(
            titles.contains(HiveTerminalThemeSelection.allCases.map(\.displayName)),
            "the theme selector must offer every selection; got \(titles)"
        )
        XCTAssertTrue(
            titles.contains(HiveTerminalFont.allCases.map(\.displayName)),
            "the font selector must offer every font, including the one C1.1 deferred here"
        )
    }

    /// A selector that displays choices but writes nothing is the failure this
    /// guards: the write is measured through the preference, not the control.
    func testSelectingAThemeWritesThePreference() throws {
        let (controller, preferences) = makeController()
        let themePopup = try XCTUnwrap(
            popups(in: controller.view).first {
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
        let (controller, preferences) = makeController()
        let fontPopup = try XCTUnwrap(
            popups(in: controller.view).first {
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

    /// The page reopens showing what is actually in effect.
    func testPageOpensOnTheStoredSelections() throws {
        let seed = HiveAppearancePreferences(
            defaults: defaults, notificationCenter: NotificationCenter())
        seed.themeSelection = .dark
        seed.font = .systemMonospaced

        let (controller, _) = makeController()
        let controls = popups(in: controller.view)
        let themePopup = try XCTUnwrap(
            controls.first { $0.itemTitles == HiveTerminalThemeSelection.allCases.map(\.displayName) })
        let fontPopup = try XCTUnwrap(
            controls.first { $0.itemTitles == HiveTerminalFont.allCases.map(\.displayName) })

        XCTAssertEqual(themePopup.titleOfSelectedItem, HiveTerminalThemeSelection.dark.displayName)
        XCTAssertEqual(fontPopup.titleOfSelectedItem, HiveTerminalFont.systemMonospaced.displayName)
    }

    /// Selecting "appearance" must reach the Appearance page. The section
    /// chain falls through to Tasks for anything it does not recognise, so a
    /// missed wiring site would silently show the wrong page.
    func testWindowSelectsTheAppearanceSectionRatherThanFallingThroughToTasks() {
        let window = SettingsWindowController(hivePath: nil, daemonPort: nil, initialWidth: 880)
        defer { window.close() }

        window.select(section: "appearance")
        XCTAssertEqual(window.window?.title, "Settings — Appearance")

        // A control only the Appearance page builds must be the visible one.
        let visibleTitles = Set(
            popups(in: window.window?.contentView ?? NSView())
                .filter { !isHidden($0) }
                .map { $0.itemTitles }
                .flatMap { $0 }
        )
        XCTAssertTrue(
            visibleTitles.contains(HiveTerminalThemeSelection.system.displayName),
            "the Appearance page's theme selector must be the visible one"
        )
    }

    /// `knownSections` is only useful if it matches what the chain actually
    /// resolves. A stale list would report a real section as unknown, or stay
    /// silent on one that genuinely falls through -- so every listed key must
    /// select a distinct page, and an unlisted key must land on Tasks.
    func testEveryKnownSectionResolvesToItsOwnPage() {
        let window = SettingsWindowController(hivePath: nil, daemonPort: nil, initialWidth: 880)
        defer { window.close() }

        var titles: [String: String] = [:]
        for section in SettingsWindowController.knownSections {
            window.select(section: section)
            titles[section] = window.window?.title ?? ""
        }

        XCTAssertEqual(
            Set(titles.values).count, SettingsWindowController.knownSections.count,
            "each known section must reach a distinct page; got \(titles)"
        )
        XCTAssertEqual(titles["appearance"], "Settings — Appearance")

        window.select(section: "not-a-section")
        XCTAssertEqual(
            window.window?.title, titles["tasks"],
            "an unrecognised section keeps the pre-existing fall-through to Tasks"
        )
    }

    private func isHidden(_ view: NSView) -> Bool {
        var current: NSView? = view
        while let node = current {
            if node.isHidden { return true }
            current = node.superview
        }
        return false
    }
}
