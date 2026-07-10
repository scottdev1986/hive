import AppKit
import WorkspaceCore

/// The native transcript surface: a selectable NSTextView (platform find bar,
/// VoiceOver, links, selection, copy) plus an editable composer (IME-capable),
/// per the blueprint's "Hive owns the composer" correction.
final class TranscriptPaneView: NSView, NSTextViewDelegate {

    private let paneID: PaneID
    private let dispatch: (WorkspaceCommand) -> Void

    private let transcriptScroll = NSScrollView()
    private let transcriptView = NSTextView()
    private let composerScroll = NSScrollView()
    private let composerView = NSTextView()

    /// Item lengths parallel to the model's item order, so updates replace
    /// exact ranges instead of rebuilding the document.
    private var itemLengths: [Int] = []
    private var itemIDs: [String] = []

    init(paneID: PaneID, dispatch: @escaping (WorkspaceCommand) -> Void) {
        self.paneID = paneID
        self.dispatch = dispatch
        super.init(frame: .zero)
        setup()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    var transcriptTextLength: Int {
        transcriptView.textStorage?.length ?? 0
    }

    private func setup() {
        // Transcript: read-only, selectable, native find bar.
        transcriptView.isEditable = false
        transcriptView.isSelectable = true
        transcriptView.isRichText = true
        transcriptView.drawsBackground = false
        transcriptView.textContainerInset = NSSize(width: 12, height: 10)
        transcriptView.usesFindBar = true
        transcriptView.isIncrementalSearchingEnabled = true
        transcriptView.delegate = self
        transcriptView.linkTextAttributes = [
            .foregroundColor: NSColor.linkColor,
            .underlineStyle: NSUnderlineStyle.single.rawValue,
            .cursor: NSCursor.pointingHand,
        ]
        transcriptView.setAccessibilityLabel("Transcript")

        transcriptView.isVerticallyResizable = true
        transcriptView.isHorizontallyResizable = false
        transcriptView.autoresizingMask = [.width]
        transcriptView.textContainer?.widthTracksTextView = true

        transcriptScroll.documentView = transcriptView
        transcriptScroll.hasVerticalScroller = true
        transcriptScroll.drawsBackground = false
        transcriptScroll.translatesAutoresizingMaskIntoConstraints = false

        // Composer: editable (IME, dictation, autocorrect are native).
        composerView.isEditable = true
        composerView.isRichText = false
        composerView.font = Theme.bodyFont
        composerView.drawsBackground = false
        composerView.textContainerInset = NSSize(width: 8, height: 6)
        composerView.delegate = self
        composerView.setAccessibilityLabel("Message composer")
        composerView.isVerticallyResizable = true
        composerView.isHorizontallyResizable = false
        composerView.autoresizingMask = [.width]
        composerView.textContainer?.widthTracksTextView = true

        composerScroll.documentView = composerView
        composerScroll.hasVerticalScroller = false
        composerScroll.drawsBackground = false
        composerScroll.borderType = .noBorder
        composerScroll.translatesAutoresizingMaskIntoConstraints = false
        composerScroll.wantsLayer = true
        composerScroll.layer?.cornerRadius = 6
        composerScroll.layer?.borderWidth = 1
        composerScroll.layer?.borderColor = NSColor.separatorColor.cgColor

        let separator = NSBox()
        separator.boxType = .separator
        separator.translatesAutoresizingMaskIntoConstraints = false

        addSubview(transcriptScroll)
        addSubview(separator)
        addSubview(composerScroll)
        NSLayoutConstraint.activate([
            transcriptScroll.topAnchor.constraint(equalTo: topAnchor),
            transcriptScroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            transcriptScroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            transcriptScroll.bottomAnchor.constraint(equalTo: separator.topAnchor),

            separator.leadingAnchor.constraint(equalTo: leadingAnchor),
            separator.trailingAnchor.constraint(equalTo: trailingAnchor),
            separator.bottomAnchor.constraint(equalTo: composerScroll.topAnchor, constant: -6),

            composerScroll.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            composerScroll.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            composerScroll.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
            composerScroll.heightAnchor.constraint(equalToConstant: 54),
        ])
    }

    // MARK: Transcript updates

    func apply(_ change: TranscriptChange, items: [TranscriptItem]) {
        switch change {
        case .none:
            return
        case .appended(let index):
            guard index == itemLengths.count, index < items.count else {
                return rebuild(items: items)
            }
            let rendered = TranscriptRenderer.render(items[index], paneID: paneID)
            let wasAtBottom = isScrolledToBottom
            transcriptView.textStorage?.append(rendered)
            itemLengths.append(rendered.length)
            itemIDs.append(items[index].id)
            if wasAtBottom { scrollToBottom() }
        case .updated(let index):
            guard index < itemLengths.count, index < items.count, itemIDs[index] == items[index].id else {
                return rebuild(items: items)
            }
            let rendered = TranscriptRenderer.render(items[index], paneID: paneID)
            let location = itemLengths.prefix(index).reduce(0, +)
            let oldRange = NSRange(location: location, length: itemLengths[index])
            let wasAtBottom = isScrolledToBottom
            transcriptView.textStorage?.replaceCharacters(in: oldRange, with: rendered)
            itemLengths[index] = rendered.length
            if wasAtBottom { scrollToBottom() }
        }
    }

    func rebuild(items: [TranscriptItem]) {
        let document = NSMutableAttributedString()
        itemLengths = []
        itemIDs = []
        for item in items {
            let rendered = TranscriptRenderer.render(item, paneID: paneID)
            document.append(rendered)
            itemLengths.append(rendered.length)
            itemIDs.append(item.id)
        }
        transcriptView.textStorage?.setAttributedString(document)
        scrollToBottom()
    }

    private var isScrolledToBottom: Bool {
        let visible = transcriptScroll.contentView.bounds
        let documentHeight = transcriptView.frame.height
        return visible.maxY >= documentHeight - 24
    }

    private func scrollToBottom() {
        transcriptView.layoutManager?.ensureLayout(for: transcriptView.textContainer!)
        transcriptView.scrollToEndOfDocument(nil)
    }

    func focusComposer() {
        window?.makeFirstResponder(composerView)
    }

    /// Terminal-cell commit hook: transcript panes have no PTY, but the
    /// contract (exactly one geometry commit per settled layout change) is
    /// exercised here so the future SwiftTerm pane inherits tested behavior.
    func commitCellGeometry() {
        transcriptView.layoutManager?.ensureLayout(for: transcriptView.textContainer!)
    }

    // MARK: NSTextViewDelegate

    func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
        guard let url = link as? URL ?? (link as? String).flatMap(URL.init(string:)),
              url.scheme == "hive" else {
            return false // https links fall through to the system handler
        }
        let parts = url.pathComponents.filter { $0 != "/" }
        switch url.host {
        case "toggle":
            guard parts.count == 2 else { return true }
            dispatch(.toggleToolOutput(paneID: PaneID(parts[0]), itemID: parts[1]))
        case "approve":
            guard parts.count == 2 else { return true }
            dispatch(.resolveApproval(approvalID: parts[0], approved: parts[1] == "allow"))
        default:
            break
        }
        return true
    }

    func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        guard textView === composerView else { return false }
        if commandSelector == #selector(NSResponder.insertNewline(_:)) {
            let text = composerView.string.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return true }
            composerView.string = ""
            dispatch(.sendComposerText(paneID: paneID, text: text))
            return true
        }
        return false
    }
}
