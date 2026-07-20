import AppKit
import XCTest
@testable import HiveTerminalKit

/// C1.2 — persistence of the appearance selections, and their delivery to
/// panes that are already running.
@MainActor
final class C12AppearancePreferencesTests: XCTestCase {
    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "hive.c12.tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    private func makePreferences(
        center: NotificationCenter = NotificationCenter()
    ) -> HiveAppearancePreferences {
        HiveAppearancePreferences(defaults: defaults, notificationCenter: center)
    }

    // MARK: - Reading

    /// An absent key must read as the default. The positive control matters
    /// more than the assertion: without it, a misspelled key would also return
    /// every default and the test would pass while reading nothing.
    func testAbsentSelectionsReadAsDefaults() {
        let preferences = makePreferences()
        XCTAssertEqual(preferences.themeSelection, .system)
        XCTAssertEqual(preferences.font, .embedded)

        preferences.themeSelection = .light
        preferences.font = .systemMonospaced
        XCTAssertEqual(
            preferences.themeSelection, .light,
            "positive control: a written selection must read back, or the key is wrong"
        )
        XCTAssertEqual(preferences.font, .systemMonospaced)
    }

    /// A value naming no known case -- a preference file from a future or
    /// corrupted build -- must fall back rather than crash or leave the
    /// terminal unthemed.
    func testUnknownStoredValueFallsBackToTheDefault() {
        defaults.set("solarized-mocha", forKey: "hive.terminal.themeSelection")
        defaults.set("comic-sans", forKey: "hive.terminal.font")
        let preferences = makePreferences()
        XCTAssertEqual(preferences.themeSelection, .system)
        XCTAssertEqual(preferences.font, .embedded)
    }

    func testSelectionsPersistAcrossInstances() {
        let writer = makePreferences()
        writer.themeSelection = .dark
        writer.font = .systemMonospaced

        let reader = makePreferences()
        XCTAssertEqual(reader.themeSelection, .dark)
        XCTAssertEqual(reader.font, .systemMonospaced)
    }

    // MARK: - Change notification

    func testOnlyARealChangePostsTheNotification() {
        let center = NotificationCenter()
        let preferences = makePreferences(center: center)
        var posts = 0
        let token = center.addObserver(
            forName: HiveAppearancePreferences.didChangeNotification,
            object: nil, queue: nil
        ) { _ in posts += 1 }
        defer { center.removeObserver(token) }

        preferences.themeSelection = .system  // already the default
        XCTAssertEqual(posts, 0, "writing the running value must not post")

        preferences.themeSelection = .light
        XCTAssertEqual(posts, 1)

        preferences.themeSelection = .light
        XCTAssertEqual(posts, 1, "re-selecting the running value must not post")

        preferences.font = .systemMonospaced
        XCTAssertEqual(posts, 2, "the font is a separate selection")
    }

    // MARK: - Delivery to a running pane

    /// The point of the increment: a selection must reach a pane that is
    /// already open, not only panes created afterwards.
    func testChangingASelectionReconfiguresAnAlreadyRunningView() {
        let preferences = makePreferences(center: .default)
        let engine = FakeManualSurface()
        let view = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 400, height: 200),
            engine: engine
        )
        view.appearancePreferences = preferences
        view.applySelectedAppearance()

        let themeBefore = engine.hiveConfigurationTheme
        let countBefore = engine.hiveConfigurationApplyCount
        XCTAssertNotNil(themeBefore, "positive control: the view must have themed the surface")

        preferences.themeSelection = .light

        XCTAssertGreaterThan(
            engine.hiveConfigurationApplyCount, countBefore,
            "a live pane must be reconfigured when the selection changes"
        )
        XCTAssertEqual(engine.hiveConfigurationTheme?.identifier, "hive-light")
    }

    func testChangingTheFontReconfiguresAnAlreadyRunningView() {
        let preferences = makePreferences(center: .default)
        let engine = FakeManualSurface()
        let view = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 400, height: 200),
            engine: engine
        )
        view.appearancePreferences = preferences
        view.applySelectedAppearance()
        XCTAssertEqual(engine.hiveConfigurationFont, .embedded)

        preferences.font = .systemMonospaced

        XCTAssertEqual(
            engine.hiveConfigurationFont, .systemMonospaced,
            "a font change must reach a running pane"
        )
    }

    /// A pinned terminal theme is content, so it must hold regardless of the
    /// appearance the view is drawn in.
    func testPinnedThemeIgnoresTheViewAppearance() {
        let preferences = makePreferences(center: .default)
        preferences.themeSelection = .dark

        let engine = FakeManualSurface()
        let view = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 400, height: 200),
            engine: engine
        )
        view.appearancePreferences = preferences
        view.appearance = NSAppearance(named: .aqua)
        view.applySelectedAppearance()

        XCTAssertEqual(
            engine.hiveConfigurationTheme?.identifier,
            HiveAppearancePreferences.systemIncreasedContrast
                ? "hive-dark-high-contrast" : "hive-dark",
            "a pinned dark terminal theme must survive a light appearance"
        )
    }

    /// Under `.system` the palette follows the appearance the view is drawn in.
    func testSystemSelectionFollowsTheViewAppearance() {
        let preferences = makePreferences(center: .default)
        let engine = FakeManualSurface()
        let view = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 400, height: 200),
            engine: engine
        )
        view.appearancePreferences = preferences

        view.appearance = NSAppearance(named: .aqua)
        view.applySelectedAppearance()
        let light = engine.hiveConfigurationTheme?.identifier

        view.appearance = NSAppearance(named: .darkAqua)
        view.applySelectedAppearance()
        let dark = engine.hiveConfigurationTheme?.identifier

        XCTAssertTrue(light?.hasPrefix("hive-light") == true, "got \(light ?? "nil")")
        XCTAssertTrue(dark?.hasPrefix("hive-dark") == true, "got \(dark ?? "nil")")
        XCTAssertNotEqual(light, dark)
    }
}
