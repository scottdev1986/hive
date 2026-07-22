import AppKit

public struct TerminalSearchState: Equatable, Sendable {
    public fileprivate(set) var isPresented = false
    public fileprivate(set) var query = ""
    public fileprivate(set) var totalResults: Int?
    public fileprivate(set) var selectedResult: Int?
    public let retainedHistoryLimitBytes = HiveTerminalConfiguration.scrollbackLimitBytes

    public var historyLimitNotice: String {
        "Retained history · \(retainedHistoryLimitBytes / 1024 / 1024) MiB max"
    }
}

public struct TerminalScrollState: Equatable, Sendable {
    public fileprivate(set) var totalRows: UInt64 = 0
    public fileprivate(set) var viewportOffset: UInt64 = 0
    public fileprivate(set) var viewportLength: UInt64 = 0
    public fileprivate(set) var hasUnseenOutput = false

    public var followsBottom: Bool {
        viewportOffset + viewportLength >= totalRows
    }
}

extension HiveTerminalView {
    public var searchState: TerminalSearchState { searchStateStorage }
    public var scrollState: TerminalScrollState { scrollStateStorage }

    var searchOverlayForTesting: TerminalSearchOverlay? { searchOverlayStorage }
    var newOutputIndicatorForTesting: NSButton? { newOutputIndicatorStorage }

    var canCopySelection: Bool {
        if let snapshot = (engine as? ManualSurfaceSemanticSnapshotProviding)?.semanticSnapshot() {
            return snapshot.selection != nil
        }
        return engine.readSelection() != nil && engine.readSelectedText() != nil
    }

    @IBAction public func showSearch(_ sender: Any?) {
        _ = sender
        searchStateStorage.isPresented = true
        searchStateStorage.totalResults = nil
        searchStateStorage.selectedResult = nil

        let overlay: TerminalSearchOverlay
        if let existing = searchOverlayStorage {
            overlay = existing
        } else {
            overlay = TerminalSearchOverlay()
            overlay.onQueryChange = { [weak self] query in _ = self?.search(query) }
            overlay.onNext = { [weak self] in _ = self?.navigateSearchToNext() }
            overlay.onPrevious = { [weak self] in _ = self?.navigateSearchToPrevious() }
            overlay.onClose = { [weak self] in self?.endSearch() }
            overlay.translatesAutoresizingMaskIntoConstraints = false
            addSubview(overlay)
            NSLayoutConstraint.activate([
                overlay.topAnchor.constraint(equalTo: topAnchor, constant: 8),
                overlay.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            ])
            searchOverlayStorage = overlay
        }
        overlay.update(searchStateStorage)
        DispatchQueue.main.async { [weak self, weak overlay] in
            guard let self, let overlay, self.searchOverlayStorage === overlay else { return }
            self.window?.makeFirstResponder(overlay.searchField)
        }
    }

    func updateSearchQuery(_ query: String) {
        searchStateStorage.query = query
        searchStateStorage.totalResults = nil
        searchStateStorage.selectedResult = nil
        searchOverlayStorage?.update(searchStateStorage)
    }

    func dismissSearchUI(restoreTerminalFocus: Bool) {
        searchOverlayStorage?.removeFromSuperview()
        searchOverlayStorage = nil
        searchStateStorage.isPresented = false
        searchStateStorage.totalResults = nil
        searchStateStorage.selectedResult = nil
        if restoreTerminalFocus { window?.makeFirstResponder(self) }
    }

    func noteOutputApplied() {
        if let viewport = (engine as? ManualSurfaceSemanticSnapshotProviding)?
            .semanticSnapshot()?
            .viewport
        {
            scrollStateStorage.totalRows = viewport.total
            scrollStateStorage.viewportOffset = viewport.offset
            scrollStateStorage.viewportLength = viewport.length
        }
        guard !scrollStateStorage.followsBottom else { return }
        scrollStateStorage.hasUnseenOutput = true
        updateNewOutputIndicator()
    }

    func updateScrollbar(total: UInt64, offset: UInt64, length: UInt64) {
        scrollStateStorage.totalRows = total
        scrollStateStorage.viewportOffset = offset
        scrollStateStorage.viewportLength = length
        if scrollStateStorage.followsBottom {
            scrollStateStorage.hasUnseenOutput = false
        }
        updateNewOutputIndicator()
    }

