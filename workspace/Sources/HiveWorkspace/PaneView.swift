import AppKit
import HiveTerminalKit
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

    private let statusBorder = PaneStatusBorderView()
    private let focusRing = PaneFocusRingView()
    private var currentStatus: PaneStatus = .unknown
    private var pulsing = false
    private var focusIndicator: PaneFocusIndicator = .none

    /// B2.2: a sessiond-backed pane renders through HiveTerminalView driven by
    /// the pane's exact locator; the SwiftTerm content stays unspawned beneath
    /// it. nil for tmux panes.
    private(set) var sessiondTerminal: SessiondPaneTerminal?

    /// The terminal's own failure, held apart from the feed's header text.
    /// `update(state:)` rewrites detailLabel and re-hides failureBadge on every
    /// feed tick, so a failure that is not re-applied there is visible for one
    /// tick and then gone — leaving a pane that reads healthy while nothing is
    /// attached. Terminal once set: §26 give-up never un-gives-up.
    private(set) var terminalFailure: (detail: String, badge: String, evidence: String)?

    /// A host refusal the next keystroke can reverse (#87). Unlike
    /// `terminalFailure` this is not a give-up: it clears as soon as input
    /// flows again, so a pane never reads frozen while typing still works.
    private var retryableInputRefusal: String?

    /// The renderer is past its escalating retry budget but still reconnecting
    /// (#90). Transient for the same reason.
    private var rendererRecovering: String?

    /// Last header text the feed wrote, so a cleared retryable refusal restores
    /// it without waiting for the next feed tick.
    private var feedHeaderDescription = ""

    /// Installs the sessiond renderer over the content area. The tmux content
    /// view must not have been scheduled; close/kill authority is untouched
    /// (the renderer is a disposable viewer, §26).
    func installSessiondTerminal(_ terminal: SessiondPaneTerminal) {
        guard sessiondTerminal == nil else { return }
        do {
            let terminalView = try terminal.makeView()
            terminalView.frame = contentView.bounds
            contentView.addSubview(terminalView)
            sessiondTerminal = terminal
            // §26 bounded recovery: surface a visible failure on the pane
            // instead of a silently frozen frame (fires on the main thread from
            // the recovery timer). #90 splits it the way #87 split the input
            // refusals — a renderer that is still reconnecting says so
            // transiently, and only a loss retrying cannot fix latches.
            terminal.onDegraded = { [weak self] evidence in
                self?.showRendererRecovering(evidence)
            }
            terminal.onRecovered = { [weak self] in
                self?.showRendererRecovering(nil)
            }
            terminal.onFailure = { [weak self] evidence in
                self?.showTerminalFailure(
                    detail: "renderer disconnected",
                    badge: "Terminal renderer disconnected",
                    evidence: evidence)
            }
            terminalView.onInputSubmissionStateChange = { [weak self] state in
                self?.applyInputSubmissionState(state)
            }
            terminal.startWhenGeometryReady()
        } catch {
            NSLog("sessiond terminal surface for pane %@ failed: %@",
                  titleLabel.stringValue, "\(error)")
        }
    }

    init(paneID: PaneID, title: String, tmuxSession: String? = nil,
         tmuxSocket: String? = nil,
         allowsMouseReporting: Bool = true,
         dispatch: @escaping (WorkspaceCommand) -> Void) {
        self.paneID = paneID
        self.dispatch = dispatch
        self.contentView = TerminalPaneView(
            tmuxSession: tmuxSession,
            tmuxSocket: tmuxSocket,
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
        titleLabel.toolTip = title
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

        // AppKit may grow the window instead of truncating a label whose
        // compression priority is 500 or higher. Keep both labels below that
        // threshold; the detail still yields before the pane name.
        let spacer = NSView()
        spacer.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        spacer.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        titleLabel.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(490), for: .horizontal)
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
            // The status stroke occupies x/y 2...6 inside the pane. SwiftTerm
            // must receive only the pixels it can actually draw in; otherwise
            // its negotiated grid includes edge glyphs hidden by the overlay.
            contentView.leadingAnchor.constraint(equalTo: backgroundView.leadingAnchor, constant: 6),
            contentView.trailingAnchor.constraint(equalTo: backgroundView.trailingAnchor, constant: -6),
            contentView.bottomAnchor.constraint(equalTo: backgroundView.bottomAnchor, constant: -6),
        ])

        // Status and focus are sibling overlays above the opaque background.
        // Both pass every click through to the terminal below.
        headerView.wantsLayer = true
        statusBorder.translatesAutoresizingMaskIntoConstraints = false
        addSubview(statusBorder)
        focusRing.translatesAutoresizingMaskIntoConstraints = false
        addSubview(focusRing)
        NSLayoutConstraint.activate([
            statusBorder.topAnchor.constraint(equalTo: topAnchor),
            statusBorder.leadingAnchor.constraint(equalTo: leadingAnchor),
            statusBorder.trailingAnchor.constraint(equalTo: trailingAnchor),
            statusBorder.bottomAnchor.constraint(equalTo: bottomAnchor),
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

    /// CGColors are resolved, not dynamic: re-resolve the header tint whenever
    /// the pane switches between light and dark.
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyHeaderTint()
    }

    // MARK: State rendering

    /// Records a terminal failure and shows it. Main-thread only (both callers
    /// fire from the main queue). Module-internal so the durability guard can
    /// drive it without a live GPU surface.
    func showTerminalFailure(detail: String, badge: String, evidence: String) {
        terminalFailure = (detail, badge, evidence)
        applyTerminalFailure()
    }

    /// Re-asserts the recorded failure over whatever the feed just wrote.
    private func applyTerminalFailure() {
        guard let terminalFailure else {
            applyTransientNotice()
            return
        }
        failureBadge.isHidden = false
        failureBadge.toolTip = "\(terminalFailure.badge) — \(terminalFailure.evidence)"
        detailLabel.stringValue = terminalFailure.detail
        detailLabel.toolTip = terminalFailure.evidence
    }

    /// #87: the two input refusals render differently on purpose. A refusal the
    /// viewer cannot recover from latches the give-up badge; a retryable one —
    /// the host is busy with automation, or holds this human's orphaned claim —
    /// leaves the write path armed, so it must clear itself the moment input
    /// flows again rather than leaving the pane reading frozen forever.
    /// Module-internal so the split is testable without a live GPU surface.
    func applyInputSubmissionState(_ state: InputSubmissionState) {
        if let evidence = state.failureEvidence {
            showTerminalFailure(
                detail: "input refused",
                badge: "Terminal input refused",
                evidence: evidence)
            return
        }
        retryableInputRefusal = state.retryableEvidence
        applyTerminalFailure()
    }

    /// #90: the renderer is past its escalating budget but still reconnecting.
    /// Transient like a retryable input refusal — nil clears it, and it never
    /// touches the sticky give-up, which would leave a dead-looking pane that
    /// is in fact recovering.
    func showRendererRecovering(_ evidence: String?) {
        rendererRecovering = evidence
        applyTerminalFailure()
    }

    /// Shows whichever transient condition holds over the feed text, and puts
    /// the feed text back when none does. Never touches the failure badge.
    /// A renderer that is not painting outranks an input path that is refused.
    private func applyTransientNotice() {
        if let rendererRecovering {
            detailLabel.stringValue = "renderer reconnecting…"
            detailLabel.toolTip = rendererRecovering
            return
        }
        guard let retryableInputRefusal else {
            detailLabel.stringValue = feedHeaderDescription
            detailLabel.toolTip = feedHeaderDescription
            return
        }
        detailLabel.stringValue = "input refused — type to retry"
        detailLabel.toolTip = retryableInputRefusal
    }

    func update(state: PaneState) {
        titleLabel.stringValue = state.title
        titleLabel.toolTip = state.title
        feedHeaderDescription = state.headerDescription
        detailLabel.stringValue = state.headerDescription
        detailLabel.toolTip = state.headerDescription

        let appearance = FeedStatusMap.activity(
            for: state.feedStatus, paneStatus: state.status).appearance
        var subdued = false
        if case .completed(let acknowledged) = state.status { subdued = acknowledged }
        let color = Theme.statusColor(for: appearance.color, subdued: subdued)
        statusIcon.image = NSImage(systemSymbolName: appearance.symbol,
                                   accessibilityDescription: state.statusDescription)
        statusIcon.contentTintColor = color
        statusBorder.statusAppearance = appearance
        statusBorder.subdued = subdued

        if case .failed(false) = state.status {
            failureBadge.isHidden = false
        } else {
            failureBadge.isHidden = true
        }
        applyTerminalFailure()

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
        statusBorder.startPulse()
        DispatchQueue.main.asyncAfter(deadline: .now() + StatusMotion.waitingPulseBurstSeconds) { [weak self] in
            self?.pulsing = false
        }
    }

    private func stopPulse() {
        statusBorder.stopPulse()
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
        // A snapped outer frame does not synchronously propagate through this
        // pane's Auto Layout constraints. Without this layout pass the terminal
        // can still report 0x0 here, leave its launch pending, and never get
        // another commit when a second Workspace process opens for the same
        // bundle. Commit the complete pane hierarchy before testing the cell.
        layoutSubtreeIfNeeded()
        contentView.commitCellGeometry()
    }

    func focusTerminal() {
        if let terminalView = sessiondTerminal?.view {
            terminalView.focusExplicitly()
        } else {
            contentView.focusTerminal()
        }
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
