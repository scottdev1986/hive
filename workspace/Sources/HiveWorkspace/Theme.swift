import AppKit
import WorkspaceCore

/// HIG-native styling: system semantic colors (adapting to light/dark and
/// accent), system fonts, SF Symbols. Hyprland inspires the tiling behavior
/// only — never the visual language.
enum Theme {

    // MARK: Unified status legend

    static func statusColor(for color: StatusColor, subdued: Bool = false) -> NSColor {
        let systemColor: NSColor
        switch color {
        case .green: systemColor = .systemGreen
        case .yellow: systemColor = .systemYellow
        case .orange: systemColor = .systemOrange
        case .blue: systemColor = .systemBlue
        case .purple: systemColor = .systemPurple
        case .red: systemColor = .systemRed
        case .gray: systemColor = .systemGray
        }
        return subdued ? systemColor.withAlphaComponent(0.35) : systemColor
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
        statusColor(for: severity.statusColor)
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

extension NSTextField {
    /// AppKit treats priorities of 500 or higher as permission to grow the
    /// window around a label instead of compressing the label in place.
    func compressHorizontally(
        priority: Float = 490, toolTip: String? = nil
    ) {
        setContentCompressionResistancePriority(.init(priority), for: .horizontal)
        if let toolTip { self.toolTip = toolTip }
    }
}
