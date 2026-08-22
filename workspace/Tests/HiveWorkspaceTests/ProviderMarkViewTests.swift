import AppKit
import Testing
@testable import HiveWorkspace
@testable import WorkspaceCore

@Suite("Provider marks")
struct ProviderMarkViewTests {
    @Test("Every supported vendor has canonical branding and a bundled mark")
    func fiveVendorBranding() throws {
        let expected: [(ProviderID, String, String, String)] = [
            (.claude, "Claude Code", "Anthropic", "claude-code"),
            (.codex, "Codex", "OpenAI", "openai"),
            (.grok, "Grok", "xAI", "xai"),
            (.kimi, "Kimi Code", "Moonshot AI", "kimi"),
            (.opencode, "OpenCode", "OpenCode", "opencode"),
        ]

        #expect(expected.map(\.0).sorted() == expected.map(\.0))
        for (provider, title, vendor, asset) in expected {
            #expect(ProviderBranding.title(for: provider) == title)
            #expect(ProviderBranding.vendorName(for: provider) == vendor)
            #expect(ProviderBranding.markAssetName(for: provider) == asset)
            #expect(ProviderMarkView.bundledMarkImage(for: provider) != nil)
            let menu = try #require(ProviderMarkView.menuMarkImage(for: provider))
            #expect(menu.size == NSSize(
                width: Theme.Metric.menuMarkSize, height: Theme.Metric.menuMarkSize))
            #expect(menu.representations.allSatisfy {
                $0.size == NSSize(
                    width: Theme.Metric.menuMarkSize, height: Theme.Metric.menuMarkSize)
            })
            #expect(menu.isTemplate)
            #expect(menuHasInk(menu), "\(asset) menu mark must have visible pixels")
        }
    }

    /// Shrinking an SVG representation without redrawing produced a 16pt
    /// image with no ink, which is how the add-model marks vanished.
    private func menuHasInk(_ image: NSImage) -> Bool {
        guard let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff) else { return false }
        for y in 0..<rep.pixelsHigh {
            for x in 0..<rep.pixelsWide {
                if (rep.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.1 {
                    return true
                }
            }
        }
        return false
    }
}
