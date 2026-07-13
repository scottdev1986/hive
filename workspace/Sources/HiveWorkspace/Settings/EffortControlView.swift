import AppKit
import WorkspaceCore

/// The three-valued effort control (spec §2.4). Three states, three visibly
/// different treatments — a picker only ever exists when the vendor listed
/// levels, and the two no-picker states carry different words because they
/// are different facts:
/// - known(levels): a popup with exactly those strings, in vendor order
/// - known-none: "This model has no effort setting."
/// - unknown(reason): "Effort options unknown — {reason}"
final class EffortControlView: NSView {

    private let popup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let caption = NSTextField(labelWithString: "")
    private var levels: [String] = []
    var onSelect: ((EffortTarget) -> Void)?

    init(axis: EffortAxis, selection: EffortTarget, enabled: Bool) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        popup.translatesAutoresizingMaskIntoConstraints = false
        popup.controlSize = .small
        popup.font = NSFont.systemFont(ofSize: 11)
        caption.translatesAutoresizingMaskIntoConstraints = false
        caption.font = Theme.Font.caption
        caption.textColor = .secondaryLabelColor
        caption.lineBreakMode = .byTruncatingTail
        caption.setContentCompressionResistancePriority(.init(710), for: .horizontal)

        switch axis {
        case .known(let levels, _):
            self.levels = levels
            popup.addItem(withTitle: "Vendor decides")
            popup.menu?.addItem(.separator())
            for level in levels {
                popup.addItem(withTitle: level)
            }
            if case .exact(let value) = selection,
               let index = levels.firstIndex(of: value) {
                // +2 skips the vendor-default item and the separator.
                popup.selectItem(at: index + 2)
            } else {
                popup.selectItem(at: 0)
            }
            popup.target = self
            popup.action = #selector(pick(_:))
            popup.isEnabled = enabled
            popup.toolTip = MCCCopy.effortProviderControlled
            popup.setAccessibilityLabel("Effort")
            install(popup)

        case .none:
            caption.stringValue = MCCCopy.effortNone
            install(caption)

        case .unknown(let reason):
            caption.stringValue = MCCCopy.effortUnknown(reason)
            caption.textColor = .tertiaryLabelColor
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
        let index = sender.indexOfSelectedItem
        if index == 0 {
            onSelect?(.providerControlled)
        } else if index >= 2, index - 2 < levels.count {
            onSelect?(.exact(levels[index - 2]))
        }
    }
}
