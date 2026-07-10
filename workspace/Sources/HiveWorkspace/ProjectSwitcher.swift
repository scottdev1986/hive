import AppKit
import WorkspaceCore

/// Sanitized project cards: name, provider/model, aggregate agent states, and
/// warnings — never another project's transcript content. Selecting a card
/// activates its project window.
final class ProjectSwitcherController: NSObject {

    private var cardProviders: [() -> ProjectState.SwitcherCard] = []
    private var activateHandlers: [ProjectID: () -> Void] = [:]
    private var panel: NSPanel?
    private let stack = NSStackView()

    func register(state: ProjectState, activate: @escaping () -> Void) {
        cardProviders.append { state.switcherCard }
        activateHandlers[state.projectID] = activate
    }

    func showPanel() {
        if panel == nil {
            buildPanel()
        }
        rebuildCards()
        panel?.makeKeyAndOrderFront(nil)
    }

    private func buildPanel() {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 220),
            styleMask: [.titled, .closable, .utilityWindow],
            backing: .buffered, defer: false)
        panel.title = "Projects"
        panel.isFloatingPanel = true

        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 14, left: 14, bottom: 14, right: 14)
        stack.translatesAutoresizingMaskIntoConstraints = false

        let background = NSVisualEffectView()
        background.material = .popover
        background.state = .active
        background.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: background.topAnchor),
            stack.leadingAnchor.constraint(equalTo: background.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: background.trailingAnchor),
        ])
        panel.contentView = background
        panel.center()
        self.panel = panel
    }

    private func rebuildCards() {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for provider in cardProviders {
            let card = provider()

            let name = NSTextField(labelWithString: card.displayName)
            name.font = NSFont.systemFont(ofSize: 14, weight: .semibold)

            var parts: [String] = []
            if let model = card.orchestratorModel { parts.append(model) }
            parts.append("\(card.paneCount) panes")
            if card.runningCount > 0 { parts.append("\(card.runningCount) running") }
            if card.waitingCount > 0 { parts.append("\(card.waitingCount) waiting") }
            if card.failedCount > 0 { parts.append("\(card.failedCount) failed") }
            let summary = NSTextField(labelWithString: parts.joined(separator: " · "))
            summary.font = Theme.captionFont
            summary.textColor = card.failedCount > 0 ? .systemRed : .secondaryLabelColor

            let open = NSButton(title: "Open", target: self, action: #selector(openProject(_:)))
            open.bezelStyle = .rounded
            open.controlSize = .small
            open.identifier = NSUserInterfaceItemIdentifier(card.projectID.raw)

            let labels = NSStackView(views: [name, summary])
            labels.orientation = .vertical
            labels.alignment = .leading
            labels.spacing = 2

            let row = NSStackView(views: [labels, NSView(), open])
            row.orientation = .horizontal
            row.alignment = .centerY
            row.spacing = 8
            stack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -28).isActive = true
        }
    }

    @objc private func openProject(_ sender: NSButton) {
        guard let raw = sender.identifier?.rawValue else { return }
        activateHandlers[ProjectID(raw)]?()
        panel?.orderOut(nil)
    }
}
