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
        case .blue: systemColor = accent
        case .purple: systemColor = violet
        case .red: systemColor = critical
        case .gray: systemColor = secondaryText
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

    static func paint(_ view: NSView, _ color: NSColor) {
        view.wantsLayer = true
        view.layer?.backgroundColor = color.cgColor
    }

    static func styleMockupButton(_ button: NSButton, primary: Bool = false) {
        button.bezelStyle = .flexiblePush
        button.isBordered = false
        button.wantsLayer = true
        button.layer?.cornerRadius = Metric.buttonCornerRadius
        button.layer?.masksToBounds = true
        button.font = Font.chromeControl
        if primary {
            button.contentTintColor = accentInk
            button.layer?.backgroundColor = accent.cgColor
            button.layer?.borderWidth = 0
        } else {
            button.contentTintColor = primaryText
            button.layer?.backgroundColor = buttonFill.cgColor
            button.layer?.borderWidth = 1
            button.layer?.borderColor = buttonBorder.cgColor
        }
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
