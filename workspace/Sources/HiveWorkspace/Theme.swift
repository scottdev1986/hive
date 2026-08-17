import AppKit
import WorkspaceCore

/// Shared behavior layered on the Workspace palette and typography tokens.
enum Theme {

    static func statusColor(for color: StatusColor, subdued: Bool = false) -> NSColor {
        let systemColor: NSColor
        switch color {
        case .green: systemColor = positive
        case .yellow: systemColor = warning
        case .orange: systemColor = warning
        case .blue: systemColor = .systemBlue
        case .purple: systemColor = .systemPurple
        case .red: systemColor = critical
        case .gray: systemColor = .systemGray
        case .teal: systemColor = accent
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

    static let bodyFont = Font.body
    static let headerFont = Font.headline
    static let captionFont = Font.caption

    static var reduceMotion: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }
}

extension NSTextField {
    /// AppKit treats priorities of 500 or higher as permission to grow the window around a label instead of compressing the label in place.
    func compressHorizontally(
        priority: Float = 490, toolTip: String? = nil
    ) {
        setContentCompressionResistancePriority(.init(priority), for: .horizontal)
        if let toolTip { self.toolTip = toolTip }
    }
}
