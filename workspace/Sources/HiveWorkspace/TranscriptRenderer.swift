import AppKit
import WorkspaceCore

/// Renders transcript items into attributed strings for the pane's text view.
/// Interaction (expand/collapse, approve/deny) travels through `hive://`
/// links so it lands in the same command model as menus and shortcuts.
enum TranscriptRenderer {

    static let collapseThresholdLines = 30
    static let collapsedPreviewLines = 12

    static func commandURL(_ action: String, _ components: String...) -> URL {
        var url = "hive://\(action)"
        for component in components {
            url += "/" + (component.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? component)
        }
        return URL(string: url)!
    }

    /// Renders one item, always terminated by a trailing newline so item
    /// ranges stay contiguous and separable.
    static func render(_ item: TranscriptItem, paneID: PaneID) -> NSAttributedString {
        let result = NSMutableAttributedString()
        switch item {
        case .message(let message):
            appendMessage(message, to: result)
        case .toolCall(let call):
            appendToolCall(call, paneID: paneID, to: result)
        case .approval(let approval):
            appendApproval(approval, to: result)
        case .diff(_, let payload):
            appendDiff(payload, to: result)
        case .notice(_, let text):
            result.append(NSAttributedString(string: text + "\n", attributes: [
                .font: Theme.captionFont,
                .foregroundColor: NSColor.tertiaryLabelColor,
            ]))
        }
        result.append(NSAttributedString(string: "\n", attributes: [.font: Theme.captionFont]))
        return result
    }

    // MARK: Message

    private static func appendMessage(_ message: MessageItem, to result: NSMutableAttributedString) {
        let roleName: String
        switch message.role {
        case .user: roleName = "You"
        case .assistant: roleName = "Assistant"
        case .system: roleName = "System"
        }
        var header = roleName
        if let model = message.model {
            header += " · \(model)"
        }
        if message.isStreaming {
            header += " · typing…"
        }
        result.append(NSAttributedString(string: header + "\n", attributes: [
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
            .foregroundColor: message.role == .user ? NSColor.controlAccentColor : NSColor.secondaryLabelColor,
        ]))
        let body = NSMutableAttributedString(string: message.text + "\n", attributes: [
            .font: Theme.bodyFont,
            .foregroundColor: NSColor.labelColor,
        ])
        linkifyURLs(in: body)
        result.append(body)
    }

