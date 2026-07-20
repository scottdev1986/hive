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

    /// The theme a surface should be running, given the appearance state it is
    /// drawn in. `HiveTerminalTheme` stays internal to the kit: callers outside
    /// it choose a *selection*, never a palette.
    func resolvedTheme(for state: HiveTerminalAppearanceState) -> HiveTerminalTheme {
        HiveTerminalTheme.resolve(
            selection: themeSelection,
            appearance: state.appearance,
            increasedContrast: state.increasedContrast
        )
    }
}

/// The appearance state a surface resolves its theme against.
///
/// Light/dark comes from the appearance the view is drawn in. Increase Contrast
/// does NOT: it is an accessibility display option, not an appearance variant.
/// Measured on macOS 26.3.1 — `NSAppearance(named: .accessibilityHighContrastAqua)`
/// reports its own name as plain `NSAppearanceNameAqua`, and `bestMatch` maps
/// every high-contrast name onto its base, so no appearance read can recover it.
/// The only reader is `NSWorkspace`, which the kit may not reference (Gate 9).
///
/// C1.2 therefore ships the increased-contrast variants and the resolution that
/// selects them, both measured. Supplying the live signal — and re-pushing when
/// the user toggles it mid-session — is C1.4's increment, which owns the
/// accessibility-options observer. Until then this stays `false` at the call
/// site rather than being defaulted somewhere it would look wired and be inert.
struct HiveTerminalAppearanceState: Equatable {
    let appearance: HiveTerminalAppearance
    let increasedContrast: Bool

    init(appearance: HiveTerminalAppearance, increasedContrast: Bool) {
        self.appearance = appearance
        self.increasedContrast = increasedContrast
    }

    init(_ nsAppearance: NSAppearance, increasedContrast: Bool) {
        self.init(
            appearance: TerminalColorScheme(appearance: nsAppearance) == .dark ? .dark : .light,
            increasedContrast: increasedContrast
        )
    }
}