    private func updateNewOutputIndicator() {
        guard scrollStateStorage.hasUnseenOutput else {
            dismissNewOutputIndicator()
            return
        }
        guard newOutputIndicatorStorage == nil else { return }
        let button = NSButton(title: "New output ↓", target: self, action: #selector(scrollToBottom(_:)))
        button.bezelStyle = .rounded
        button.toolTip = "Return to the latest terminal output"
        button.translatesAutoresizingMaskIntoConstraints = false
        addSubview(button)
        NSLayoutConstraint.activate([
            button.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            button.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
        ])
        newOutputIndicatorStorage = button
    }

    func dismissNewOutputIndicator() {
        newOutputIndicatorStorage?.removeFromSuperview()
        newOutputIndicatorStorage = nil
    }

    @IBAction public func scrollToBottom(_ sender: Any?) {
        _ = sender
        _ = performScrollToBottom()
    }

    @discardableResult
    func performScrollToBottom() -> Bool {
        guard engine.performBindingAction("scroll_to_bottom") else { return false }
        scrollStateStorage.hasUnseenOutput = false
        dismissNewOutputIndicator()
        return true
    }

    func handleTerminalActionNotification(_ note: HiveTerminalActionNotification) {
        dispatchPrecondition(condition: .onQueue(.main))
        switch note {
        case .searchTotal(let total):
            searchStateStorage.totalResults = total
            if let total, total > 0 {
                searchStateStorage.selectedResult = searchStateStorage.selectedResult ?? 0
            } else {
                searchStateStorage.selectedResult = nil
            }
        case .searchSelected(let selected):
            searchStateStorage.selectedResult = selected
        case .scrollbar(let total, let offset, let length):
            updateScrollbar(total: total, offset: offset, length: length)
        case .selectionChanged:
            return
        }
        searchOverlayStorage?.update(searchStateStorage)
    }

    public override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard modifiers.contains(.command),
              modifiers.subtracting([.command, .shift]).isEmpty,
              let key = event.charactersIgnoringModifiers?.lowercased()
        else { return super.performKeyEquivalent(with: event) }

        switch key {
        case "c":
            copy(nil)
            return true
        case "f":
            showSearch(nil)
            return true
        case "g":
            _ = event.modifierFlags.contains(.shift)
                ? navigateSearchToPrevious()
                : navigateSearchToNext()
            return true
        default:
            return super.performKeyEquivalent(with: event)
        }
    }
}

extension HiveTerminalView: NSMenuItemValidation {
    public func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(copy(_:)) { return canCopySelection }
        return true
    }
}

final class TerminalSearchOverlay: NSView, NSSearchFieldDelegate {
    let searchField = NSSearchField()
    private let resultLabel = NSTextField(labelWithString: "")
    private let scopeLabel = NSTextField(labelWithString: "")
    var onQueryChange: ((String) -> Void)?
    var onNext: (() -> Void)?
    var onPrevious: (() -> Void)?
    var onClose: (() -> Void)?

    var resultText: String { resultLabel.stringValue }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.backgroundColor = NSColor.windowBackgroundColor.withAlphaComponent(0.96).cgColor
        layer?.shadowColor = NSColor.black.cgColor
        layer?.shadowOpacity = 0.25
        layer?.shadowRadius = 6

        searchField.placeholderString = "Search retained history"
        searchField.delegate = self
        searchField.setContentHuggingPriority(.defaultLow, for: .horizontal)
        resultLabel.font = .monospacedDigitSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
        resultLabel.textColor = .secondaryLabelColor
        scopeLabel.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        scopeLabel.textColor = .secondaryLabelColor

        let previous = NSButton(title: "↑", target: self, action: #selector(previousResult))
        previous.toolTip = "Previous result (Shift-Command-G)"
        let next = NSButton(title: "↓", target: self, action: #selector(nextResult))
        next.toolTip = "Next result (Command-G)"
        let close = NSButton(title: "×", target: self, action: #selector(closeSearch))
        close.toolTip = "Close search"
        for button in [previous, next, close] { button.bezelStyle = .texturedRounded }

        let top = NSStackView(views: [searchField, resultLabel, previous, next, close])
        top.orientation = .horizontal
        top.alignment = .centerY
        top.spacing = 6
        let stack = NSStackView(views: [top, scopeLabel])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            searchField.widthAnchor.constraint(greaterThanOrEqualToConstant: 200),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func update(_ state: TerminalSearchState) {
        if searchField.stringValue != state.query { searchField.stringValue = state.query }
        if let selected = state.selectedResult {
            resultLabel.stringValue = "\(selected + 1)/\(state.totalResults.map(String.init) ?? "?")"
        } else if let total = state.totalResults {
            resultLabel.stringValue = "-/\(total)"
        } else {
            resultLabel.stringValue = ""
        }
        scopeLabel.stringValue = state.historyLimitNotice
    }

    func controlTextDidChange(_ notification: Notification) {
        _ = notification
        onQueryChange?(searchField.stringValue)
    }

    override func cancelOperation(_ sender: Any?) {
        _ = sender
        onClose?()
    }

    @objc private func previousResult() { onPrevious?() }
    @objc private func nextResult() { onNext?() }
    @objc private func closeSearch() { onClose?() }
}
