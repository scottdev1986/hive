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

    /// A 16pt template bitmap of the vendor mark for `NSMenuItem.image`.
    /// Setting `NSImage.size` on the SVG is not enough: the menu draws the
    /// representation, and shrinking that representation without redrawing
    /// clips the glyph to empty. Rasterize into a new bitmap instead.
    static func menuMarkImage(
        for provider: ProviderID,
        size: CGFloat = Theme.Metric.menuMarkSize
    ) -> NSImage? {
        guard let source = markImage(for: provider),
              let drawn = source.copy() as? NSImage else { return nil }
        drawn.isTemplate = false
        let pointSize = NSSize(width: size, height: size)
        let scale: CGFloat = 2
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int((pointSize.width * scale).rounded()),
            pixelsHigh: Int((pointSize.height * scale).rounded()),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else { return nil }
        rep.size = pointSize
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        guard let context = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
        NSGraphicsContext.current = context
        context.imageInterpolation = .high
        NSColor.clear.setFill()
        NSRect(origin: .zero, size: pointSize).fill()
        drawn.draw(
            in: NSRect(origin: .zero, size: pointSize),
            from: .zero,
            operation: .sourceOver,
            fraction: 1,
            respectFlipped: true,
            hints: [.interpolation: NSImageInterpolation.high])
        let image = NSImage(size: pointSize)
        image.addRepresentation(rep)
        image.isTemplate = true
        return image
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
