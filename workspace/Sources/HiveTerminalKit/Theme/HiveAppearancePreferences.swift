import AppKit
import Foundation

/// The user's terminal appearance choices, persisted across launches.
///
/// These are local presentation preferences, not routing policy, so they live
/// in `UserDefaults` rather than round-tripping through the daemon.
///
/// A change posts `didChangeNotification` so running panes can reconfigure
/// themselves; a write that does not change the value posts nothing, because a
/// selector that re-pushes on every redraw would thrash the engine.
public final class HiveAppearancePreferences {
    public static let didChangeNotification = Notification.Name(
        "hive.terminal.appearancePreferencesDidChange")

    public static let shared = HiveAppearancePreferences()

    private enum Key {
        static let themeSelection = "hive.terminal.themeSelection"
        static let font = "hive.terminal.font"
    }

    private let defaults: UserDefaults
    private let notificationCenter: NotificationCenter

    public init(
        defaults: UserDefaults = .standard,
        notificationCenter: NotificationCenter = .default
    ) {
        self.defaults = defaults
        self.notificationCenter = notificationCenter
    }

    /// An absent key reads as the default, and so does a value that no longer
    /// names a case — a preference file written by a future or corrupted build
    /// must not crash the terminal or leave it unthemed.
    public var themeSelection: HiveTerminalThemeSelection {
        get {
            defaults.string(forKey: Key.themeSelection)
                .flatMap(HiveTerminalThemeSelection.init(rawValue:)) ?? .system
        }
        set { store(newValue.rawValue, forKey: Key.themeSelection, changed: newValue != themeSelection) }
    }

    public var font: HiveTerminalFont {
        get {
            defaults.string(forKey: Key.font)
                .flatMap(HiveTerminalFont.init(rawValue:)) ?? .embedded
        }
        set { store(newValue.rawValue, forKey: Key.font, changed: newValue != font) }
    }

    private func store(_ value: String, forKey key: String, changed: Bool) {
        defaults.set(value, forKey: key)
        guard changed else { return }
        notificationCenter.post(name: Self.didChangeNotification, object: self)
    }

    /// Read live rather than cached: the accessibility setting can change while
    /// the app runs. Observing that change to drive a re-push is C1.4's work;
    /// resolving correctly whenever we do push is this increment's.
    static var systemIncreasedContrast: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast
    }

    /// The theme a surface should be running, given the appearance it is drawn
    /// in. `HiveTerminalTheme` stays internal to the kit: callers outside it
    /// choose a *selection*, never a palette.
    func resolvedTheme(appearance: HiveTerminalAppearance) -> HiveTerminalTheme {
        HiveTerminalTheme.resolve(
            selection: themeSelection,
            appearance: appearance,
            increasedContrast: Self.systemIncreasedContrast
        )
    }
}
