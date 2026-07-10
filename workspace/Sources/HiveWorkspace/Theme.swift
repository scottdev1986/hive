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

    // MARK: ANSI → system colors

    /// Standard 8/16 ANSI slots mapped to semantic system colors so logs adapt
    /// to appearance changes like native text.
    static func ansiColor(_ color: StyledSpan.Color) -> NSColor {
        switch color {
        case .standard(let index), .bright(let index):
            switch index {
            case 0: return .labelColor          // "black" reads as primary text
            case 1: return .systemRed
            case 2: return .systemGreen
            case 3: return .systemYellow
            case 4: return .systemBlue
            case 5: return .systemPurple
            case 6: return .systemTeal
            default: return .secondaryLabelColor // "white" against system background
            }
        case .palette256(let value):
            return palette256Color(value)
        case .rgb(let red, let green, let blue):
            return NSColor(srgbRed: CGFloat(red) / 255, green: CGFloat(green) / 255,
                           blue: CGFloat(blue) / 255, alpha: 1)
        }
    }

    private static func palette256Color(_ value: Int) -> NSColor {
        switch value {
        case 0...15:
            return ansiColor(.standard(value % 8))
        case 16...231:
            let index = value - 16
            let levels: [CGFloat] = [0, 95, 135, 175, 215, 255].map { $0 / 255 }
            let r = levels[index / 36]
            let g = levels[(index / 6) % 6]
            let b = levels[index % 6]
            return NSColor(srgbRed: r, green: g, blue: b, alpha: 1)
        default:
            let gray = CGFloat(8 + (value - 232) * 10) / 255
            return NSColor(srgbRed: gray, green: gray, blue: gray, alpha: 1)
        }
    }

    static var reduceMotion: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }
}