    /// Detects plain http(s) URLs in message text so links behave natively.
    private static func linkifyURLs(in text: NSMutableAttributedString) {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return }
        let range = NSRange(location: 0, length: text.length)
        detector.enumerateMatches(in: text.string, options: [], range: range) { match, _, _ in
            guard let match, let url = match.url else { return }
            text.addAttribute(.link, value: url, range: match.range)
        }
    }

    // MARK: Tool call

    private static func appendToolCall(_ call: ToolCallItem, paneID: PaneID, to result: NSMutableAttributedString) {
        var header = "⚙︎ \(call.name)"
        if call.isRunning {
            header += " · running"
        } else if let exit = call.exitCode {
            header += exit == 0 ? " · exit 0" : " · exit \(exit)"
        }
        let headerColor: NSColor = (call.exitCode ?? 0) == 0 ? .secondaryLabelColor : .systemRed
        result.append(NSAttributedString(string: header + "\n", attributes: [
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
            .foregroundColor: headerColor,
        ]))
        result.append(NSAttributedString(string: call.input + "\n", attributes: [
            .font: Theme.monoFont,
            .foregroundColor: NSColor.secondaryLabelColor,
        ]))
        guard !call.output.isEmpty else { return }

        let lines = call.output.split(separator: "\n", omittingEmptySubsequences: false)
        let totalLines = lines.count
        let needsCollapse = totalLines > collapseThresholdLines

        let visibleText: String
        if needsCollapse && !call.expanded {
            visibleText = lines.prefix(collapsedPreviewLines).joined(separator: "\n") + "\n"
        } else {
            visibleText = call.output.hasSuffix("\n") ? call.output : call.output + "\n"
        }

        if call.isANSI {
            for span in ANSIParser.parse(visibleText) {
                var attributes: [NSAttributedString.Key: Any] = [
                    .font: span.bold
                        ? NSFont.monospacedSystemFont(ofSize: 12, weight: .bold)
                        : Theme.monoFont,
                    .foregroundColor: span.foreground.map(Theme.ansiColor) ?? NSColor.labelColor,
                ]
                if let background = span.background {
                    attributes[.backgroundColor] = Theme.ansiColor(background).withAlphaComponent(0.25)
                }
                if span.underline {
                    attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
                }
                if span.italic, let font = attributes[.font] as? NSFont {
                    attributes[.font] = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask)
                }
                result.append(NSAttributedString(string: span.text, attributes: attributes))
            }
        } else {
            result.append(NSAttributedString(string: visibleText, attributes: [
                .font: Theme.monoFont,
                .foregroundColor: NSColor.labelColor,
            ]))
        }

        if needsCollapse {
            let label = call.expanded
                ? "Collapse output\n"
                : "Show all \(totalLines.formatted()) lines\n"
            result.append(NSAttributedString(string: label, attributes: [
                .font: Theme.captionFont,
                .link: commandURL("toggle", paneID.raw, call.id),
            ]))
        }
    }

    // MARK: Approval

    private static func appendApproval(_ approval: ApprovalItem, to result: NSMutableAttributedString) {
        result.append(NSAttributedString(string: "Approval required — \(approval.title)\n", attributes: [
            .font: Theme.headerFont,
            .foregroundColor: approval.state == .pending ? NSColor.systemOrange : NSColor.secondaryLabelColor,
        ]))
        result.append(NSAttributedString(string: approval.detail + "\n", attributes: [
            .font: Theme.bodyFont,
            .foregroundColor: NSColor.labelColor,
        ]))
        if let diff = approval.diff {
            appendDiff(diff, to: result)
        }
        switch approval.state {
        case .pending:
            // Explicit actions only: links route into the shared command
            // model; focusing this pane can never trigger them.
            result.append(NSAttributedString(string: "Approve", attributes: [
                .font: Theme.headerFont,
                .link: commandURL("approve", approval.id, "allow"),
            ]))
            result.append(NSAttributedString(string: "   ", attributes: [.font: Theme.headerFont]))
            result.append(NSAttributedString(string: "Deny", attributes: [
                .font: Theme.headerFont,
                .link: commandURL("approve", approval.id, "deny"),
            ]))
            result.append(NSAttributedString(string: "\n", attributes: [.font: Theme.headerFont]))
        case .approved:
            result.append(NSAttributedString(string: "✓ Approved\n", attributes: [
                .font: Theme.headerFont,
                .foregroundColor: NSColor.systemGreen,
            ]))
        case .denied:
            result.append(NSAttributedString(string: "✗ Denied\n", attributes: [
                .font: Theme.headerFont,
                .foregroundColor: NSColor.systemRed,
            ]))
        }
    }

    // MARK: Diff

    private static func appendDiff(_ diff: DiffPayload, to result: NSMutableAttributedString) {
        result.append(NSAttributedString(string: diff.filePath + "\n", attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .semibold),
            .foregroundColor: NSColor.labelColor,
        ]))
        for hunk in diff.hunks {
            result.append(NSAttributedString(string: hunk.header + "\n", attributes: [
                .font: Theme.monoFont,
                .foregroundColor: NSColor.tertiaryLabelColor,
            ]))
            for line in hunk.lines {
                let prefix: String
                var attributes: [NSAttributedString.Key: Any] = [.font: Theme.monoFont]
                switch line.kind {
                case .context:
                    prefix = "  "
                    attributes[.foregroundColor] = NSColor.secondaryLabelColor
                case .addition:
                    prefix = "+ "
                    attributes[.foregroundColor] = NSColor.labelColor
                    attributes[.backgroundColor] = NSColor.systemGreen.withAlphaComponent(0.15)
                case .deletion:
                    prefix = "- "
                    attributes[.foregroundColor] = NSColor.labelColor
                    attributes[.backgroundColor] = NSColor.systemRed.withAlphaComponent(0.15)
                }
                result.append(NSAttributedString(string: prefix + line.text + "\n", attributes: attributes))
            }
        }
    }
}
