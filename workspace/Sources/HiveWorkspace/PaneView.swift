import AppKit
import WorkspaceCore

/// One pane: native header bar, content, and the two independent signals the
/// blueprint separates — a status border (semantic color) and a focus ring
/// (accent color, inset) that never overwrites it.
final class PaneView: NSView {

    let paneID: PaneID
    private let dispatch: (WorkspaceCommand) -> Void

    private let backgroundView = NSVisualEffectView()
    private let headerView = NSView()
    private let statusIcon = NSImageView()
    private let titleLabel = NSTextField(labelWithString: "")
    private let detailLabel = NSTextField(labelWithString: "")
    private let failureBadge = NSImageView()
    let contentView: TranscriptPaneView

    private let statusBorderLayer = CAShapeLayer()
    private let focusRingLayer = CAShapeLayer()
    private var currentStatus: PaneStatus = .running
    private var pulsing = false

    init(paneID: PaneID, title: String, dispatch: @escaping (WorkspaceCommand) -> Void) {
        self.paneID = paneID
        self.dispatch = dispatch
        self.contentView = TranscriptPaneView(paneID: paneID, dispatch: dispatch)
        super.init(frame: .zero)
        wantsLayer = true
        setup(title: title)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func setup(title: String) {
        layer?.cornerRadius = 10
        layer?.masksToBounds = false

        backgroundView.material = .contentBackground
        backgroundView.blendingMode = .withinWindow
        backgroundView.state = .active
        backgroundView.wantsLayer = true
        backgroundView.layer?.cornerRadius = 10
        backgroundView.layer?.masksToBounds = true
        backgroundView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(backgroundView)

        statusIcon.translatesAutoresizingMaskIntoConstraints = false
        statusIcon.contentTintColor = .systemBlue

        titleLabel.stringValue = title
        titleLabel.font = Theme.headerFont
        titleLabel.textColor = .labelColor
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.translatesAutoresizingMaskIntoConstraints = false

        detailLabel.font = Theme.captionFont
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.lineBreakMode = .byTruncatingTail
        detailLabel.translatesAutoresizingMaskIntoConstraints = false

        failureBadge.image = NSImage(systemSymbolName: "exclamationmark.circle.fill",
                                     accessibilityDescription: "Failure")
        failureBadge.contentTintColor = .systemRed
        failureBadge.isHidden = true
        failureBadge.translatesAutoresizingMaskIntoConstraints = false

        let promoteButton = headerButton(symbol: "arrow.up.left.and.arrow.down.right",
                                         tooltip: "Promote to Master",
                                         action: #selector(promoteAction))
        let closeButton = headerButton(symbol: "xmark", tooltip: "Close Pane",
                                       action: #selector(closeAction))

        headerView.translatesAutoresizingMaskIntoConstraints = false
        headerView.addSubview(statusIcon)
        headerView.addSubview(titleLabel)
        headerView.addSubview(detailLabel)
        headerView.addSubview(failureBadge)
        headerView.addSubview(promoteButton)
        headerView.addSubview(closeButton)
        backgroundView.addSubview(headerView)

        contentView.translatesAutoresizingMaskIntoConstraints = false
        backgroundView.addSubview(contentView)

        let headerSeparator = NSBox()
        headerSeparator.boxType = .separator
        headerSeparator.translatesAutoresizingMaskIntoConstraints = false
        backgroundView.addSubview(headerSeparator)

        NSLayoutConstraint.activate([
            backgroundView.topAnchor.constraint(equalTo: topAnchor),
            backgroundView.leadingAnchor.constraint(equalTo: leadingAnchor),
            backgroundView.trailingAnchor.constraint(equalTo: trailingAnchor),
            backgroundView.bottomAnchor.constraint(equalTo: bottomAnchor),

            headerView.topAnchor.constraint(equalTo: backgroundView.topAnchor),
            headerView.leadingAnchor.constraint(equalTo: backgroundView.leadingAnchor),
            headerView.trailingAnchor.constraint(equalTo: backgroundView.trailingAnchor),
            headerView.heightAnchor.constraint(equalToConstant: 30),

            statusIcon.leadingAnchor.constraint(equalTo: headerView.leadingAnchor, constant: 10),
            statusIcon.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),
            statusIcon.widthAnchor.constraint(equalToConstant: 14),
            statusIcon.heightAnchor.constraint(equalToConstant: 14),

            titleLabel.leadingAnchor.constraint(equalTo: statusIcon.trailingAnchor, constant: 6),
            titleLabel.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),

            detailLabel.leadingAnchor.constraint(equalTo: titleLabel.trailingAnchor, constant: 8),
            detailLabel.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),
            detailLabel.trailingAnchor.constraint(lessThanOrEqualTo: failureBadge.leadingAnchor, constant: -6),

            failureBadge.trailingAnchor.constraint(equalTo: promoteButton.leadingAnchor, constant: -6),
            failureBadge.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),

            promoteButton.trailingAnchor.constraint(equalTo: closeButton.leadingAnchor, constant: -4),
            promoteButton.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),
            closeButton.trailingAnchor.constraint(equalTo: headerView.trailingAnchor, constant: -8),
            closeButton.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),

