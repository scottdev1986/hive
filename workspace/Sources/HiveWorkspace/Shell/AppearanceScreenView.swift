// AppearanceScreenView.swift
//
// Terminal theme and font. These are local presentation preferences, not
// daemon policy, so this view writes HiveAppearancePreferences directly.
// Live Run terminals already observe that notification and reconfigure in
// place. Hive follows the system light/dark setting; a theme here changes
// terminal content only.

import AppKit
import HiveTerminalKit

final class AppearanceScreenView: NSView {

    private let preferences: HiveAppearancePreferences

    init(preferences: HiveAppearancePreferences = .shared) {
        self.preferences = preferences
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityIdentifier("appearance-screen")
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Appearance")
        build()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private func build() {
        let header = PageHeaderView(
            title: "Appearance",
            subtitle: """
                The terminal theme and font. Changes apply immediately to every \
                live terminal. Hive follows your system light or dark setting; \
                choosing a theme here changes terminal content only.
                """)

        let stack = NSStackView(views: [
            header,
            row(
                label: "Terminal theme",
                accessibility: "Terminal theme",
                identifier: "appearance-theme",
                titles: HiveTerminalThemeSelection.allCases.map(\.displayName),
                selectedIndex: HiveTerminalThemeSelection.allCases
                    .firstIndex(of: preferences.themeSelection),
                action: #selector(themeChanged(_:))),
            row(
                label: "Terminal font",
                accessibility: "Terminal font",
                identifier: "appearance-font",
                titles: HiveTerminalFont.allCases.map(\.displayName),
                selectedIndex: HiveTerminalFont.allCases.firstIndex(of: preferences.font),
                action: #selector(fontChanged(_:))),
        ])
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.m
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Theme.Space.page),
            stack.trailingAnchor.constraint(
                equalTo: trailingAnchor, constant: -Theme.Space.page),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: Theme.Space.page),
            stack.bottomAnchor.constraint(
                equalTo: bottomAnchor, constant: -Theme.Space.page),
            stack.widthAnchor.constraint(equalToConstant: 360),
        ])
    }

    private func row(
        label: String,
        accessibility: String,
        identifier: String,
        titles: [String],
        selectedIndex: Int?,
        action: Selector
    ) -> NSView {
        let caption = NSTextField(labelWithString: label)
        caption.font = Theme.Font.headline
        caption.textColor = Theme.primaryText
        caption.compressHorizontally()

        let popup = NSPopUpButton(frame: .zero, pullsDown: false)
        popup.controlSize = .small
        popup.font = Theme.Font.chromeControl
        titles.forEach { popup.addItem(withTitle: $0) }
        if let selectedIndex { popup.selectItem(at: selectedIndex) }
        popup.target = self
        popup.action = action
        popup.setAccessibilityLabel(accessibility)
        popup.setAccessibilityIdentifier(identifier)

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
