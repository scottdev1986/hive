import AppKit
import WorkspaceCore

/// The three-valued effort control (spec §2.4). Three states, three visibly
/// different treatments — a picker only ever exists when the vendor listed
/// levels, and the two no-picker states carry different words because they
/// are different facts:
/// - known(levels): a popup with exactly those strings, in vendor order
/// - known-none: "This model has no effort setting."
/// - unknown(reason): "Effort options unknown — {reason}"
///
/// There is deliberately NO "vendor decides" option: a vendor-chosen effort
/// is a default wearing a different hat, and the user is specific about what
/// runs. An effort the user has not chosen yet displays as unchosen
/// ("Set effort…"), never as a hidden delegation.
final class EffortControlView: NSView {

    private let popup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let caption = NSTextField(labelWithString: "")
    private var levels: [String] = []
    private var hasPlaceholder = false
    var onSelect: ((EffortTarget) -> Void)?

    /// `selection` nil (or provider-controlled) = no explicit choice yet.
    init(axis: EffortAxis, selection: EffortTarget?, enabled: Bool) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        popup.translatesAutoresizingMaskIntoConstraints = false
        popup.controlSize = .small
        popup.font = NSFont.systemFont(ofSize: 11)
        caption.translatesAutoresizingMaskIntoConstraints = false
        caption.font = Theme.Font.caption
        caption.textColor = .secondaryLabelColor
        caption.lineBreakMode = .byTruncatingTail
        caption.setContentCompressionResistancePriority(.init(455), for: .horizontal)

        switch axis {
        case .known(let levels, let defaultLevel):
            self.levels = levels
            var selectedIndex: Int?
            if case .exact(let value)? = selection,
               let index = levels.firstIndex(of: value) {
                selectedIndex = index
            }
            if selectedIndex == nil {
                // No explicit choice yet: say so. The placeholder is not a
                // pickable value and disappears once the user chooses.
                hasPlaceholder = true
                popup.addItem(withTitle: "Set effort…")
                popup.menu?.addItem(.separator())
            }
            for level in levels {
                let suffix = level == defaultLevel ? " (vendor recommends)" : ""
                popup.addItem(withTitle: "\(level)\(suffix)")
            }
            let offset = hasPlaceholder ? 2 : 0
            popup.selectItem(at: selectedIndex.map { $0 + offset } ?? 0)
            popup.target = self
            popup.action = #selector(pick(_:))
            popup.isEnabled = enabled
            popup.setAccessibilityLabel("Effort")
            install(popup)

        case .none:
            caption.stringValue = MCCCopy.effortNone
            caption.toolTip = caption.stringValue
            install(caption)

        case .unknown(let reason):
            caption.stringValue = MCCCopy.effortUnknown(reason)
            caption.textColor = .tertiaryLabelColor
            caption.toolTip = caption.stringValue
            install(caption)
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private func install(_ view: NSView) {
        addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: leadingAnchor),
            view.trailingAnchor.constraint(equalTo: trailingAnchor),
            view.topAnchor.constraint(equalTo: topAnchor),
            view.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    @objc private func pick(_ sender: NSPopUpButton) {
        let offset = hasPlaceholder ? 2 : 0
        let index = sender.indexOfSelectedItem - offset
        guard index >= 0, index < levels.count else { return }
        onSelect?(.exact(levels[index]))
    }
}