            headerSeparator.topAnchor.constraint(equalTo: headerView.bottomAnchor),
            headerSeparator.leadingAnchor.constraint(equalTo: backgroundView.leadingAnchor),
            headerSeparator.trailingAnchor.constraint(equalTo: backgroundView.trailingAnchor),

            contentView.topAnchor.constraint(equalTo: headerSeparator.bottomAnchor),
            contentView.leadingAnchor.constraint(equalTo: backgroundView.leadingAnchor),
            contentView.trailingAnchor.constraint(equalTo: backgroundView.trailingAnchor),
            contentView.bottomAnchor.constraint(equalTo: backgroundView.bottomAnchor),
        ])

        // Status border (outer) and focus ring (inset) are separate layers.
        statusBorderLayer.fillColor = nil
        statusBorderLayer.lineWidth = 2
        layer?.addSublayer(statusBorderLayer)

        focusRingLayer.fillColor = nil
        focusRingLayer.lineWidth = 2
        focusRingLayer.isHidden = true
        layer?.addSublayer(focusRingLayer)

        // Double-click the header promotes (same command as menu/shortcut).
        let doubleClick = NSClickGestureRecognizer(target: self, action: #selector(promoteAction))
        doubleClick.numberOfClicksRequired = 2
        headerView.addGestureRecognizer(doubleClick)

        // A click anywhere focuses the pane but never promotes it.
        let click = NSClickGestureRecognizer(target: self, action: #selector(focusAction))
        click.numberOfClicksRequired = 1
        click.delaysPrimaryMouseButtonEvents = false
        addGestureRecognizer(click)

        // Accessibility: one group per pane; actions mirror the command model.
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("\(title) pane")
    }

    private func headerButton(symbol: String, tooltip: String, action: Selector) -> NSButton {
        let button = NSButton(image: NSImage(systemSymbolName: symbol, accessibilityDescription: tooltip)!,
                              target: self, action: action)
        button.isBordered = false
        button.bezelStyle = .accessoryBarAction
        button.toolTip = tooltip
        button.translatesAutoresizingMaskIntoConstraints = false
        button.setAccessibilityLabel(tooltip)
        return button
    }

    override func layout() {
        super.layout()
        let borderPath = CGPath(roundedRect: bounds.insetBy(dx: 1, dy: 1),
                                cornerWidth: 10, cornerHeight: 10, transform: nil)
        statusBorderLayer.path = borderPath
        statusBorderLayer.frame = bounds
        let ringPath = CGPath(roundedRect: bounds.insetBy(dx: 4, dy: 4),
                              cornerWidth: 7, cornerHeight: 7, transform: nil)
        focusRingLayer.path = ringPath
        focusRingLayer.frame = bounds
    }

    // MARK: State rendering

    func update(state: PaneState) {
        titleLabel.stringValue = state.title
        var detail = state.statusDescription
        if let model = state.model {
            detail = "\(model) · \(detail)"
        }
        detailLabel.stringValue = detail

        let color = Theme.statusColor(for: state.status)
        statusIcon.image = NSImage(systemSymbolName: Theme.statusSymbol(for: state.status),
                                   accessibilityDescription: state.statusDescription)
        statusIcon.contentTintColor = color
        statusBorderLayer.strokeColor = color.cgColor
        statusBorderLayer.lineDashPattern = Theme.statusIsDashed(state.status) ? [6, 4] : nil

        if case .failed(false) = state.status {
            failureBadge.isHidden = false
        } else {
            failureBadge.isHidden = true
        }

        let wasWaiting = currentStatus.isWaiting
        currentStatus = state.status
        if state.status.isWaiting && !wasWaiting {
            startBoundedPulse()
        } else if !state.status.isWaiting {
            stopPulse()
        }

        setAccessibilityLabel("\(state.title) pane")
        setAccessibilityValue(state.statusDescription)
        window?.contentView?.setNeedsDisplay(frame)
    }

    /// Amber pulse: a short bounded burst, then steady amber. Purely visual —
    /// semantic state and attention never depend on it. Reduce Motion skips
    /// straight to steady.
    private func startBoundedPulse() {
        guard !pulsing, !Theme.reduceMotion else { return }
        pulsing = true
        let pulse = CABasicAnimation(keyPath: "opacity")
        pulse.fromValue = 1.0
        pulse.toValue = 0.25
        pulse.duration = StatusMotion.waitingPulseCycleSeconds / 2
        pulse.autoreverses = true
        pulse.repeatCount = Float(StatusMotion.waitingPulseCycles)
        pulse.isRemovedOnCompletion = true
        statusBorderLayer.add(pulse, forKey: "waiting-pulse")
        DispatchQueue.main.asyncAfter(deadline: .now() + StatusMotion.waitingPulseBurstSeconds) { [weak self] in
            self?.pulsing = false
        }
    }

    private func stopPulse() {
        statusBorderLayer.removeAnimation(forKey: "waiting-pulse")
        pulsing = false
    }

    func setFocused(_ focused: Bool) {
        focusRingLayer.strokeColor = NSColor.controlAccentColor.cgColor
        focusRingLayer.isHidden = !focused
        // The status border above is untouched: focus never overwrites status.
    }

    /// Called exactly once per settled layout change (end of the ~180 ms
    /// transition, or immediately under Reduce Motion). The future terminal
    /// pane converts this into its single PTY resize.
    func commitCellGeometry() {
        contentView.commitCellGeometry()
    }

    // MARK: Actions (all routed through the shared command model)

    @objc private func promoteAction() {
        dispatch(.promotePane(paneID))
    }

    @objc private func closeAction() {
        dispatch(.closePane(paneID))
    }

    @objc private func focusAction() {
        dispatch(.focusPane(paneID))
    }

    override func accessibilityCustomActions() -> [NSAccessibilityCustomAction]? {
        [
            NSAccessibilityCustomAction(name: "Promote to Master") { [weak self] in
                guard let self else { return false }
                self.dispatch(.promotePane(self.paneID))
                return true
            },
            NSAccessibilityCustomAction(name: "Acknowledge") { [weak self] in
                guard let self else { return false }
                self.dispatch(.acknowledgePane(self.paneID))
                return true
            },
            NSAccessibilityCustomAction(name: "Close Pane") { [weak self] in
                guard let self else { return false }
                self.dispatch(.closePane(self.paneID))
                return true
            },
        ]
    }
}
