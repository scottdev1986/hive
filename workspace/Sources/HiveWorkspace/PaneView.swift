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
    private let headerStack = NSStackView()
    private let statusIcon = NSImageView()
    private let titleLabel = NSTextField(labelWithString: "")
    private let detailLabel = NSTextField(labelWithString: "")
    private let failureBadge = NSImageView()
    let contentView: TerminalPaneView

    private let statusBorderLayer = CAShapeLayer()
    private let focusRing = PaneFocusRingView()
    private var currentStatus: PaneStatus = .running
    private var pulsing = false
    private var focusIndicator: PaneFocusIndicator = .none

    init(paneID: PaneID, title: String, tmuxSession: String? = nil,
         allowsMouseReporting: Bool = true,
         dispatch: @escaping (WorkspaceCommand) -> Void) {
        self.paneID = paneID
        self.dispatch = dispatch
        self.contentView = TerminalPaneView(
            tmuxSession: tmuxSession,
            allowsMouseReporting: allowsMouseReporting)
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
        // Middle truncation keeps names tellable-apart under extreme squeeze:
        // "ab…l"/"ab…y" instead of both collapsing to "ab…".
        titleLabel.lineBreakMode = .byTruncatingMiddle
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

        // Explicit truncation priority for a narrowing header. The user finds
        // a pane by NAME and DOT, so those are the last things standing:
        //   1. status dot — fixed size, never yields
        //   2. agent name — compresses (middle-truncated) only when nothing
        //      else is left to give
        //   3. failure badge, then close, then promote — detached whole,
        //      never clipped; both buttons have keyboard/menu equivalents
        //   4. detail text — yields first; its status word already rides the
        //      dot, so it is the least costly loss
        let spacer = NSView()
        spacer.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        spacer.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        titleLabel.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(999), for: .horizontal)
        detailLabel.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(200), for: .horizontal)

        headerStack.orientation = .horizontal
        headerStack.alignment = .centerY
        headerStack.spacing = 6
        headerStack.detachesHiddenViews = true
        headerStack.setClippingResistancePriority(.required, for: .horizontal)
        headerStack.translatesAutoresizingMaskIntoConstraints = false
        for view in [statusIcon, titleLabel, detailLabel, spacer, failureBadge, promoteButton, closeButton] {
            headerStack.addArrangedSubview(view)
        }
        headerStack.setVisibilityPriority(.mustHold, for: statusIcon)
        headerStack.setVisibilityPriority(.mustHold, for: titleLabel)
        // The detail label shrinks to nothing (truncating tail) rather than
        // detaching, so mild squeezes lose characters, not whole fields.
        headerStack.setVisibilityPriority(.mustHold, for: detailLabel)
        headerStack.setVisibilityPriority(.mustHold, for: spacer)
        headerStack.setVisibilityPriority(NSStackView.VisibilityPriority(500), for: failureBadge)
        headerStack.setVisibilityPriority(NSStackView.VisibilityPriority(400), for: closeButton)
        headerStack.setVisibilityPriority(NSStackView.VisibilityPriority(300), for: promoteButton)

        headerView.translatesAutoresizingMaskIntoConstraints = false
        headerView.addSubview(headerStack)
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

            headerStack.leadingAnchor.constraint(equalTo: headerView.leadingAnchor, constant: 10),
            headerStack.trailingAnchor.constraint(equalTo: headerView.trailingAnchor, constant: -8),
            headerStack.topAnchor.constraint(equalTo: headerView.topAnchor),
            headerStack.bottomAnchor.constraint(equalTo: headerView.bottomAnchor),
            statusIcon.widthAnchor.constraint(equalToConstant: 14),
            statusIcon.heightAnchor.constraint(equalToConstant: 14),

            headerSeparator.topAnchor.constraint(equalTo: headerView.bottomAnchor),
            headerSeparator.leadingAnchor.constraint(equalTo: backgroundView.leadingAnchor),
            headerSeparator.trailingAnchor.constraint(equalTo: backgroundView.trailingAnchor),

            contentView.topAnchor.constraint(equalTo: headerSeparator.bottomAnchor),
            contentView.leadingAnchor.constraint(equalTo: backgroundView.leadingAnchor),
            contentView.trailingAnchor.constraint(equalTo: backgroundView.trailingAnchor),
            contentView.bottomAnchor.constraint(equalTo: backgroundView.bottomAnchor),
        ])

        statusBorderLayer.fillColor = nil
        statusBorderLayer.lineWidth = 2
        layer?.addSublayer(statusBorderLayer)

        // The focus ring is the LAST subview: it must draw over the pane's
        // opaque background (and it passes every click through to the terminal).
        headerView.wantsLayer = true
        focusRing.translatesAutoresizingMaskIntoConstraints = false
        addSubview(focusRing)
        NSLayoutConstraint.activate([
            focusRing.topAnchor.constraint(equalTo: topAnchor),
            focusRing.leadingAnchor.constraint(equalTo: leadingAnchor),
            focusRing.trailingAnchor.constraint(equalTo: trailingAnchor),
            focusRing.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

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
    }

    /// CGColors are resolved, not dynamic: re-resolve the header tint whenever
    /// the pane switches between light and dark.
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyHeaderTint()
    }

    // MARK: State rendering

    func update(state: PaneState) {
        titleLabel.stringValue = state.title
        detailLabel.stringValue = state.headerDescription

        let color = Theme.statusColor(for: state.status)
        statusIcon.image = NSImage(systemSymbolName: Theme.statusSymbol(for: state.status),
                                   accessibilityDescription: state.statusDescription)
        // The dot reports measured activity (finer than the border's semantic
        // state): working and idle must read differently at a glance.
        var doneAcknowledged = false
        if case .completed(let acknowledged) = state.status { doneAcknowledged = acknowledged }
        statusIcon.contentTintColor = Theme.dotColor(
            for: FeedStatusMap.activity(for: state.feedStatus),
            acknowledged: doneAcknowledged)
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

    /// What this pane is actually rendering (smoke introspection).
    var currentFocusIndicator: PaneFocusIndicator { focusIndicator }

    /// Driven by the window's REAL first responder and key state — never by the
    /// last click. See `ProjectWindowController.refreshFocusIndicators()`.
    func setFocusIndicator(_ indicator: PaneFocusIndicator) {
        guard indicator != focusIndicator else { return }
        focusIndicator = indicator
        focusRing.indicator = indicator
        applyHeaderTint()
        // The status border is untouched: focus never overwrites status.
    }

    private func applyHeaderTint() {
        let tint = PaneFocusRing.headerTint(for: focusIndicator)
        effectiveAppearance.performAsCurrentDrawingAppearance {
            headerView.layer?.backgroundColor = tint.cgColor
        }
    }

    /// Called exactly once per settled layout change (end of the ~180 ms
    /// transition, or immediately under Reduce Motion). The terminal pane
    /// uses it to spawn its child with settled pty geometry.
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
