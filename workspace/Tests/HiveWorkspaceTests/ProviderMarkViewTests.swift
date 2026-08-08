import Testing
@testable import HiveWorkspace
@testable import WorkspaceCore

@Suite("Provider marks")
struct ProviderMarkViewTests {
    @Test("Every supported vendor has canonical branding and a bundled mark")
    func fiveVendorBranding() {
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
        }
    }
}
