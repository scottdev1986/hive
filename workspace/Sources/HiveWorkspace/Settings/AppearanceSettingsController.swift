import AppKit
import HiveTerminalKit

/// Settings → Appearance: the terminal theme and the terminal font.
///
/// Both selections persist and apply to panes that are already running, so the
/// user never has to restart a session to see a choice take effect.
///
/// There is deliberately no app-appearance control here. Hive follows the
/// system appearance; the terminal *theme* is content, which is why it can be
/// pinned independently without becoming an appearance override.
final class AppearanceSettingsController: SettingsPageController {

    private let preferences: HiveAppearancePreferences

    init(dataSource: ModelControlDataSource, preferences: HiveAppearancePreferences = .shared) {
        self.preferences = preferences
        super.init(dataSource: dataSource)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func buildContent() {
        addHeader(
            title: "Appearance",
            subtitle: """
                The terminal theme and font. Changes apply immediately to every \
                open pane. Hive follows your system light or dark setting; \
                choosing a theme here changes terminal content only.
                """
        )

        contentStack.addArrangedSubview(
            row(
                label: "Terminal theme",
                accessibility: "Terminal theme",
                titles: HiveTerminalThemeSelection.allCases.map(\.displayName),
                selectedIndex: HiveTerminalThemeSelection.allCases
                    .firstIndex(of: preferences.themeSelection),
                action: #selector(themeChanged(_:))
            )
        )

        contentStack.addArrangedSubview(
            row(
                label: "Terminal font",
                accessibility: "Terminal font",
                titles: HiveTerminalFont.allCases.map(\.displayName),
                selectedIndex: HiveTerminalFont.allCases.firstIndex(of: preferences.font),
                action: #selector(fontChanged(_:))
            )
        )
    }

    private func row(
        label: String,
        accessibility: String,
        titles: [String],
        selectedIndex: Int?,
        action: Selector
    ) -> NSView {
        let caption = NSTextField(labelWithString: label)
        caption.font = Theme.Font.headline
        caption.compressHorizontally()

        let popup = NSPopUpButton(frame: .zero, pullsDown: false)
        popup.controlSize = .small
        popup.font = NSFont.systemFont(ofSize: 11)
        titles.forEach { popup.addItem(withTitle: $0) }
        if let selectedIndex { popup.selectItem(at: selectedIndex) }
        popup.target = self
        popup.action = action
        popup.setAccessibilityLabel(accessibility)

        let stack = NSStackView(views: [caption, popup])
        stack.orientation = .horizontal
        stack.spacing = Theme.Space.s
        stack.alignment = .firstBaseline
        return stack
    }

    @objc private func themeChanged(_ sender: NSPopUpButton) {
        let choices = HiveTerminalThemeSelection.allCases
        guard choices.indices.contains(sender.indexOfSelectedItem) else { return }
        preferences.themeSelection = choices[sender.indexOfSelectedItem]
    }

    @objc private func fontChanged(_ sender: NSPopUpButton) {
        let choices = HiveTerminalFont.allCases
        guard choices.indices.contains(sender.indexOfSelectedItem) else { return }
        preferences.font = choices[sender.indexOfSelectedItem]
    }
}
