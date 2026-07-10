import AppKit
import WorkspaceCore

/// HIG-native styling: system semantic colors (adapting to light/dark and
/// accent), system fonts, SF Symbols. Hyprland inspires the tiling behavior
/// only — never the visual language.
enum Theme {

    // MARK: Status colors (blueprint "State and attention")

    static func statusColor(for status: PaneStatus) -> NSColor {
        switch status {
        case .running: return .systemBlue
        case .waiting: return .systemOrange
        case .completed(let acknowledged):
            return acknowledged ? NSColor.systemGreen.withAlphaComponent(0.35) : .systemGreen
        case .failed: return .systemRed
        case .disconnected: return .systemGray
        }
    }

    static func statusIsDashed(_ status: PaneStatus) -> Bool {
        if case .disconnected = status { return true }
        return false
    }

    static func statusSymbol(for status: PaneStatus) -> String {
        switch status {
        case .running: return "circle.fill"
        case .waiting: return "hourglass.circle.fill"
        case .completed: return "checkmark.circle.fill"
        case .failed: return "exclamationmark.circle.fill"
        case .disconnected: return "bolt.horizontal.circle.fill"
        }
    }

    static func severitySymbol(for severity: AttentionSeverity) -> String {
        switch severity {
        case .failed: return "exclamationmark.circle.fill"
        case .waiting: return "hourglass.circle.fill"
        case .disconnected: return "bolt.horizontal.circle.fill"
        case .completed: return "checkmark.circle.fill"
        }
    }

    static func severityColor(for severity: AttentionSeverity) -> NSColor {
        switch severity {
        case .failed: return .systemRed
        case .waiting: return .systemOrange
        case .disconnected: return .systemGray
        case .completed: return .systemGreen
        }
    }

    // MARK: Fonts

    static let bodyFont = NSFont.systemFont(ofSize: 13)
    static let monoFont = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    static let headerFont = NSFont.systemFont(ofSize: 13, weight: .semibold)
    static let captionFont = NSFont.systemFont(ofSize: 11)

    static var reduceMotion: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }
}
