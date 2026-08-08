// QueenProviderScreenView.swift The Queen Provider screen: which vendor runs the live Queen, and the one control that changes it. The vendor list is the projection's own, so a vendor that cannot launch here is offered and disabled with its reason rather than hidden — hiding it would read as "no such vendor". A refused swap rebuilds this view with the same selection still made and the competing revision named.

import AppKit
import WorkspaceCore

final class QueenProviderScreenView: NSView {

    private let editor: QueenProviderEditor
    private let onSelect: (ProviderID) -> Void
    private let onSwap: () -> Void

    init(
        screen: ShellScreenProjection,
        editor: QueenProviderEditor,
        onSelect: @escaping (ProviderID) -> Void,
        onSwap: @escaping () -> Void
    ) {
        self.editor = editor
        self.onSelect = onSelect
        self.onSwap = onSwap
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.s
        stack.translatesAutoresizingMaskIntoConstraints = false

        for status in statusLabels() { stack.addArrangedSubview(status) }

        let card = CardView()
        for vendor in editor.observed.vendorIDs {
            let row = vendorRow(vendor)
            card.contentStack.addArrangedSubview(row)
            card.pinToContentWidth(row)
        }
        stack.addArrangedSubview(card)
        card.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        stack.addArrangedSubview(swapControl())
        stack.addArrangedSubview(ShellAvailabilityPanel(route: .queen, screen: screen))

        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Theme.Space.page),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: Theme.Space.m),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// One row per vendor the projection named. A vendor that cannot launch is shown disabled with the reason, never omitted.
    private func vendorRow(_ vendor: ProviderID) -> NSView {
        let available = editor.observed.vendors[vendor.rawValue]?.available == true
        let button = NSButton(
            radioButtonWithTitle: vendor.rawValue, target: self,
            action: #selector(vendorPicked(_:)))
        button.state = selected == vendor ? .on : .off
        button.isEnabled = editor.mutationsAllowed && available
        button.identifier = NSUserInterfaceItemIdentifier(vendor.rawValue)
        button.setAccessibilityIdentifier("queen-provider-vendor-\(vendor.rawValue)")

        var detail = available
            ? "can launch a queen on this machine"
            : "cannot launch a queen here right now"
        if vendor == editor.observed.liveProvider { detail = "running the live Queen · \(detail)" }
        let reading = NSTextField(labelWithString: detail)
        reading.font = Theme.Font.caption
        reading.textColor = .secondaryLabelColor

        let row = NSStackView(views: [button, reading])
        row.orientation = .horizontal
        row.spacing = Theme.Space.s
        return row
    }

    private func swapControl() -> NSView {
        let button = NSButton(
            title: "Change the live Queen's provider", target: self,
            action: #selector(swapTapped(_:)))
        button.bezelStyle = .rounded
        button.isEnabled = editor.body() != nil
        button.setAccessibilityIdentifier("queen-provider-swap")
        return button
    }

    private func statusLabels() -> [NSView] {
        var labels: [NSView] = []
        if let competing = editor.competingRevision {
            labels.append(status(
                "queen-provider-conflict",
                "Another change reached the Queen first (revision \(competing)). "
                    + "Nothing was launched or terminated, and your choice is kept below.",
                color: .systemOrange))
        }
        switch editor.observed.change.state {
        case .pending:
            labels.append(status(
                "queen-provider-pending",
                "A change was accepted and the requested provider has not been "
                    + "observed running yet.",
                color: .secondaryLabelColor))
        case .failed:
            labels.append(status(
                "queen-provider-failed",
                editor.observed.change.failure
                    ?? "The last change failed. The prior provider was preserved.",
                color: .systemOrange))
        case .idle:
            break
        case .unknown(let state):
            // A state this build cannot name is reported as itself. Reading it as idle would assert that nothing is in flight, which is a claim this build has no basis for.
            labels.append(status(
                "queen-provider-unknown-state",
                "The daemon reports a change state this build does not know: "
                    + "\(state). No claim is made about what is in flight.",
                color: .systemOrange))
        }
        if editor.hasDraft {
            labels.append(status(
                "queen-provider-draft",
                "Unsent choice: \(selected?.rawValue ?? "none").",
                color: .secondaryLabelColor))
        }
        if !editor.mutationsAllowed {
            labels.append(status(
                "queen-provider-readonly",
                "This projection is not current, so no change can be sent. "
                    + "The vendors below are the last observed reading.",
                color: .secondaryLabelColor))
        }
        return labels
    }

    private var selected: ProviderID? {
        editor.draft ?? editor.observed.liveProvider
    }

    @objc private func vendorPicked(_ sender: NSButton) {
        guard let raw = sender.identifier?.rawValue else { return }
        onSelect(ProviderID(raw))
    }

    @objc private func swapTapped(_ sender: NSButton) {
        onSwap()
    }

    private func status(_ identifier: String, _ text: String, color: NSColor) -> NSView {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = Theme.Font.callout
        label.textColor = color
        label.maximumNumberOfLines = 0
        label.setAccessibilityIdentifier(identifier)
        return label
    }
}
