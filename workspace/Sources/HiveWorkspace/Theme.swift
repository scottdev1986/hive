import AppKit
import WorkspaceCore

/// Workspace chrome follows the Split Horizon mockup (`Theme.Chrome`). Hyprland inspires tiling behavior only. System colors are not a waiver to ignore the mockup.
enum Theme {

    static func statusColor(for color: StatusColor, subdued: Bool = false) -> NSColor {
        let systemColor: NSColor
        switch color {
        case .green: systemColor = Chrome.green
        case .yellow: systemColor = Chrome.yellow
        case .orange: systemColor = Chrome.yellow
        case .blue: systemColor = Chrome.accent
        case .purple: systemColor = Chrome.violet
        case .red: systemColor = Chrome.red
        case .gray: systemColor = Chrome.muted
        case .teal: systemColor = Chrome.accent
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

    static let bodyFont = NSFont.systemFont(ofSize: 13)
    static let headerFont = NSFont.systemFont(ofSize: 13, weight: .semibold)
    static let captionFont = NSFont.systemFont(ofSize: 11)

    static var reduceMotion: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }

    static func applyWorkspaceChrome(to window: NSWindow) {
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = Chrome.bg
        window.contentView?.wantsLayer = true
        window.contentView?.layer?.backgroundColor = Chrome.bg.cgColor
    }

    static func paint(_ view: NSView, _ color: NSColor) {
        view.wantsLayer = true
        view.layer?.backgroundColor = color.cgColor
    }

    static func styleMockupButton(_ button: NSButton, primary: Bool = false) {
        button.bezelStyle = .flexiblePush
        button.isBordered = false
        button.wantsLayer = true
        button.layer?.cornerRadius = 7
        button.layer?.masksToBounds = true
        if primary {
            button.contentTintColor = Chrome.accentInk
            button.layer?.backgroundColor = Chrome.accent.cgColor
            button.layer?.borderWidth = 0
        } else {
            button.contentTintColor = Chrome.text
            button.layer?.backgroundColor = Chrome.buttonFill.cgColor
            button.layer?.borderWidth = 1
            button.layer?.borderColor = Chrome.buttonBorder.cgColor
        }
        button.font = Font.caption
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
