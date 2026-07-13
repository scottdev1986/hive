import AppKit
import WorkspaceCore

/// One model under a provider card: enable switch, name + id, three-valued
/// effort control, and the override chrome (spec §7.4).
///
/// The switch is a FINANCIAL CONSENT CONTROL: flipping it on authorises Hive
/// to spend on this model, with no later prompt. Rows whose billing cannot be
/// verified as covered carry a persistent, calm may-spend line (`spendCaveat`)
/// so a user who flips one can never say nobody told him.
///
/// The switch position always shows the stored PREFERENCE; effectiveness is
/// carried by the row chrome. The three off-reasons get three treatments:
/// seeded-off is inviting (full-strength row, "Off by default" badge),
/// user-off is neutral, provider-off is a dimmed override that still shows
/// the model's own setting.
final class ModelRowView: NSView {

    private let toggle = NSSwitch()
    var onToggle: ((Bool) -> Void)?

    init(
        model: DiscoveredModel,
        rowState: ModelRowState,
        effortAxis: EffortAxis,
        effortSelection: EffortTarget,
        providerTitle: String,
        poolExhausted: Bool,
        spendCaveat: String?,
        onToggle: @escaping (Bool) -> Void,
        onEffort: @escaping (EffortTarget) -> Void
    ) {
        self.onToggle = onToggle
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let name = model.humanName
        let nameLabel = NSTextField(labelWithString: name)
        nameLabel.font = Theme.Font.body
        nameLabel.lineBreakMode = .byTruncatingTail
        nameLabel.setContentCompressionResistancePriority(.init(480), for: .horizontal)

        let idLabel = NSTextField(labelWithString: model.displayId)
        idLabel.font = Theme.Font.monoCaption
        idLabel.textColor = .tertiaryLabelColor
        idLabel.lineBreakMode = .byTruncatingTail
        idLabel.toolTip = model.displayId
        idLabel.setContentCompressionResistancePriority(.init(470), for: .horizontal)

        toggle.controlSize = .small
        toggle.target = self
        toggle.action = #selector(toggled(_:))
        toggle.setAccessibilityLabel(MCCCopy.a11yModelToggle(name))

        let effort = EffortControlView(
            axis: effortAxis, selection: effortSelection,
            enabled: rowState == .enabled || rowState == .disabledBySelf
                || rowState == .seededOff)
        effort.onSelect = onEffort
        effort.setContentHuggingPriority(.defaultHigh, for: .horizontal)
        effort.setContentCompressionResistancePriority(.init(760), for: .horizontal)

        // Caption: the override / disabled story, in words, never color alone.
        var captionText = ""
        var badges: [CapsuleBadge] = []
        switch rowState {
        case .enabled:
            toggle.state = .on
        case .seededOff:
            // Deliberate, safe, and INVITING: full-strength row, an "Off by
            // default" badge, and the consent story in plain words.
            toggle.state = .off
            badges.append(CapsuleBadge(
                text: MCCCopy.seededOffBadge, symbol: "shield", style: .info))
            captionText = MCCCopy.seededOffCaption
            toggle.setAccessibilityLabel(MCCCopy.a11ySeededOff(name))
        case .disabledBySelf:
            toggle.state = .off
            captionText = MCCCopy.modelDisabledSelf
        case .disabledByProvider(let preferenceOn):
            toggle.state = preferenceOn ? .on : .off
            toggle.isEnabled = true
            captionText = MCCCopy.modelOverriddenByProvider(providerTitle)
            if preferenceOn {
                captionText += " · " + MCCCopy.modelPreferenceOnOverridden
                toggle.setAccessibilityLabel(
                    MCCCopy.a11yModelToggleOverridden(name, providerTitle))
            }
        case .unavailable:
            toggle.state = .off
            toggle.isEnabled = false
            badges.append(CapsuleBadge(
                text: MCCCopy.badgeUnavailableModel,
                symbol: "slash.circle", style: .warning))
        }
        if poolExhausted {
            badges.append(CapsuleBadge(
                text: MCCCopy.badgePlanLimit,
                symbol: "gauge.with.needle", style: .critical))
        }

        let titleRow = NSStackView(views: [nameLabel, idLabel] + badges)
        titleRow.orientation = .horizontal
        titleRow.alignment = .firstBaseline
        titleRow.spacing = Theme.Space.s

        let textColumn = NSStackView(views: [titleRow])
        textColumn.orientation = .vertical
        textColumn.alignment = .leading
        textColumn.spacing = 2
        if !captionText.isEmpty {
            let caption = NSTextField(labelWithString: captionText)
            caption.font = Theme.Font.caption
            caption.textColor = .secondaryLabelColor
            caption.lineBreakMode = .byTruncatingTail
            caption.toolTip = captionText
            caption.setContentCompressionResistancePriority(.init(450), for: .horizontal)
            textColumn.addArrangedSubview(caption)
        }
        // The persistent may-spend line: icon + words, calm, always there
        // while coverage is unverified. Seeded-off rows fold it into their
        // consent caption instead of saying it twice.
        if let spendCaveat, rowState != .seededOff {
            let icon = NSImageView()
            icon.image = NSImage(
                systemSymbolName: "dollarsign.circle", accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 10, weight: .medium))
            icon.contentTintColor = .systemOrange
            let text = rowState == .enabled
                ? MCCCopy.maySpendEnabled(spendCaveat)
                : MCCCopy.maySpend(spendCaveat)
            let label = NSTextField(labelWithString: text)
            label.font = Theme.Font.caption
            label.textColor = .secondaryLabelColor
            label.lineBreakMode = .byTruncatingTail
            label.toolTip = text
            label.setContentCompressionResistancePriority(.init(450), for: .horizontal)
            let line = NSStackView(views: [icon, label])
            line.orientation = .horizontal
            line.alignment = .centerY
            line.spacing = Theme.Space.xs
            textColumn.addArrangedSubview(line)
        }

        let row = NSStackView(views: [toggle, textColumn, NSView.spacer(), effort])
        row.translatesAutoresizingMaskIntoConstraints = false
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = Theme.Space.m
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor, constant: Theme.Space.xs),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -Theme.Space.xs),
            heightAnchor.constraint(
                greaterThanOrEqualToConstant: Theme.Metric.controlMinHeight),
        ])

        // Effective state dominates the chrome: a non-effective row is
        // visibly muted as a whole, not just captioned — EXCEPT seeded-off,
        // which is a deliberate invitation and stays full strength.
        switch rowState {
        case .disabledByProvider, .unavailable:
            alphaValue = Theme.disabledContentAlpha
        case .disabledBySelf:
            nameLabel.textColor = .tertiaryLabelColor
        case .enabled, .seededOff:
            break
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    @objc private func toggled(_ sender: NSSwitch) {
        onToggle?(sender.state == .on)
    }
}
