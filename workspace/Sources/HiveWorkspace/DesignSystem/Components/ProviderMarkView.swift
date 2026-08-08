import AppKit
import WorkspaceCore

/// Display metadata for providers. The well-known vendors get their official marks and product titles; a provider this table has never heard of still renders — its own id as the title and an SF Symbol as the mark — instead of vanishing from the screen.
enum ProviderBranding {

    static func title(for id: ProviderID) -> String {
        switch id {
        case .claude: return "Claude Code"
        case .codex: return "Codex"
        case .grok: return "Grok"
        case .kimi: return "Kimi Code"
        case .opencode: return "OpenCode"
        default: return id.rawValue.prefix(1).uppercased() + id.rawValue.dropFirst()
        }
    }

    static func vendorName(for id: ProviderID) -> String {
        switch id {
        case .claude: return "Anthropic"
        case .codex: return "OpenAI"
        case .grok: return "xAI"
        case .kimi: return "Moonshot AI"
        case .opencode: return "OpenCode"
        default: return title(for: id)
        }
    }

    static func markAssetName(for id: ProviderID) -> String? {
        switch id {
        case .claude: return "claude-code"
        case .codex: return "openai"
        case .grok: return "xai"
        case .kimi: return "kimi"
        case .opencode: return "opencode"
        default: return nil
        }
    }
}

/// The official vendor mark, tinted to `labelColor` as a template image so it is dark-safe by construction. A missing asset falls back to an SF Symbol — never a broken image frame.
final class ProviderMarkView: NSImageView {

    init(provider: ProviderID, size: CGFloat = Theme.Metric.markSize) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        imageScaling = .scaleProportionallyUpOrDown
        contentTintColor = .labelColor
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: size),
            heightAnchor.constraint(equalToConstant: size),
        ])
        image = Self.markImage(for: provider)
        setAccessibilityElement(true)
        setAccessibilityRole(.image)
        setAccessibilityLabel("\(ProviderBranding.vendorName(for: provider)) logo")
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    static func markImage(for provider: ProviderID) -> NSImage? {
        if let image = bundledMarkImage(for: provider) {
            return image
        }
        return NSImage(
            systemSymbolName: "cpu", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 15, weight: .medium))
    }

    static func bundledMarkImage(for provider: ProviderID) -> NSImage? {
        if let asset = ProviderBranding.markAssetName(for: provider),
           let url = Bundle.module.url(
               forResource: asset, withExtension: "svg", subdirectory: "VendorMarks"),
           let image = NSImage(contentsOf: url) {
            image.isTemplate = true
            return image
        }
        return nil
    }
}
